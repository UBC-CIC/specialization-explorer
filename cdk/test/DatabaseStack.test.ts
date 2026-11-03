import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";

const env = { account: "123456789012", region: "ca-central-1" };

let dbResources: Record<string, { Type: string; Properties: any; DependsOn?: string[] }>;
let flowResources: Record<string, { Type: string; Properties: any; DependsOn?: string[] }>;
let dbSecurityGroupId: string;

beforeAll(() => {
  // Asset bundling is not needed to inspect networking, so code comes from parameters
  jest
    .spyOn(lambda.Code, "fromAsset")
    .mockImplementation(() => lambda.Code.fromCfnParameters() as unknown as lambda.AssetCode);

  const app = new cdk.App();
  const vpcStack = new VpcStack(app, "test-VpcStack", { env, stackPrefix: "test" });
  const dbStack = new DatabaseStack(app, "test-Database", vpcStack, { env });
  const flowStack = new DBFlowStack(app, "test-DBFlow", vpcStack, dbStack, { env });

  dbResources = Template.fromStack(dbStack).toJSON().Resources;
  flowResources = Template.fromStack(flowStack).toJSON().Resources;

  const instance = Object.values(dbResources).find((r) => r.Type === "AWS::RDS::DBInstance")!;
  dbSecurityGroupId = instance.Properties.VPCSecurityGroups[0]["Fn::GetAtt"][0];
});

afterAll(() => {
  jest.restoreAllMocks();
});

const ingressRules = (resources: typeof dbResources) =>
  Object.entries(resources).filter(([, r]) => r.Type === "AWS::EC2::SecurityGroupIngress");

// True when a rule's GroupId refers to the database security group, in this or another stack
const targetsDbGroup = (rule: any) => JSON.stringify(rule.Properties.GroupId).includes(dbSecurityGroupId);

describe("Database network path", () => {
  test("the database security group admits no CIDR ranges", () => {
    const inline = dbResources[dbSecurityGroupId].Properties.SecurityGroupIngress ?? [];
    expect(inline.filter((rule: any) => rule.CidrIp || rule.CidrIpv6)).toEqual([]);

    const cidrRules = [...ingressRules(dbResources), ...ingressRules(flowResources)]
      .filter(([, r]) => targetsDbGroup(r))
      .filter(([, r]) => r.Properties.CidrIp || r.Properties.CidrIpv6);
    expect(cidrRules).toEqual([]);
  });

  test("the database admits the proxy and both rotation functions", () => {
    const sources = ingressRules(dbResources)
      .filter(([, r]) => targetsDbGroup(r))
      .map(([, r]) => JSON.stringify(r.Properties.SourceSecurityGroupId));
    expect(sources.some((s) => s.includes("ProxySecurityGroup"))).toBe(true);
    expect(sources.some((s) => s.includes("AppUserRot"))).toBe(true);
    expect(sources.some((s) => s.includes("TableCreatorRot"))).toBe(true);
    expect(sources).toHaveLength(3);
  });

  test("the database admits the initializer, and the initializer runs after that rule exists", () => {
    const rules = ingressRules(flowResources).filter(([, r]) => targetsDbGroup(r));
    expect(rules).toHaveLength(1);
    const [ruleId, rule] = rules[0];
    expect(JSON.stringify(rule.Properties.SourceSecurityGroupId)).toContain("InitializerSecurityGroup");
    expect(rule.Properties.FromPort).toBe(5432);

    const trigger = Object.values(flowResources).find((r) => r.Type === "Custom::Trigger")!;
    expect(trigger.DependsOn).toEqual(expect.arrayContaining([ruleId]));
  });

  test("application functions still reach the proxy from the private subnets", () => {
    const proxyGroup = Object.entries(dbResources).find(
      ([id, r]) => r.Type === "AWS::EC2::SecurityGroup" && id.includes("ProxySecurityGroup")
    )![1];
    const cidrs = (proxyGroup.Properties.SecurityGroupIngress ?? []).map((rule: any) => rule.CidrIp);
    expect(cidrs.length).toBeGreaterThan(0);
  });
});
