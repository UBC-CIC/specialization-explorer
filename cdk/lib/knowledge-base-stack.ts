import * as cdk from "aws-cdk-lib";
import { Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as opensearchserverless from "aws-cdk-lib/aws-opensearchserverless";
import { Construct } from "constructs";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  Provider,
} from "aws-cdk-lib/custom-resources";

const FALLBACK_URL = ["https://example.com"];

// Bedrock KB / AOSS index settings
const VECTOR_INDEX_NAME = "bedrock-knowledge-base-default-index";
const VECTOR_FIELD_NAME = "bedrock-knowledge-base-default-vector";
const TEXT_FIELD_NAME = "AMAZON_BEDROCK_TEXT_CHUNK";
const METADATA_FIELD_NAME = "AMAZON_BEDROCK_METADATA";
const EMBEDDING_MODEL_ID = "cohere.embed-english-v3";
const COHERE_V3_DIMENSIONS = 1024;

export interface KnowledgeBaseStackProps extends StackProps {
  stackPrefix: string;
  vectorIndexManagerRepository: ecr.IRepository;
  vectorIndexManagerPipelineName: string;
  vpc: ec2.IVpc;
  vpcCidr: string;
}

export class KnowledgeBaseStack extends Stack {
  public readonly knowledgeBaseBucket: s3.Bucket;
  public readonly vectorCollection: opensearchserverless.CfnCollection;
  public readonly knowledgeBaseId: string;
  public readonly knowledgeBaseSecret: secretsmanager.Secret;
  public readonly s3DataSourceId: string;
  public readonly webCrawlerDataSourceId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    // Keep name very short to avoid 32 character limit on AOSS Collection & Policy Names
    // e.g. "specex-kb"
    const rawPrefix = props.stackPrefix.toLowerCase().substring(0, 6);
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // Use a stable, deterministic collection name
    const collectionName = `${rawPrefix}-kb`;

    // We also use shorter suffixes for policies: `-enc`, `-net`, `-acc`
    const embeddingModelArn = `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL_ID}`;

