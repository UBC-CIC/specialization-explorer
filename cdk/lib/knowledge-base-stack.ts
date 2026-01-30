import { Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
    AwsCustomResource,
    AwsCustomResourcePolicy,
    PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import {
    bedrock,
    opensearchserverless as genaiOSS,
} from "@cdklabs/generative-ai-cdk-constructs";

// Placeholder URL for web crawler - will be updated dynamically by admin
// The web crawler data source requires at least one URL, so we use a minimal placeholder
const PLACEHOLDER_URL = ["https://example.com"];

export interface KnowledgeBaseStackProps extends StackProps {
    stackPrefix: string;
}

export class KnowledgeBaseStack extends Stack {
    public readonly knowledgeBase: bedrock.VectorKnowledgeBase;
    public readonly knowledgeBaseBucket: s3.Bucket;
    public readonly s3DataSource: bedrock.S3DataSource;
    public readonly webCrawlerDataSource: bedrock.WebCrawlerDataSource;

    constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
        super(scope, id, props);

        // Set OpenSearch Serverless capacity limits to minimum to reduce costs
        // Note: This is an account-level setting that affects all collections
        // Minimum for vector search: 2 OCUs indexing, 2 OCUs search
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

        // Create OpenSearch Serverless vector collection for storing embeddings
        const vectorStore = new genaiOSS.VectorCollection(
            this,
            "VectorCollection",
            {
                collectionName: `${props.stackPrefix.toLowerCase()}-kb-vectors`,
            }
        );

        // Create the Bedrock Knowledge Base with Titan Embed V2 model
        this.knowledgeBase = new bedrock.VectorKnowledgeBase(this, "KnowledgeBase", {
            embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
            vectorStore: vectorStore,
            name: `${props.stackPrefix}-KnowledgeBase`,
            description:
                "Knowledge base for RAG application with S3 and web-crawled content",
            instruction:
                "Use this knowledge base to answer questions about the uploaded documents and crawled website content.",
        });

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
                    allowedOrigins: ["*"], // Will be restricted in production
                    exposedHeaders: ["ETag"],
                },
            ],
        });

        // Add S3 data source - bucket starts empty, admin will upload documents via frontend
        this.s3DataSource = new bedrock.S3DataSource(this, "S3DataSource", {
            bucket: this.knowledgeBaseBucket,
            knowledgeBase: this.knowledgeBase,
            dataSourceName: "s3-documents-source",
            chunkingStrategy: bedrock.ChunkingStrategy.HIERARCHICAL_COHERE,
        });

        // Add Web Crawler data source - uses placeholder URL initially
        // Admin will update the URLs and trigger sync via frontend
        this.webCrawlerDataSource = new bedrock.WebCrawlerDataSource(this, "WebCrawlerDataSource", {
            knowledgeBase: this.knowledgeBase,
            sourceUrls: PLACEHOLDER_URL,
            dataSourceName: "web-crawler-source",
            chunkingStrategy: bedrock.ChunkingStrategy.HIERARCHICAL_COHERE,
        });

        // Note: Sync (ingestion) jobs will be triggered by a Lambda function
        // when admin uploads documents or updates URLs via the frontend

        // Outputs
        new CfnOutput(this, "KnowledgeBaseId", {
            value: this.knowledgeBase.knowledgeBaseId,
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
            value: this.s3DataSource.dataSourceId,
            description: "The ID of the S3 data source",
        });

        new CfnOutput(this, "WebCrawlerDataSourceId", {
            value: this.webCrawlerDataSource.dataSourceId,
            description: "The ID of the Web Crawler data source",
        });

        new CfnOutput(this, "VectorCollectionArn", {
            value: vectorStore.collectionArn,
            description: "The ARN of the OpenSearch Serverless collection",
        });
    }
}
