import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { ApiGatewayStack } from "../lib/api-stack";

type Statement = { Action: string | string[]; Resource?: unknown };

const env = { account: "123456789012", region: "ca-central-1" };

// Function logical ids are fixed in the stack because the OpenAPI definition refers to them
const PUBLIC_HANDLERS = ["chatSessionFunction", "userFunction", "systemMessagesFunction"];
const ADMIN_AUTHORIZER = "adminLambdaAuthorizer";
const TEXT_GEN = "lambdaTextGen";
const KNOWLEDGE_BASE = "lambdaKnowledgeBase";
const SEPARATED_FUNCTIONS = [...PUBLIC_HANDLERS, ADMIN_AUTHORIZER, TEXT_GEN, KNOWLEDGE_BASE];

let template: Template;
let resources: Record<string, { Type: string; Properties: any }>;

beforeAll(() => {
  // Asset bundling is not needed to inspect IAM, so function and layer code comes from parameters
  jest
    .spyOn(lambda.Code, "fromAsset")
    .mockImplementation(() => lambda.Code.fromCfnParameters() as unknown as lambda.AssetCode);

  const app = new cdk.App();
  const vpcStack = new VpcStack(app, "test-VpcStack", { env, stackPrefix: "test" });
  const dbStack = new DatabaseStack(app, "test-Database", vpcStack, { env });

  const kbStub = new cdk.Stack(app, "test-KnowledgeBaseStub", { env });
  const knowledgeBaseBucket = new s3.Bucket(kbStub, "KnowledgeBaseBucket");
  const knowledgeBaseSecret = new secretsmanager.Secret(kbStub, "KnowledgeBaseSecret");

  const apiStack = new ApiGatewayStack(app, "test-Api", dbStack, vpcStack, {
    env,
    ecrRepositories: {},
    knowledgeBaseBucket,
    knowledgeBaseSecret,
  });

  template = Template.fromStack(apiStack);
  resources = template.toJSON().Resources;
});

afterAll(() => {
  jest.restoreAllMocks();
});

function roleOf(functionLogicalId: string): string {
  const fn = resources[functionLogicalId];
  expect(fn?.Type).toBe("AWS::Lambda::Function");
  return fn.Properties.Role["Fn::GetAtt"][0];
}

