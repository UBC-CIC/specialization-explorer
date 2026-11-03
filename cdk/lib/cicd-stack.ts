import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as codeconnections from "aws-cdk-lib/aws-codeconnections";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";

interface LambdaConfig {
  name: string; // Module name (e.g., "textGeneration")
  functionName: string; // Lambda function name
  sourceDir: string; // Source directory for Docker build
}

interface CICDStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  environmentName?: string;
  lambdaFunctions: LambdaConfig[];
  pathFilters?: string[];
}

export class CICDStack extends cdk.Stack {
  public readonly ecrRepositories: { [key: string]: ecr.Repository } = {};
  public readonly buildProjects: { [key: string]: codebuild.IProject } = {};
  public readonly pipelineName: string;

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);

    const envName = props.environmentName ?? "dev";
    this.pipelineName = `${id}-DockerImagePipeline`;

    // Create a common role for all CodeBuild projects
    const codeBuildRole = new iam.Role(this, "DockerBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    const lambdaUpdateArns = props.lambdaFunctions.map(
      (fn) => `arn:aws:lambda:${this.region}:${this.account}:function:${fn.functionName}`
    );

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:PublishVersion",
          "lambda:GetAlias",
          "lambda:UpdateAlias",
        ],
        // Qualified ARNs cover the published versions and the live alias
        resources: [...lambdaUpdateArns, ...lambdaUpdateArns.map((arn) => `${arn}:*`)],
      })
    );

    // Create artifacts for pipeline
    const sourceOutput = new codepipeline.Artifact();

    // Explicit artifact bucket with access logging
    const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
    });

    const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
      serverAccessLogsBucket: artifactAccessLogsBucket,
      serverAccessLogsPrefix: "pipeline-artifacts/",
    });

    // Create the pipeline
    const pipeline = new codepipeline.Pipeline(this, "DockerImagePipeline", {
      pipelineName: this.pipelineName,
      artifactBucket: artifactBucket,
    });

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "specEx-owner-name"
    );

    // Create GitHub connection using CodeStar Connections
    const githubConnection = new codeconnections.CfnConnection(
      this,
      "GitHubConnection",
      {
        connectionName: `${id}-github-conn`,
        providerType: "GitHub",
      }
    );

    // Output the connection ARN for reference
    new cdk.CfnOutput(this, "GitHubConnectionArn", {
      value: githubConnection.attrConnectionArn,
      description: "ARN of the GitHub connection. After deployment, authorize this connection in the AWS Console.",
    });

    // Add source stage using CodeStar Connections
    pipeline.addStage({
      stageName: "Source",
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: "GitHub",
          owner: username,
          repo: props.githubRepo,
          branch: props.githubBranch ?? "main",
          connectionArn: githubConnection.attrConnectionArn,
          output: sourceOutput,
          triggerOnPush: true,
        }),
      ],
    });

    // Create build actions for each Lambda function
    const buildActions: codepipeline_actions.CodeBuildAction[] = [];

    props.lambdaFunctions.forEach((lambda) => {
      // Create ECR repository
      const repoName = `${id.toLowerCase()}-${lambda.name.toLowerCase()}`;
      // Commit tags can never be overwritten, so a tag always names the image that was scanned.
      // "latest" stays movable: the pipeline moves it to each image that passes the scan.
      const ecrRepo = new ecr.Repository(this, `${lambda.name}Repo`, {
        repositoryName: repoName,
        imageTagMutability: ecr.TagMutability.IMMUTABLE_WITH_EXCLUSION,
        imageTagMutabilityExclusionFilters: [
          ecr.ImageTagMutabilityExclusionFilter.wildcard("latest"),
        ],
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        imageScanOnPush: true,
        lifecycleRules: [
          {
            description: "Expire untagged images after 14 days",
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: cdk.Duration.days(14),
          },
        ],
      });

      ecrRepo.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "LambdaPullAccess",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
          actions: [
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:BatchCheckLayerAvailability",
          ],
          conditions: {
            StringEquals: {
              "aws:SourceAccount": this.account,
            },
          },
        })
      );

      // The build role may only pull, push and read scan results for the repositories it builds
      ecrRepo.grantPullPush(codeBuildRole);
      codeBuildRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ecr:DescribeImages", "ecr:DescribeImageScanFindings"],
          resources: [ecrRepo.repositoryArn],
        })
      );

      this.ecrRepositories[lambda.name] = ecrRepo;
      cdk.Tags.of(ecrRepo).add("module", lambda.name);
      cdk.Tags.of(ecrRepo).add("env", envName);

      // Create CodeBuild project
      const buildProject = new codebuild.PipelineProject(
        this,
        `${lambda.name}BuildProject`,
        {
          projectName: `${id}-${lambda.name}Builder`,
          role: codeBuildRole,
          environment: {
            buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
            privileged: true,
          },
          environmentVariables: {
            AWS_ACCOUNT_ID: { value: this.account },
            AWS_REGION: { value: this.region },
            ENVIRONMENT: { value: envName },
            MODULE_NAME: { value: lambda.name },
            LAMBDA_FUNCTION_NAME: { value: lambda.functionName },
            REPO_NAME: { value: repoName },
            REPOSITORY_URI: { value: ecrRepo.repositoryUri },
            GITHUB_USERNAME: { value: username },
            GITHUB_REPO: { value: props.githubRepo },
            PATH_FILTER: { value: lambda.sourceDir },
          },
          buildSpec: codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
              pre_build: {
                commands: [
                  "echo Logging in to Amazon ECR...",
                  "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com",
                  'echo "#!/bin/bash" > check_and_build.sh',
                  'echo "set -e" >> check_and_build.sh',
                  'echo "# Source is provided by CodePipeline via CodeStar Connection" >> check_and_build.sh',
                  'echo "cd $CODEBUILD_SRC_DIR" >> check_and_build.sh',
                  'echo "# Check if image exists in ECR" >> check_and_build.sh',
                  'echo "if ! aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=latest &>/dev/null; then" >> check_and_build.sh',
                  'echo "  echo \\\"First deployment or image doesn\'t exist - building without path check\\\"" >> check_and_build.sh',
                  'echo "  exit 0" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "# Initialize git if needed (CodePipeline source may not have .git)" >> check_and_build.sh',
                  'echo "if [ ! -d .git ]; then" >> check_and_build.sh',
                  'echo "  echo \\\"No git history available - building to be safe\\\"" >> check_and_build.sh',
                  'echo "  exit 0" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "PREV_COMMIT=\\$(git rev-parse HEAD~1 || echo \\\"\\\")" >> check_and_build.sh',
                  'echo "if [ -z \\\"\\$PREV_COMMIT\\\" ]; then" >> check_and_build.sh',
                  'echo "  echo \\\"First commit - building\\\"" >> check_and_build.sh',
                  'echo "  exit 0" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "CHANGED_FILES=\\$(git diff --name-only \\$PREV_COMMIT HEAD)" >> check_and_build.sh',
                  'echo "echo \\\"Changed files:\\\"" >> check_and_build.sh',
                  'echo "echo \\\"\\$CHANGED_FILES\\\"" >> check_and_build.sh',
                  'echo "if ! echo \\\"\\$CHANGED_FILES\\\" | grep -q \\\"^$PATH_FILTER/\\\"; then" >> check_and_build.sh',
                  'echo "  echo \\\"No changes in $PATH_FILTER — skipping build.\\\"" >> check_and_build.sh',
                  'echo "  exit 1" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "exit 0" >> check_and_build.sh',
                  "chmod +x check_and_build.sh",
                  "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
                  "IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}",
                  "export DOCKER_HOST=unix:///var/run/docker.sock",
                  './check_and_build.sh || { echo "Skipping build due to no changes"; exit 1; }',
                ],
              },
              build: {
                commands: [
                  // Commit tags are immutable, so a re-run for the same commit reuses its image
                  'if aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=$IMAGE_TAG >/dev/null 2>&1; then IMAGE_EXISTS=1; else IMAGE_EXISTS=0; fi',
                  'if [ "$IMAGE_EXISTS" = "1" ]; then echo "Image $IMAGE_TAG already exists, reusing it"; docker pull $REPOSITORY_URI:$IMAGE_TAG; fi',
                  `if [ "$IMAGE_EXISTS" = "0" ]; then echo "Building Docker image..."; docker build -t $REPOSITORY_URI:$IMAGE_TAG $CODEBUILD_SRC_DIR/${lambda.sourceDir} -f $CODEBUILD_SRC_DIR/${lambda.sourceDir}/Dockerfile; fi`,
                ],
              },
              post_build: {
                commands: [
                  // post_build also runs after a failed build; there is nothing to publish then
                  'test "$CODEBUILD_BUILD_SUCCEEDING" = "1"',
                  // Only the commit-specific tag is pushed until the scan has passed
                  'if [ "$IMAGE_EXISTS" = "0" ]; then docker push $REPOSITORY_URI:$IMAGE_TAG; fi',
                  'echo "Waiting for vulnerability scan to complete..."',
                  "aws ecr wait image-scan-complete --repository-name $REPO_NAME --image-id imageTag=$IMAGE_TAG",
                  // Any failure to read the results fails the build; nothing here defaults to a pass
                  "SCAN_STATUS=$(aws ecr describe-image-scan-findings --repository-name $REPO_NAME --image-id imageTag=$IMAGE_TAG --query imageScanStatus.status --output text)",
                  'if [ "$SCAN_STATUS" != "COMPLETE" ]; then echo "Vulnerability scan did not complete (status: $SCAN_STATUS). Blocking deployment."; exit 1; fi',
                  // A completed scan with no CRITICAL findings reports no CRITICAL key at all
                  "CRITICAL_COUNT=$(aws ecr describe-image-scan-findings --repository-name $REPO_NAME --image-id imageTag=$IMAGE_TAG --query imageScanFindingsSummary.findingCounts.CRITICAL --output text)",
                  'if [ "$CRITICAL_COUNT" = "None" ]; then CRITICAL_COUNT=0; fi',
                  'if ! echo "$CRITICAL_COUNT" | grep -Eq "^[0-9]+$"; then echo "Unreadable scan result: $CRITICAL_COUNT. Blocking deployment."; exit 1; fi',
                  'if [ "$CRITICAL_COUNT" -gt 0 ]; then echo "CRITICAL vulnerabilities found: $CRITICAL_COUNT. Blocking deployment."; exit 1; fi',
                  'echo "No critical vulnerabilities found. Promoting image."',
                  "docker tag $REPOSITORY_URI:$IMAGE_TAG $REPOSITORY_URI:latest",
                  "docker push $REPOSITORY_URI:latest",
                  "export IMAGE_TAG",
                  'echo "Checking if Lambda function exists before updating..."',
                  // The function is pointed at the verified, commit-specific tag and published as
                  // a new version; the "live" alias then moves to it, and the log prints the command
                  // that moves the alias back to the previous version
                  `bash -c '
                    set -e
                    if ! aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME &>/dev/null; then
                      echo "Lambda function $LAMBDA_FUNCTION_NAME does not exist yet. Skipping update."
                      exit 0
                    fi
                    echo "Updating Lambda function to use the new image..."
                    aws lambda update-function-code --function-name $LAMBDA_FUNCTION_NAME --image-uri $REPOSITORY_URI:$IMAGE_TAG > /dev/null
                    aws lambda wait function-updated --function-name $LAMBDA_FUNCTION_NAME
                    NEW_VERSION=$(aws lambda publish-version --function-name $LAMBDA_FUNCTION_NAME --description "$IMAGE_TAG" --query Version --output text)
                    echo "Published version $NEW_VERSION for $IMAGE_TAG"
                    if ! PREVIOUS_VERSION=$(aws lambda get-alias --function-name $LAMBDA_FUNCTION_NAME --name live --query FunctionVersion --output text 2>/dev/null); then
                      echo "Alias live does not exist yet; it is created by the next CDK deployment."
                      exit 0
                    fi
                    aws lambda update-alias --function-name $LAMBDA_FUNCTION_NAME --name live --function-version $NEW_VERSION > /dev/null
                    echo "Alias live moved from version $PREVIOUS_VERSION to $NEW_VERSION"
                    echo "Rollback: aws lambda update-alias --function-name $LAMBDA_FUNCTION_NAME --name live --function-version $PREVIOUS_VERSION"
                  '`,
                ],
              },
            },
          }),
        }
      );

      this.buildProjects[lambda.name] = buildProject;

      // CodeBuild creates this log group on its first build, outside CloudFormation
      new logs.LogRetention(this, `${lambda.name}BuildLogRetention`, {
        logGroupName: `/aws/codebuild/${buildProject.projectName}`,
        retention: logs.RetentionDays.ONE_MONTH,
      });


      // Add build action to the list
      buildActions.push(
        new codepipeline_actions.CodeBuildAction({
          actionName: `Build_${lambda.name}`,
          project: buildProject,
          input: sourceOutput,
        })
      );
    });

    // Add build stage with all build actions
    pipeline.addStage({
      stageName: "Build",
      actions: buildActions,
    });
  }
}