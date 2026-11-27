import { App, RedirectStatus } from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { ApiGatewayStack } from "./api-stack";

interface AmplifyStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  /** CodeConnections connection to GitHub, created by the CICD stack */
  connectionArn: string;
  knowledgeBaseBucketName: string;
  allowedOriginsParamName: string;
}

/**
 * Hosts the frontend on Amplify Hosting as a manually deployed app (not connected to a Git
 * repository), so Amplify needs no GitHub personal access token.
 *
 * A CodePipeline pulls the repository through the CodeConnections connection, builds
 * `frontend/` with the API and Cognito values from the API stack and publishes `dist/` to the
 * Amplify branch with CreateDeployment and StartDeployment. It runs once when it is created
 * and then on every push to the branch that changes `frontend/`.
 *
 * https://docs.aws.amazon.com/amplify/latest/userguide/manual-deploys.html
 */
export class AmplifyStack extends cdk.Stack {
  public readonly pipelineName: string;

  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props: AmplifyStackProps
  ) {
    super(scope, id, props);

    const branch = props.githubBranch ?? "main";

    // A new construct ID gives a new app: an app created from a repository cannot be turned
    // into a manually deployed one, so the old repository-connected app is replaced
    const amplifyApp = new App(this, `${id}-manualDeployApp`, {
      appName: `${id}-amplify`,
      customResponseHeaders: [
        {
          pattern: "**/*",
          headers: {
            "Content-Security-Policy": [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              `connect-src 'self' ${apiStack.getEndpointUrl()} ${apiStack.getWebSocketUrl()} https://cognito-idp.${this.region}.amazonaws.com https://cognito-identity.${this.region}.amazonaws.com https://*.s3.${this.region}.amazonaws.com https://*.s3.amazonaws.com`,
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
            // HTTPS only for a year, including other branch subdomains of this app
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
            // Cross-origin requests and links send only the origin, never the path
            "Referrer-Policy": "strict-origin-when-cross-origin",
            // Browsers use the declared content type instead of guessing it
            "X-Content-Type-Options": "nosniff",
            // The app uses none of these browser features, so pages cannot request them
            "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        },
      ],
    });

    // Client-side routes (paths without a file extension) get the app shell with a 200
    // https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html#redirects-for-single-page-web-apps-spa
    amplifyApp.addCustomRule({
      source: "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
      target: "/index.html",
      status: RedirectStatus.REWRITE,
    });

    const amplifyBranch = amplifyApp.addBranch(branch);

    // -- FRONTEND PIPELINE --
    this.pipelineName = `${id}-FrontendPipeline`;

    const buildLogGroup = new logs.LogGroup(this, "FrontendBuildLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const buildProject = new codebuild.PipelineProject(this, "FrontendBuild", {
      projectName: `${id}-FrontendBuild`,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_4_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      logging: { cloudWatch: { logGroup: buildLogGroup } },
      // Public client configuration that ends up in the browser bundle
      environmentVariables: {
        VITE_AWS_REGION: { value: this.region },
        VITE_COGNITO_USER_POOL_ID: { value: apiStack.getUserPoolId() },
        VITE_COGNITO_USER_POOL_CLIENT_ID: { value: apiStack.getUserPoolClientId() },
        VITE_API_ENDPOINT: { value: apiStack.getEndpointUrl() },
        VITE_IDENTITY_POOL_ID: { value: apiStack.getIdentityPoolId() },
        VITE_WEBSOCKET_URL: {
          value: `${apiStack.getWebSocketUrl()}/${apiStack.getStageName()}`,
        },
        AMPLIFY_APP_ID: { value: amplifyApp.appId },
        AMPLIFY_BRANCH: { value: amplifyBranch.branchName },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { nodejs: 24 },
          },
          pre_build: {
            commands: ["cd frontend", "npm ci"],
          },
          build: {
            commands: ["npm run build"],
          },
          post_build: {
            commands: [
              // post_build also runs after a failed build; there is nothing to publish then
              'test "$CODEBUILD_BUILD_SUCCEEDING" = "1"',
              "(cd dist && zip -qr ../site.zip .)",
              // Amplify returns a presigned URL for the zip and a job that publishes it
              `bash -c '
                set -euo pipefail
                read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" --query "[jobId,zipUploadUrl]" --output text)
                curl --fail --silent --show-error -X PUT -H "Content-Type: application/zip" --upload-file site.zip "$UPLOAD_URL"
                aws amplify start-deployment --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" --job-id "$JOB_ID" > /dev/null
                echo "Started Amplify deployment job $JOB_ID"
                for _ in $(seq 1 60); do
                  STATUS=$(aws amplify get-job --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" --job-id "$JOB_ID" --query job.summary.status --output text)
                  case "$STATUS" in
                    SUCCEED) echo "Deployment $JOB_ID succeeded"; exit 0 ;;
                    FAILED|CANCELLED) echo "Deployment $JOB_ID ended with status $STATUS"; exit 1 ;;
                  esac
                  sleep 10
                done
                echo "Deployment $JOB_ID did not finish within 10 minutes"
                exit 1
              '`,
            ],
          },
        },
      }),
    });

    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["amplify:CreateDeployment", "amplify:StartDeployment", "amplify:GetJob"],
        // CreateDeployment is authorized against the branch's deployments path
        resources: [
          amplifyBranch.arn,
          `${amplifyBranch.arn}/deployments/*`,
          `${amplifyBranch.arn}/jobs/*`,
        ],
      })
    );

    const artifactBucket = new s3.Bucket(this, "PipelineArtifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    const owner = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "specEx-owner-name"
    );
    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: "GitHub",
      owner,
      repo: props.githubRepo,
      branch,
      connectionArn: props.connectionArn,
      output: sourceOutput,
    });

    new codepipeline.Pipeline(this, "FrontendPipeline", {
      pipelineName: this.pipelineName,
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      stages: [
        { stageName: "Source", actions: [sourceAction] },
        {
          stageName: "Deploy",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "BuildAndPublish",
              project: buildProject,
              input: sourceOutput,
            }),
          ],
        },
      ],
      // Only pushes that change the frontend rebuild the site
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction,
            pushFilter: [{ branchesIncludes: [branch], filePathsIncludes: ["frontend/**"] }],
          },
        },
      ],
    });

    // -- UPDATE THE SSM PARAMETER TO POINT TO THE AMPLIFY APP URL --
    const amplifyUrl = `https://${branch}.${amplifyApp.appId}.amplifyapp.com`;

    new cdk.CfnOutput(this, "AmplifyUrl", {
      value: amplifyUrl,
      description: "URL of the web app",
    });
    new cdk.CfnOutput(this, "FrontendPipelineName", {
      value: this.pipelineName,
      description: "Pipeline that builds the frontend and publishes it to Amplify",
    });
    // Set the allowed origins to the Amplify URL.
    // To add additional origins (e.g. custom domains), update the SSM parameter manually.
    // See Docs/DEPLOYMENT_GUIDE.md for instructions.
    // Re-applied on every deployment so a stack update never reverts the allow-list
    const updateAllowedOrigins = {
      service: "SSM",
      action: "putParameter",
      parameters: {
        Name: props.allowedOriginsParamName,
        Value: amplifyUrl,
        Type: "String",
        Overwrite: true,
      },
      physicalResourceId: cdk.custom_resources.PhysicalResourceId.of(Date.now().toString()),
    };

    new cdk.custom_resources.AwsCustomResource(this, "UpdateSSMAllowedOrigins", {
      onCreate: updateAllowedOrigins,
      onUpdate: updateAllowedOrigins,
      policy: cdk.custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${props.allowedOriginsParamName}`,
        ],
      }),
    });

    // Origin used by the API preflight and gateway error responses
    const updateStageOrigin = {
      service: "APIGateway",
      action: "updateStage",
      parameters: {
        restApiId: apiStack.api.restApiId,
        stageName: apiStack.api.deploymentStage.stageName,
        patchOperations: [
          { op: "replace", path: "/variables/allowedOrigin", value: amplifyUrl },
        ],
      },
      physicalResourceId: cdk.custom_resources.PhysicalResourceId.of(Date.now().toString()),
    };

    new cdk.custom_resources.AwsCustomResource(this, "UpdateStageAllowedOrigin", {
      onCreate: updateStageOrigin,
      onUpdate: updateStageOrigin,
      policy: cdk.custom_resources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["apigateway:PATCH"],
          resources: [
            `arn:aws:apigateway:${this.region}::/restapis/${apiStack.api.restApiId}/stages/${apiStack.api.deploymentStage.stageName}`,
          ],
        }),
      ]),
    });

    const updateBucketCors = {
      service: "S3",
      action: "putBucketCors",
      parameters: {
        Bucket: props.knowledgeBaseBucketName,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ["*"],
              AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
              AllowedOrigins: [amplifyUrl],
              ExposeHeaders: ["ETag"],
            },
          ],
        },
      },
      physicalResourceId: cdk.custom_resources.PhysicalResourceId.of(Date.now().toString()),
    };

    new cdk.custom_resources.AwsCustomResource(this, "UpdateS3BucketCors", {
      onCreate: updateBucketCors,
      onUpdate: updateBucketCors,
      policy: cdk.custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [`arn:aws:s3:::${props.knowledgeBaseBucketName}`],
      }),
    });
  }
}
