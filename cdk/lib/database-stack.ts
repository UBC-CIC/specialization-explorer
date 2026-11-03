import { Stack, StackProps, RemovalPolicy, SecretValue, Token } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";

import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";

import { VpcStack } from "./vpc-stack";

export class DatabaseStack extends Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly secretPathAdminName: string;
  public readonly secretPathUser: secretsmanager.Secret;
  public readonly secretPathTableCreator: secretsmanager.Secret;
  public readonly rdsProxyEndpoint: string;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    props?: StackProps
  ) {
    super(scope, id, props);

    const serviceLinkedRole = new cr.AwsCustomResource(
      this,
      `${id}-RDSServiceLinkedRoleResource`,
      {
      onCreate: {
        service: "IAM",
        action: "createServiceLinkedRole",
        parameters: {
          AWSServiceName: "rds.amazonaws.com",
        },
        ignoreErrorCodesMatching: "InvalidInput",
        physicalResourceId: cr.PhysicalResourceId.of("RDSServiceLinkedRole"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      }
    );
    /**
     * Retrieve a secret from Secret Manager
     */
    const secret = secretmanager.Secret.fromSecretNameV2(
      this,
      "ImportedSecrets",
      "SpecExSecrets"
    );

    /**
     * Create Secrets for various users
     */
    this.secretPathAdminName = `${id}-SpecEx/credentials/rdsDbCredential`;
    const secretPathUserName = `${id}-SpecEx/userCredentials/rdsDbCredential`;
    this.secretPathUser = new secretsmanager.Secret(this, secretPathUserName, {
      secretName: secretPathUserName,
      description: "Secrets for clients to connect to RDS",
      removalPolicy: RemovalPolicy.DESTROY,
      secretObjectValue: {
        username: SecretValue.unsafePlainText("applicationUsername"), // will be changed at runtime
        password: SecretValue.unsafePlainText("applicationPassword"), // will be changed at runtime
      },
    });

    const secretPathTableCreator = `${id}-SpecEx/userCredentials/TableCreator`;
    this.secretPathTableCreator = new secretsmanager.Secret(
      this,
      secretPathTableCreator,
      {
        secretName: secretPathTableCreator,
        description: "Secrets for TableCreator to connect to RDS",
        removalPolicy: RemovalPolicy.DESTROY,
        secretObjectValue: {
          username: SecretValue.unsafePlainText("applicationUsername"), // will be changed at runtime
          password: SecretValue.unsafePlainText("applicationPassword"), // will be changed at runtime
        },
      }
    );

    const parameterGroup = new rds.ParameterGroup(
      this,
      `${id}-rdsParameterGroup`,
      {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16_13,
        }),
        description: "Empty parameter group",
        parameters: {
          "rds.force_ssl": "1",
        },
      }
    );

    /**
     * Create the RDS Postgres database
     */
    this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
      vpc: vpcStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_13,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MEDIUM
      ),
      credentials: rds.Credentials.fromUsername(
        secret.secretValueFromJson("DB_Username").unsafeUnwrap(),
        {
          secretName: this.secretPathAdminName,
        }
      ),
      multiAz: false,
      allocatedStorage: 100,
      maxAllocatedStorage: 150,
      allowMajorVersionUpgrade: false,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      autoMinorVersionUpgrade: true,
      backupRetention: Duration.days(7),
      // Keep the automated backups if the instance is deleted, so it can still be restored
      deleteAutomatedBackups: false,
      deletionProtection: true,
      databaseName: "specEx",
      publiclyAccessible: false,
      // Send the engine and upgrade logs to CloudWatch; the retention below applies to these groups
      cloudwatchLogsExports: ["postgresql", "upgrade"],
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      storageEncrypted: true, // storage encryption at rest
      monitoringInterval: Duration.seconds(60), // enhanced monitoring interval
      parameterGroup: parameterGroup,
    });

    // The instance admits only named security groups: the proxy (below), the secret rotation
    // functions (after the rotation schedules) and the database initializer (DBFlow stack).
    // Application functions reach the database through the proxy, so no subnet range is
    // allowed to the instance directly.
    const dbSecurityGroup = this.dbInstance.connections.securityGroups[0];

    // Application functions run in the private and isolated subnets only, so only those
    // ranges can reach the proxy. Public subnets get no path to the database.
    const privateSubnetCidrs: string[] =
      vpcStack.privateSubnetsCidrStrings &&
      vpcStack.privateSubnetsCidrStrings.length > 0
        ? vpcStack.privateSubnetsCidrStrings
        : [
            ...vpcStack.vpc.privateSubnets,
            ...vpcStack.vpc.isolatedSubnets,
          ].map((subnet) => subnet.ipv4CidrBlock);

    // The proxy has its own security group: clients reach the proxy, and only the proxy
    // is allowed through to the instance on behalf of them
    const proxySecurityGroup = new ec2.SecurityGroup(this, `${id}-ProxySecurityGroup`, {
      vpc: vpcStack.vpc,
      description: "RDS Proxy for the application database",
      allowAllOutbound: true,
    });
    privateSubnetCidrs.forEach((cidr) => {
      proxySecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(5432),
        `Allow PostgreSQL traffic from private subnet CIDR range ${cidr}`
      );
    });
    dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(proxySecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      "Allow PostgreSQL traffic from the RDS Proxy"
    );

    /**
     * Create IAM role for RDS Proxy
     */
    const rdsProxyRole = new iam.Role(this, `${id}-DBProxyRole`, {
      assumedBy: new iam.ServicePrincipal("rds.amazonaws.com"),
    });

    /**
     * Create RDS Proxy for database connections with all secrets
     */
    const secretPathAdmin = secretmanager.Secret.fromSecretNameV2(
      this,
      "AdminSecret",
      this.secretPathAdminName
    );

    const rdsProxy = this.dbInstance.addProxy(id + "-proxy", {
      secrets: [
        this.secretPathUser!,
        this.secretPathTableCreator!,
        secretPathAdmin,
      ],
      vpc: vpcStack.vpc,
      role: rdsProxyRole,
      securityGroups: [proxySecurityGroup],
      requireTLS: true,
    });

    rdsProxy.node.addDependency(serviceLinkedRole);

    /**
     * Workaround for TargetGroupName not being set automatically
     */
    let targetGroup = rdsProxy.node.children.find((child: any) => {
      return child instanceof rds.CfnDBProxyTargetGroup;
    }) as rds.CfnDBProxyTargetGroup;

    targetGroup.addPropertyOverride("TargetGroupName", "default");

    /**
     * Grant the role permission to connect to the database
     */
    this.dbInstance.grantConnect(rdsProxyRole);

    this.rdsProxyEndpoint = rdsProxy.endpoint;

    /**
     * Enable automatic secret rotation for database credentials
     * Note: Admin secret rotation already exists in the stack, so we only manage
     * rotation for application user and table creator credentials.
     */
    
    // 1. Admin credentials rotation is already configured - do not create duplicate
    // The existing rotation schedule for secretPathAdmin will remain active.

    // 2. Rotation for application user credentials (multi-user strategy)
    const appUserRotation = secretsmanager.HostedRotation.postgreSqlMultiUser({
      vpc: vpcStack.vpc,
      masterSecret: secretPathAdmin,
      functionName: `${id}-AppUserRotation`,
    });
    this.secretPathUser.addRotationSchedule("AppUserRot", {
      automaticallyAfter: Duration.days(30),
      hostedRotation: appUserRotation,
    });

    // 3. Rotation for table creator credentials (multi-user strategy)
    const tableCreatorRotation = secretsmanager.HostedRotation.postgreSqlMultiUser({
      vpc: vpcStack.vpc,
      masterSecret: secretPathAdmin,
      functionName: `${id}-TableCreatorRotation`,
    });
    this.secretPathTableCreator.addRotationSchedule("TableCreatorRot", {
      automaticallyAfter: Duration.days(30),
      hostedRotation: tableCreatorRotation,
    });

    // The rotation functions log in as the admin user on the instance itself, not through
    // the proxy, so each one's security group is allowed in. Their connections exist only
    // after the rotation schedules above are created.
    this.dbInstance.connections.allowDefaultPortFrom(
      appUserRotation,
      "Allow PostgreSQL traffic from the app user secret rotation function"
    );
    this.dbInstance.connections.allowDefaultPortFrom(
      tableCreatorRotation,
      "Allow PostgreSQL traffic from the table creator secret rotation function"
    );

    // The rotation functions and the proxy write to log groups their services create outside
    // CloudFormation, so the retention is applied to the existing groups.
    // RDS stores proxy names in lowercase, and the proxy's log group uses the stored name.
    // The name CDK writes into the template is a plain string, so it can be lowercased here
    // without changing the proxy itself.
    const cfnProxyName = (rdsProxy.node.defaultChild as rds.CfnDBProxy).dbProxyName;
    const proxyName = Token.isUnresolved(cfnProxyName) ? rdsProxy.dbProxyName : cfnProxyName.toLowerCase();
    [
      `/aws/lambda/${id}-AppUserRotation`,
      `/aws/lambda/${id}-TableCreatorRotation`,
      `/aws/rds/proxy/${proxyName}`,
    ].forEach((logGroupName, index) => {
      new logs.LogRetention(this, `${id}-ServiceLogRetention${index}`, {
        logGroupName,
        retention: logs.RetentionDays.ONE_MONTH,
      });
    });

    // Note: AWS HostedRotation automatically creates and configures:
    // - Rotation Lambda functions in the VPC, each with its own security group
    // - Required IAM permissions for Secrets Manager and RDS
    // - Multi-user strategy creates alternating users (A/B) for zero-downtime rotation
    // The database ingress for those security groups is added above.
  }
}
