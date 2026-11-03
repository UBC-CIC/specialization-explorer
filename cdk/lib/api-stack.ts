import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Code, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { WebSocketLambdaAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
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
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as crypto from 'crypto';

function computeConfigHash(config: object): string {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

interface ApiGatewayStackProps extends cdk.StackProps {
  ecrRepositories: { [key: string]: ecr.Repository };
  knowledgeBaseBucket: s3.IBucket;
  knowledgeBaseSecret: secretsmanager.ISecret;
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.SpecRestApi;
  public readonly appClient: cognito.UserPoolClient;
  public readonly userPool: cognito.UserPool;
  public readonly identityPool: cognito.CfnIdentityPool;
  private readonly layerList: { [key: string]: lambda.ILayerVersion };
  public readonly stageARN_APIGW: string;
  public readonly apiGW_basedURL: string;
  public readonly secret: secretsmanager.ISecret;
  public readonly allowedOriginsParamName: string;
  public getEndpointUrl = () => this.api.url;
  public getUserPoolId = () => this.userPool.userPoolId;
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

    
    this.layerList = {};
    /**
     *
     * Create Integration Lambda layer for aws-jwt-verify
     */
    const jwt = new lambda.LayerVersion(this, "aws-jwt-verify", {
      code: lambda.Code.fromAsset("./layers/aws-jwt-verify.zip"),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
      description: "Contains the aws-jwt-verify library for JS",
    });

    /**
     *
     * Create Integration Lambda layer for PSQL
     */
    const postgres = new lambda.LayerVersion(this, "postgres", {
      code: lambda.Code.fromAsset("./layers/postgres.zip"),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
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

    // Create Allowed Origin Parameters
      this.allowedOriginsParamName = `/${id}/API/AllowedOrigins`;
      const crParams = {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: this.allowedOriginsParamName,
            Value: 'http://localhost:5173/',
            Type: 'String',
            Description: 'List of allowed CORS origins for the API',
          },
          physicalResourceId: cr.PhysicalResourceId.of('InitAllowedOriginsParam'),
          ignoreErrorCodesMatching: 'ParameterAlreadyExists',
        };
    
        const initAllowedOrigins = new cr.AwsCustomResource(this, 'InitAllowedOriginsParamV2', {
          onCreate: crParams,
          policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
          }),
        });

    // powertoolsLayer does not follow the format of layerList.
    // Powertools v3 layers are built per Python version and architecture; this one matches the
    // Python 3.12 x86_64 text generation function. Pinned to a published layer version.
    // https://docs.aws.amazon.com/powertools/python/latest/getting-started/install/
    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      `${id}-PowertoolsLayer`,
      `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-python312-x86_64:41`
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
      selfSignUpEnabled: false,
      // Every account in this pool is an administrator, so each sign-in needs an
      // authenticator app code; administrators enroll on their first sign-in
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      // Threat protection (Plus plan) blocks sign-ins with compromised passwords and
      // acts on risky sign-ins; the actions are set in the risk configuration below
      // https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-threat-protection.html
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
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
      // User accounts cannot be backed up with AWS Backup, so the pool is kept if the stack
      // is deleted, and deletion protection blocks deleting it directly
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // Create app client. The admin login uses SRP (the Amplify default), so the password
    // never leaves the browser; refresh tokens stay enabled for session renewal.
    this.appClient = this.userPool.addClient(`${id}-pool`, {
      userPoolClientName: userPoolName,
      authFlows: {
        userSrp: true,
      },
      // Sign-in and password reset errors do not reveal whether an account exists
      preventUserExistenceErrors: true,
    });

    // Actions for threat protection in full-function mode. Notifications are off because the
    // pool sends email through Cognito's default sender, which risk notifications cannot use.
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpoolriskconfigurationattachment.html
    new cognito.CfnUserPoolRiskConfigurationAttachment(this, `${id}-RiskConfiguration`, {
      userPoolId: this.userPool.userPoolId,
      clientId: "ALL",
      compromisedCredentialsRiskConfiguration: {
        actions: { eventAction: "BLOCK" },
      },
      accountTakeoverRiskConfiguration: {
        actions: {
          lowAction: { eventAction: "MFA_IF_CONFIGURED", notify: false },
          mediumAction: { eventAction: "MFA_REQUIRED", notify: false },
          highAction: { eventAction: "BLOCK", notify: false },
        },
      },
    });

    this.identityPool = new cognito.CfnIdentityPool(
      this,
      `${id}-identity-pool`,
      {
        allowUnauthenticatedIdentities: false,
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
        // Stage-wide defaults. Setting throttling here, instead of under a "/*/*" method option,
        // keeps them in one method setting; a second "/*/*" entry overrides logging and metrics.
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        metricsEnabled: true,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,

        // Origin returned by preflight and gateway error responses; kept in sync with the
        // allow-list by the Amplify stack once the app URL is known
        variables: {
          allowedOrigin: "http://localhost:5173",
        },
        
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
          // FREQUENT: Public token endpoint. A method override does not inherit the stage
          // defaults, so logging and metrics are repeated here.
          "/user/publicToken/GET": {
            throttlingRateLimit: 50,
            throttlingBurstLimit: 100,
            loggingLevel: apigateway.MethodLoggingLevel.ERROR,
            metricsEnabled: true,
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
        // Rule 0: AWS Managed IP reputation list (known botnets, scanners and other sources
        // AWS threat intelligence has flagged). Evaluated first, so these IPs are not counted
        // against the rate limits of other clients.
        {
          name: "AWS-AWSManagedRulesAmazonIpReputationList",
          priority: 0,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesAmazonIpReputationList",
          },
        },

        // Rule 1: AWS Managed Common Rule Set (SQL injection, XSS, etc.)
        // SizeRestrictions_BODY is counted only, since batch admin endpoints send large JSON payloads
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              ruleActionOverrides: [
                {
                  name: "SizeRestrictions_BODY",
                  actionToUse: { count: {} },
                },
              ],
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet",
          },
        },

        // Rule 2: Per-IP rate limit for all requests (2000 req/5min)
        {
          name: "LimitRequestsPerIp",
          priority: 2,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitRequestsPerIp",
          },
        },

        // Rule 3: Moderate limit for expensive AI endpoints (500 req/5min per IP)
        {
          name: "LimitExpensiveEndpoints",
          priority: 3,
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

        // Rule 4: Strict limit on account creation (20 req/5min per IP). Each new user gets a fresh
        // message quota, so this bounds how many identities one IP can mint. Matched on method and
        // path, which a client cannot alter. It is not set lower because a class on a shared
        // campus network reaches the API from a few NAT addresses; the per-user WebSocket rate
        // limit and the daily quota bound what each identity can send.
        {
          name: "LimitUserCreation",
          priority: 4,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 20,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                andStatement: {
                  statements: [
                    {
                      byteMatchStatement: {
                        searchString: "POST",
                        fieldToMatch: { method: {} },
                        textTransformations: [{ priority: 0, type: "NONE" }],
                        positionalConstraint: "EXACTLY",
                      },
                    },
                    {
                      byteMatchStatement: {
                        searchString: "/user",
                        fieldToMatch: { uriPath: {} },
                        textTransformations: [{ priority: 0, type: "NONE" }],
                        positionalConstraint: "EXACTLY",
                      },
                    },
                  ],
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitUserCreation",
          },
        },

        // Rule 5: Limit on token issuance (100 req/5min per IP). Every page load and 15-minute
        // refresh calls this endpoint, so the limit leaves room for several users behind one IP.
        {
          name: "LimitPublicToken",
          priority: 5,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 100,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "/user/publicToken",
                  fieldToMatch: { uriPath: {} },
                  textTransformations: [{ priority: 0, type: "NONE" }],
                  positionalConstraint: "EXACTLY",
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitPublicToken",
          },
        },

        // Rule 6: AWS Managed Known Bad Inputs (Log4j/JNDI lookups, Java deserialization,
        // localhost Host headers and other request patterns tied to known exploits)
        {
          name: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
          priority: 6,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
          },
        },
      ],
    });

    // WAF logs for investigating blocked and counted requests. Allowed requests are already in
    // the API access logs, so only requests a rule blocked or counted are kept, which limits
    // log volume and cost. The name must start with "aws-waf-logs-"; WAF adds the log group
    // resource policy it needs when logging is turned on.
    // https://docs.aws.amazon.com/waf/latest/developerguide/logging-cw-logs.html
    const wafLogGroup = new logs.LogGroup(this, `${id}-WafLogs`, {
      logGroupName: `aws-waf-logs-${id}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new wafv2.CfnLoggingConfiguration(this, `${id}-WafLogging`, {
      resourceArn: waf.attrArn,
      // WAF needs the log group ARN without the ":*" suffix that logGroupArn carries
      logDestinationConfigs: [
        this.formatArn({
          service: "logs",
          resource: "log-group",
          resourceName: wafLogGroup.logGroupName,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      // Admin requests carry a Cognito token and student requests a signed user token
      redactedFields: [{ singleHeader: { Name: "authorization" } }],
      loggingFilter: {
        DefaultBehavior: "DROP",
        Filters: [
          {
            Behavior: "KEEP",
            Requirement: "MEETS_ANY",
            Conditions: ["BLOCK", "COUNT", "EXCLUDED_AS_COUNT", "CAPTCHA", "CHALLENGE"].map(
              (action) => ({ ActionCondition: { Action: action } })
            ),
          },
        ],
      },
    });

    // Custom Response for WAF Blocks (Returns 429 instead of 403)
    this.api.addGatewayResponse(`${id}-WafBlockResponse`, {
      type: apigateway.ResponseType.WAF_FILTERED,
      statusCode: "429",
      responseHeaders: {
        "Access-Control-Allow-Origin": "stageVariables.allowedOrigin",
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
        "Access-Control-Allow-Origin": "stageVariables.allowedOrigin",
        "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
        "Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE'",
      },
    });

    // Add Default 5XX Gateway Response to prevent CORS errors on server errors (like Throttling)
    this.api.addGatewayResponse(`${id}-Default5XXResponse`, {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "stageVariables.allowedOrigin",
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

    // Default role for authenticated identities outside the admin group; it has no permissions
    const authenticatedRole = new iam.Role(this, `${id}-AuthenticatedRole`, {
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

    const adminGroup = new cognito.CfnUserPoolGroup(this, `${id}-AdminGroup`, {
      groupName: "admin",
      userPoolId: this.userPool.userPoolId,
      roleArn: adminRole.roleArn,
    });

    // Builds a VPC-capable Lambda role with the network, logging and tracing
    // permissions every function needs; callers add only what their function uses
    const createLambdaRole = (roleId: string) => {
      const role = new iam.Role(this, roleId, {
        roleName: roleId,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });

      // Grant access to EC2
      role.addToPolicy(
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
      role.addToPolicy(
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
      role.addToPolicy(
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

      return role;
    };

    // One role per function, so a public handler cannot use permissions that only the
    // text generation or knowledge base functions need

    // REST handlers that only read the database credentials
    const chatSessionFunctionRole = createLambdaRole(`${id}-chatSessionFunctionRole`);
    db.secretPathUser.grantRead(chatSessionFunctionRole);

    const userFunctionRole = createLambdaRole(`${id}-userFunctionRole`);
    db.secretPathUser.grantRead(userFunctionRole);

    const systemMessagesFunctionRole = createLambdaRole(`${id}-systemMessagesFunctionRole`);
    db.secretPathUser.grantRead(systemMessagesFunctionRole);

    // The admin authorizer reads only the Cognito pool and client ids
    const adminAuthorizerRole = createLambdaRole(`${id}-adminAuthorizerRole`);
    this.secret.grantRead(adminAuthorizerRole);

    // Text generation reads the database credentials and the knowledge base id;
    // its Bedrock and WebSocket permissions are added where the function is defined
    const textGenRole = createLambdaRole(`${id}-textGenRole`);
    db.secretPathUser.grantRead(textGenRole);
    props.knowledgeBaseSecret.grantRead(textGenRole);

    // The knowledge base function reads the database credentials and the knowledge base id;
    // its S3, Bedrock agent and scheduler permissions are added where the function is defined
    const knowledgeBaseFunctionRole = createLambdaRole(`${id}-knowledgeBaseFunctionRole`);
    db.secretPathUser.grantRead(knowledgeBaseFunctionRole);
    props.knowledgeBaseSecret.grantRead(knowledgeBaseFunctionRole);

    // Dedicated role for the admin function
    const adminFunctionRole = createLambdaRole(`${id}-adminFunctionRole`);
    db.secretPathUser.grantRead(adminFunctionRole);

    // Dedicated role for the functions that verify or mint student tokens
    const jwtLambdaRole = createLambdaRole(`${id}-jwtLambdaRole`);
    db.secretPathUser.grantRead(jwtLambdaRole);

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

    // The pre-signup trigger reads only the allowed email domains parameter
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/AllowedEmailDomains`,
        ],
      })
    );

    // Attach roles to the identity pool
    new cognito.CfnIdentityPoolRoleAttachment(this, `${id}-IdentityPoolRoles`, {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: authenticatedRole.roleArn,
      },
      // Admin group members resolve to the group's role (adminRole); everyone else gets authenticatedRole
      roleMappings: {
        userPool: {
          type: "Token",
          ambiguousRoleResolution: "AuthenticatedRole",
          identityProvider: `${this.userPool.userPoolProviderName}:${this.appClient.userPoolClientId}`,
        },
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

    // Rotate the token signing key on the same cadence as the database credentials.
    // Verifiers accept the previous key only briefly after a rotation (see the authorizers).
    const jwtSecretRotationFunction = new lambda.Function(this, `${id}-JwtSecretRotationFunction`, {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/jwtSecretRotation"),
      timeout: Duration.seconds(30),
      memorySize: 128,
    });
    jwtSecretRotationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:UpdateSecretVersionStage",
        ],
        resources: [jwtSecret.secretArn],
      })
    );
    jwtSecretRotationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetRandomPassword"],
        resources: ["*"],
      })
    );
    jwtSecret.addRotationSchedule(`${id}-JwtSecretRotation`, {
      rotationLambda: jwtSecretRotationFunction,
      automaticallyAfter: Duration.days(30),
    });

    const adminAuthorizationFunction = new lambda.Function(
      this,
      `${id}-admin-authorization-api-gateway`,
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset("lambda/adminAuthorizerFunction"),
        handler: "adminAuthorizerFunction.handler",
        timeout: Duration.seconds(30),
        reservedConcurrentExecutions: 100,
        vpc: vpcStack.vpc,
        environment: {
          SM_COGNITO_CREDENTIALS: this.secret.secretName,
        },
        functionName: `${id}-adminLambdaAuthorizer`,
        memorySize: 512,
        layers: [jwt],
        role: adminAuthorizerRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    adminAuthorizationFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/authorizers/*`,
    });

    new cloudwatch.Alarm(this, 'AdminAuthorizerConcurrencyAlarm', {
      metric: adminAuthorizationFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 80,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Admin authorizer approaching concurrency limit',
    });

    const apiGW_authorizationFunction = adminAuthorizationFunction.node
      .defaultChild as lambda.CfnFunction;
    apiGW_authorizationFunction.overrideLogicalId("adminLambdaAuthorizer");

    const userAuthFunction = new lambda.Function(
      this,
      `${id}-user-authorization-api-gateway`,
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset("lambda/authorization"),
        handler: "userAuthorizerFunction.handler",
        timeout: Duration.seconds(30),
        memorySize: 256,
        reservedConcurrentExecutions: 50,
        layers: [jwt],
        role: jwtLambdaRole,
        environment: {
          JWT_SECRET: jwtSecret.secretArn,
        },
        functionName: `${id}-userLambdaAuthorizer`,
        tracing: lambda.Tracing.ACTIVE,
      }
    );
    jwtSecret.grantRead(userAuthFunction);
    userAuthFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/authorizers/*`,
    });

    new cloudwatch.Alarm(this, 'UserAuthorizerConcurrencyAlarm', {
      metric: userAuthFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 40,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'User authorizer approaching concurrency limit',
    });

    const apiGW_userauthorizationFunction = userAuthFunction.node
      .defaultChild as lambda.CfnFunction;
    apiGW_userauthorizationFunction.overrideLogicalId("userLambdaAuthorizer");

    const publicTokenLambda = new lambda.Function(
      this,
      `${id}-PublicTokenFunction`,
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "publicTokenFunction.handler",
        layers: [jwt, postgres],
        reservedConcurrentExecutions: 50,
        code: lambda.Code.fromAsset("lambda/publicTokenFunction"),
        vpc: vpcStack.vpc,
        environment: {
          JWT_SECRET: jwtSecret.secretArn,
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
        timeout: Duration.seconds(30),
        // Every page load waits on this function; Lambda CPU scales with memory, so 256 MB
        // shortens cold starts (same size as the user and WebSocket authorizers)
        memorySize: 256,
        role: jwtLambdaRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    jwtSecret.grantRead(publicTokenLambda);

    // Add the permission to the Lambda function's policy to allow API Gateway access
    publicTokenLambda.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/GET/user/publicToken`,
    });

    new cloudwatch.Alarm(this, 'PublicTokenConcurrencyAlarm', {
      metric: publicTokenLambda.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 40,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Public Token Lambda approaching concurrency limit',
    });

    // Change Logical ID to match the one decleared in YAML file of Open API
    const apiGW_publicTokenFunction = publicTokenLambda.node
      .defaultChild as lambda.CfnFunction;
    apiGW_publicTokenFunction.overrideLogicalId("PublicTokenFunction");

    const preSignupLambda = new lambda.Function(this, `preSignupLambda`, {
      runtime: lambda.Runtime.NODEJS_24_X,
      code: lambda.Code.fromAsset("lambda/authorization"),
      handler: "preSignUp.handler",
      timeout: Duration.seconds(30),
      environment: {
        ALLOWED_EMAIL_DOMAINS: "/SpecEx/AllowedEmailDomains",
      },
      vpc: vpcStack.vpc,
      functionName: `${id}-preSignupLambda`,
      memorySize: 128,
      role: coglambdaRole,
      tracing: lambda.Tracing.ACTIVE,
    });

    preSignupLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    preSignupLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    publicTokenLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    publicTokenLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    userAuthFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    userAuthFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    adminAuthorizationFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    adminAuthorizationFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));

    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_SIGN_UP,
      preSignupLambda
    );

    const AutoSignupLambda = new lambda.Function(
      this,
      `${id}-addAdminOnSignUp`,
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset("lambda/authorization"),
        handler: "addAdminOnSignUp.handler",
        timeout: Duration.seconds(30),
        environment: {
          SM_DB_CREDENTIALS: db.secretPathTableCreator.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
        vpc: vpcStack.vpc,
        functionName: `${id}-addMemberOnSignUp`,
        memorySize: 128,
        layers: [postgres],
        role: coglambdaRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );
    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      AutoSignupLambda
    );



    const lambdaTextGen = new lambda.Function(
      this,
      `${id}-lambdaTextGen`,
      {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "main.handler",
        code: lambda.Code.fromAsset("lambda/textGeneration"),
        // Sized for the slowest WebSocket stream: a full MAX_TOKENS (4000) answer at roughly
        // 60 tokens/s is about 65 s, plus the guardrail, query rewrite, retrieval and verifier.
        // HTTP fallback requests use a smaller token cap to finish within the 29 s REST limit.
        timeout: cdk.Duration.seconds(90),
        role: textGenRole,
        reservedConcurrentExecutions: 100,
        layers: [psycopgLayer, powertoolsLayer],
        vpc: vpcStack.vpc,
        tracing: lambda.Tracing.ACTIVE,
        memorySize: 512,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          REGION: this.region,
          LLM_REGION: this.region,
          BEDROCK_MODEL_ID: `us.anthropic.claude-sonnet-5-5`,
          KB_SECRET_NAME: props.knowledgeBaseSecret.secretName
        },
      }
    )

    // Grant SSM parameter access for HaikuArn and SonnetArn
      lambdaTextGen.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ssm:GetParameter", "ssm:GetParameters"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/LLM/HaikuArn`,
            `arn:aws:ssm:${this.region}:${this.account}:parameter/SpecEx/LLM/SonnetArn`,
          ],
        })
      );

      // Add SSM parameter names as environment variables
      lambdaTextGen.addEnvironment("HAIKU_ARN", "/SpecEx/LLM/HaikuArn");
      lambdaTextGen.addEnvironment("SONNET_ARN", "/SpecEx/LLM/SonnetArn");

    // --- Bedrock Input Guardrail ---
    const guardrailConfig = {
      piiEntities: [
        // General
        'ADDRESS', 'AGE', 'NAME', 'EMAIL', 'PHONE', 'USERNAME', 'PASSWORD',
        'DRIVER_ID', 'LICENSE_PLATE', 'VEHICLE_IDENTIFICATION_NUMBER',
        // Finance
        'CREDIT_DEBIT_CARD_CVV', 'CREDIT_DEBIT_CARD_EXPIRY', 'CREDIT_DEBIT_CARD_NUMBER',
        'PIN', 'INTERNATIONAL_BANK_ACCOUNT_NUMBER', 'SWIFT_CODE',
        // IT
        'IP_ADDRESS', 'MAC_ADDRESS', 'URL',
        // Canada
        'CA_HEALTH_NUMBER', 'CA_SOCIAL_INSURANCE_NUMBER',
      ],
      piiInputAction: 'ANONYMIZE',
      piiInputEnabled: true,
      promptAttackStrength: 'HIGH',
      blockedInputMessaging: "Sorry, I can't help with that. I'm the UBC Science Specialization Explorer — I'm here to help you find the right specialization for your academic journey.",
    };

    const inputGuardrail = new bedrock.CfnGuardrail(this, 'InputGuardrail', {
      name: `${id}-input-guardrail`,
      blockedInputMessaging: "Sorry, I can't help with that. I'm the UBC Science Specialization Explorer — I'm here to help you find the right specialization for your academic journey.",
      blockedOutputsMessaging: 'Response blocked.',
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          // General
          { type: 'ADDRESS',                    action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'AGE',                        action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'NAME',                       action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'EMAIL',                      action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'PHONE',                      action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'USERNAME',                   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'PASSWORD',                   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'DRIVER_ID',                  action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'LICENSE_PLATE',              action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'VEHICLE_IDENTIFICATION_NUMBER', action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          // Finance
          { type: 'CREDIT_DEBIT_CARD_CVV',      action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'CREDIT_DEBIT_CARD_EXPIRY',   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'CREDIT_DEBIT_CARD_NUMBER',   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'PIN',                        action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'INTERNATIONAL_BANK_ACCOUNT_NUMBER', action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'SWIFT_CODE',                 action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          // IT
          { type: 'IP_ADDRESS',                 action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'MAC_ADDRESS',                action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'URL',                        action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          // Canada
          { type: 'CA_HEALTH_NUMBER',           action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'CA_SOCIAL_INSURANCE_NUMBER', action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
        ],
      },
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
    });

    const configHash = computeConfigHash(guardrailConfig);
    cdk.Tags.of(inputGuardrail).add('ConfigHash', configHash);

    const inputGuardrailVersion = new bedrock.CfnGuardrailVersion(this, `InputGuardrailVersion-${configHash.substring(0, 8)}`, {
      guardrailIdentifier: inputGuardrail.attrGuardrailId,
      description: `Config hash: ${configHash.substring(0, 8)}`,
    });

    lambdaTextGen.addEnvironment('GUARDRAIL_ID', inputGuardrail.attrGuardrailId);
    lambdaTextGen.addEnvironment('GUARDRAIL_VERSION', inputGuardrailVersion.attrVersion);

    lambdaTextGen.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:ApplyGuardrail'],
      resources: [inputGuardrail.attrGuardrailArn],
    }));

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

    new cloudwatch.Alarm(this, 'TextGenConcurrencyAlarm', {
      metric: lambdaTextGen.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 80,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Text Generation Lambda approaching concurrency limit',
    });

    lambdaTextGen.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaTextGen.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    AutoSignupLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    AutoSignupLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    // Bedrock permissions
    const textGenBedrockPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:GetInferenceProfile",
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream", // Add streaming permission
        "bedrock:Converse",
        "bedrock:ConverseStream",
        "bedrock:Retrieve", // Add Retrieve permission for Knowledge Base
      ],
      resources: [
        // Claude Sonnet 5.5
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-5-5`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5`,
        // Claude Sonnet 4.6 (Converse currently resolves this model in us-west-2)
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
        // Claude Sonnet 4.5 (Direct Foundation Models)
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        // Claude Haiku 5.5
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-5-5`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5`,
        // Claude Haiku 4.5 (Converse currently resolves this model in us-west-2)
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
        // Knowledge Base
        `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`,
      ],
    });
    lambdaTextGen.addToRolePolicy(textGenBedrockPolicyStatement);



    // --- Knowledge Base Lambda Function ---
    const lambdaKnowledgeBase = new lambda.Function(this, `${id}-lambdaKnowledgeBase`, {
      functionName: `${id}-lambdaKnowledgeBase`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "main.handler",
      code: lambda.Code.fromAsset("lambda/knowledgeBase"),
      timeout: Duration.seconds(300),
      role: knowledgeBaseFunctionRole,
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
        KB_SECRET_NAME: props.knowledgeBaseSecret.secretName
      },
    });

    // Ingestion polling publishes failed document and job counts to this namespace (Embedded
    // Metric Format). A Bedrock job can finish COMPLETE with failed documents, so both are alarmed.
    const knowledgeBaseMetricsNamespace = `${id}/KnowledgeBase`;
    lambdaKnowledgeBase.addEnvironment('METRICS_NAMESPACE', knowledgeBaseMetricsNamespace);

    new cloudwatch.Alarm(this, 'KnowledgeBaseFailedDocumentsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: knowledgeBaseMetricsNamespace,
        metricName: 'FailedDocuments',
        period: Duration.minutes(5),
        statistic: cloudwatch.Stats.SUM,
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Knowledge base ingestion finished with documents that failed to ingest',
    });

    new cloudwatch.Alarm(this, 'KnowledgeBaseFailedIngestionJobsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: knowledgeBaseMetricsNamespace,
        metricName: 'FailedIngestionJobs',
        period: Duration.minutes(5),
        statistic: cloudwatch.Stats.SUM,
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A knowledge base ingestion job failed',
    });

    lambdaKnowledgeBase.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaKnowledgeBase.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    const cfnLambdaKnowledgeBase = lambdaKnowledgeBase.node.defaultChild as lambda.CfnFunction;
    cfnLambdaKnowledgeBase.overrideLogicalId("lambdaKnowledgeBase");

    lambdaKnowledgeBase.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin/*`,
    });

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
      runtime: lambda.Runtime.NODEJS_24_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "handlers/userHandler.handler",
      timeout: Duration.seconds(30),
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        USER_POOL: this.userPool.userPoolId,
      },
      functionName: `${id}-userFunction`,
      memorySize: 512,
      reservedConcurrentExecutions: 50,
      layers: [postgres],
      role: userFunctionRole,
      tracing: lambda.Tracing.ACTIVE,
    });

    lambdaUserFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaUserFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    lambdaUserFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/member*`,
    });

    const cfnLambda_user = lambdaUserFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_user.overrideLogicalId("userFunction");

    lambdaUserFunction.addPermission("AllowAdminApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/user*`,
    });

    const lambdaSystemMessagesFunction = new lambda.Function(this, `${id}-systemMessagesFunction`, {
      runtime: lambda.Runtime.NODEJS_24_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "handlers/systemMessagesHandler.handler",
      timeout: Duration.seconds(30),
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        USER_POOL: this.userPool.userPoolId,
      },
      functionName: `${id}-systemMessagesFunction`,
      memorySize: 512,
      layers: [postgres],
      role: systemMessagesFunctionRole,
      tracing: lambda.Tracing.ACTIVE,
    });

    lambdaSystemMessagesFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaSystemMessagesFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    lambdaSystemMessagesFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/member*`,
    });

    const cfnLambda_systemMessages = lambdaSystemMessagesFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_systemMessages.overrideLogicalId("systemMessagesFunction");

    lambdaSystemMessagesFunction.addPermission("AllowAdminApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/system*`,
    });


    const lambdaChatSessionFunction = new lambda.Function(
      this,
      `${id}-chatSessionFunction`,
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset("lambda"),
        handler: "handlers/chatSessionHandler.handler",
        timeout: Duration.seconds(30),
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
        functionName: `${id}-chatSessionFunction`,
        memorySize: 512,
        layers: [postgres],
        role: chatSessionFunctionRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    // Allow API Gateway to invoke for shared chat endpoints (public access)
    lambdaChatSessionFunction.addPermission("AllowApiGatewayInvokeShared", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/chat_sessions*`,
    });

    lambdaChatSessionFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaChatSessionFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    const cfnLambda_chatSession = lambdaChatSessionFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_chatSession.overrideLogicalId("chatSessionFunction");

    const lambdaAdminFunction = new lambda.Function(
      this,
      `${id}-adminFunction`,
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset("lambda"),
        handler: "handlers/adminHandler.handler",
        timeout: Duration.seconds(30),
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          USER_POOL: this.userPool.userPoolId,
        },
        functionName: `${id}-adminFunction`,
        memorySize: 512,
        layers: [postgres],
        role: adminFunctionRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    lambdaAdminFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });

    lambdaAdminFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaAdminFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


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
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "connect.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 50,
      tracing: lambda.Tracing.ACTIVE,
    });

    // $connect authorizer: verifies the user-bound token and passes the user id to every route
    const wsAuthorizerFunction = new lambda.Function(this, `${id}-WebSocketAuthorizerFunction`, {
      functionName: `${id}-WebSocketAuthorizerFunction`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "authorizer.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 50,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        JWT_SECRET: jwtSecret.secretArn,
      },
      layers: [jwt],
    });
    jwtSecret.grantRead(wsAuthorizerFunction);

    new cloudwatch.Alarm(this, 'ConnectFunctionConcurrencyAlarm', {
      metric: connectFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 40,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'WebSocket Connect Lambda approaching concurrency limit',
    });

    connectFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    connectFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    // Disconnect Lambda
    const disconnectFunction = new lambda.Function(
      this,
      `${id}-DisconnectFunction`,
      {
        functionName: `${id}-DisconnectFunction`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "disconnect.handler",
        code: lambda.Code.fromAsset("lambda/websocket"),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    // Default route Lambda for handling messages
    const defaultFunction = new lambda.Function(this, `${id}-DefaultFunction`, {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "default.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 50,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TEXT_GEN_FUNCTION_NAME: lambdaTextGen.functionName,
      },
      functionName: `${id}-DefaultFunction`,
    });

    new cloudwatch.Alarm(this, 'DefaultFunctionConcurrencyAlarm', {
      metric: defaultFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 40,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'WebSocket Default Lambda approaching concurrency limit',
    });

    // Per-user message rate for the WebSocket API, which WAF cannot be associated with.
    // Each item is one user's counter for one 60-second window and expires through TTL,
    // so the table holds no history; it has no point-in-time recovery and is not retained.
    const wsRateLimitTable = new dynamodb.TableV2(this, `${id}-WebSocketRateLimits`, {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    wsRateLimitTable.grant(defaultFunction, "dynamodb:UpdateItem");
    defaultFunction.addEnvironment("RATE_LIMIT_TABLE_NAME", wsRateLimitTable.tableName);
    // A reply streams for 10 to 60 seconds, so 10 messages a minute is well above normal use.
    // The chat page sends a warm-up every 5 minutes.
    defaultFunction.addEnvironment("MESSAGE_RATE_LIMIT_PER_MINUTE", "10");
    defaultFunction.addEnvironment("WARMUP_RATE_LIMIT_PER_MINUTE", "2");

    defaultFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    defaultFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    disconnectFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    disconnectFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
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

    // Grant the default function permission to invoke the text generation function
    lambdaTextGen.grantInvoke(defaultFunction);

    // --- Async text generation failure path ---
    // The default route invokes text generation asynchronously. A retry would replay a request
    // whose user message is already saved and whose answer was partly streamed, and a throttled
    // event that arrives minutes later has no client waiting for it. So failed or expired events
    // are not retried; they go to a queue, and a handler tells the client the request failed.
    // https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html
    const textGenFailureDlq = new sqs.Queue(this, `${id}-TextGenFailureDLQ`, {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
    });

    // Records include the user's query, so they are kept only briefly
    const textGenFailureQueue = new sqs.Queue(this, `${id}-TextGenFailureQueue`, {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(1),
      // AWS recommends at least six times the consumer function timeout
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: { queue: textGenFailureDlq, maxReceiveCount: 3 },
    });

    lambdaTextGen.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.minutes(2),
      onFailure: new lambdaDestinations.SqsDestination(textGenFailureQueue),
    });

    const textGenFailureFunction = new lambda.Function(this, `${id}-TextGenFailureFunction`, {
      functionName: `${id}-TextGenFailureFunction`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "asyncFailure.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      reservedConcurrentExecutions: 10,
      tracing: lambda.Tracing.ACTIVE,
    });
    textGenFailureFunction.addToRolePolicy(wsPolicy);
    textGenFailureFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(textGenFailureQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      })
    );

    new cloudwatch.Alarm(this, 'TextGenAsyncFailureAlarm', {
      metric: textGenFailureQueue.metricNumberOfMessagesSent({
        period: Duration.minutes(5),
        statistic: cloudwatch.Stats.SUM,
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Asynchronous text generation requests failed or expired before running',
    });

    new cloudwatch.Alarm(this, 'TextGenFailureDestinationAlarm', {
      metric: lambdaTextGen.metric('DestinationDeliveryFailures', {
        period: Duration.minutes(5),
        statistic: cloudwatch.Stats.SUM,
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Failed text generation events could not be delivered to the failure queue',
    });

    new cloudwatch.Alarm(this, 'TextGenFailureDlqAlarm', {
      metric: textGenFailureDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: cloudwatch.Stats.MAXIMUM,
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The text generation failure handler could not process failure records',
    });

    // Routes
    new apigatewayv2.WebSocketRoute(this, `${id}-ConnectRoute`, {
      webSocketApi: this.webSocketApi,
      routeKey: "$connect",
      integration: new WebSocketLambdaIntegration(
        `${id}-ConnectIntegration`,
        connectFunction
      ),
      authorizer: new WebSocketLambdaAuthorizer(
        `${id}-ConnectAuthorizer`,
        wsAuthorizerFunction,
        { identitySource: ["route.request.querystring.token"] }
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
      // WAF cannot be associated with WebSocket APIs, so cap request rates at the stage.
      // Execution logging stays off: the connect request carries the token in its query string.
      defaultRouteSettings: {
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        loggingLevel: "OFF",
        dataTraceEnabled: false,
      },
      accessLogSettings: {
        destinationArn: wsAccessLogGroup.logGroupArn,
        // Do not add request URL or query string fields: the connect token is in the query string
        format: JSON.stringify({
          requestId: "$context.requestId",
          requestTime: "$context.requestTime",
          routeKey: "$context.routeKey",
          connectionId: "$context.connectionId",
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
    // The failure handler posts to this endpoint rather than one taken from the failure record
    textGenFailureFunction.addEnvironment(
      "WEBSOCKET_API_ENDPOINT",
      `${this.webSocketApi.apiEndpoint}/${this.wsStage.stageName}`
    );
    // The default route posts rate limit errors to this endpoint
    defaultFunction.addEnvironment(
      "WEBSOCKET_API_ENDPOINT",
      `${this.webSocketApi.apiEndpoint}/${this.wsStage.stageName}`
    );

    // Function log retention is applied to every stack in bin/cdk.ts (lib/log-retention.ts)

    // Add WebSocket URL as stack output
    new cdk.CfnOutput(this, "WebSocketUrl", {
      value: this.webSocketApi.apiEndpoint,
      description: "WebSocket URL for real-time streaming",
      exportName: `${id}-WebSocketUrl`,
    });

  }
}


