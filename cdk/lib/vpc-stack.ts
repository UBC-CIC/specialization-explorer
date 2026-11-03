import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import { Fn } from "aws-cdk-lib";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";

export class VpcStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly vpcCidrString: string;
  public readonly privateSubnetsCidrStrings: string[];

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { stackPrefix: string; environmentName?: string }
  ) {
    super(scope, id, props);
    const existingVpcId: string = ""; // CHANGE IF DEPLOYING WITH EXISTING VPC

    if (existingVpcId !== "") {
      const AWSControlTowerStackSet = ""; // CHANGE TO YOUR CONTROL TOWER STACK SET
      const existingPublicSubnetID: string = ""; // CHANGE IF DEPLOYING WITH EXISTING PUBLIC SUBNET

      const latPrefix = props.stackPrefix;

      const publicSubnetCidr = "172.31.0.0/20"; // CHANGE TO YOUR PUBLIC SUBNET CIDR; IT MUST NOT OVERLAP WITH PRIVATE SUBNETS
      this.vpcCidrString = "172.31.0.0/16";

      // VPC for application
      this.vpc = ec2.Vpc.fromVpcAttributes(this, `${id}-Vpc`, {
        vpcId: existingVpcId,
        availabilityZones: ["ca-central-1a", "ca-central-1b", "ca-central-1d"],
        privateSubnetIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
        ],
        privateSubnetRouteTableIds: [
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet1ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet2ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet3ARouteTable`
          ),
        ],
        isolatedSubnetIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
        ],
        isolatedSubnetRouteTableIds: [
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet1ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet2ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet3ARouteTable`
          ),
        ],
        vpcCidrBlock: Fn.importValue(`${AWSControlTowerStackSet}-VPCCIDR`),
      }) as ec2.Vpc;

      // Extract CIDR ranges from the private subnets
      this.privateSubnetsCidrStrings = [
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3ACIDR`),
      ];

      if (existingPublicSubnetID === "") {
        console.log(
          "No public subnet exists. Creating new public subnet, IGW, and NAT GW."
        );

        // Create a public subnet
        const publicSubnet = new ec2.Subnet(this, `PublicSubnet`, {
          vpcId: this.vpc.vpcId,
          availabilityZone: this.vpc.availabilityZones[0],
          cidrBlock: publicSubnetCidr,
          mapPublicIpOnLaunch: true,
        });

        // Create an Internet Gateway and attach it to the VPC
        const internetGateway = new ec2.CfnInternetGateway(
          this,
          `InternetGateway`,
          {}
        );
        const vpcGatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, "VPCGatewayAttachment", {
          vpcId: this.vpc.vpcId,
          internetGatewayId: internetGateway.ref,
        });

        // Add a NAT Gateway in the public subnet
        const natGateway = new ec2.CfnNatGateway(this, `NatGateway`, {
          subnetId: publicSubnet.subnetId,
          allocationId: new ec2.CfnEIP(this, "EIP", {}).attrAllocationId,
        });

        // Use the route table associated with the public subnet
        const publicRouteTableId = publicSubnet.routeTable.routeTableId;

        // Add a route to the Internet Gateway in the existing public route table
        const publicRoute = new ec2.CfnRoute(this, `PublicRoute`, {
          routeTableId: publicRouteTableId,
          destinationCidrBlock: "0.0.0.0/0",
          gatewayId: internetGateway.ref,
        });
        publicRoute.addDependency(vpcGatewayAttachment);

        // NAT Gateway also needs the IGW attached before it can work
        natGateway.addDependency(vpcGatewayAttachment);

        // Update route table for private subnets
        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute1`, {
          routeTableId: this.vpc.privateSubnets[0].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute2`, {
          routeTableId: this.vpc.privateSubnets[1].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute3`, {
          routeTableId: this.vpc.privateSubnets[2].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });
      } else {
        console.log(
          `Public subnet already exists. Creating NAT GW and private subnet routes.`
        );

        // Reference the existing public subnet
        const existingPublicSubnet = ec2.Subnet.fromSubnetId(
          this,
          "ExistingPublicSubnet",
          existingPublicSubnetID
        );

        // Look up the existing Internet Gateway attached to the VPC
        const igwLookup = new AwsCustomResource(this, "IGWLookup", {
          onCreate: {
            service: "EC2",
            action: "describeInternetGateways",
            parameters: {
              Filters: [
                {
                  Name: "attachment.vpc-id",
                  Values: [existingVpcId],
                },
              ],
            },
            physicalResourceId: PhysicalResourceId.of("igw-lookup"),
          },
          policy: AwsCustomResourcePolicy.fromSdkCalls({
            resources: AwsCustomResourcePolicy.ANY_RESOURCE,
          }),
        });

        const existingIgwId = igwLookup.getResponseField(
          "InternetGateways.0.InternetGatewayId"
        );

        // If no IGW exists, create one and attach it
        // (This is a fallback — most existing VPCs with a public subnet already have an IGW)

        // Add a NAT Gateway in the existing public subnet
        const natGateway = new ec2.CfnNatGateway(this, `NatGateway`, {
          subnetId: existingPublicSubnetID,
          allocationId: new ec2.CfnEIP(this, "EIP", {}).attrAllocationId,
        });

        // Update route table for private subnets to route internet traffic through NAT
        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute1`, {
          routeTableId: this.vpc.privateSubnets[0].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute2`, {
          routeTableId: this.vpc.privateSubnets[1].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute3`, {
          routeTableId: this.vpc.privateSubnets[2].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });
      }

      // Add interface endpoints for private isolated subnets
      this.vpc.addInterfaceEndpoint("SSM Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: true,
      });

      this.vpc.addInterfaceEndpoint("Secrets Manager Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: true,
      });

      // No RDS interface endpoint: it only serves the RDS management API, which nothing calls
      // at runtime. Database traffic goes to RDS Proxy inside the VPC and does not use it.

      this.setFlowLogRetention(this.vpc.addFlowLog(`${id}-vpcFlowLog`), props.environmentName);

      // Add S3 gateway endpoint
      this.vpc.addGatewayEndpoint(`${id}-S3 Endpoint`, {
        service: ec2.GatewayVpcEndpointAwsService.S3,
        subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
      });

      // Get default security group for VPC
      const defaultSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        id,
        this.vpc.vpcDefaultSecurityGroup
      );
    } else {
      this.vpcCidrString = "10.0.0.0/16";

      const natGatewayProvider = ec2.NatProvider.gateway();

      // VPC for application
      this.vpc = new ec2.Vpc(this, "SpecEx-Vpc", {
        ipAddresses: ec2.IpAddresses.cidr(this.vpcCidrString),
        natGatewayProvider: natGatewayProvider,
        natGateways: 1,
        maxAzs: 2,
        subnetConfiguration: [
          {
            name: "public-subnet-1",
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            name: "private-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          {
            name: "isolated-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        ],
      });

      this.setFlowLogRetention(this.vpc.addFlowLog("specEx-vpcFlowLog"), props.environmentName);

      // Add secrets manager endpoint to VPC
      this.vpc.addInterfaceEndpoint(`${id}-Secrets Manager Endpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });

      // No RDS interface endpoint: it only serves the RDS management API, which nothing calls
      // at runtime. Database traffic goes to RDS Proxy inside the VPC and does not use it.
      // Any management call (for example from the hosted rotation functions) leaves through NAT.

      // Add S3 gateway endpoint
      this.vpc.addGatewayEndpoint(`${id}-S3 Endpoint`, {
        service: ec2.GatewayVpcEndpointAwsService.S3,
        subnets: [
          { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        ],
      });
    }
  }

  // Flow logs keep 90 days in dev; other environments keep CDK's two-year default
  private setFlowLogRetention(flowLog: ec2.FlowLog, environmentName?: string) {
    if ((environmentName ?? "dev") !== "dev") return;
    const logGroup = flowLog.node.tryFindChild("LogGroup");
    if (logGroup instanceof logs.LogGroup) {
      (logGroup.node.defaultChild as logs.CfnLogGroup).retentionInDays = logs.RetentionDays.THREE_MONTHS;
    }
  }
}
