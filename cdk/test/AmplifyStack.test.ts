import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as yaml from "yaml";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { ApiGatewayStack } from "../lib/api-stack";
import { AmplifyStack } from "../lib/amplify-stack";

const env = { account: "123456789012", region: "ca-central-1" };

let headers: Record<string, string>;

beforeAll(() => {
  // Asset bundling is not needed to inspect the Amplify app, so code comes from parameters
  jest
    .spyOn(lambda.Code, "fromAsset")
    .mockImplementation(() => lambda.Code.fromCfnParameters() as unknown as lambda.AssetCode);

  const app = new cdk.App();
  const vpcStack = new VpcStack(app, "test-VpcStack", { env, stackPrefix: "test" });
  const dbStack = new DatabaseStack(app, "test-Database", vpcStack, { env });
  const kbStub = new cdk.Stack(app, "test-KnowledgeBaseStub", { env });
  const apiStack = new ApiGatewayStack(app, "test-Api", dbStack, vpcStack, {
    env,
    ecrRepositories: {},
    knowledgeBaseBucket: new s3.Bucket(kbStub, "KnowledgeBaseBucket"),
    knowledgeBaseSecret: new secretsmanager.Secret(kbStub, "KnowledgeBaseSecret"),
  });
  const amplifyStack = new AmplifyStack(app, "test-Amplify", apiStack, {
    env,
    githubRepo: "repo",
    knowledgeBaseBucketName: "bucket",
    allowedOriginsParamName: apiStack.allowedOriginsParamName,
  });

  const amplifyApp = Object.values(Template.fromStack(amplifyStack).toJSON().Resources).find(
    (r: any) => r.Type === "AWS::Amplify::App"
  ) as { Properties: { CustomHeaders: string } };
  // The header values contain tokens, which Fn::Join renders as a list of parts
  const customHeaders = JSON.stringify(amplifyApp.Properties.CustomHeaders);
  const rendered = typeof amplifyApp.Properties.CustomHeaders === "string"
    ? amplifyApp.Properties.CustomHeaders
    : JSON.parse(customHeaders)["Fn::Join"][1].map((p: unknown) => (typeof p === "string" ? p : "TOKEN")).join("");
  const parsed = yaml.parse(rendered);
  headers = Object.fromEntries(
    parsed.applications[0].customHeaders[0].headers.map(
      (h: { key: string; value: string }) => [h.key, h.value]
    )
  );
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe("Amplify response headers", () => {
  test("sends the security headers alongside the CSP", () => {
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
  });
});
