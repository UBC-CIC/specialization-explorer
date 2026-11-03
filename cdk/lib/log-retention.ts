import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { IConstruct } from "constructs";

// CDK's default retention for log groups it creates (RetentionDays.TWO_YEARS)
const CDK_DEFAULT_RETENTION_DAYS = 731;

/**
 * Gives every Lambda log group in the given stacks a retention period.
 *
 * - Functions whose log group CloudFormation manages (the
 *   `@aws-cdk/aws-lambda:useCdkManagedLogGroup` flag in cdk.json) get the retention set on that
 *   log group directly. A group that already sets its own retention keeps it.
 * - Low-level handlers that CDK adds for custom resource providers have no managed log group.
 *   Lambda creates theirs on first run, outside CloudFormation, so a LogRetention resource sets
 *   the retention on the existing group. This also covers the LogRetention handler itself.
 *
 * https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda-readme.html#log-group
 */
export function applyLambdaLogRetention(stacks: cdk.Stack[], retention: logs.RetentionDays): void {
  const handled = new Set<IConstruct>();

  // Adding a LogRetention can add its own handler to a stack, so repeat until nothing is new
  let changed = true;
  while (changed) {
    changed = false;
    for (const stack of stacks) {
      for (const node of stack.node.findAll()) {
        if (handled.has(node)) continue;

        if (node instanceof lambda.Function) {
          handled.add(node);
          if (node.node.defaultChild) handled.add(node.node.defaultChild);
          const managedLogGroup = node.node.tryFindChild("LogGroup");
          if (managedLogGroup instanceof logs.LogGroup) {
            const cfnLogGroup = managedLogGroup.node.defaultChild as logs.CfnLogGroup;
            if (
              cfnLogGroup.retentionInDays === undefined ||
              cfnLogGroup.retentionInDays === CDK_DEFAULT_RETENTION_DAYS
            ) {
              cfnLogGroup.retentionInDays = retention;
            }
          }
          continue;
        }

        if (node instanceof cdk.CfnResource && node.cfnResourceType === "AWS::Lambda::Function") {
          handled.add(node);
          new logs.LogRetention(stack, `${cdk.Names.uniqueId(node)}LogRetention`, {
            logGroupName: `/aws/lambda/${node.ref}`,
            retention,
          });
          changed = true;
        }
      }
    }
  }
}
