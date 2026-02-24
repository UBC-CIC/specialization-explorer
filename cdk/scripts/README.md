# Manual Index Creation for Bedrock Knowledge Base

This directory contains a script to manually create the OpenSearch Serverless vector index required by the Bedrock Knowledge Base.

## Why Manual Creation?

The `@cdklabs/generative-ai-cdk-constructs` library requires Docker for bundling Lambda functions, which we want to avoid. Creating the index manually is a one-time operation that eliminates this dependency.

## Steps

### 1. Deploy the CDK Stack

First, deploy the Knowledge Base stack (it will fail on the Knowledge Base resource, which is expected):

```bash
cd cdk
npm run deploy
```

The stack will create:
- OpenSearch Serverless collection
- Encryption, network, and data access policies
- S3 bucket for documents
- IAM roles

### 2. Create the Vector Index

After deployment, check the CloudFormation outputs for the collection endpoint, then run:

```bash
python scripts/create-index.py <collection-endpoint> <region>
```

Example:
```bash
python scripts/create-index.py https://abc123xyz.ca-central-1.aoss.amazonaws.com ca-central-1
```

The script will:
- Create the index `bedrock-knowledge-base-default-index`
- Configure it with the correct vector field mappings for Bedrock
- Use your AWS credentials to authenticate

### 3. Re-deploy the Stack

After the index is created, deploy the stack again:

```bash
npm run deploy
```

This time, the Knowledge Base resource will succeed because the index already exists.

## Troubleshooting

### Authentication Errors

Make sure your AWS credentials are configured:
```bash
aws configure
# or
export AWS_PROFILE=your-profile
```

### Index Already Exists

If you see "index already exists", that's fine! The script will report success.

### 403 Forbidden

If you get 403 errors, you may need to temporarily add your IAM user/role to the data access policy in the AWS console:

1. Go to OpenSearch Service > Collections
2. Find your collection
3. Go to Data access control
4. Add your IAM principal with index permissions

After creating the index, you can remove yourself from the policy.

## Index Configuration

The script creates an index with:
- **Name**: `bedrock-knowledge-base-default-index`
- **Vector field**: `bedrock-knowledge-base-default-vector` (1024 dimensions for Titan Embed V2)
- **Text field**: `AMAZON_BEDROCK_TEXT_CHUNK`
- **Metadata field**: `AMAZON_BEDROCK_METADATA`
- **Engine**: FAISS with HNSW algorithm
