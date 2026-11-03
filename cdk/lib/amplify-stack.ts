import {
  App,
  GitHubSourceCodeProvider,
  RedirectStatus,
} from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { BuildSpec } from "aws-cdk-lib/aws-codebuild";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as yaml from "yaml";
import { ApiGatewayStack } from "./api-stack";

interface AmplifyStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  knowledgeBaseBucketName: string;
  allowedOriginsParamName: string;
}

export class AmplifyStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props: AmplifyStackProps
  ) {
    super(scope, id, props);

    const githubRepoName = props.githubRepo;

    const amplifyYaml = yaml.parse(`
      version: 1
      applications:
        - appRoot: frontend
          frontend:
            phases:
              preBuild:
                commands:
                  - pwd
                  - npm ci
              build:
                commands:
                  - npm run build
            artifacts:
              baseDirectory: dist
              files:
                - '**/*'
            cache:
              paths:
                - 'node_modules/**/*'
            redirects:
              - source: </^[^.]+$|.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>
                target: /
                status: 404
    `);

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "specEx-owner-name"
    );

    const amplifyApp = new App(this, `${id}-amplifyApp`, {
      appName: `${id}-amplify`,
      sourceCodeProvider: new GitHubSourceCodeProvider({
        owner: username,
        repository: githubRepoName,
        oauthToken: cdk.SecretValue.secretsManager(
          "github-personal-access-token",
          {
            jsonField: "my-github-token",
          }
        ),
      }),
      environmentVariables: {
        VITE_AWS_REGION: this.region,
        VITE_COGNITO_USER_POOL_ID: apiStack.getUserPoolId(),
        VITE_COGNITO_USER_POOL_CLIENT_ID: apiStack.getUserPoolClientId(),
        VITE_API_ENDPOINT: apiStack.getEndpointUrl(),
        VITE_IDENTITY_POOL_ID: apiStack.getIdentityPoolId(),
        VITE_WEBSOCKET_URL: `${apiStack.getWebSocketUrl()}/${apiStack.getStageName() ?? ""
          }`,
      },
      buildSpec: BuildSpec.fromObjectToYaml(amplifyYaml),
      customResponseHeaders: [
        {
          appRoot: "frontend",
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

    amplifyApp.addCustomRule({
      source: "/<*>",
      target: "\t/index.html",
      status: RedirectStatus.NOT_FOUND_REWRITE,
    });

    // Add main branch
    amplifyApp.addBranch("main");

    // Add feature branch if specified and not main
    const branch = props.githubBranch ?? "main";
    if (branch !== "main") {
      amplifyApp.addBranch(branch);
    }

    // -- UPDATE THE SSM PARAMETER TO POINT TO THE AMPLIFY APP URL --
    const amplifyUrl = `https://${branch}.${amplifyApp.appId}.amplifyapp.com`;

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
