import { Stack, StackProps, triggers } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";

export class DBFlowStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    db: DatabaseStack,
    props?: StackProps
  ) {
    super(scope, id, props);

    // Create IAM role for Lambda within the VPC
    const lambdaRole = new iam.Role(this, `${id}-lambda-vpc-role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Role for all Lambda functions inside VPC",
    });

    // Add necessary policies to the Lambda role
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          // Secrets Manager
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
        ],
        resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${db.secretPathAdminName}-*`,
        db.secretPathUser.secretArn,
        db.secretPathTableCreator.secretArn,
        ]
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          // CloudWatch Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
        ],
        resources: ["*"],
      })
    );

    // Add additional managed policies
    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMReadOnlyAccess")
    );

    // Create a Lambda layer for node-pg-migrate
    const nodePgMigrateLayer = new lambda.LayerVersion(
      this,
      "nodePgMigrateLayer",
      {
        code: lambda.Code.fromAsset("./layers/node-pg-migrate.zip"),
        compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
        description: "Lambda layer with node-pg-migrate and pg",
      }
    );

    // The initializer connects to the instance directly as the admin user (not through the
    // proxy), so the database admits this security group. The ingress rule is created in this
    // stack as a child of the group, and the trigger runs only after it exists.
    const initializerSecurityGroup = new ec2.SecurityGroup(this, `${id}-InitializerSecurityGroup`, {
      vpc: db.dbInstance.vpc,
      description: "Database initializer and migration runner",
      allowAllOutbound: true,
    });
    // Defined here rather than with connections.allowDefaultPortFrom, which would place the
    // rule in the database stack and make it depend on this one
    new ec2.CfnSecurityGroupIngress(initializerSecurityGroup, "DatabaseIngress", {
      groupId: db.dbInstance.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: initializerSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "Allow PostgreSQL traffic from the database initializer",
    });

    const initializer = new triggers.TriggerFunction(this, `${id}-triggerLambda`, {
      description: `Database initializer and migration runner - ${new Date().toISOString()}`,
      functionName: `${id}-initializerFunction`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      timeout: Duration.seconds(300),
      memorySize: 512,
      environment: {
        DB_SECRET_NAME: db.secretPathAdminName,
        DB_USER_SECRET_NAME: db.secretPathUser.secretName,
        DB_TABLE_CREATOR_SECRET_NAME: db.secretPathTableCreator.secretName,
      },
      vpc: db.dbInstance.vpc,
      securityGroups: [initializerSecurityGroup],
      code: lambda.Code.fromAsset("lambda/db_setup"),
      layers: [nodePgMigrateLayer],
      role: lambdaRole,
    });
    initializer.executeAfter(initializerSecurityGroup);
  }
}
