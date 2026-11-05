# ECR Image Waiter Custom Resource

## Purpose

This custom resource prevents a first-deployment race condition: the container-image Lambda for the vector index manager (`vectorIndexManagerSigV4`) cannot be created until CodePipeline has built and pushed its image to ECR.

## Problem

The stacks are deployed in this order:

1. **CICD stack** creates the ECR repository and the CodePipeline that builds the image.
2. **KnowledgeBase stack** creates the `VectorIndexManagerFn` Docker image Lambda from the `latest` tag of that repository.

The stack dependency (`kbStack.addDependency(cicdStack)` in `bin/cdk.ts`) only guarantees that the repository and pipeline exist. It does not guarantee that the pipeline has run, so on a first deployment the repository is empty and the Lambda cannot be created.

## Solution

The waiter custom resource (`KBEcrImageWaiter` in `lib/knowledge-base-stack.ts`):

1. Checks the repository for the `latest` image tag.
2. If the image is missing, starts the pipeline (`TriggerBuildOnMissing: "true"` with `CodePipelineName`).
3. Checks again every 30 seconds, up to 28 times (about 14 minutes, inside the Lambda's 15-minute timeout).
4. Succeeds as soon as the image exists. `VectorIndexManagerFn` depends on the waiter, so CloudFormation creates it only after that.

If the image never appears, the custom resource fails and CloudFormation rolls back the KnowledgeBase stack.

## Architecture

```
┌──────────────────────────┐
│   CICD Stack             │
│  ECR repo                │
│  (vectorIndexManagerSigV4)│
│  CodePipeline            │
└────────────┬─────────────┘
             │ stack dependency
             ▼
┌──────────────────────────┐
│   KnowledgeBase Stack    │
│  KBEcrImageWaiter ───────┼──► starts the pipeline if the image is missing,
│        │                 │    then polls ECR
│        ▼ dependency      │
│  VectorIndexManagerFn    │
│  (Docker image Lambda)   │
└──────────────────────────┘
```

## Implementation

### Files

- `lambda/ecrImageWaiter/index.js`: custom resource handler
- `lambda/ecrImageWaiter/package.json`: dependencies (`@aws-sdk/client-ecr`, `@aws-sdk/client-codepipeline`, `@aws-sdk/client-codebuild`)
- `lib/knowledge-base-stack.ts`: creates the waiter role (`KBEcrImageWaiterRole`), function (`KBEcrImageWaiterFn`) and custom resource (`KBEcrImageWaiter`)

### Custom Resource Properties

| Property                | Type   | Handler default | Value used     | Description                                                    |
| ----------------------- | ------ | --------------- | -------------- | -------------------------------------------------------------- |
| `RepositoryName`        | String | Required        | Repository name | ECR repository to check                                       |
| `ImageTag`              | String | Required        | `latest`       | Image tag to look for                                          |
| `MaxRetries`            | String | `"60"`          | `"28"`         | Maximum number of checks                                       |
| `RetryDelaySeconds`     | String | `"30"`          | `"30"`         | Seconds between checks                                         |
| `TriggerBuildOnMissing` | String | `"false"`       | `"true"`       | Start a build when the image is missing                        |
| `CodePipelineName`      | String | none            | `<StackPrefix>-CICD-DockerImagePipeline` | Pipeline to start                    |
| `CodeBuildProjectName`  | String | none            | not set        | Used instead of the pipeline when `CodePipelineName` is unset  |

Keep `MaxRetries × RetryDelaySeconds` below the function's 15-minute timeout; a larger value would let Lambda time out before the waiter reports a result.

## Deployment Workflow

### First-Time Deployment

`npx cdk deploy --all` handles this automatically, provided the GitHub connection created by the CICD stack has been authorized (see the Deployment Guide). An unauthorized connection is the most common reason the pipeline fails and the waiter times out.

To avoid the wait, authorize the connection and click **Release change** on `<StackPrefix>-CICD-DockerImagePipeline` as soon as the CICD stack finishes.

### Subsequent Deployments

The image already exists, so the waiter succeeds on its first check.

## Monitoring

- **CloudWatch Logs**: the waiter function's log group (`/aws/lambda/<StackPrefix>-KnowledgeBase-KBEcrImageWaiterFn...`) shows each check, the retry count, and whether the pipeline was started.
- **CloudFormation events**: `KBEcrImageWaiter` stays in `CREATE_IN_PROGRESS` while it waits.

## Troubleshooting

### The KnowledgeBase stack fails after about 14 minutes

The pipeline has not pushed the image yet.

1. Open `<StackPrefix>-CICD-DockerImagePipeline` in CodePipeline and check the last execution.
2. If the Source stage failed, authorize the GitHub connection, then click **Release change**.
3. If the Build stage failed, read the CodeBuild logs. The build also fails when the image scan finds CRITICAL vulnerabilities, in which case `latest` is not moved.
4. When the image is in ECR, redeploy: `npx cdk deploy <StackPrefix>-KnowledgeBase`.

### The custom resource fails immediately

A missing image or repository is retried, so an immediate failure comes from another ECR error, usually access denied. The log shows the error. Check that the CICD stack deployed successfully and that the waiter role can read the repository.

### The image exists but the waiter still times out

Check that `KBEcrImageWaiterRole` has `ecr:DescribeImages` on the repository and `codepipeline:StartPipelineExecution` on the pipeline.
