# Specialization Explorer CDK App

AWS CDK (TypeScript) app for the Specialization Explorer backend and infrastructure. See the [Deployment Guide](../Docs/DEPLOYMENT_GUIDE.md) for the full deployment steps, including the secrets and SSM parameters that must exist before `cdk deploy`.

## Layout

- `bin/cdk.ts`: app entry point. Creates the stacks (`<StackPrefix>-VpcStack`, `-Database`, `-DBFlow`, `-CICD`, `-KnowledgeBase`, `-Api`, `-Amplify`, `-Backup`), tags them and sets Lambda log retention.
- `lib/`: one file per stack, plus `log-retention.ts`.
- `lambda/`: Lambda function source (Node.js handlers, Python text generation and knowledge base functions, database migrations in `lambda/db_setup/migrations/`).
- `layers/`: zipped Lambda layers.
- `OpenAPI_Swagger_Definition.yaml`: REST API definition loaded by `SpecRestApi` in `lib/api-stack.ts`.
- `test/`: Jest tests.

## Commands

Run from this directory after `npm install`:

- `npm run build`: compile TypeScript
- `npm test`: run the Jest tests
- `npx cdk synth`: synthesize the CloudFormation templates
- `npx cdk diff`: compare the deployed stacks with the current code
- `npx cdk deploy --all --context StackPrefix=<PREFIX> --context environment=dev --context githubRepo=<REPO>`: deploy every stack

The app reads these context values: `StackPrefix` (required), `environment` (defaults to `dev`), `githubRepo` (required) and `githubBranch` (defaults to `main`).
