import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Code, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Fn } from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cr from "aws-cdk-lib/custom-resources";

interface ApiGatewayStackProps extends cdk.StackProps {
  ecrRepositories: { [key: string]: ecr.Repository };
  knowledgeBaseBucket: s3.IBucket;
}

export class ApiGatewayStack extends cdk.Stack {
  private readonly api: apigateway.SpecRestApi;
  public readonly appClient: cognito.UserPoolClient;
  public readonly userPool: cognito.UserPool;
  public readonly identityPool: cognito.CfnIdentityPool;
  private readonly layerList: { [key: string]: lambda.ILayerVersion };
  public readonly stageARN_APIGW: string;
  public readonly apiGW_basedURL: string;
  private eventApi: appsync.GraphqlApi;
  public readonly secret: secretsmanager.ISecret;
  public getEndpointUrl = () => this.api.url;
  public getUserPoolId = () => this.userPool.userPoolId;
  public getEventApiUrl = () => this.eventApi.graphqlUrl;
  public getUserPoolClientId = () => this.appClient.userPoolClientId;
  public getIdentityPoolId = () => this.identityPool.ref;
  public addLayer = (name: string, layer: lambda.ILayerVersion) =>
    (this.layerList[name] = layer);
  public getLayers = () => this.layerList;
  private readonly webSocketApi?: apigatewayv2.WebSocketApi;
  private readonly wsStage?: apigatewayv2.CfnStage;
  public getWebSocketUrl = () => this.webSocketApi?.apiEndpoint ?? "";
  public getStageName = () => this.wsStage?.stageName ?? "";

