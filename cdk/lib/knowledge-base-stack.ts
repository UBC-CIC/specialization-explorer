import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
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

// Hardcoded small, multiple source URLs for web crawler just to test the data out
const SOURCE_URLS = ["https://sheeerio.github.io/", "https://www.cs.ubc.ca/~wolf/"];

export interface KnowledgeBaseStackProps extends StackProps {
    stackPrefix: string;
}

export class KnowledgeBaseStack extends Stack {
    public readonly knowledgeBase: bedrock.VectorKnowledgeBase;

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
            name: `${props.stackPrefix}-WebCrawlerKB`,
            description:
                "Knowledge base containing web-crawled content for AI-powered responses",
            instruction:
                "Use this knowledge base to answer questions about the crawled website content. " +
                "It contains information scraped from the source URLs.",
        });

        // Add Web Crawler data source
        new bedrock.WebCrawlerDataSource(this, "WebCrawlerDataSource", {
            knowledgeBase: this.knowledgeBase,
            sourceUrls: SOURCE_URLS,
            dataSourceName: "web-crawler-source",
            chunkingStrategy: bedrock.ChunkingStrategy.HIERARCHICAL_COHERE,
        });

        // Outputs
        new CfnOutput(this, "KnowledgeBaseId", {
            value: this.knowledgeBase.knowledgeBaseId,
            description: "The ID of the Bedrock Knowledge Base",
        });

        new CfnOutput(this, "VectorCollectionArn", {
            value: vectorStore.collectionArn,
            description: "The ARN of the OpenSearch Serverless collection",
        });
    }
}
