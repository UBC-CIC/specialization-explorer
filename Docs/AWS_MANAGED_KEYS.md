# AWS Managed Keys Usage

This document lists every place in the CDK infrastructure where an AWS managed key (rather than a customer-managed KMS key) is used for encryption, and describes exactly what code changes are required if you want to bring your own key (CMK).

---

## 1. RDS Instance — `cdk/lib/database-stack.ts`

**Current behaviour**

`storageEncrypted: true` is set on the `DatabaseInstance` construct without a `storageEncryptionKey` property. AWS therefore encrypts the RDS storage volume using the AWS managed key for RDS (`aws/rds`).

```ts
// cdk/lib/database-stack.ts
this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  ...
  storageEncrypted: true, // uses aws/rds managed key
  ...
});
```

**To use a CMK**

1. Create (or import) a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const rdsKey = new kms.Key(this, "RdsEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for RDS storage encryption",
   });
   ```
2. Add the `storageEncryptionKey` property to the `DatabaseInstance` definition:
   ```ts
   this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
     ...
     storageEncrypted: true,
     storageEncryptionKey: rdsKey, // add this line
     ...
   });
   ```
3. If Performance Insights is also required to use the same CMK, add:
   ```ts
   performanceInsightEncryptionKey: rdsKey,
   ```

---

## 2. OpenSearch Serverless Collection — `cdk/lib/knowledge-base-stack.ts`

**Current behaviour**

The encryption security policy for the OpenSearch Serverless collection sets `AWSOwnedKey: true`, which means AWS encrypts the collection with an AWS-owned key that you cannot view, rotate, or audit independently.

```ts
// cdk/lib/knowledge-base-stack.ts
const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, "EncryptionPolicy", {
  name: `${collectionName}-enc`,
  type: "encryption",
  policy: JSON.stringify({
    Rules: [{ ResourceType: "collection", Resource: [`collection/${collectionName}`] }],
    AWSOwnedKey: true, // uses AWS-owned key
  }),
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const aossKey = new kms.Key(this, "AossEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for OpenSearch Serverless collection",
   });
   ```
2. Replace `AWSOwnedKey: true` with `KmsARN` pointing to your key:
   ```ts
   policy: JSON.stringify({
     Rules: [{ ResourceType: "collection", Resource: [`collection/${collectionName}`] }],
     AWSOwnedKey: false,
     KmsARN: aossKey.keyArn, // add this line, remove AWSOwnedKey: true
   }),
   ```
3. Grant the Bedrock Knowledge Base role and the vector index manager role permission to use the key:
   ```ts
   aossKey.grantEncryptDecrypt(knowledgeBaseRole);
   aossKey.grantEncryptDecrypt(vectorIndexManagerRole);
   ```

---

## 3. S3 Buckets — `cdk/lib/knowledge-base-stack.ts`

**Current behaviour**

Both `KnowledgeBaseBucket` and `KnowledgeBaseAccessLogsBucket` are created without an `encryption` or `encryptionKey` property. CDK defaults to SSE-S3 (`AES256`), which uses the AWS managed key for S3 (`aws/s3`).

```ts
// cdk/lib/knowledge-base-stack.ts
const accessLogsBucket = new s3.Bucket(this, "KnowledgeBaseAccessLogsBucket", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});

this.knowledgeBaseBucket = new s3.Bucket(this, "KnowledgeBaseBucket", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const s3Key = new kms.Key(this, "KnowledgeBaseS3Key", {
     enableKeyRotation: true,
     description: "CMK for Knowledge Base S3 buckets",
   });
   ```
2. Add `encryption` and `encryptionKey` to both bucket definitions:
   ```ts
   const accessLogsBucket = new s3.Bucket(this, "KnowledgeBaseAccessLogsBucket", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: s3Key,
   });

   this.knowledgeBaseBucket = new s3.Bucket(this, "KnowledgeBaseBucket", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: s3Key,
   });
   ```
3. Grant the Bedrock Knowledge Base role permission to use the key (in addition to the existing `grantRead`):
   ```ts
   s3Key.grantEncryptDecrypt(knowledgeBaseRole);
   ```

---

## 4. S3 Buckets — `cdk/lib/cicd-stack.ts`

**Current behaviour**

Both `PipelineArtifactBucket` and `ArtifactAccessLogs` are created without an `encryption` or `encryptionKey` property. CDK defaults to SSE-S3 (`AES256`), which uses the AWS managed key for S3 (`aws/s3`).

```ts
// cdk/lib/cicd-stack.ts
const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});