function statementsOf(roleLogicalId: string): Statement[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .filter((r) => (r.Properties.Roles ?? []).some((ref: any) => ref.Ref === roleLogicalId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}

function actionsOf(functionLogicalId: string): string[] {
  return statementsOf(roleOf(functionLogicalId)).flatMap((s) =>
    Array.isArray(s.Action) ? s.Action : [s.Action]
  );
}

function resourcesFor(functionLogicalId: string, action: string): string {
  return JSON.stringify(
    statementsOf(roleOf(functionLogicalId))
      .filter((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes(action))
      .map((s) => s.Resource)
  );
}

const matching = (actions: string[], pattern: RegExp) => actions.filter((a) => pattern.test(a));

describe("Lambda execution roles", () => {
  test("each function has its own role", () => {
    const roles = SEPARATED_FUNCTIONS.map(roleOf);
    expect(new Set(roles).size).toBe(SEPARATED_FUNCTIONS.length);

    const usage = new Map<string, string[]>();
    Object.entries(resources)
      .filter(([, r]) => r.Type === "AWS::Lambda::Function")
      .forEach(([logicalId, r]) => {
        const role = r.Properties.Role?.["Fn::GetAtt"]?.[0];
        if (role) usage.set(role, [...(usage.get(role) ?? []), logicalId]);
      });
    SEPARATED_FUNCTIONS.forEach((fn) => {
      expect(usage.get(roleOf(fn))).toEqual([fn]);
    });
  });

  test.each([...PUBLIC_HANDLERS, ADMIN_AUTHORIZER])(
    "%s cannot call Bedrock, write S3, schedule, pass roles or post to connections",
    (fn) => {
      const actions = actionsOf(fn);
      expect(matching(actions, /^bedrock:/)).toEqual([]);
      expect(matching(actions, /^s3:/)).toEqual([]);
      expect(matching(actions, /^scheduler:/)).toEqual([]);
      expect(matching(actions, /^iam:PassRole$/)).toEqual([]);
      expect(matching(actions, /^execute-api:/)).toEqual([]);
    }
  );

  test.each(PUBLIC_HANDLERS)("%s reads only the database user secret", (fn) => {
    const secretResources = resourcesFor(fn, "secretsmanager:GetSecretValue");
    expect(secretResources).toContain("SpecExuserCredentialsrdsDbCredential");
    expect(secretResources).not.toContain("KnowledgeBaseSecret");
    expect(secretResources).not.toContain("SpecExCognitoSecrets");
  });

  test("the admin authorizer reads only the Cognito secret", () => {
    const secretResources = resourcesFor(ADMIN_AUTHORIZER, "secretsmanager:GetSecretValue");
    expect(secretResources).toContain("SpecExCognitoSecrets");
    expect(secretResources).not.toContain("rdsDbCredential");
    expect(secretResources).not.toContain("KnowledgeBaseSecret");
  });

  test("text generation can call models but cannot change the knowledge base", () => {
    const actions = actionsOf(TEXT_GEN);
    expect(actions).toEqual(
      expect.arrayContaining([
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:Converse",
        "bedrock:ConverseStream",
        "bedrock:Retrieve",
        "bedrock:ApplyGuardrail",
        "execute-api:ManageConnections",
      ])
    );
    expect(matching(actions, /^bedrock:(StartIngestionJob|CreateDataSource|UpdateDataSource)$/)).toEqual([]);
    expect(matching(actions, /^s3:/)).toEqual([]);
    expect(matching(actions, /^scheduler:/)).toEqual([]);
    expect(matching(actions, /^iam:PassRole$/)).toEqual([]);
  });

  test("the knowledge base function can manage ingestion but cannot call models", () => {
    const actions = actionsOf(KNOWLEDGE_BASE);
    expect(actions).toEqual(
      expect.arrayContaining([
        "bedrock:StartIngestionJob",
        "bedrock:CreateDataSource",
        "scheduler:CreateSchedule",
        "scheduler:DeleteSchedule",
        "iam:PassRole",
      ])
    );
    expect(matching(actions, /^s3:PutObject/).length).toBeGreaterThan(0);
    expect(matching(actions, /^bedrock:(InvokeModel|Converse|Retrieve|ApplyGuardrail)/)).toEqual([]);
    expect(matching(actions, /^execute-api:/)).toEqual([]);
  });
});

describe("Cognito user pool", () => {
  test("requires TOTP MFA, keeps deletion protection and turns on threat protection", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      MfaConfiguration: "ON",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
      DeletionProtection: "ACTIVE",
      UserPoolTier: "PLUS",
      UserPoolAddOns: { AdvancedSecurityMode: "ENFORCED" },
    });
  });

  test("the app client allows only SRP and hides whether a user exists", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
    });
  });

  test("threat protection blocks compromised credentials and high-risk sign-ins", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolRiskConfigurationAttachment", {
      ClientId: "ALL",
      CompromisedCredentialsRiskConfiguration: { Actions: { EventAction: "BLOCK" } },
      AccountTakeoverRiskConfiguration: {
        Actions: { HighAction: { EventAction: "BLOCK", Notify: false } },
      },
    });
  });
});

describe("WAF and WebSocket rate limiting", () => {
  test("the web ACL includes the IP reputation and known bad inputs rule groups", () => {
    const acl = Object.values(resources).find((r) => r.Type === "AWS::WAFv2::WebACL")!;
    const managed = acl.Properties.Rules.map(
      (rule: any) => rule.Statement.ManagedRuleGroupStatement?.Name
    );
    expect(managed).toEqual(
      expect.arrayContaining([
        "AWSManagedRulesAmazonIpReputationList",
        "AWSManagedRulesKnownBadInputsRuleSet",
        "AWSManagedRulesCommonRuleSet",
      ])
    );
    const priorities = acl.Properties.Rules.map((rule: any) => rule.Priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  test("WAF logs blocked and counted requests to a 90-day log group with tokens redacted", () => {
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "aws-waf-logs-test-Api",
      RetentionInDays: 90,
    });
    template.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      RedactedFields: [{ SingleHeader: { Name: "authorization" } }],
      LoggingFilter: { DefaultBehavior: "DROP" },
    });
  });

  test("the WebSocket default route can only update the rate limit table", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      BillingMode: "PAY_PER_REQUEST",
    });
    const actions = actionsOf(
      Object.entries(resources).find(
        ([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties.Handler === "default.handler"
      )![0]
    );
    expect(matching(actions, /^dynamodb:/)).toEqual(["dynamodb:UpdateItem"]);
  });
});
