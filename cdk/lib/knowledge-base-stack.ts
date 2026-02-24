import * as cdk from "aws-cdk-lib";
import { Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as opensearchserverless from "aws-cdk-lib/aws-opensearchserverless";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import { Construct } from "constructs";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  Provider,
} from "aws-cdk-lib/custom-resources";

// Fallback placeholder URL if SSM parameter doesn't exist
// The web crawler data source requires at least one URL
const FALLBACK_URL = ["https://example.com"];

// SSM Parameter name for web crawler URLs (stored as comma-separated string)
// Example value in SSM: https://url1.com,https://url2.com
const WEB_CRAWLER_URLS_PARAM = "/SpecEx/KnowledgeBase/WebCrawlerUrls";

// Bedrock KB / AOSS index settings
const VECTOR_INDEX_NAME = "bedrock-knowledge-base-default-index";
const VECTOR_FIELD_NAME = "bedrock-knowledge-base-default-vector";
const TEXT_FIELD_NAME = "AMAZON_BEDROCK_TEXT_CHUNK";
const METADATA_FIELD_NAME = "AMAZON_BEDROCK_METADATA";
const TITAN_EMBED_V2_DIMENSIONS = 1024;

export interface KnowledgeBaseStackProps extends StackProps {
  stackPrefix: string;
}

export class KnowledgeBaseStack extends Stack {
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly knowledgeBaseBucket: s3.Bucket;
  public readonly s3DataSource: bedrock.CfnDataSource;
  public readonly webCrawlerDataSource: bedrock.CfnDataSource;
  public readonly vectorCollection: opensearchserverless.CfnCollection;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    const collectionName = `${props.stackPrefix.toLowerCase()}-kb-vectors`;
    const embeddingModelArn = `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`;

    /**
     * account-level capacity limits set to minimum 2/2 OCUs
     */
    new AwsCustomResource(this, "OSSCapacityLimits", {
      onCreate: {
        service: "OpenSearchServerless",
        action: "updateAccountSettings",
        parameters: {
          capacityLimits: {
            maxIndexingCapacityInOCU: 2,
            maxSearchCapacityInOCU: 2,
          },
        },
        physicalResourceId: PhysicalResourceId.of("oss-capacity-limits"),
      },
      onUpdate: {
        service: "OpenSearchServerless",
        action: "updateAccountSettings",
        parameters: {
          capacityLimits: {
            maxIndexingCapacityInOCU: 2,
            maxSearchCapacityInOCU: 2,
          },
        },
        physicalResourceId: PhysicalResourceId.of("oss-capacity-limits"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    // Create encryption policy for OpenSearch Serverless
    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(
      this,
      "EncryptionPolicy",
      {
        name: `${collectionName}-encryption`,
        type: "encryption",
        policy: JSON.stringify({
          Rules: [
            {
              ResourceType: "collection",
              Resource: [`collection/${collectionName}`],
            },
          ],
          AWSOwnedKey: true,
        }),
      }
    );

    // Create network policy for OpenSearch Serverless
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(
      this,
      "NetworkPolicy",
      {
        name: `${collectionName}-network`,
        type: "network",
        policy: JSON.stringify([
          {
            Rules: [
              {
                ResourceType: "collection",
                Resource: [`collection/${collectionName}`],
              },
              {
                ResourceType: "dashboard",
                Resource: [`collection/${collectionName}`],
              },
            ],
            AllowFromPublic: true,
          },
        ]),
      }
    );

    // IAM role for Bedrock Knowledge Base
    const knowledgeBaseRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: "Role for Bedrock Knowledge Base to access OpenSearch and S3",
    });

    /**
     * Custom resource Lambda to create/update the OpenSearch Serverless vector index.
     * No Docker required: uses Python runtime + botocore (built into Lambda runtime)
     * to SigV4-sign requests to the AOSS data plane endpoint.
     */
    const vectorIndexManagerRole = new iam.Role(this, "VectorIndexManagerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for custom resource that creates AOSS vector index",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // IAM permission for AOSS data-plane calls from Lambda (SigV4 signed)
    vectorIndexManagerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["aoss:APIAccessAll"],
        resources: ["*"], // keep broad here; data access policy is the actual gate
      })
    );

    this.vectorCollection = new opensearchserverless.CfnCollection(
      this,
      "VectorCollection",
      {
        name: collectionName,
        type: "VECTORSEARCH",
        description: "Vector collection for Bedrock Knowledge Base",
      }
    );

