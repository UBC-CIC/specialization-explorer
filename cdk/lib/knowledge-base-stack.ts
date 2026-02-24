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

    // The custom resource Lambda needs data-plane API access to the collection endpoint.
    vectorIndexManagerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["aoss:APIAccessAll"],
        resources: ["*"], // collection ARN not available yet at role creation time; data access policy also restricts principals
      })
    );

    // Create data access policy for OpenSearch Serverless
    // Include BOTH Bedrock role and the custom resource Lambda role as principals.
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
                  "aoss:CreateCollectionItems",
                  "aoss:DeleteCollectionItems",
                  "aoss:UpdateCollectionItems",
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
            Principal: [knowledgeBaseRole.roleArn, vectorIndexManagerRole.roleArn],
          },
        ]),
      }
    );

    // Create OpenSearch Serverless vector collection
    this.vectorCollection = new opensearchserverless.CfnCollection(
      this,
      "VectorCollection",
      {
        name: collectionName,
        type: "VECTORSEARCH",
        description: "Vector collection for Bedrock Knowledge Base",
      }
    );

    this.vectorCollection.addDependency(encryptionPolicy);
    this.vectorCollection.addDependency(networkPolicy);
    this.vectorCollection.addDependency(dataAccessPolicy);

    // Grant Bedrock role permissions to access OpenSearch (data plane)
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["aoss:APIAccessAll"],
        resources: [this.vectorCollection.attrArn],
      })
    );

    // Grant Bedrock role permission to invoke the embedding model (required for KB ingestion)
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [embeddingModelArn],
      })
    );

    // Create S3 bucket for knowledge base documents (CSV files, PDFs, etc.)
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
      handler: "index.handler",
      role: vectorIndexManagerRole,
      timeout: cdk.Duration.minutes(15),
      code: lambda.Code.fromInline(`
import json
import os
import time
import urllib.request
import urllib.error
import ssl

import boto3
from botocore.awsrequest import AWSRequest
from botocore.auth import SigV4Auth
from botocore.credentials import Credentials
from botocore.session import Session

SUCCESS = "SUCCESS"
FAILED = "FAILED"

def send_cfn_response(event, context, status, reason=None, data=None, physical_resource_id=None):
    response_url = event.get("ResponseURL")
    if not response_url:
        print("No ResponseURL; event:", json.dumps(event))
        return

    response_body = {
        "Status": status,
        "Reason": reason or f"See CloudWatch Logs: {context.log_stream_name}",
        "PhysicalResourceId": physical_resource_id or context.log_stream_name,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": data or {},
    }

    body = json.dumps(response_body).encode("utf-8")
    req = urllib.request.Request(
        response_url,
        data=body,
        method="PUT",
        headers={"content-type": "", "content-length": str(len(body))}
    )
    with urllib.request.urlopen(req) as resp:
        print("CFN response status:", resp.status)

def _normalize_endpoint(endpoint: str) -> str:
    endpoint = endpoint.strip()
    if not endpoint.startswith("http://") and not endpoint.startswith("https://"):
        endpoint = "https://" + endpoint
    return endpoint.rstrip("/")

def _signed_request(method: str, url: str, region: str, body_obj=None):
    session = Session()
    creds = session.get_credentials()
    frozen = creds.get_frozen_credentials()
    body = None
    headers = {"content-type": "application/json"}
    if body_obj is not None:
        body = json.dumps(body_obj).encode("utf-8")

    aws_req = AWSRequest(method=method, url=url, data=body, headers=headers)
    SigV4Auth(Credentials(frozen.access_key, frozen.secret_key, frozen.token), "aoss", region).add_auth(aws_req)
    prepared = aws_req.prepare()

    req = urllib.request.Request(
        prepared.url,
        data=body,
        method=method,
        headers=dict(prepared.headers.items()),
    )

    try:
        with urllib.request.urlopen(req, context=ssl.create_default_context()) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8") if e.fp else ""
        return e.code, raw

def _wait_for_collection(endpoint: str, region: str, max_attempts=60, sleep_seconds=10):
    # Try a simple endpoint call until it responds (401/403/404/200 all indicate endpoint is alive enough)
    # A 5xx/connection error means not ready yet.
    # OpenSearch Serverless collections can take 5-10 minutes to be fully ready
    for attempt in range(1, max_attempts + 1):
        try:
            code, body = _signed_request("GET", endpoint + "/_cat/indices?v", region)
            print(f"Collection readiness check attempt {attempt}: code={code}")
            if code in (200, 401, 403, 404):
                # Wait a bit more after first success to ensure stability
                if attempt == 1:
                    print("Collection responded, waiting 30s for stability...")
                    time.sleep(30)
                return
        except Exception as e:
            print(f"Readiness attempt {attempt} exception: {e}")
        time.sleep(sleep_seconds)
    raise RuntimeError("Timed out waiting for OpenSearch Serverless collection endpoint readiness")

def _create_or_update_index(endpoint: str, index_name: str, region: str, vector_field: str, text_field: str, metadata_field: str, dimensions: int):
    # Bedrock KB-compatible vector index mapping
    mapping_body = {
        "settings": {
            "index": {
                "knn": True
            }
        },
        "mappings": {
            "properties": {
                vector_field: {
                    "type": "knn_vector",
                    "dimension": dimensions,
                    "method": {
                        "engine": "faiss",
                        "name": "hnsw",
                        "space_type": "l2"
                    }
                },
                text_field: {
                    "type": "text"
                },
                metadata_field: {
                    "type": "text",
                    "index": False
                }
            }
        }
    }

    # Create index (idempotent enough: if exists, update mapping as possible)
    create_url = f"{endpoint}/{index_name}"
    code, body = _signed_request("PUT", create_url, region, mapping_body)
    print("Create index response:", code, body)

    # Accept common "already exists" outcomes
    if code in (200, 201):
        return
    if code == 400 and ("resource_already_exists_exception" in body or "already exists" in body.lower()):
        # Try a lightweight mapping put to ensure fields exist (won't change incompatible types)
        map_url = f"{endpoint}/{index_name}/_mapping"
        code2, body2 = _signed_request("PUT", map_url, region, {"properties": mapping_body["mappings"]["properties"]})
        print("Update mapping response:", code2, body2)
        if code2 in (200, 201):
            return
        # If mapping already exists and is compatible, some clusters return 400; surface only if clearly incompatible
        if code2 == 400 and ("mapper_parsing_exception" not in body2 and "illegal_argument_exception" not in body2):
            return
        raise RuntimeError(f"Failed to update index mapping: {code2} {body2}")
    raise RuntimeError(f"Failed to create index: {code} {body}")

def handler(event, context):
    print("Event:", json.dumps(event))
    props = event.get("ResourceProperties", {})
    endpoint = _normalize_endpoint(props["CollectionEndpoint"])
    region = props["Region"]
    index_name = props["IndexName"]
    vector_field = props["VectorField"]
    text_field = props["TextField"]
    metadata_field = props["MetadataField"]
    dimensions = int(props["Dimensions"])

    physical_id = f"{index_name}-vector-index"

    try:
        request_type = event["RequestType"]

        if request_type == "Delete":
            # Leave index in place to avoid delete-order issues / accidental data loss.
            send_cfn_response(event, context, SUCCESS, data={"SkippedDelete": "true"}, physical_resource_id=physical_id)
            return

        _wait_for_collection(endpoint, region)
        _create_or_update_index(
            endpoint=endpoint,
            index_name=index_name,
            region=region,
            vector_field=vector_field,
            text_field=text_field,
            metadata_field=metadata_field,
            dimensions=dimensions,
        )

        send_cfn_response(event, context, SUCCESS, data={"IndexName": index_name}, physical_resource_id=physical_id)
    except Exception as e:
        print("ERROR:", str(e))
        send_cfn_response(event, context, FAILED, reason=str(e), physical_resource_id=physical_id)
      `),
    });

    const vectorIndexProvider = new Provider(this, "VectorIndexProvider", {
      onEventHandler: vectorIndexManagerFn,
    });

    const vectorIndexCustomResource = new cdk.CustomResource(this, "VectorIndexCustomResource", {
      serviceToken: vectorIndexProvider.serviceToken,
      properties: {
        CollectionEndpoint: this.vectorCollection.attrCollectionEndpoint,
        Region: this.region,
        IndexName: VECTOR_INDEX_NAME,
        VectorField: VECTOR_FIELD_NAME,
        TextField: TEXT_FIELD_NAME,
        MetadataField: METADATA_FIELD_NAME,
        Dimensions: TITAN_EMBED_V2_DIMENSIONS,
        // Add a timestamp to force updates when needed
        Timestamp: Date.now().toString(),
      },
    });

    vectorIndexCustomResource.node.addDependency(this.vectorCollection);
    vectorIndexCustomResource.node.addDependency(dataAccessPolicy);
    vectorIndexCustomResource.node.addDependency(vectorIndexManagerRole);

    // Create the Bedrock Knowledge Base (depends on collection and index existing)
    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${props.stackPrefix}-KnowledgeBase`,
      description:
        "Knowledge base for RAG application with S3 and web-crawled content",
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

    // KB must wait for both collection AND index creation to complete
    this.knowledgeBase.node.addDependency(this.vectorCollection);
    this.knowledgeBase.node.addDependency(vectorIndexCustomResource);
    
    // Force CloudFormation to wait by referencing the custom resource output
    const indexCreationToken = vectorIndexCustomResource.getAtt("IndexName").toString();
    this.knowledgeBase.addMetadata("IndexCreationToken", indexCreationToken);

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
  }
}