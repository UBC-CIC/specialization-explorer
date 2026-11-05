# Dependency Management Guide

## Overview

This document explains how Python dependencies are locked and managed across Lambda functions in this project to ensure reproducible builds and security.

## Lambda Functions with Locked Dependencies

The `vectorIndexManagerSigV4` function is the only Lambda deployed as a Docker image built by CodePipeline, so exact version pinning is critical for reproducible builds.

| Lambda Function           | Location                              | Approach                      |
| ------------------------- | ------------------------------------- | ----------------------------- |
| `vectorIndexManagerSigV4` | `cdk/lambda/vectorIndexManagerSigV4/` | Locked via pip-tools (Docker) |
| `textGeneration`          | `cdk/lambda/textGeneration/`          | Not installed at deploy time: `psycopg2` and Powertools come from Lambda layers, `boto3` from the runtime. `requirements.txt` lists the packages for Dependabot and local use. |
| `knowledgeBase`, `knowledgeBaseProvisioner` | `cdk/lambda/knowledgeBase/`, `cdk/lambda/knowledgeBaseProvisioner/` | No `requirements.txt`; `boto3` comes from the runtime, and `knowledgeBase` gets `psycopg2` from the `psycopg2.zip` layer |

### Dependabot

`.github/dependabot.yml` opens weekly update pull requests for the `frontend` and `cdk` npm packages (minor and patch updates grouped), `cdk/lambda/ecrImageWaiter`, the pip requirements of `textGeneration` and `vectorIndexManagerSigV4`, and the `vectorIndexManagerSigV4` Docker base image.

Dependabot edits `requirements.txt` directly, so after merging its pull requests, regenerate the lock file from `requirements.in` (below) to keep the two consistent.

## How Dependencies Were Locked

### 1. Requirements Structure

The `vectorIndexManagerSigV4` function uses a two-file approach:

- `requirements.in` — High-level direct dependencies
- `requirements.txt` — All dependencies with exact pinned versions (generated from `requirements.in`)

### 2. Current Direct Dependencies (`requirements.in`)

```
opensearch-py>=3.2.0
requests-aws4auth>=1.4.0
boto3>=1.43.123
```

### 3. Locking Process

Dependencies are locked using pip-tools inside a locally built Docker container from the function's `Dockerfile`, so the lock matches the Lambda runtime (currently `public.ecr.aws/lambda/python:3.14`).

```bash
# Navigate to the function directory
cd cdk/lambda/vectorIndexManagerSigV4

# Build the Docker image
docker build -t vectorindexmanager-img .

# Run pip-compile inside the container to generate requirements.txt
docker run --rm -v ${PWD}:/app -w /app --entrypoint="" vectorindexmanager-img bash -c "
  pip install pip-tools &&
  pip-compile requirements.in
"
```

### 4. Key Locked Dependencies

The current `requirements.txt` pins the following. Its header says it was generated with Python 3.12, while the Dockerfile now uses Python 3.14 (updated by Dependabot), so regenerate it with the steps below at the next dependency change.

| Package | Pinned Version | Purpose |
|---|---|---|
| `opensearch-py` | 3.2.0 | OpenSearch Serverless client |
| `requests-aws4auth` | 1.4.0 | SigV4 request signing for AOSS |
| `boto3` | 1.43.123 | AWS SDK |
| `botocore` | 1.43.123 | AWS SDK core |
| `requests` | 2.33.1 | HTTP client (transitive) |
| `certifi` | 2026.10.18 | TLS certificates (transitive) |
| `urllib3` | 2.8.0 | HTTP library (transitive) |
| `opensearch-protobufs`, `grpcio`, `protobuf` | 1.2.0, 1.85.0, 7.36.2 | Pulled in by `opensearch-py` 3.x (transitive) |

## How to Modify Dependencies

### Adding New Dependencies

1. **Add to `requirements.in`:**

   ```
   # Example: add a new package
   some-package>=1.0.0
   ```

2. **Open Docker Desktop** and keep it running.

3. **Build the Docker image:**

   ```bash
   cd cdk/lambda/vectorIndexManagerSigV4
   docker build -t vectorindexmanager-img .
   ```

4. **Regenerate `requirements.txt`:**

   ```bash
   docker run --rm -v ${PWD}:/app -w /app --entrypoint="" vectorindexmanager-img bash -c "
     pip install pip-tools &&
     pip-compile requirements.in
   "
   ```

5. **Commit and push the changes:**

   **Option 1: Terminal**

   ```bash
   git add requirements.in requirements.txt
   git commit -m "Add new dependency to vectorIndexManagerSigV4"
   git push origin <branch-name>
   ```

   **Option 2: VS Code Source Control**

   1. Go to the Source Control tab.
   2. Stage `requirements.in` and `requirements.txt`.
   3. Write a commit message and click ✓ Commit.
   4. Click Push.

Once pushed to the branch the pipeline watches (`githubBranch`, default `main`), CodePipeline builds the image if the commit changed files under `cdk/lambda/vectorIndexManagerSigV4/`, blocks it if the ECR scan finds CRITICAL vulnerabilities, and otherwise updates the Lambda, publishes a version and moves the `live` alias to it. The build log prints the command that moves the alias back to the previous version.

### Updating Existing Dependencies

1. **Update the version constraint in `requirements.in`:**

   ```
   # Change from:
   opensearch-py>=3.2.0
   # To:
   opensearch-py>=3.3.0
   ```

2. **Open Docker Desktop.**

3. **Build the Docker image:**

   ```bash
   cd cdk/lambda/vectorIndexManagerSigV4
   docker build -t vectorindexmanager-img .
   ```

4. **Regenerate `requirements.txt`:**

   ```bash
   docker run --rm -v ${PWD}:/app -w /app --entrypoint="" vectorindexmanager-img bash -c "
     pip install pip-tools &&
     pip-compile requirements.in
   "
   ```

5. **Commit and push** the updated `requirements.in` and `requirements.txt` to trigger the CI/CD pipeline.


