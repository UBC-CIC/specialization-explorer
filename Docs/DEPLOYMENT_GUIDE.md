# Deployment Guide

## Table of Contents

- [Deployment Guide](#deployment-guide)
- [Table of Contents](#table-of-contents)
- [Requirements](#requirements)
  - [Request Higher Bedrock LLM Invocation Quotas](#request-higher-bedrock-llm-invocation-quotas)
- [Pre-Deployment](#pre-deployment)
  - [Create GitHub Personal Access Token](#create-github-personal-access-token)
- [Deployment](#deployment)
  - [Step 1: Fork \& Clone The Repository](#step-1-fork--clone-the-repository)
  - [Step 2: Upload Secrets \& Parameters](#step-2-upload-secrets--parameters)
  - [Step 3: CDK Deployment](#step-3-cdk-deployment)
- [Post-Deployment](#post-deployment)
  - [Step 1: Build AWS Amplify App](#step-1-build-aws-amplify-app)
  - [Step 2: Configure Admin User](#step-2-configure-admin-user)
  - [Step 3: Visit Web App](#step-3-visit-web-app)
  - [Step 4: Add Data to the Knowledge Base](#step-4-add-data-to-the-knowledge-base)
- [Troubleshooting](#troubleshooting)
  - [Common Issues](#common-issues)
- [Cleanup](#cleanup)
  - [Taking down the deployed stack](#taking-down-the-deployed-stack)

## Requirements

Before you deploy, you must have the following installed on your device:

- [git](https://git-scm.com/downloads)
- [AWS Account](https://aws.amazon.com/account/)
- [GitHub Account](https://github.com/)
- [AWS CLI](https://aws.amazon.com/cli/) _(v2.0.0+ required)_
- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) _(v2.1022.0+ required)_
- [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) _(v10.0.0+ required)_
- [node](https://nodejs.org/en/learn/getting-started/how-to-install-nodejs) _(v22.7.9+ required)_
- [Python](https://www.python.org/downloads/) _(v3.12+ required)_

### Request Higher Bedrock LLM Invocation Quotas

For optimal performance, it is recommended to request higher invocation quotas for Bedrock LLM models before deployment. The default quotas may be insufficient for processing concurrent requests or high-volume usage.

For detailed information about Bedrock service quotas, see the [AWS Bedrock Service Quotas documentation](https://docs.aws.amazon.com/general/latest/gr/bedrock.html#limits_bedrock).

To request quota increases:

1. Navigate to the **AWS Service Quotas** console in your AWS account
2. Search for "Bedrock" in the service quotas
3. Select the relevant LLM models you plan to use:
   - Anthropic Claude Haiku 5.5 (`us.anthropic.claude-haiku-5-5`)
   - Anthropic Claude Sonnet 5.5 (`us.anthropic.claude-sonnet-5-5`)
   - Cohere Embed V3
4. Request quota increases for "Requests per minute" based on your expected usage
5. Submit the quota increase request and wait for AWS approval (this can take 24-48 hours)

_Note: Consider your expected concurrent users and document processing volume when requesting quota increases. Higher quotas ensure smoother operations without throttling._

## Pre-Deployment

### Create GitHub Personal Access Token

To deploy this solution, you will need to generate a GitHub personal access token. Please visit [here](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) for detailed instruction to create a personal access token.

_Note: Make sure to give access to only the SpecEx repository. Enable Read-only for Contents, and Metadata. For webhooks and Commit statuses enable read and write permissions._

**Once you create a token, please note down its value as you will use it later in the deployment process.**

## Deployment

### Step 1: Fork & Clone The Repository

First, you need to fork the repository. To create a fork, navigate to the main branch of this repository. Then, in the top-right corner, click `Fork`.

You will be directed to the page where you can customize owner, repository name, etc, but you do not have to change any option. Simply click `Create fork` in the bottom right corner.

Now let's clone the GitHub repository onto your machine. To do this:

1. Create a folder on your computer to contain the project code.
2. For an Apple computer, open Terminal. If on a Windows machine, open Command Prompt or Windows Terminal. Enter into the folder you made using the command `cd path/to/folder`. To find the path to a folder on a Mac, right click on the folder and press `Get Info`, then select the whole text found under `Where:` and copy with ⌘C. On Windows (not WSL), enter into the folder on File Explorer and click on the path box (located to the left of the search bar), then copy the whole text that shows up.
3. Clone the GitHub repository by entering the following command. Be sure to replace `<YOUR-GITHUB-USERNAME>` with your own username.

```bash
git clone https://github.com/<YOUR-GITHUB-USERNAME>/specialization-explorer.git
```

The code should now be in the folder you created. Navigate into the root folder containing the entire codebase by running the command:

```bash
cd specialization-explorer
```

#### Install Dependencies

Go into the cdk folder which can be done with the following command:

```bash
cd cdk
```

Now that you are in the cdk directory, install the core dependencies with the following command:

```bash
npm install
```

Go into the frontend folder which can be done with the following command:

```bash
cd ../frontend
```

Now that you are in the frontend directory, install the core dependencies with the following command:

```bash
npm install
```

### Step 2: Upload Secrets & Parameters

You would have to supply your GitHub personal access token you created earlier when deploying the solution. Run the following command and ensure you replace `<YOUR-GITHUB-TOKEN>` and `<YOUR-PROFILE-NAME>` with your actual GitHub token and the appropriate AWS profile name.

<details>
<summary>macOS/Linux</summary>

```bash
aws secretsmanager create-secret \
  --name github-personal-access-token \
  --secret-string '{"my-github-token": "<YOUR-GITHUB-TOKEN>"}' \
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws secretsmanager create-secret ^
  --name github-personal-access-token ^
  --secret-string "{\"my-github-token\": \"<YOUR-GITHUB-TOKEN>\"}" ^
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws secretsmanager create-secret `
  --name github-personal-access-token `
  --secret-string '{\"my-github-token\": \"<YOUR-GITHUB-TOKEN>\"}' `
  --profile <YOUR-PROFILE-NAME>
```

</details>

&nbsp;

You will need to upload your GitHub username to Amazon SSM Parameter Store. Replace `<YOUR-GITHUB-USERNAME>` and `<YOUR-PROFILE-NAME>` accordingly.

<details>
<summary>macOS/Linux</summary>

```bash
aws ssm put-parameter \
  --name "specEx-owner-name" \
  --value "<YOUR-GITHUB-USERNAME>" \
  --type String \
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws ssm put-parameter ^
  --name "specEx-owner-name" ^
  --value "<YOUR-GITHUB-USERNAME>" ^
  --type String ^
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws ssm put-parameter `
  --name "specEx-owner-name" `
  --value "<YOUR-GITHUB-USERNAME>" `
  --type String `
  --profile <YOUR-PROFILE-NAME>
```

</details>

&nbsp;

You would have to supply a custom database username when deploying the solution to increase security. Run the following command and ensure you replace `<YOUR-DB-USERNAME>` with the custom name of your choice.

<details>
<summary>macOS/Linux</summary>

```bash
aws secretsmanager create-secret \
  --name SpecExSecrets \
  --secret-string "{\"DB_Username\":\"<YOUR-DB-USERNAME>\"}" \
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws secretsmanager create-secret ^
  --name SpecExSecrets ^
  --secret-string "{\"DB_Username\":\"<YOUR-DB-USERNAME>\"}" ^
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws secretsmanager create-secret `
  --name SpecExSecrets `
  --secret-string '{\"DB_Username\": \"<YOUR-DB-USERNAME>\"}' `
  --profile <YOUR-PROFILE-NAME>
```

</details>

&nbsp;

For example:

```bash
aws secretsmanager create-secret \
  --name SpecExSecrets \
  --secret-string '{"DB_Username":"SpecExDatabaseUser"}' \
  --profile <YOUR-PROFILE-NAME>
```

In order to restrict user sign up to specific email domains, upload a comma-separated list of allowed email domains to Amazon SSM Parameter Store. Replace `<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>` and `<YOUR-PROFILE-NAME>` accordingly.

<details>
<summary>macOS/Linux</summary>

```bash
aws ssm put-parameter \
    --name "/SpecEx/AllowedEmailDomains" \
    --value "<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>" \
    --type SecureString \
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws ssm put-parameter ^
    --name "/SpecEx/AllowedEmailDomains" ^
    --value "<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>" ^
    --type SecureString ^
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws ssm put-parameter `
    --name "/SpecEx/AllowedEmailDomains" `
    --value "<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>" `
    --type SecureString `
    --profile <YOUR-PROFILE-NAME>
```

</details>

&nbsp;

For example:

```bash
aws ssm put-parameter \
    --name "/SpecEx/AllowedEmailDomains" \
    --value "gmail.com,ubc.ca,student.ubc.ca" \
    --type SecureString \
    --profile <YOUR-PROFILE-NAME>
```

Self sign-up is disabled, so administrator accounts are created in the Cognito console after deployment (see [Step 2: Configure Admin User](#step-2-configure-admin-user)). The administrator's email domain must be in this allow-list.

The application uses two Claude models for text generation, referenced via SSM parameters. You must create both parameters before deploying.

**Haiku model** (used for lightweight/fast responses):

<details>
<summary>macOS/Linux</summary>

```bash
aws ssm put-parameter \
    --name "/SpecEx/LLM/HaikuArn" \
    --value "us.anthropic.claude-haiku-5-5" \
    --type String \
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws ssm put-parameter ^
    --name "/SpecEx/LLM/HaikuArn" ^
    --value "us.anthropic.claude-haiku-5-5" ^
    --type String ^
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws ssm put-parameter `
    --name "/SpecEx/LLM/HaikuArn" `
    --value "us.anthropic.claude-haiku-5-5" `
    --type String `
    --profile <YOUR-PROFILE-NAME>
```

</details>

&nbsp;

**Sonnet model** (used for higher-quality responses):

<details>
<summary>macOS/Linux</summary>

```bash
aws ssm put-parameter \
    --name "/SpecEx/LLM/SonnetArn" \
    --value "us.anthropic.claude-sonnet-5-5" \
    --type String \
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws ssm put-parameter ^
    --name "/SpecEx/LLM/SonnetArn" ^
    --value "us.anthropic.claude-sonnet-5-5" ^
    --type String ^
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws ssm put-parameter `
    --name "/SpecEx/LLM/SonnetArn" `
    --value "us.anthropic.claude-sonnet-5-5" `
    --type String `
    --profile <YOUR-PROFILE-NAME>
```

</details>

&nbsp;





### Step 3: CDK Deployment

It's time to set up everything that goes on behind the scenes! For more information on how the backend works, feel free to refer to the Architecture documentation, but an understanding of the backend is not necessary for deployment.

If you are new to CDK, note that the AWS Cloud Development Kit (CDK) lets you define cloud infrastructure using code. Review the [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/) for a quick primer before proceeding.

Note: Guardrails (Bedrock) are created as part of the CDK deployment. For operational guidance and advanced customization of guardrails and Bedrock configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

Open a terminal in the `/cdk` directory.

#### CDK Deployment with an Existing VPC (Optional)

The following instructions are only relevant if you want to deploy this application using an **existing VPC** (e.g., an AWS Control Tower-managed VPC). If you are deploying with a new VPC, skip this section and proceed to [Initialize the CDK stack](#initialize-the-cdk-stack).

To use an existing VPC, you will need access to the **aws-controltower-VPC** and the name of your **AWSControlTowerStackSet**.

##### Step-by-Step Instructions

**1. Set your existing VPC ID**

Open `cdk/lib/vpc-stack.ts` and set the `existingVpcId` variable to your existing VPC ID:

```typescript
const existingVpcId: string = "your-vpc-id"; // CHANGE IF DEPLOYING WITH EXISTING VPC
```

You can find your VPC ID in the **VPC dashboard** of the AWS Console under **Your VPCs**.

![VPC ID](media/ExistingVPCId.png)

**2. Set your AWS Control Tower Stack Set name**

In the same file, update the `AWSControlTowerStackSet` variable with your stack set name:

```typescript
const AWSControlTowerStackSet = "your-stackset-name"; // CHANGE TO YOUR CONTROL TOWER STACK SET
```

You can find this in the **CloudFormation** console under **Stacks**. Look for a stack whose name starts with `StackSet-AWSControlTowerBP-VPC-ACCOUNT-FACTORY`.

![AWS Control Tower Stack Set](media/AWSControlTowerStack.png)

The stack set name is used to import the private subnet IDs, route table IDs, and subnet CIDR ranges via CloudFormation exports — so it must match exactly.

---

##### Second Deployment in the Same Environment with an Existing VPC

The following instructions only apply if this is the **second project** you are deploying into the same existing VPC. If this is your first deployment, skip this section.

When deploying a second project into the same VPC, a new public subnet is created for the NAT Gateway. You need to provide an available **Public Subnet ID** from the first deployment and an unused **CIDR range** within the VPC.

**1. Set the existing public subnet ID**

Update the `existingPublicSubnetID` variable in `cdk/lib/vpc-stack.ts`:

```typescript
const existingPublicSubnetID: string = "your-public-subnet-id"; // CHANGE IF DEPLOYING WITH EXISTING PUBLIC SUBNET
```

To find the public subnet ID:
- Go to **VPC → Subnets** in the AWS Console
- Identify the public subnet from your first deployment (it will have a route table entry pointing to an Internet Gateway)
- Copy its **Subnet ID**

**2. Update the public subnet CIDR range**

The `publicSubnetCidr` variable defines the CIDR block for the new public subnet. It must not overlap with any existing subnets in the VPC:

```typescript
const publicSubnetCidr = "172.31.0.0/20"; // Must not overlap with private subnets
```

To find an available CIDR block:
- Go to **VPC → Subnets** and note the CIDR blocks of all existing subnets in your VPC
- The third octet of a `/20` block must be a **multiple of 16** within the VPC range (e.g., `172.31.0.0/20`, `172.31.16.0/20`, `172.31.32.0/20`, etc.)
- Pick the first unused block

For example, if existing subnets use `172.31.0.0/20` and `172.31.16.0/20`, use `172.31.32.0/20` as your next available range.

---

#### Initialize the CDK stack

Run the CDK commands below from the `cdk` folder after `npm ci`. They use `npx cdk` so the CLI version always matches the project's `aws-cdk-lib`.

**Initialize the CDK stack** (required only if you have not deployed any resources with CDK in this region before). Please replace `<YOUR-PROFILE-NAME>` with the appropriate AWS profile used earlier.

```bash
npx cdk synth \
  --profile <YOUR-PROFILE-NAME> \
  --context githubRepo=specialization-explorer

npx cdk bootstrap \
  aws://<YOUR_AWS_ACCOUNT_ID>/<YOUR_ACCOUNT_REGION> \
  --profile <YOUR-PROFILE-NAME> \
  --context githubRepo=specialization-explorer
```

**Deploy CDK stack**

You may run the following command to deploy the stacks all at once. Again, replace `<YOUR-PROFILE-NAME>` with the appropriate AWS profile used earlier. Also replace `<YOUR-STACK-PREFIX>` with the appropriate stack prefix.

The stack prefix will be prefixed onto the physical names of the resources created during deployment. The `environment` parameter specifies the deployment environment (dev, test, prod), the `version` parameter indicates the application version being deployed, and the `githubRepo` parameter should match your forked repository name.

```bash
npx cdk deploy --all \
  --context StackPrefix=<YOUR-STACK-PREFIX> \
  --context environment=dev \
  --context version=1.0.0 \
  --context githubRepo=specialization-explorer \
  --profile <YOUR-PROFILE-NAME>
```

For example:

```bash
npx cdk deploy --all \
  --context StackPrefix=<YOUR-STACK-PREFIX> \
  --context environment=dev \
  --context version=1.0.0 \
  --context githubRepo=specialization-explorer \
  --profile my-aws-profile
```

**Note:** The deployment process may take 15-30 minutes to complete. You will be prompted to approve IAM changes and security group modifications during deployment.

#### Stacks Deployed

The CDK deployment creates the following stacks in dependency order:

| Stack | Description |
|---|---|
| `<PREFIX>-VpcStack` | VPC, subnets, security groups, and VPC endpoints |
| `<PREFIX>-Database` | RDS PostgreSQL instance and RDS Proxy |
| `<PREFIX>-DBFlow` | Database migration Lambda and schema setup |
| `<PREFIX>-CICD` | CodePipeline and ECR repositories for Docker image builds |
| `<PREFIX>-KnowledgeBase` | Amazon Bedrock Knowledge Base, OpenSearch Serverless collection, and S3 data source bucket |
| `<PREFIX>-Api` | API Gateway (REST + WebSocket), all Lambda functions, and Cognito User Pool |
| `<PREFIX>-Amplify` | AWS Amplify app connected to your GitHub repository |

### Authorize the GitHub Connection (Required After First Deploy)

The CICD stack creates a GitHub connection via AWS CodeConnections to allow CodePipeline to pull source code. This connection must be **manually authorized** in the AWS Console before the pipeline can run — it will remain in a `PENDING` state until you do this.

1. After CDK deployment completes, go to **AWS Console → Developer Tools → Settings → Connections** (or search "CodeConnections").
2. Find the connection named `<STACK-PREFIX>-CICD-github-conn` with status `Pending`.
3. Click on it, then click **Update pending connection**.
4. Follow the prompts to authorize access to your GitHub account and the `specialization-explorer` repository.
5. Once authorized, the connection status will change to `Available`.

_Note: The CDK output `GitHubConnectionArn` shows the ARN of this connection for reference._

### CodePipeline & ECR Image Bootstrapping (First-Time Deployment)

The CICD stack builds and pushes the Docker image for the `vectorIndexManagerSigV4` Lambda to ECR via CodePipeline. The KnowledgeBase stack depends on this image being present before it can create the vector index manager Lambda.

**How it works automatically:**

The KnowledgeBase stack includes an `ecrImageWaiter` custom resource that:
1. Checks ECR for the `latest` image tag on the `vectorIndexManagerSigV4` repository.
2. If the image is not found, it **automatically triggers the CodePipeline** to start a build.
3. It then polls ECR every 30 seconds for up to ~14 minutes waiting for the image to appear.
4. Once the image is available, the KnowledgeBase stack deployment continues.

This means in most cases you do not need to manually trigger the pipeline — it is triggered automatically during deployment. However, the GitHub connection **must be authorized** (see above) before the pipeline can successfully pull source code and build the image.

**If the KnowledgeBase stack times out waiting for the image:**

1. Go to **AWS Console → CodePipeline** → select `<STACK-PREFIX>-CICD-DockerImagePipeline`.
2. Check if the pipeline failed — a common cause is the GitHub connection not being authorized yet.
3. Authorize the connection (see above), then click **Release change** to re-run the pipeline.
4. Once the pipeline completes and the image is in ECR, redeploy: `npx cdk deploy <STACK-PREFIX>-KnowledgeBase --profile <YOUR-PROFILE-NAME>`.

**Notes:**

- Verify the ECR repository names and tags in the AWS Console or CDK outputs to ensure they match the expected values.
- After the pipeline successfully completes and the images are pushed, the KnowledgeBase stack should deploy successfully.

**Troubleshooting:**

- Check the CodePipeline and CodeBuild logs for any errors during the build process.
- Verify that the required images and tags are present in ECR.
- Ensure that the IAM roles for CodePipeline and CodeBuild have the necessary permissions to push images to ECR.

> **Tip:** The KnowledgeBase stack waits for a Docker image to exist in ECR before it can complete. To avoid a long wait, authorize the GitHub connection and trigger the pipeline **as soon as the CICD stack finishes** — before the KnowledgeBase stack starts deploying. This is only required for the first deployment; subsequent deploys will automatically trigger a new build if the relevant source code has changed.
>
> **1. Authorize the GitHub connection (first deployment only):**
> - Follow the same steps as above to authorize the connection.
>
> **2. Trigger the CodePipeline build:**
> - Go to AWS Console → **CodePipeline**
> - Find `<PREFIX>-CICD-DockerImagePipeline`
> - Click **Release change** to start the pipeline manually
> - This kicks off CodeBuild, which builds and pushes the Docker image to ECR
>
> Once the image is in ECR, the KnowledgeBase stack will detect it and continue deploying without waiting.

---



## Post-Deployment

### Step 1: Build AWS Amplify App

1. Log in to AWS console, and navigate to **AWS Amplify**. You can do so by typing `Amplify` in the search bar at the top.
2. From `All apps`, click `<STACK-PREFIX>-amplify`.
3. You will see multiple branches listed (`main`, `dev`, `api_endpoint_setup`). Click on the branch that corresponds to your GitHub repository's default branch (typically `main`).
4. Click `Redeploy this version` to trigger a build
5. Wait for the build to complete (this may take 5-10 minutes)
6. You now have access to the `Amplify App ID` and the public domain name to use the web app.

> [!NOTE]
> If the build fails with the following IAM role error:
>
> `Unable to assume specified IAM Role. Please ensure the selected IAM Role has sufficient permissions and the Trust Relationship is configured correctly.`
>
> 1. In the Amplify app, go to **App settings**.
> 2. Click **Branch settings**.
> 3. Click **Reconnect repository** and complete the GitHub authorization.
> 4. Return to the branch and click `Redeploy this version` again.

### Step 2: Configure Admin User

To create an admin user for accessing the admin dashboard:

1. Navigate to **AWS Cognito** in the AWS Console
2. Find the User Pool named `<STACK-PREFIX>-UserPool`
3. Click on "Users" in the left sidebar
4. Click "Create user"
5. Fill in the required information:
   - Username: your email address
   - Email: same as username
   - Temporary password: create a secure password
6. Click "Don't send an email invitation"
7. Click "Create user"
8. After creation, select the user and click "Add user to group"
9. Select the "admin" group
10. Open the web app and add `/admin/login` to the end of the URL, then sign in with the email and temporary password. You'll be prompted to set a new password on first login.
11. Set up an authenticator app (for example Microsoft Authenticator, Google Authenticator or 1Password). The login page shows a setup key, and a link that opens the app on a phone. Enter the 6-digit code from the app to finish signing in.

MFA is required: every later sign-in asks for a code from the authenticator app. If an administrator loses their authenticator app, an AWS administrator can reset it by running `aws cognito-idp admin-set-user-mfa-preference --user-pool-id <POOL-ID> --username <EMAIL> --software-token-mfa-settings Enabled=false,PreferredMfa=false`; the administrator then enrolls a new app at their next sign-in.

The user pool uses the Cognito Plus feature plan for threat protection in full-function mode. Sign-ins with passwords found in known credential leaks are blocked, and high-risk sign-ins are blocked. The admin login uses SRP, so the password is not sent to Cognito. The Plus plan is billed per monthly active user; see [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/).

After the first sign-in, the mode dropdown appears in the top right of the header, so the administrator can switch between the student and administrator views. Further administrators are created the same way.

### Step 3: Visit Web App

You can now navigate to the web app URL (found in the Amplify console) to see your application in action.

**Default URL format:** `https://main.<app-id>.amplifyapp.com`

### Step 4: Add Data to the Knowledge Base

A freshly deployed knowledge base is empty, so the chatbot has nothing to answer from until an administrator adds data. Sign in as an administrator and use the dashboard to add data sources, then sync them:

- [Adding a Website](./USER_GUIDE.md#adding-a-website): stage a website for crawling, with optional include/exclude URL patterns.
- [Adding a File](./USER_GUIDE.md#adding-a-file): upload a CSV/Markdown file and its metadata JSON.
- [Syncing Data Sources](./USER_GUIDE.md#syncing-data-sources): start an ingestion job so staged sources become searchable.

See the [Knowledge Base Documentation](./KNOWLEDGE_BASE_DOCUMENTATION.md) for how ingestion works under the hood.

### Adding Custom Allowed Origins

The application stores allowed CORS origins in an SSM parameter (`/<STACK-PREFIX>-Api/API/AllowedOrigins`). The Amplify URL is added automatically during deployment. If you need to allow additional origins (e.g., a custom domain or localhost for development), update the parameter manually:

<details>
<summary>macOS/Linux</summary>

```bash
# First, read the current value
aws ssm get-parameter \
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" \
  --profile <YOUR-PROFILE-NAME> \
  --query Parameter.Value --output text

# Then update with the new origin appended (comma-separated, no trailing slashes)
aws ssm put-parameter \
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" \
  --value "https://main.abc123.amplifyapp.com,https://your-custom-domain.com" \
  --type String \
  --overwrite \
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
# First, read the current value
aws ssm get-parameter `
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" `
  --profile <YOUR-PROFILE-NAME> `
  --query Parameter.Value --output text

# Then update with the new origin appended (comma-separated, no trailing slashes)
aws ssm put-parameter `
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" `
  --value "https://main.abc123.amplifyapp.com,https://your-custom-domain.com" `
  --type String `
  --overwrite `
  --profile <YOUR-PROFILE-NAME>
```

</details>

&nbsp;

_Note: Always read the current value first and append your new origin to avoid removing existing ones. Origins should not have trailing slashes. Subsequent CDK deployments will not duplicate existing origins._

## Troubleshooting

### Common Issues

**Issue: CDK deployment fails with "Resource already exists"**

- Solution: Check if you have existing resources with the same names. Either delete them or use a different stack prefix.

**Issue: CloudFormation validation error during ResourceExistenceCheck referencing DataPipeline or CICD ARNs**

- Symptoms: CloudFormation throws a validation error during the change set or deployment phase, related to a `ResourceExistenceCheck` for an ARN that appears to reference the `DataPipeline` or `CICD` resources.
- Solution: This commonly occurs on first-time deployments when the pipeline and ECR resources are created by the deployment but are referenced in IAM policy statements before they exist. Authorize the GitHub connection and follow the [CodePipeline & ECR Image Bootstrapping](#codepipeline--ecr-image-bootstrapping-first-time-deployment) steps to manually trigger the pipeline build and redeploy.

**Issue: Amplify build fails**

- Solution: Check the build logs in Amplify console. Common causes:
  - Missing environment variables
  - Node version mismatch
  - Dependency installation failures

**Issue: Database connection errors**

- Solution: Verify that:
  - RDS instance is running
  - Security groups allow Lambda to access RDS
  - Database credentials are correct in Secrets Manager

**Issue: CORS errors in browser**

- Solution: Verify that the API Gateway CORS configuration includes your Amplify domain

**Issue: WebSocket connection fails**

- Solution: Check that:
  - WebSocket API is deployed
  - Lambda functions have correct permissions
  - Frontend is using the correct WebSocket URL

**Issue: Text generation Lambda fails with parameter not found error**

- Solution: Ensure the `/SpecEx/LLM/HaikuArn` and `/SpecEx/LLM/SonnetArn` SSM parameters were created before deployment. See [Step 2: Upload Secrets & Parameters](#step-2-upload-secrets--parameters).

**Issue: Knowledge Base ingestion fails or returns no results**

- Solution:
  - Verify the `<PREFIX>-KnowledgeBase` stack deployed successfully in CloudFormation.
  - Check that the S3 bucket for the knowledge base exists and contains your source documents.
  - The web crawler data source is created with a `.*` exclusion filter by default — nothing is crawled until you add real URLs via the admin dashboard.
  - Trigger a manual ingestion job from the Bedrock console under Knowledge Bases.

## Cleanup

### Taking down the deployed stack

To take down the deployed stack for a fresh redeployment in the future, follow these steps in order:

1. **Disable RDS Deletion Protection:**
   - Navigate to **Amazon RDS** in the AWS Console
   - Click on "Databases" in the left sidebar
   - Select the database instance named `<STACK-PREFIX>-database`
   - Click "Modify"
   - Scroll down to "Deletion protection" and uncheck the box
   - Click "Continue" and then "Modify DB instance"
   - Wait for the modification to complete before proceeding

2. **Disable Cognito Deletion Protection** (only if you want to delete the user pool in step 8):
   - Navigate to **Amazon Cognito** → User pools → `<STACK-PREFIX>-UserPool`
   - Open the **Settings** tab, edit **Deletion protection**, and turn it off

3. **Delete CloudFormation Stacks:**
   Navigate to AWS CloudFormation console and delete stacks in this order:
   - `<STACK-PREFIX>-Backup`
   - `<STACK-PREFIX>-Amplify`
   - `<STACK-PREFIX>-CICD`
   - `<STACK-PREFIX>-Api`
   - `<STACK-PREFIX>-KnowledgeBase`
   - `<STACK-PREFIX>-DBFlow`
   - `<STACK-PREFIX>-Database`
   - `<STACK-PREFIX>-VpcStack`

4. **Delete Secrets:**
   - Navigate to AWS Secrets Manager
   - Delete the following secrets:
     - `github-personal-access-token`
     - `SpecExSecrets`
     - Any database credentials created by the stack

5. **Delete SSM Parameters:**
   - Navigate to AWS Systems Manager → Parameter Store
   - Delete the following parameters:
     - `specEx-owner-name`
     - `/SpecEx/AllowedEmailDomains`
     - `/SpecEx/LLM/HaikuArn`
     - `/SpecEx/LLM/SonnetArn`
     - `/SpecEx/API/AllowedOrigins`

6. **Delete ECR Repositories** (if any were created):
   - Navigate to Amazon ECR
   - Delete repositories created by the stack (e.g. `<STACK-PREFIX>-vectorindexmanagersigv4`)

7. **Delete Knowledge Base Resources** (if not removed by CloudFormation):
   - Navigate to **Amazon Bedrock** → Knowledge Bases
   - Delete the knowledge base created by the stack
   - Navigate to **Amazon OpenSearch Serverless** → Collections
   - Delete the collection created by the stack

8. **Delete Retained Data** (only if the data is no longer needed; this cannot be undone):
   Stack deletion keeps these resources so users, chats and documents survive an accidental delete:
   - **Cognito:** the `<STACK-PREFIX>-UserPool` user pool (turn off deletion protection first, step 2)
   - **S3:** the bucket whose name starts with the first six characters of the stack prefix in lowercase, followed by `-kb-documents` (empty all object versions, then delete it)
   - **RDS:** the final snapshot and retained automated backups under **Snapshots** and **Automated backups → Retained**
   - **AWS Backup:** the recovery points in the `<STACK-PREFIX>-Backup-Vault` vault, then the vault itself

9. **Verify Cleanup**:
   - Check CloudWatch Logs for any remaining log groups
   - Check Lambda functions for any remaining functions
   - Check API Gateway for any remaining APIs

**Note:** Please wait for each stack to be properly deleted before deleting the next stack. Some resources have dependencies that must be removed first.

**Cost Warning:** Ensure all resources are deleted to avoid ongoing charges. Pay special attention to:

- RDS instances
- Retained RDS snapshots and automated backups, and AWS Backup recovery points
- NAT Gateways
- Elastic IPs
- S3 storage
- OpenSearch Serverless OCUs
- CloudWatch Logs retention