  constructor(
    scope: Construct,
    id: string,
    db: DatabaseStack,
    vpcStack: VpcStack,
    props: ApiGatewayStackProps
  ) {
    super(scope, id, props);


    const crParams = {
      service: 'SSM',
      action: 'putParameter',
      parameters: {
        Name: '/SpecEx/API/AllowedOrigins',
        Value: '*',
        Type: 'String',
        Description: 'List of allowed CORS origins for the API',
      },
      physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
      ignoreErrorCodesMatching: 'ParameterAlreadyExists',
    };

    const initAllowedOrigins = new cr.AwsCustomResource(this, 'InitAllowedOriginsParamV2', {
      onCreate: crParams,
      onUpdate: crParams,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:PutParameter'],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`
          ],
        }),
      ]),
    });

    
    this.layerList = {};
    /**
     *
     * Create Integration Lambda layer for aws-jwt-verify
     */
    const jwt = new lambda.LayerVersion(this, "aws-jwt-verify", {
      code: lambda.Code.fromAsset("./layers/aws-jwt-verify.zip"),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: "Contains the aws-jwt-verify library for JS",
    });

    /**
     *
     * Create Integration Lambda layer for PSQL
     */
    const postgres = new lambda.LayerVersion(this, "postgres", {
      code: lambda.Code.fromAsset("./layers/postgres.zip"),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: "Contains the postgres library for JS",
    });

    /**
     *
     * Create Lambda layer for Psycopg2
     */
    const psycopgLayer = new lambda.LayerVersion(this, "psycopgLambdaLayer", {
      code: lambda.Code.fromAsset("./layers/psycopg2.zip"),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: "Lambda layer containing the psycopg2 Python library",
    });

    // powertoolsLayer does not follow the format of layerList
    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      `${id}-PowertoolsLayer`,
      `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:78`
    );

    this.layerList["jwt"] = jwt;
    this.layerList["postgres"] = postgres;
    this.layerList["psycopg2"] = psycopgLayer;
    this.layerList["powertools"] = powertoolsLayer;

    const userPoolName = `${id}-UserPool`;
    this.userPool = new cognito.UserPool(this, `${id}-pool`, {
      userPoolName: userPoolName,
      signInAliases: {
        email: true,
      },
      selfSignUpEnabled: true,
      autoVerify: {
        email: true,
      },
      userVerification: {
        emailSubject: "Specialization Explorer - Verify your email",
        emailBody: `
                    <html>
                        <head>
                            <style>
                            body {
                                font-family: Outfit, sans-serif;
                                background-color: #F5F5F5;
                                color: #111835;
                                margin: 0;
                                padding: 0;
                                font-size: 16px;
                            }
                            .email-container {
                                background-color: #ffffff;
                                width: 100%;
                                max-width: 600px;
                                margin: 0 auto;
                                padding: 20px;
                                border-radius: 8px;
                                border: 1px solid #ddd;
                            }
                            .header {
                                text-align: center;
                                margin-bottom: 20px;
                            }
                            .header img {
                                width: 100px;
                                height: auto;
                            }
                            .main-content {
                                text-align: center;
                                font-size: 18px;
                                color: #444;
                                margin-bottom: 30px;
                            }
                            .code {
                                display: inline-block;
                                background-color: #111835;
                                color: #ffffff;
                                font-size: 24px;
                                font-weight: bold;
                                padding: 15px 25px;
                                border-radius: 4px;
                                margin-top: 20px;
                                margin-bottom: 20px;
                            }
                            .footer {
                                text-align: center;
                                font-size: 14px;
                                color: #888;
                            }
                            .footer a {
                                color: #546bdf;
                                text-decoration: none;
                            }
                            </style>
                            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap" rel="stylesheet">
                        </head>
                        <body>
                            <div class="email-container">
                            <div class="header">
                                <h1>Specialization Explorer</h1>
                            </div>
                            <div class="main-content">
                                <p>Thank you for signing up for Specialization Explorer!</p>
                                <p>Verify your email by using the code below:</p>
                                <div class="code">{####}</div>
                                <p>If you did not request this verification, please ignore this email.</p>
                            </div>
                            <div class="footer">
                                <p>Please do not reply to this email.</p>
                                <p>Specialization Explorer, 2025</p>
                            </div>
                            </div>
                        </body>
                    </html>
          `,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      passwordPolicy: {
        minLength: 10,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create app client
    this.appClient = this.userPool.addClient(`${id}-pool`, {
      userPoolClientName: userPoolName,
      authFlows: {
        userPassword: true,
        custom: true,
        userSrp: true,
      },
    });

    this.identityPool = new cognito.CfnIdentityPool(
      this,
      `${id}-identity-pool`,
      {
        allowUnauthenticatedIdentities: true,
        identityPoolName: `${id}IdentityPool`,
        cognitoIdentityProviders: [
          {
            clientId: this.appClient.userPoolClientId,
            providerName: this.userPool.userPoolProviderName,
          },
        ],
      }
    );

    const secretsName = `${id}-SpecEx_Cognito_Secrets`;
    this.secret = new secretsmanager.Secret(this, secretsName, {
      secretName: secretsName,
      description: "Cognito Secrets for authentication",
      secretObjectValue: {
        VITE_COGNITO_USER_POOL_ID: cdk.SecretValue.unsafePlainText(
          this.userPool.userPoolId
        ),
        VITE_COGNITO_USER_POOL_CLIENT_ID: cdk.SecretValue.unsafePlainText(
          this.appClient.userPoolClientId
        ),
        VITE_AWS_REGION: cdk.SecretValue.unsafePlainText(this.region),
        VITE_IDENTITY_POOL_ID: cdk.SecretValue.unsafePlainText(
          this.identityPool.ref
        ),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // create CloudWatch logs role required for WebSocket access logs
    const apiGatewayLogsRole = new iam.Role(this, "ApiGatewayCloudWatchLogsRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonAPIGatewayPushToCloudWatchLogs"
        ),
      ],
    });

    const apiGatewayAccount = new apigateway.CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: apiGatewayLogsRole.roleArn,
    });

    // Create roles and policies
    const createPolicyStatement = (actions: string[], resources: string[]) => {
      return new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: actions,
        resources: resources,
      });
    };

    const asset = new Asset(this, "SampleAsset", {
      path: "OpenAPI_Swagger_Definition.yaml",
    });

    const data = Fn.transform("AWS::Include", { Location: asset.s3ObjectUrl });

    const accessLogGroup = new logs.LogGroup(this, `${id}-ApiAccessLogs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create the API Gateway REST API
    this.api = new apigateway.SpecRestApi(this, `${id}-APIGateway`, {
      apiDefinition: apigateway.AssetApiDefinition.fromInline(data),
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      restApiName: `${id}-API`,
      deploy: true,
      cloudWatchRole: true,
      deployOptions: {
        stageName: "prod",
        tracingEnabled: true,
        description: "Deployment with flashcard support - Nov 18 2025",
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
        
        accessLogDestination: new apigateway.LogGroupLogDestination(
          accessLogGroup
        ),
        
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        
        methodOptions: {
          // Default for all endpoints
          "/*/*": {
            throttlingRateLimit: 100,
            throttlingBurstLimit: 200,
          },

          // FREQUENT: Public token endpoint
          "/user/publicToken/GET": {
            throttlingRateLimit: 50,
            throttlingBurstLimit: 100,
          },
        },
      },
    });

    this.stageARN_APIGW = this.api.deploymentStage.stageArn;
    this.apiGW_basedURL = this.api.urlForPath();

    // Waf Firewall - Enhanced with endpoint-specific and authentication-aware rate limiting
    const waf = new wafv2.CfnWebACL(this, `${id}-waf`, {
      description: "WAF for SpecEx",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "specEx-firewall",
      },
      rules: [
        // Rule 1: AWS Managed Common Rule Set (SQL injection, XSS, etc.)
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet",
          },
        },

        // Rule 2: Strict limit for unauthenticated requests (100 req/5min per IP)
        {
          name: "LimitUnauthenticatedRequests",
          priority: 2,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 100, // Reduced from 1000 to 100 for anonymous users
              aggregateKeyType: "IP",
              scopeDownStatement: {
                // Only apply to requests WITHOUT Authorization header
                notStatement: {
                  statement: {
                    byteMatchStatement: {
                      searchString: "Bearer",
                      fieldToMatch: {
                        singleHeader: {
                          name: "authorization",
                        },
                      },
                      textTransformations: [
                        {
                          priority: 0,
                          type: "NONE",
                        },
                      ],
                      positionalConstraint: "CONTAINS",
                    },
                  },
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitUnauthenticatedRequests",
          },
        },

        // Rule 3: More lenient for authenticated requests (2000 req/5min per IP)
        {
          name: "LimitAuthenticatedRequests",
          priority: 3,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 2000, // Increased from 1000 to 2000 for authenticated users
              aggregateKeyType: "IP",
              scopeDownStatement: {
                // Only apply to requests WITH Authorization header
                byteMatchStatement: {
                  searchString: "Bearer",
                  fieldToMatch: {
                    singleHeader: {
                      name: "authorization",
                    },
                  },
                  textTransformations: [
                    {
                      priority: 0,
                      type: "NONE",
                    },
                  ],
                  positionalConstraint: "CONTAINS",
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitAuthenticatedRequests",
          },
        },

        // Rule 4: Moderate limit for expensive AI endpoints (500 req/5min per IP)
        {
          name: "LimitExpensiveEndpoints",
          priority: 4,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 1000, // 500 reqs / 5 mins prevents abuse while allowing rapid conversational flow
              aggregateKeyType: "IP",
              scopeDownStatement: {
                // Apply to chat_sessions endpoints
                byteMatchStatement: {
                  searchString: "/chat_sessions",
                  fieldToMatch: {
                    uriPath: {},
                  },
                  textTransformations: [
                    {
                      priority: 0,
                      type: "NONE",
                    },
                  ],
                  positionalConstraint: "CONTAINS",
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitExpensiveEndpoints",
          },
        },
      ],
    });

    // Custom Response for WAF Blocks (Returns 429 instead of 403)
    this.api.addGatewayResponse(`${id}-WafBlockResponse`, {
      type: apigateway.ResponseType.WAF_FILTERED,
      statusCode: "429",
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
        "Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE'",
      },
      templates: {
        "application/json": JSON.stringify({
          error: "Rate limit exceeded. Please wait a few minutes before chatting again."
        })
      }
    });

    // Add Default 4XX Gateway Response to prevent CORS errors on bad requests
    this.api.addGatewayResponse(`${id}-Default4XXResponse`, {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
        "Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE'",
      },
    });

    // Add Default 5XX Gateway Response to prevent CORS errors on server errors (like Throttling)
    this.api.addGatewayResponse(`${id}-Default5XXResponse`, {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
        "Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE'",
      },
    });

    const wafAssociation = new wafv2.CfnWebACLAssociation(
      this,
      `${id}-waf-association`,
      {
        resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`,
        webAclArn: waf.attrArn,
      }
    );

    wafAssociation.node.addDependency(this.api.deploymentStage);

    const adminRole = new iam.Role(this, `${id}-AdminRole`, {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    adminRole.attachInlinePolicy(
      new iam.Policy(this, `${id}-AdminPolicy`, {
        statements: [
          createPolicyStatement(
            ["execute-api:Invoke"],
            [
              `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin/*`,
              `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/instructor/*`,
              `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/user/*`,
            ]
          ),
        ],
      })
    );

    const unauthenticatedRole = new iam.Role(
      this,
      `${id}-UnauthenticatedRole`,
      {
        assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "unauthenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
        ),
      }
    );

    const adminGroup = new cognito.CfnUserPoolGroup(this, `${id}-AdminGroup`, {
      groupName: "admin",
      userPoolId: this.userPool.userPoolId,
      roleArn: adminRole.roleArn,
    });

    const lambdaRole = new iam.Role(this, `${id}-postgresLambdaRole`, {
      roleName: `${id}-postgresLambdaRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });


    // Grant access to specific secrets instead of '*'
    db.secretPathUser.grantRead(lambdaRole);
    this.secret.grantRead(lambdaRole);

    // Explicitly grant access to the KnowledgeBase ID secret without using a broad wildcard
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*KnowledgeBase/Id-*`,
        ],
      })
    );

    // Grant access to EC2
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"], // must be *
      })
    );

    // Grant access to log
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    // Grant X-Ray tracing permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      })
    );

    // Inline policy to allow AdminAddUserToGroup action
    const adminAddUserToGroupPolicyLambda = new iam.Policy(
      this,
      `${id}-adminAddUserToGroupPolicyLambda`,
      {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "cognito-idp:AdminAddUserToGroup",
              "cognito-idp:AdminRemoveUserFromGroup",
              "cognito-idp:AdminGetUser",
              "cognito-idp:AdminListGroupsForUser",
            ],
            resources: [
              `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${this.userPool.userPoolId}`,
            ],
          }),
        ],
      }
    );
    lambdaRole.attachInlinePolicy(adminAddUserToGroupPolicyLambda);

    const coglambdaRole = new iam.Role(
      this,
      `${id}-cognitoLambdaRole-${this.region}`,
      {
        roleName: `${id}-cognitoLambdaRole-${this.region}`,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      }
    );

    // Grant access to specific secret instead of '*'
    db.secretPathTableCreator.grantRead(coglambdaRole);

    // Grant access to EC2
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"], // must be *
      })
    );

    // Grant access to log
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    // Grant permission to add users to an IAM group
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:AddUserToGroup"],
        resources: [
          `arn:aws:iam::${this.account}:user/*`,
          `arn:aws:iam::${this.account}:group/*`,
        ],
      })
    );

    // Redundant secrets manager access block removed

    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/*`],
      })
    );

    // Attach roles to the identity pool
    new cognito.CfnIdentityPoolRoleAttachment(this, `${id}-IdentityPoolRoles`, {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: adminRole.roleArn,
        unauthenticated: unauthenticatedRole.roleArn,
      },
    });

    const jwtSecret = new secretsmanager.Secret(this, `${id}-JwtSecret`, {
      secretName: `${id}-SpecEx-JWTSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "jwtSecret",
        excludePunctuation: false,
        excludeCharacters: '"@/\\\'',
        passwordLength: 128,
      },
    });

    const adminAuthorizationFunction = new lambda.Function(
      this,
      `${id}-admin-authorization-api-gateway`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda/adminAuthorizerFunction"),
        handler: "adminAuthorizerFunction.handler",
        timeout: Duration.seconds(300),
        vpc: vpcStack.vpc,
        environment: {
          SM_COGNITO_CREDENTIALS: this.secret.secretName,
        },
        functionName: `${id}-adminLambdaAuthorizer`,
        memorySize: 512,
        layers: [jwt],
        role: lambdaRole,
      }
    );

    adminAuthorizationFunction.grantInvoke(
      new iam.ServicePrincipal("apigateway.amazonaws.com")
    );

    const apiGW_authorizationFunction = adminAuthorizationFunction.node
      .defaultChild as lambda.CfnFunction;
    apiGW_authorizationFunction.overrideLogicalId("adminLambdaAuthorizer");

    const userAuthFunction = new lambda.Function(
      this,
      `${id}-user-authorization-api-gateway`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda/authorization"),
        handler: "userAuthorizerFunction.handler",
        timeout: Duration.seconds(300),
        memorySize: 256,
        layers: [jwt],
        role: lambdaRole,
        environment: {
          JWT_SECRET: jwtSecret.secretArn,
        },
        functionName: `${id}-userLambdaAuthorizer`,
      }
    );
    jwtSecret.grantRead(userAuthFunction);
    userAuthFunction.grantInvoke(
      new iam.ServicePrincipal("apigateway.amazonaws.com")
    );

    const apiGW_userauthorizationFunction = userAuthFunction.node
      .defaultChild as lambda.CfnFunction;
    apiGW_userauthorizationFunction.overrideLogicalId("userLambdaAuthorizer");

    const publicTokenLambda = new lambda.Function(
      this,
      `${id}-PublicTokenFunction`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "publicTokenFunction.handler",
        layers: [jwt],
        code: lambda.Code.fromAsset("lambda/publicTokenFunction"),
        environment: {
          JWT_SECRET: jwtSecret.secretArn,
        },
        timeout: Duration.seconds(30),
        memorySize: 128,
        role: lambdaRole,
      }
    );

    jwtSecret.grantRead(publicTokenLambda);

    // Add the permission to the Lambda function's policy to allow API Gateway access
    publicTokenLambda.grantInvoke(
      new iam.ServicePrincipal("apigateway.amazonaws.com")
    );

    // Change Logical ID to match the one decleared in YAML file of Open API
    const apiGW_publicTokenFunction = publicTokenLambda.node
      .defaultChild as lambda.CfnFunction;
    apiGW_publicTokenFunction.overrideLogicalId("PublicTokenFunction");

    const preSignupLambda = new lambda.Function(this, `preSignupLambda`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset("lambda/authorization"),
      handler: "preSignUp.handler",
      timeout: Duration.seconds(300),
      environment: {
        ALLOWED_EMAIL_DOMAINS: "/SpecEx/AllowedEmailDomains",
      },
      vpc: vpcStack.vpc,
      functionName: `${id}-preSignupLambda`,
      memorySize: 128,
      role: coglambdaRole,
    });

    preSignupLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    preSignupLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    publicTokenLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    publicTokenLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    userAuthFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    userAuthFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    adminAuthorizationFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    adminAuthorizationFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));

    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_SIGN_UP,
      preSignupLambda
    );

    const AutoSignupLambda = new lambda.Function(
      this,
      `${id}-addAdminOnSignUp`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda/authorization"),
        handler: "addAdminOnSignUp.handler",
        timeout: Duration.seconds(300),
        environment: {
          SM_DB_CREDENTIALS: db.secretPathTableCreator.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
        vpc: vpcStack.vpc,
        functionName: `${id}-addMemberOnSignUp`,
        memorySize: 128,
        layers: [postgres],
        role: coglambdaRole,
      }
    );
    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      AutoSignupLambda
    );



    // --- ECR Image Waiter code removed as it's handled in KnowledgeBaseStack ---

    const lambdaTextGen = new lambda.Function(
      this,
      `${id}-lambdaTextGen`,
      {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "main.handler",
        code: lambda.Code.fromAsset("lambda/textGeneration"),
        timeout: cdk.Duration.seconds(60),
        role: lambdaRole,
        layers: [psycopgLayer],
        vpc: vpcStack.vpc,
        tracing: lambda.Tracing.ACTIVE,
        memorySize: 512,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          REGION: this.region,
          LLM_REGION: "us-west-2",
          HAIKU_ARN: "/SpecEx/LLM/HaikuArn",
          SONNET_ARN: "/SpecEx/LLM/SonnetArn"
        },
      }
    )

    // Override the Logical ID
    const cfnlambdaTextGen = lambdaTextGen.node
      .defaultChild as lambda.CfnFunction;
    cfnlambdaTextGen.overrideLogicalId("lambdaTextGen");

    // API Gateway permissions

    lambdaTextGen.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/chat_sessions*`,
    });

    lambdaTextGen.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    lambdaTextGen.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/LLM/HaikuArn`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/LLM/SonnetArn`
      ],
    }));


    AutoSignupLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    AutoSignupLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    // Bedrock permissions
    const textGenBedrockPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:GetInferenceProfile",
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream", // Add streaming permission
        "bedrock:Retrieve", // Add Retrieve permission for Knowledge Base
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/meta.llama3-70b-instruct-v1:0`,
        `arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-v4:0`,
        // Mistral Large
        `arn:aws:bedrock:${this.region}::foundation-model/mistral.mistral-large-2402-v1:0`,
        // Claude Sonnet 3 (Direct Foundation Models)
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
        // Claude Sonnet 4.6 (Converse currently resolves this model in us-west-2)
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
        // Claude Haiku 4.5 (Converse currently resolves this model in us-west-2)
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
        // Knowledge Base
        `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`,
      ],
    });
    lambdaTextGen.addToRolePolicy(textGenBedrockPolicyStatement);

    // lambdaRole already has read access to db.secretPathUser through the stack-wide policy



    // --- Knowledge Base Lambda Function ---
    const lambdaKnowledgeBase = new lambda.Function(this, `${id}-lambdaKnowledgeBase`, {
      functionName: `${id}-lambdaKnowledgeBase`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "main.handler",
      code: lambda.Code.fromAsset("lambda/knowledgeBase"),
      timeout: Duration.seconds(300),
      role: lambdaRole,
      layers: [psycopgLayer],
      memorySize: 512,
      vpc: vpcStack.vpc,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        REGION: this.region,
        SCHEDULER_ROLE_ARN: `arn:aws:iam::${this.account}:role/${id}-schedulerInvokeRole`,
        SCHEDULER_TARGET_ARN: `arn:aws:lambda:${this.region}:${this.account}:function:${id}-lambdaKnowledgeBase`,
        KNOWLEDGE_BASE_BUCKET_NAME: props.knowledgeBaseBucket.bucketName,
      },
    });

    lambdaKnowledgeBase.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    lambdaKnowledgeBase.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    const cfnLambdaKnowledgeBase = lambdaKnowledgeBase.node.defaultChild as lambda.CfnFunction;
    cfnLambdaKnowledgeBase.overrideLogicalId("lambdaKnowledgeBase");

    lambdaKnowledgeBase.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin/*`,
    });

    // lambdaRole already has read access to db.secretPathUser through the stack-wide policy

    // Tightly scopes S3 permissions to only the target knowledge base bucket
    props.knowledgeBaseBucket.grantReadWrite(lambdaKnowledgeBase);

    lambdaKnowledgeBase.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:ListDataSources",
          "bedrock:GetDataSource",
          "bedrock:CreateDataSource",
          "bedrock:UpdateDataSource",
          "bedrock:ListIngestionJobs",
          "bedrock:GetIngestionJob",
          "bedrock:StartIngestionJob",
        ],
        // Tightly scopes Bedrock APIs specifically to knowledge bases
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`,
        ],
      })
    );

    lambdaKnowledgeBase.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*KnowledgeBase/Id/playground-*`, //TODO: remove this as we'll merge to a single knowledge base
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*KnowledgeBase/Id-*`
        ],
      })
    );
    lambdaKnowledgeBase.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "scheduler:CreateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
        ],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/*`,
        ],
      })
    );

    // EventBridge Scheduler role to invoke this Lambda function
    const schedulerInvokeRole = new iam.Role(this, `${id}-schedulerInvokeRole`, {
      roleName: `${id}-schedulerInvokeRole`,
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });

    schedulerInvokeRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:${id}-lambdaKnowledgeBase`,
        ],
      })
    );
    
    // Scheduler also requires the caller to be allowed to pass the target role
    lambdaKnowledgeBase.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/${id}-schedulerInvokeRole`,
        ],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "scheduler.amazonaws.com",
          },
        },
      })
    );

    const lambdaUserFunction = new lambda.Function(this, `${id}-userFunction`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "handlers/userHandler.handler",
      timeout: Duration.seconds(300),
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        USER_POOL: this.userPool.userPoolId,
      },
      functionName: `${id}-userFunction`,
      memorySize: 512,
      layers: [postgres],
      role: lambdaRole,
      tracing: lambda.Tracing.ACTIVE,
    });

    lambdaUserFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    lambdaUserFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    lambdaUserFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/member*`,
    });

    //TODO: REMOVE IN PRODUCTION
    lambdaUserFunction.addPermission("AllowTestInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/test-invoke-stage/*/*`,
    });

    const cfnLambda_user = lambdaUserFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_user.overrideLogicalId("userFunction");

    const lambdaSystemMessagesFunction = new lambda.Function(this, `${id}-systemMessagesFunction`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "handlers/systemMessagesHandler.handler",
      timeout: Duration.seconds(300),
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        USER_POOL: this.userPool.userPoolId,
      },
      functionName: `${id}-systemMessagesFunction`,
      memorySize: 512,
      layers: [postgres],
      role: lambdaRole,
      tracing: lambda.Tracing.ACTIVE,
    });

    lambdaSystemMessagesFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    lambdaSystemMessagesFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    lambdaSystemMessagesFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/member*`,
    });

    lambdaSystemMessagesFunction.addPermission("AllowTestInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/test-invoke-stage/*/*`,
    });

    const cfnLambda_systemMessages = lambdaSystemMessagesFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_systemMessages.overrideLogicalId("systemMessagesFunction");




    lambdaUserFunction.addPermission("AllowAdminApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/user*`,
    });

    lambdaSystemMessagesFunction.addPermission("AllowAdminApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/system_message*`,
    });


    const lambdaChatSessionFunction = new lambda.Function(
      this,
      `${id}-chatSessionFunction`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda"),
        handler: "handlers/chatSessionHandler.handler",
        timeout: Duration.seconds(300),
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
        functionName: `${id}-chatSessionFunction`,
        memorySize: 512,
        layers: [postgres],
        role: lambdaRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    // Allow API Gateway to invoke for shared chat endpoints (public access)
    lambdaChatSessionFunction.addPermission("AllowApiGatewayInvokeShared", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/chat_sessions*`,
    });

    lambdaChatSessionFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    lambdaChatSessionFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    const cfnLambda_chatSession = lambdaChatSessionFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_chatSession.overrideLogicalId("chatSessionFunction");

    const lambdaAdminFunction = new lambda.Function(
      this,
      `${id}-adminFunction`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda"),
        handler: "handlers/adminHandler.handler",
        timeout: Duration.seconds(300),
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,

        },
        functionName: `${id}-adminFunction`,
        memorySize: 512,
        layers: [postgres],
        role: lambdaRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    lambdaAdminFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });

    lambdaAdminFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    lambdaAdminFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    //TODO: REMOVE IN PRODUCTION - allows invoking admin Lambda from API Gateway test stage for easier testing
    lambdaAdminFunction.addPermission("AllowTestInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/test-invoke-stage/*/*`,
    });

    const cfnLambda_admin = lambdaAdminFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_admin.overrideLogicalId("adminFunction");

    // Define WebSocket API and related resources directly in ApiGatewayStack
    this.webSocketApi = new apigatewayv2.WebSocketApi(
      this,
      `${id}-ChatWebSocketApi`,
      {
        apiName: `${id}-chat-websocket`,
      }
    );

    // Connect Lambda
    const connectFunction = new lambda.Function(this, `${id}-ConnectFunction`, {
      functionName: `${id}-ConnectFunction`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "connect.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        JWT_SECRET: jwtSecret.secretArn,
      },
      layers: [jwt],
    });

    connectFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    connectFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    // Disconnect Lambda
    const disconnectFunction = new lambda.Function(
      this,
      `${id}-DisconnectFunction`,
      {
        functionName: `${id}-DisconnectFunction`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "disconnect.handler",
        code: lambda.Code.fromAsset("lambda/websocket"),
        timeout: cdk.Duration.seconds(30),
      }
    );

    // Default route Lambda for handling messages
    const defaultFunction = new lambda.Function(this, `${id}-DefaultFunction`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "default.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        TEXT_GEN_FUNCTION_NAME: lambdaTextGen.functionName,
      },
      functionName: `${id}-DefaultFunction`,
    });

    defaultFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    defaultFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    disconnectFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', '/SpecEx/API/AllowedOrigins');
    disconnectFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/API/AllowedOrigins`],
    }));


    // Grant permissions to post to connections
    const wsPolicy = new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/*/*`,
      ],
    });

    lambdaTextGen.addToRolePolicy(wsPolicy);
    connectFunction.addToRolePolicy(wsPolicy);
    disconnectFunction.addToRolePolicy(wsPolicy);
    defaultFunction.addToRolePolicy(wsPolicy);

    jwtSecret.grantRead(connectFunction);
    // Grant the default function permission to invoke the text generation function
    lambdaTextGen.grantInvoke(defaultFunction);

    // Routes
    new apigatewayv2.WebSocketRoute(this, `${id}-ConnectRoute`, {
      webSocketApi: this.webSocketApi,
      routeKey: "$connect",
      integration: new WebSocketLambdaIntegration(
        `${id}-ConnectIntegration`,
        connectFunction
      ),
    });

    new apigatewayv2.WebSocketRoute(this, `${id}-DisconnectRoute`, {
      webSocketApi: this.webSocketApi,
      routeKey: "$disconnect",
      integration: new WebSocketLambdaIntegration(
        `${id}-DisconnectIntegration`,
        disconnectFunction
      ),
    });

    new apigatewayv2.WebSocketRoute(this, `${id}-DefaultRoute`, {
      webSocketApi: this.webSocketApi,
      routeKey: "$default",
      integration: new WebSocketLambdaIntegration(
        `${id}-DefaultIntegration`,
        defaultFunction
      ),
    });

    // Create CloudWatch Log Group for WebSocket access logs
    const wsAccessLogGroup = new logs.LogGroup(
      this,
      `${id}-WebSocketAccessLogs`,
      {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // Stage (using CfnStage to enable access log settings for WebSocket API)
    this.wsStage = new apigatewayv2.CfnStage(this, `${id}-ProdCfnStage`, {
      apiId: this.webSocketApi?.apiId,
      stageName: "prod",
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: wsAccessLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          requestTime: "$context.requestTime",
          routeKey: "$context.routeKey",
          connectionId: "$context.connectionId",
          message: "$context.message",
          status: "$context.status",
        }),
      },
    });

    this.wsStage.node.addDependency(apiGatewayAccount);

    // Add environment variable to text generation function (include stage name)
    lambdaTextGen.addEnvironment(
      "WEBSOCKET_API_ENDPOINT",
      `${this.webSocketApi.apiEndpoint}/${this.wsStage.stageName}`
    );

    // Add WebSocket URL as stack output
    new cdk.CfnOutput(this, "WebSocketUrl", {
      value: this.webSocketApi.apiEndpoint,
      description: "WebSocket URL for real-time streaming",
      exportName: `${id}-WebSocketUrl`,
    });

  }
}
