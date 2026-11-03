import * as cdk from "aws-cdk-lib";
import { Stack, StackProps, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct, IConstruct } from "constructs";
import * as backup from "aws-cdk-lib/aws-backup";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";

// Resources with this tag are backed up by the plan below. Selecting by tag keeps this stack
// independent of the stacks that own the data, so either can be deployed or deleted on its own.
export const BACKUP_TAG_KEY = "BackupPlan";
export const backupTagValue = (stackPrefix: string) => `${stackPrefix}-Daily`;

/**
 * Adds the backup tag to one resource only. Pass the L1 resource (node.defaultChild) so the
 * tag is not copied to child resources such as the database proxy or subnet group.
 */
export function addToBackupPlan(resource: IConstruct, stackPrefix: string): void {
  cdk.Tags.of(resource).add(BACKUP_TAG_KEY, backupTagValue(stackPrefix));
}

/**
 * Daily AWS Backup plan for the stateful resources: the RDS instance (users, chats) and the
 * knowledge base bucket (source documents). Cognito user pools are not supported by AWS Backup;
 * the pool is protected by RETAIN and deletion protection instead.
 * https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html
 */
export class BackupStack extends Stack {
  public readonly backupVault: backup.BackupVault;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { stackPrefix: string }
  ) {
    super(scope, id, props);

    // Recovery points are encrypted with the AWS managed key for AWS Backup.
    // The vault and its recovery points are kept if this stack is deleted.
    this.backupVault = new backup.BackupVault(this, `${id}-Vault`, {
      backupVaultName: `${id}-Vault`,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const plan = new backup.BackupPlan(this, `${id}-Plan`, {
      backupPlanName: `${id}-DailyPlan`,
      backupVault: this.backupVault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: "Daily35Days",
          // 08:00 UTC is midnight or 01:00 in Vancouver, outside normal use
          scheduleExpression: events.Schedule.cron({ hour: "8", minute: "0" }),
          startWindow: Duration.hours(1),
          completionWindow: Duration.hours(8),
          deleteAfter: Duration.days(35),
        }),
      ],
    });

    const selection = plan.addSelection(`${id}-TaggedResources`, {
      backupSelectionName: `${id}-TaggedResources`,
      resources: [
        backup.BackupResource.fromTag(BACKUP_TAG_KEY, backupTagValue(props.stackPrefix)),
      ],
      allowRestores: true,
    });

    // The default backup and restore policies do not cover S3; AWS Backup needs these for buckets
    // https://docs.aws.amazon.com/aws-backup/latest/devguide/s3-backups.html
    const backupRole = selection.grantPrincipal as iam.Role;
    backupRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSBackupServiceRolePolicyForS3Backup")
    );
    backupRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSBackupServiceRolePolicyForS3Restore")
    );
  }
}
