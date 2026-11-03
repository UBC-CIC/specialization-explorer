#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import { applyLambdaLogRetention } from "../lib/log-retention";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { ApiGatewayStack } from "../lib/api-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";
import { AmplifyStack } from "../lib/amplify-stack";
import { CICDStack } from "../lib/cicd-stack";
import { KnowledgeBaseStack } from "../lib/knowledge-base-stack";
import { BackupStack, addToBackupPlan } from "../lib/backup-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const StackPrefix = app.node.tryGetContext("StackPrefix");
const environment = app.node.tryGetContext("environment");
const version = app.node.tryGetContext("versionNumber");
const githubRepo = app.node.tryGetContext("githubRepo");
const githubBranch = app.node.tryGetContext("githubBranch") || "main";

const vpcStack = new VpcStack(app, `${StackPrefix}-VpcStack`, {
  env,
  stackPrefix: StackPrefix,
  environmentName: environment,
});

const dbStack = new DatabaseStack(app, `${StackPrefix}-Database`, vpcStack, {
  env,
});

const dbFlowStack = new DBFlowStack(
  app,
  `${StackPrefix}-DBFlow`,
  vpcStack,
  dbStack,
  { env }
);

const cicdStack = new CICDStack(app, `${StackPrefix}-CICD`, {
  env,
  githubRepo: githubRepo,
  githubBranch: githubBranch,
  environmentName: environment,
  lambdaFunctions: [
    {
      name: "vectorIndexManagerSigV4",
      functionName: `${StackPrefix}-KnowledgeBase-VectorIndexManagerFn-v2`,
      sourceDir: "cdk/lambda/vectorIndexManagerSigV4",
    },
  ],
  pathFilters: [
    "cdk/lambda/vectorIndexManagerSigV4/**",
  ],
});

const kbStack = new KnowledgeBaseStack(app, `${StackPrefix}-KnowledgeBase`, {
  env,
  stackPrefix: StackPrefix,
  vectorIndexManagerRepository: cicdStack.ecrRepositories["vectorIndexManagerSigV4"],
  vectorIndexManagerPipelineName: cicdStack.pipelineName,
  vpc: vpcStack.vpc,
  vpcCidr: vpcStack.vpcCidrString,
});
kbStack.addDependency(cicdStack);
kbStack.addDependency(vpcStack);

const apiStack = new ApiGatewayStack(
  app,
  `${StackPrefix}-Api`,
  dbStack,
  vpcStack,
  {
    env,
    ecrRepositories: cicdStack.ecrRepositories,
    knowledgeBaseBucket: kbStack.knowledgeBaseBucket,
    knowledgeBaseSecret: kbStack.knowledgeBaseSecret,
  }
);
apiStack.addDependency(kbStack);
apiStack.addDependency(cicdStack);

const amplifyStack = new AmplifyStack(app, `${StackPrefix}-Amplify`, apiStack, {
  env,
  githubRepo: githubRepo,
  githubBranch: githubBranch,
  knowledgeBaseBucketName: kbStack.knowledgeBaseBucket.bucketName,
  allowedOriginsParamName: apiStack.allowedOriginsParamName,
});
amplifyStack.addDependency(apiStack);

// Daily AWS Backup of the database (users, chats) and the knowledge base bucket (documents).
// Resources are selected by tag, so this stack has no references to the other stacks.
const backupStack = new BackupStack(app, `${StackPrefix}-Backup`, {
  env,
  stackPrefix: StackPrefix,
});
addToBackupPlan(dbStack.dbInstance.node.defaultChild!, StackPrefix);
addToBackupPlan(kbStack.knowledgeBaseBucket.node.defaultChild!, StackPrefix);

const stackTags = {
  Project: "specEx",
  StackPrefix: StackPrefix || "SpecEx",
  Environment: environment || "dev",
  ManagedBy: "CDK",
};

const stacks = [
  vpcStack,
  dbStack,
  dbFlowStack,
  cicdStack,
  kbStack,
  apiStack,
  amplifyStack,
  backupStack,
];

stacks.forEach((stack) => {
  Object.entries(stackTags).forEach(([key, value]) => {
    cdk.Tags.of(stack).add(key, value);
  });
});

// Every Lambda log group keeps one month of logs
applyLambdaLogRetention(stacks, logs.RetentionDays.ONE_MONTH);