const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const pipelineKey = new kms.Key(this, "PipelineArtifactKey", {
     enableKeyRotation: true,
     description: "CMK for CodePipeline artifact buckets",
   });
   ```
2. Add `encryption` and `encryptionKey` to both bucket definitions:
   ```ts
   const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: pipelineKey,
   });

   const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: pipelineKey,
   });
   ```
3. Grant the CodeBuild role and the CodePipeline service permission to use the key:
   ```ts
   pipelineKey.grantEncryptDecrypt(codeBuildRole);
   pipelineKey.grant(new iam.ServicePrincipal("codepipeline.amazonaws.com"), "kms:GenerateDataKey", "kms:Decrypt");
   ```

---

## 5. Secrets Manager Secrets — `cdk/lib/api-stack.ts` and `cdk/lib/database-stack.ts`

**Current behaviour**

All `secretsmanager.Secret` constructs are created without an `encryptionKey` property. Secrets Manager therefore encrypts them using the AWS managed key for Secrets Manager (`aws/secretsmanager`).

The affected secrets are:

| Secret | File | Variable |
|---|---|---|
| Cognito credentials | `api-stack.ts` | `this.secret` (`${id}-SpecEx_Cognito_Secrets`) |
| JWT secret | `api-stack.ts` | `jwtSecret` (`${id}-SpecEx-JWTSecret`) |
| RDS application user credentials | `database-stack.ts` | `this.secretPathUser` |
| RDS table creator credentials | `database-stack.ts` | `this.secretPathTableCreator` |

Two more secrets use the same managed key but are not `secretsmanager.Secret` constructs:

| Secret | File | How it is created |
|---|---|---|
| RDS admin credentials (`${id}-SpecEx/credentials/rdsDbCredential`) | `database-stack.ts` | `rds.Credentials.fromUsername(...)`, which generates the secret; pass `encryptionKey` in its options |
| Knowledge base ID (`${stackPrefix}/KnowledgeBase/Id`) | `knowledge-base-stack.ts` | `EnsureKBSecret` custom resource calling `createSecret`; add `KmsKeyId` to its parameters and grant the custom resource and readers use of the key |

```ts
// Example from api-stack.ts — same pattern applies to all four secrets
this.secret = new secretsmanager.Secret(this, secretsName, {
  secretName: secretsName,
  // no encryptionKey — uses aws/secretsmanager managed key
  ...
});
```

**To use a CMK**

1. Create a KMS key (one shared key or one per secret, depending on your policy requirements):
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const secretsKey = new kms.Key(this, "SecretsEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for Secrets Manager secrets",
   });
   ```
2. Add the `encryptionKey` property to each `secretsmanager.Secret` definition:
   ```ts
   this.secret = new secretsmanager.Secret(this, secretsName, {
     secretName: secretsName,
     encryptionKey: secretsKey, // add this line
     ...
   });
   ```
   Repeat for `jwtSecret`, `this.secretPathUser`, and `this.secretPathTableCreator`.
3. Any IAM role that calls `secretsmanager:GetSecretValue` on these secrets will also need `kms:Decrypt` on the key. The CDK `grantRead` helper on a secret automatically adds the required KMS permissions when an `encryptionKey` is set, so existing `grantRead` calls do not need to change. For roles that use inline `PolicyStatement` instead of `grantRead`, add:
   ```ts
   secretsKey.grantDecrypt(lambdaRole);
   secretsKey.grantDecrypt(coglambdaRole);
   ```

---

## 6. DynamoDB Table — `cdk/lib/api-stack.ts`

**Current behaviour**

The WebSocket rate limit table (`${id}-WebSocketRateLimits`, a `dynamodb.TableV2`) has no `encryption` property, so DynamoDB encrypts it with an AWS owned key. The table holds only per-user counters that expire after two minutes.

**To use a CMK**

```ts
import * as kms from "aws-cdk-lib/aws-kms";

const tableKey = new kms.Key(this, "RateLimitTableKey", { enableKeyRotation: true });

const wsRateLimitTable = new dynamodb.TableV2(this, `${id}-WebSocketRateLimits`, {
  ...
  encryption: dynamodb.TableEncryptionV2.customerManagedKey(tableKey),
});
```

The existing `grant(...)` calls add the KMS permissions for the default route and text generation functions.

---

## 7. SQS Queues — `cdk/lib/api-stack.ts`

**Current behaviour**

The text generation failure queue and its dead-letter queue use `encryption: sqs.QueueEncryption.SQS_MANAGED` (SSE-SQS, keys owned by SQS).

**To use a CMK**

Set `encryption: sqs.QueueEncryption.KMS` and `encryptionMasterKey: queueKey` on both queues. Lambda's on-failure destination sends to the queue as the text generation function's role, so grant that role `kms:GenerateDataKey` and `kms:Decrypt` on the key, and grant the failure handler function `kms:Decrypt`.

---

## 8. AWS Backup Vault — `cdk/lib/backup-stack.ts`

**Current behaviour**

`BackupVault` is created without `encryptionKey`, so recovery points are encrypted with the AWS managed key for AWS Backup (`aws/backup`). RDS snapshots keep the encryption of the source instance.

**To use a CMK**

```ts
this.backupVault = new backup.BackupVault(this, `${id}-Vault`, {
  ...
  encryptionKey: backupKey,
});
```

The vault's key cannot be changed after it is created; a new vault is needed to switch keys.

---

## Summary

| Resource | Stack file | AWS managed key used | Property to add for CMK |
|---|---|---|---|
| RDS instance storage | `database-stack.ts` | `aws/rds` | `storageEncryptionKey` on `DatabaseInstance` |
| OpenSearch Serverless collection | `knowledge-base-stack.ts` | AWS-owned key | Replace `AWSOwnedKey: true` with `KmsARN` in the encryption policy |
| S3 knowledge base buckets (×2) | `knowledge-base-stack.ts` | `aws/s3` (SSE-S3) | `encryption: BucketEncryption.KMS` + `encryptionKey` on each `Bucket` |
| S3 pipeline artifact buckets (×2) | `cicd-stack.ts` | `aws/s3` (SSE-S3) | `encryption: BucketEncryption.KMS` + `encryptionKey` on each `Bucket` |
| Secrets Manager secrets (×6) | `api-stack.ts`, `database-stack.ts`, `knowledge-base-stack.ts` | `aws/secretsmanager` | `encryptionKey` on each `Secret` (see section 5 for the two created differently) |
| DynamoDB rate limit table | `api-stack.ts` | AWS owned key | `encryption: TableEncryptionV2.customerManagedKey(...)` |
| SQS failure queues (×2) | `api-stack.ts` | SSE-SQS | `encryption: QueueEncryption.KMS` + `encryptionMasterKey` |
| AWS Backup vault | `backup-stack.ts` | `aws/backup` | `encryptionKey` on `BackupVault` |