    // Security group for VPC-attached Lambda functions (no inbound, outbound HTTPS only)
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for VPC-attached Lambda functions in KB stack',
      allowAllOutbound: false,
    });
    lambdaSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow outbound HTTPS');

    // Security group for AOSS VPC endpoint (inbound HTTPS from VPC CIDR and Lambda SG)
    const vpcEndpointSg = new ec2.SecurityGroup(this, 'AossVpcEndpointSg', {
      vpc: props.vpc,
      description: 'Security group for AOSS VPC endpoint',
      allowAllOutbound: false,
    });
    vpcEndpointSg.addIngressRule(ec2.Peer.ipv4(props.vpcCidr), ec2.Port.tcp(443), 'Allow HTTPS from VPC CIDR');
    vpcEndpointSg.addIngressRule(lambdaSg, ec2.Port.tcp(443), 'Allow HTTPS from Lambda SG');

    // OpenSearch Serverless VPC endpoint in private subnets
    const aossVpcEndpoint = new opensearchserverless.CfnVpcEndpoint(this, 'AossVpcEndpoint', {
      name: `${collectionName}-vpce`,
      vpcId: props.vpc.vpcId,
      subnetIds: props.vpc.privateSubnets.map(s => s.subnetId),
      securityGroupIds: [vpcEndpointSg.securityGroupId],
    });

    // Account-level capacity limits set to minimum 2/2 OCUs
    new AwsCustomResource(this, "OSSCapacityLimits", {
      onCreate: {
        service: "OpenSearchServerless",
        action: "updateAccountSettings",
        parameters: {
          capacityLimits: { maxIndexingCapacityInOCU: 2, maxSearchCapacityInOCU: 2 },
        },
        physicalResourceId: PhysicalResourceId.of("oss-capacity-limits"),
      },
      onUpdate: {
        service: "OpenSearchServerless",
        action: "updateAccountSettings",
        parameters: {
          capacityLimits: { maxIndexingCapacityInOCU: 2, maxSearchCapacityInOCU: 2 },
        },
        physicalResourceId: PhysicalResourceId.of("oss-capacity-limits"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });


    // Create encryption policy for OpenSearch Serverless
    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, "EncryptionPolicy", {
      name: `${collectionName}-enc`,
      type: "encryption",
      policy: JSON.stringify({
        Rules: [{ ResourceType: "collection", Resource: [`collection/${collectionName}`] }],
        AWSOwnedKey: true,
      }),
    });

    // Create network policy for OpenSearch Serverless (private access via VPC endpoint and Bedrock service)
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, "NetworkPolicy", {
      name: `${collectionName}-net`,
      type: "network",
      policy: JSON.stringify([{
        Rules: [
          { ResourceType: "collection", Resource: [`collection/${collectionName}`] },
          { ResourceType: "dashboard", Resource: [`collection/${collectionName}`] },
        ],
        AllowFromPublic: false,
        SourceVPCEs: [aossVpcEndpoint.attrId],
        SourceServices: ['bedrock.amazonaws.com'],
      }]),
    });
    networkPolicy.addDependency(aossVpcEndpoint); // Ensure VPC endpoint exists first

    // IAM role for Bedrock Knowledge Base
    const knowledgeBaseRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: "Role for Bedrock Knowledge Base to access OpenSearch and S3",
    });

    // IAM role for custom resource that manages AOSS vector index
    const vectorIndexManagerRole = new iam.Role(this, "VectorIndexManagerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for custom resource that creates AOSS vector index",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    vectorIndexManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["aoss:APIAccessAll", "aoss:DashboardsAccessAll"],
      resources: ["*"],
    }));

    // Vector collection
    this.vectorCollection = new opensearchserverless.CfnCollection(this, "VectorCollection", {
      name: collectionName,
      type: "VECTORSEARCH",
      description: "Vector collection for Bedrock Knowledge Base",
    });

    // Bedrock role IAM permissions
    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["aoss:APIAccessAll", "aoss:DashboardsAccessAll"],
      resources: [this.vectorCollection.attrArn],
    }));

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["bedrock:InvokeModel"],
      resources: [embeddingModelArn],
    }));

    // Dedicated bucket for S3 server access logs
    const accessLogsBucket = new s3.Bucket(this, "KnowledgeBaseAccessLogsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    // Use account and region for uniqueness (see https://aws.amazon.com/blogs/aws/introducing-account-regional-namespaces-for-amazon-s3-general-purpose-buckets/)
    // CORS is configured by the amplify-stack with the amplify-url to restrict requests only to our application
    // Holds the source documents, so it is kept (with its objects) if the stack is deleted.
    // Turning off autoDeleteObjects removes the bucket's aws-cdk:auto-delete-objects tag
    // before the cleanup resource is deleted, and that handler only empties tagged buckets.
    this.knowledgeBaseBucket = new s3.Bucket(this, "KnowledgeBaseBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          // Uploads that were never staged are not part of the corpus; clear them out
          id: "ExpireUnstagedUploads",
          prefix: "quarantine/",
          expiration: cdk.Duration.days(7),
          noncurrentVersionExpiration: cdk.Duration.days(7),
        },
      ],
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "kb-bucket-access-logs/",
    });

    // Access the underlying L1 construct for enabling account regional space
    const cfnBucket = this.knowledgeBaseBucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.bucketNamespace = 'account-regional';
    cfnBucket.bucketNamePrefix = `${rawPrefix}-kb-documents`;

    // Grant Bedrock role permissions to read from S3
    this.knowledgeBaseBucket.grantRead(knowledgeBaseRole);

    // Ensure the vector index manager container image exists in ECR before creating the image-based Lambda.
    const ecrImageWaiterRole = new iam.Role(this, "KBEcrImageWaiterRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    ecrImageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:BatchGetImage"],
      resources: [props.vectorIndexManagerRepository.repositoryArn],
    }));

    ecrImageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["codepipeline:StartPipelineExecution"],
      resources: [
        `arn:aws:codepipeline:${this.region}:${this.account}:${props.vectorIndexManagerPipelineName}`,
      ],
    }));

    ecrImageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: ["arn:aws:logs:*:*:*"],
    }));

    const ecrImageWaiterFn = new lambda.Function(this, "KBEcrImageWaiterFn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      role: ecrImageWaiterRole,
      timeout: cdk.Duration.minutes(15),
      code: lambda.Code.fromAsset("lambda/ecrImageWaiter"),
    });

    const ecrImageWaiter = new cdk.CustomResource(this, "KBEcrImageWaiter", {
      serviceToken: ecrImageWaiterFn.functionArn,
      properties: {
        RepositoryName: props.vectorIndexManagerRepository.repositoryName,
        ImageTag: "latest",
        MaxRetries: "28",
        RetryDelaySeconds: "30",
        CodePipelineName: props.vectorIndexManagerPipelineName,
        TriggerBuildOnMissing: "true",
      },
    });

    // ENI permissions for VPC-attached Lambda execution
    vectorIndexManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    // Vector Index Manager Lambda
    const vectorIndexManagerFn = new lambda.DockerImageFunction(this, "VectorIndexManagerFn", {
      role: vectorIndexManagerRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      functionName: `${props.stackPrefix}-KnowledgeBase-VectorIndexManagerFn-v2`,
      code: lambda.DockerImageCode.fromEcr(props.vectorIndexManagerRepository, {
        tagOrDigest: "latest",
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
    });
    vectorIndexManagerFn.node.addDependency(ecrImageWaiter);

    // The pipeline publishes a version for each scanned image and moves this alias to it,
    // so the provider always runs a known version and can be rolled back by moving the alias
    const vectorIndexManagerLive = new lambda.Alias(this, "VectorIndexManagerLive", {
      aliasName: "live",
      version: vectorIndexManagerFn.currentVersion,
    });

    const vectorIndexProvider = new Provider(this, "VectorIndexProvider", {
      onEventHandler: vectorIndexManagerLive,
      isCompleteHandler: vectorIndexManagerLive,
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.minutes(30),
    });

    // OpenSearch Serverless data access policy
    const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, "DataAccessPolicy", {
      name: `${collectionName}-acc`,
      type: "data",
      policy: JSON.stringify([{
        Rules: [
          {
            ResourceType: "collection",
            Resource: [`collection/${collectionName}`],
            Permission: ["aoss:CreateCollectionItems", "aoss:DeleteCollectionItems", "aoss:UpdateCollectionItems", "aoss:DescribeCollectionItems"],
          },
          {
            ResourceType: "index",
            Resource: [`index/${collectionName}/*`],
            Permission: [
              "aoss:CreateIndex", "aoss:DeleteIndex", "aoss:UpdateIndex",
              "aoss:DescribeIndex", "aoss:ReadDocument", "aoss:WriteDocument"
            ],
          },
        ],
        Principal: [knowledgeBaseRole.roleArn, vectorIndexManagerRole.roleArn],
      }]),
    });

    this.vectorCollection.addDependency(encryptionPolicy);
    this.vectorCollection.addDependency(networkPolicy);
    this.vectorCollection.addDependency(dataAccessPolicy);

    const vectorIndexCustomResource = new cdk.CustomResource(this, "VectorIndexCustomResource", {
      serviceToken: vectorIndexProvider.serviceToken,
      properties: {
        CollectionEndpoint: this.vectorCollection.attrCollectionEndpoint,
        Region: this.region,
        IndexName: VECTOR_INDEX_NAME,
        VectorField: VECTOR_FIELD_NAME,
        TextField: TEXT_FIELD_NAME,
        MetadataField: METADATA_FIELD_NAME,
        Dimensions: COHERE_V3_DIMENSIONS,
      },
    });

    vectorIndexCustomResource.node.addDependency(this.vectorCollection);
    vectorIndexCustomResource.node.addDependency(networkPolicy);
    vectorIndexCustomResource.node.addDependency(dataAccessPolicy);
    vectorIndexCustomResource.node.addDependency(vectorIndexManagerRole);
    vectorIndexProvider.node.addDependency(networkPolicy);
    vectorIndexProvider.node.addDependency(dataAccessPolicy);

    const webCrawlerUrls = FALLBACK_URL.join(",");

    // Role for Knowledge Base Provisioner Lambda
    const kbProvisionerRole = new iam.Role(this, "KBProvisionerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for custom resource that creates the Bedrock Knowledge Base and Data Sources",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });

    // Create/List actions cannot be scoped to a specific resource ARN
    kbProvisionerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:CreateKnowledgeBase",
        "bedrock:ListDataSources",
      ],
      resources: ["*"],
    }));

    // Remaining actions scoped to knowledge base ARNs in this account/region
    kbProvisionerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:GetKnowledgeBase",
        "bedrock:GetDataSource",
        "bedrock:UpdateKnowledgeBase",
        "bedrock:DeleteKnowledgeBase",
        "bedrock:CreateDataSource",
        "bedrock:UpdateDataSource",
        "bedrock:DeleteDataSource",
      ],
      resources: [
        `arn:aws:bedrock:${region}:${accountId}:knowledge-base/*`,
      ],
    }));

    // PassRole scoped to the KB role, only passable to Bedrock
    kbProvisionerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: [knowledgeBaseRole.roleArn],
      conditions: {
        StringEquals: {
          "iam:PassedToService": "bedrock.amazonaws.com",
        },
      },
    }));

    // ENI permissions for VPC-attached Lambda execution
    kbProvisionerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    const kbProvisionerFn = new lambda.Function(this, "KBProvisionerFn", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "main.handler",
      role: kbProvisionerRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      code: lambda.Code.fromAsset("lambda/knowledgeBaseProvisioner"),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
    });

    const kbProvisionerProvider = new Provider(this, "KBProvisionerProvider", {
      onEventHandler: kbProvisionerFn,
    });

    // Create the Bedrock Knowledge Base using the Custom Resource Lambda
    const kbCustomResource = new cdk.CustomResource(this, "KnowledgeBaseProvisioner", {
      serviceToken: kbProvisionerProvider.serviceToken,
      properties: {
        Name: `${props.stackPrefix}-KnowledgeBase`,
        RoleArn: knowledgeBaseRole.roleArn,
        EmbeddingModelArn: embeddingModelArn,
        CollectionArn: this.vectorCollection.attrArn,
        VectorIndexName: VECTOR_INDEX_NAME,
        VectorField: VECTOR_FIELD_NAME,
        TextField: TEXT_FIELD_NAME,
        MetadataField: METADATA_FIELD_NAME,
        Description: "Knowledge base for RAG application with S3 and web-crawled content",
        S3BucketArn: this.knowledgeBaseBucket.bucketArn,
        // Bedrock reads only this prefix; presigned uploads land under quarantine/ until staging promotes them
        S3InclusionPrefix: "uploads/",
        WebCrawlerUrls: webCrawlerUrls,
        // If the placeholder URL is used, exclude everything so nothing gets crawled.
        // When real URLs are set, no exclusion filter is applied.
        WebCrawlerExclusionFilters: webCrawlerUrls.trim() === "https://example.com" ? "https://example\\.com.*" : "",
      },
    });

    // Important: Wait for vector index to exist before creating Knowledge Base
    kbCustomResource.node.addDependency(vectorIndexCustomResource);

    this.knowledgeBaseId = kbCustomResource.getAttString("KnowledgeBaseId");
    this.s3DataSourceId = kbCustomResource.getAttString("S3DataSourceId");
    this.webCrawlerDataSourceId = kbCustomResource.getAttString("WebCrawlerDataSourceId");

    // Create the secret if it doesn't exist, update its value if it does
    const knowledgeBaseSecretName = `${props.stackPrefix}/KnowledgeBase/Id`;
    const secretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${knowledgeBaseSecretName}-*`;

    const ensureSecret = new AwsCustomResource(this, "EnsureKBSecret", {
      onCreate: {
        service: "SecretsManager",
        action: "createSecret",
        parameters: {
          Name: knowledgeBaseSecretName,
          SecretString: this.knowledgeBaseId,
          Description: "Knowledge Base ID for the application",
        },
        physicalResourceId: PhysicalResourceId.of(knowledgeBaseSecretName),
        ignoreErrorCodesMatching: "ResourceExistsException",
      },
      onUpdate: {
        service: "SecretsManager",
        action: "putSecretValue",
        parameters: {
          SecretId: knowledgeBaseSecretName,
          SecretString: this.knowledgeBaseId,
        },
        physicalResourceId: PhysicalResourceId.of(knowledgeBaseSecretName),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["secretsmanager:CreateSecret"],
          resources: ["*"], // CreateSecret cannot be scoped to a specific ARN (secret doesn't exist yet)
        }),
        new iam.PolicyStatement({
          actions: ["secretsmanager:PutSecretValue"],
          resources: [secretArn],
        }),
      ]),
    });

    ensureSecret.node.addDependency(kbCustomResource);

    this.knowledgeBaseSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "KnowledgeBaseIdSecret",
      knowledgeBaseSecretName
    ) as secretsmanager.Secret;

    // Outputs
    new CfnOutput(this, "KnowledgeBaseId", {
      value: this.knowledgeBaseId,
      description: "The ID of the Bedrock Knowledge Base",
    });

    new CfnOutput(this, "KnowledgeBaseBucketName", {
      value: this.knowledgeBaseBucket.bucketName,
      description: "The name of the S3 bucket for knowledge base documents",
    });

    new CfnOutput(this, "KnowledgeBaseAccessLogsBucketName", {
      value: accessLogsBucket.bucketName,
      description: "The name of the S3 bucket storing access logs for the knowledge base bucket",
    });

    new CfnOutput(this, "KnowledgeBaseBucketArn", {
      value: this.knowledgeBaseBucket.bucketArn,
      description: "The ARN of the S3 bucket for knowledge base documents",
    });

    new CfnOutput(this, "S3DataSourceId", {
      value: this.s3DataSourceId,
      description: "The ID of the S3 data source",
    });

    new CfnOutput(this, "WebCrawlerDataSourceId", {
      value: this.webCrawlerDataSourceId,
      description: "The ID of the Web Crawler data source",
    });

    new CfnOutput(this, "VectorCollectionArn", {
      value: this.vectorCollection.attrArn,
      description: "The ARN of the OpenSearch Serverless collection",
    });

    new CfnOutput(this, "KnowledgeBaseIdSecretArn", {
      value: this.knowledgeBaseSecret.secretArn,
      description: "The ARN of the secret containing the Knowledge Base ID",
    });
  }
}