    // Optional scoped IAM allow too (fine to keep)
    vectorIndexManagerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["aoss:APIAccessAll"],
        resources: [this.vectorCollection.attrArn],
      })
    );

    // Bedrock role IAM permissions
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["aoss:APIAccessAll"],
        resources: [this.vectorCollection.attrArn],
      })
    );

    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [embeddingModelArn],
      })
    );

    this.knowledgeBaseBucket = new s3.Bucket(this, "KnowledgeBaseBucket", {
      bucketName: `${props.stackPrefix.toLowerCase()}-kb-documents-bucket`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
          ],
          allowedOrigins: ["*"], // TODO: restrict in production
          exposedHeaders: ["ETag"],
        },
      ],
    });

    // Grant Bedrock role permissions to read from S3
    this.knowledgeBaseBucket.grantRead(knowledgeBaseRole);

    /**
     * Custom resource Lambda that creates/updates the vector index + mappings
     * Uses botocore SigV4 signing to call AOSS endpoint directly
     */
    const vectorIndexManagerFn = new lambda.Function(this, "VectorIndexManagerFn", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "main.handler",
      role: vectorIndexManagerRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      code: lambda.Code.fromAsset("lambda/vectorIndexManager"),
    });

    // Create the Provider - this creates a framework role that wraps the Lambda
    const vectorIndexProvider = new Provider(this, "VectorIndexProvider", {
      onEventHandler: vectorIndexManagerFn,
    });

    // Get the Provider's framework role (this is what actually calls the Lambda)
    const providerRole = vectorIndexProvider.node.findChild('framework-onEvent').node.findChild('ServiceRole') as iam.Role;
    
    // Grant the Provider role permissions to access OpenSearch Serverless
    providerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["aoss:APIAccessAll"],
        resources: [this.vectorCollection.attrArn],
      })
    );

    /**
     * OpenSearch Serverless data access policy
     * CRITICAL: Must use the Provider's framework role, not the Lambda execution role
     * The Provider framework creates its own role that actually invokes the Lambda
     */
    const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(
      this,
      "DataAccessPolicy",
      {
        name: `${collectionName}-access`,
        type: "data",
        policy: JSON.stringify([
          {
            Rules: [
              {
                ResourceType: "collection",
                Resource: [`collection/${collectionName}`],
                Permission: [
                  "aoss:DescribeCollectionItems",
                ],
              },
              {
                ResourceType: "index",
                Resource: [`index/${collectionName}/*`],
                Permission: [
                  "aoss:CreateIndex",
                  "aoss:DeleteIndex",
                  "aoss:UpdateIndex",
                  "aoss:DescribeIndex",
                  "aoss:ReadDocument",
                  "aoss:WriteDocument",
                ],
              },
            ],
            Principal: [
              knowledgeBaseRole.roleArn,
              providerRole.roleArn,  // Use Provider's framework role
            ],
          },
        ]),
      }
    );

    this.vectorCollection.addDependency(encryptionPolicy);
    this.vectorCollection.addDependency(networkPolicy);
    this.vectorCollection.addDependency(dataAccessPolicy);

    const vectorIndexCustomResource = new cdk.CustomResource(
      this,
      "VectorIndexCustomResource",
      {
        serviceToken: vectorIndexProvider.serviceToken,
        properties: {
          CollectionEndpoint: this.vectorCollection.attrCollectionEndpoint,
          Region: this.region,
          IndexName: VECTOR_INDEX_NAME,
          VectorField: VECTOR_FIELD_NAME,
          TextField: TEXT_FIELD_NAME,
          MetadataField: METADATA_FIELD_NAME,
          Dimensions: TITAN_EMBED_V2_DIMENSIONS,
        },
      }
    );

    // Ensure collection + access policy + role exist before custom resource runs
    vectorIndexCustomResource.node.addDependency(this.vectorCollection);
    vectorIndexCustomResource.node.addDependency(dataAccessPolicy);
    vectorIndexCustomResource.node.addDependency(vectorIndexManagerRole);

    // Create the Bedrock Knowledge Base (depends on collection and index existing)
    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${props.stackPrefix}-KnowledgeBase`,
      description: "Knowledge base for RAG application with S3 and web-crawled content",
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: embeddingModelArn,
        },
      },
      storageConfiguration: {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn: this.vectorCollection.attrArn,
          vectorIndexName: VECTOR_INDEX_NAME,
          fieldMapping: {
            vectorField: VECTOR_FIELD_NAME,
            textField: TEXT_FIELD_NAME,
            metadataField: METADATA_FIELD_NAME,
          },
        },
      },
    });

    this.knowledgeBase.addDependency(this.vectorCollection);

    // Strong dependency on underlying CFN custom resource
    const cfnCustomResource = vectorIndexCustomResource.node.defaultChild as cdk.CfnResource;
    this.knowledgeBase.addDependency(cfnCustomResource);

    // Read web crawler URLs from SSM Parameter Store
    let webCrawlerUrls: string[];
    try {
      const urlsParam = ssm.StringParameter.valueFromLookup(this, WEB_CRAWLER_URLS_PARAM);
      if (urlsParam.includes("dummy-value")) {
        webCrawlerUrls = FALLBACK_URL;
      } else {
        webCrawlerUrls = urlsParam
          .split(",")
          .map((url) => url.trim())
          .filter((url) => url.length > 0);
      }
    } catch {
      webCrawlerUrls = FALLBACK_URL;
    }

    // Add S3 data source
    this.s3DataSource = new bedrock.CfnDataSource(this, "S3DataSource", {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: "s3-documents-source",
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: this.knowledgeBaseBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "HIERARCHICAL",
          hierarchicalChunkingConfiguration: {
            levelConfigurations: [{ maxTokens: 1500 }, { maxTokens: 300 }],
            overlapTokens: 60,
          },
        },
      },
    });

    // Add Web Crawler data source
    this.webCrawlerDataSource = new bedrock.CfnDataSource(this, "WebCrawlerDataSource", {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: "web-crawler-source",
      dataSourceConfiguration: {
        type: "WEB",
        webConfiguration: {
          sourceConfiguration: {
            urlConfiguration: {
              seedUrls: webCrawlerUrls.map((url) => ({ url })),
            },
          },
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "HIERARCHICAL",
          hierarchicalChunkingConfiguration: {
            levelConfigurations: [{ maxTokens: 1500 }, { maxTokens: 300 }],
            overlapTokens: 60,
          },
        },
      },
    });

    // Store Knowledge Base ID in AWS Secrets Manager
    const knowledgeBaseIdSecret = new secretsmanager.Secret(this, "KnowledgeBaseIdSecret", {
      secretName: `${props.stackPrefix}/KnowledgeBase/Id`,
      description: "The ID of the Bedrock Knowledge Base",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        this.knowledgeBase.attrKnowledgeBaseId
      ),
    });

    // Outputs
    new CfnOutput(this, "KnowledgeBaseId", {
      value: this.knowledgeBase.attrKnowledgeBaseId,
      description: "The ID of the Bedrock Knowledge Base",
    });

    new CfnOutput(this, "KnowledgeBaseBucketName", {
      value: this.knowledgeBaseBucket.bucketName,
      description: "The name of the S3 bucket for knowledge base documents",
    });

    new CfnOutput(this, "KnowledgeBaseBucketArn", {
      value: this.knowledgeBaseBucket.bucketArn,
      description: "The ARN of the S3 bucket for knowledge base documents",
    });

    new CfnOutput(this, "S3DataSourceId", {
      value: this.s3DataSource.attrDataSourceId,
      description: "The ID of the S3 data source",
    });

    new CfnOutput(this, "WebCrawlerDataSourceId", {
      value: this.webCrawlerDataSource.attrDataSourceId,
      description: "The ID of the Web Crawler data source",
    });

    new CfnOutput(this, "VectorCollectionArn", {
      value: this.vectorCollection.attrArn,
      description: "The ARN of the OpenSearch Serverless collection",
    });

    new CfnOutput(this, "KnowledgeBaseIdSecretArn", {
      value: knowledgeBaseIdSecret.secretArn,
      description: "The ARN of the secret containing the Knowledge Base ID",
    });

    new CfnOutput(this, "ProviderRoleArn", {
      value: providerRole.roleArn,
      description: "The ARN of the Provider framework role for vector index management",
    });

    new CfnOutput(this, "DataAccessPolicyName", {
      value: dataAccessPolicy.name,
      description: "The name of the OpenSearch Serverless data access policy",
    });
  }
}