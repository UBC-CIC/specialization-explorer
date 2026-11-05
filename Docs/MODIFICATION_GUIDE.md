# Specialization Explorer - Project Modification Guide

This guide covers practical modifications developers commonly need to make: styling, authentication, API extensions, frontend components, LLM configuration, database migrations, and deployment. For guardrail configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

---

## Table of Contents

- [Modifying Colors and Styles](#modifying-colors-and-styles)
- [Admin & Public Token](#admin--public-token)
- [Using External Identity Providers (Enterprise SSO)](#using-external-identity-providers-enterprise-sso)
- [Extending the API](#extending-the-api)
- [Modifying Frontend Components](#modifying-frontend-components)
- [Changing Website License (Footer)](#changing-website-license-footer)
- [Configuring LLM Models](#configuring-llm-models)
- [Database Schema Changes (Migrations)](#database-schema-changes-migrations)
- [Message/Token Limit Management](#messagetoken-limit-management)
- [Data Ingestion Modifications](#data-ingestion-modifications)
- [Deployment & Testing](#deployment--testing)
- [Encryption & KMS Keys](#encryption--kms-keys)
- [Troubleshooting & Best Practices](#troubleshooting--best-practices)

---

## Modifying Colors and Styles

The frontend uses Tailwind and CSS variables for theme colors. Primary variables are defined in `frontend/src/index.css`.

**Example** (change the primary brand color and sidebar background; the current values are `rgb(0, 85, 183)` and `rgb(23, 68, 103)`):

```css
/* frontend/src/index.css */
:root {
  --primary: rgb(0, 85, 183);
  --sidebar: rgb(23, 68, 103);
}

.dark {
  --primary: rgb(215, 155, 100);
  --sidebar: rgb(23, 68, 103);
}
```

The Content-Security-Policy set by Amplify (`cdk/lib/amplify-stack.ts`) allows only scripts from the site itself, so load fonts, scripts or images from other hosts only after adding them to that policy.

For component-specific overrides, search for hex codes or Tailwind classes directly in `frontend/src/components/`.

---

## Admin & Public Token

The project uses a dual access model:

- **Admin users**: Authenticated via Cognito (SRP, required TOTP MFA, `admin` group). Admin-only APIs require a Cognito ID token and are restricted by the admin authorizer in `cdk/OpenAPI_Swagger_Definition.yaml` and `cdk/lib/api-stack.ts`.
- **Public users**: `POST /user` creates an anonymous user and returns a random user key. `cdk/lambda/publicTokenFunction/publicTokenFunction.js` exchanges the key for a 15-minute JWT bound to that user. The frontend stores the user ID and key in `localStorage` and rotates the key daily (`frontend/src/providers/UserContext.tsx`), and fetches tokens in `frontend/src/lib/userToken.ts`. See section 3.5 of the [Security Overview](./SECURITY_OVERVIEW.md) for the accepted risk.

Key files:
- `cdk/lib/api-stack.ts` — Cognito UserPool and API authorizer setup
- `cdk/lambda/publicTokenFunction/publicTokenFunction.js` — public token generation and expiry
- `cdk/lambda/authorization/userAuthorizerFunction.js` and `cdk/lambda/adminAuthorizerFunction/adminAuthorizerFunction.js` — REST authorizers
- `cdk/lambda/websocket/authorizer.js` — WebSocket `$connect` authorizer
- `frontend/src/components/ProtectedRoute.tsx` — admin route protection

---

## Using External Identity Providers (Enterprise SSO)

Cognito supports federation with SAML 2.0 and OIDC providers (Okta, Azure AD, Keycloak, etc.), enabling SSO and centralized identity management.

- Configure an identity provider via the console or CDK (`CfnIdentityProvider`) and attach it to the user pool.
- Map attributes (e.g., email, groups) so application roles like `admin` are correctly assigned.
- Update redirect/callback URIs for the provider to include your Amplify/web app endpoints.

AWS docs:
- SAML: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html
- OIDC: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html

---

## Extending the API

The REST API is a `SpecRestApi` built from `cdk/OpenAPI_Swagger_Definition.yaml`, so routes and authorizers are defined in the spec, not with `api.root.addResource`.

1. Add the Lambda handler in `cdk/lambda/handlers/<your-handler>.js` (Node) or a new Python module. Route on `event.httpMethod + " " + event.resource`, take the caller from `event.requestContext.authorizer` (`userId` for students, `email` for admins), and call `auditLog` from `handlers/utils/audit.js` before returning.
2. Define a new `lambda.Function` in `cdk/lib/api-stack.ts` and override its logical ID so the spec can reference it.
3. Grant API Gateway permission to invoke it, scoped to the new path.
4. Add the path to `cdk/OpenAPI_Swagger_Definition.yaml` with an `aws_proxy` integration that references the function, `security: - userAuthorizer: []` or `- adminAuthorizer: []`, and `<<: *commonOptions` for CORS preflight.
5. If the path should have its own WAF rate rule, add it to the Web ACL in `api-stack.ts`.
6. Run `npx cdk deploy`.

Example (Node.js):

```typescript
const myHandler = new lambda.Function(this, `${id}-MyHandler`, {
  runtime: lambda.Runtime.NODEJS_24_X,
  code: lambda.Code.fromAsset("lambda"),
  handler: "handlers/myHandler.handler",
  vpc: vpcStack.vpc,
  environment: {
    SM_DB_CREDENTIALS: db.secretPathUser.secretName,
    RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
    ALLOWED_ORIGIN_PARAM: this.allowedOriginsParamName,
  },
});
(myHandler.node.defaultChild as lambda.CfnFunction).overrideLogicalId("myFeatureFunction");

myHandler.addPermission("AllowApiGatewayInvoke", {
  principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
  action: "lambda:InvokeFunction",
  sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/my-feature*`,
});
```

```yaml
# cdk/OpenAPI_Swagger_Definition.yaml
  /my-feature:
    <<: *commonOptions
    post:
      security:
        - adminAuthorizer: []
      x-amazon-apigateway-integration:
        uri:
          Fn::Sub: arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${myFeatureFunction.Arn}/invocations
        passthroughBehavior: "when_no_match"
        httpMethod: POST
        type: aws_proxy
```

The function also needs read access to its secrets and the allowed-origins SSM parameter; copy the grants used for an existing handler. Existing handlers in `cdk/lambda/handlers/` (e.g., `adminHandler.js`, `chatSessionHandler.js`) are good patterns to follow.

---

## Modifying Frontend Components

Frontend code is in `frontend/src/`:
- `pages/` — route-level pages
- `components/` — reusable UI blocks
- `providers/` — React context (`UserContext`, `ViewContext`, `SidebarContext`)

### Adding a new page

```tsx
// frontend/src/pages/NewFeature/NewFeature.tsx
export default function NewFeature() {
  return <div>New Feature page</div>;
}

// frontend/src/App.tsx
import NewFeature from "./pages/NewFeature/NewFeature";
<Route path="/new-feature" element={<NewFeature />} />
```

Wrap with `<ProtectedRoute>` if admin-only.

---

## Changing Website License (Footer)

Edit `frontend/src/components/Footer.tsx`:

```tsx
<div className="text-sm text-muted-foreground">
  © {new Date().getFullYear()} Your Organization Name.
</div>
```

Or use a Vite env variable to avoid rebuilding for content changes:

```tsx
© {new Date().getFullYear()} {import.meta.env.VITE_WEBSITE_NAME || 'Specialization Explorer'}.
```

---

## Configuring LLM Models

The text generation Lambda uses two models: **Haiku** (fast; answers in the detective phase, rewrites queries for retrieval, and verifies answers for hallucination warnings) and **Sonnet** (answers in the suggestion phase, when specializations are recommended). Their model IDs are stored as SSM parameters, read once per cold start:

- `/SpecEx/LLM/HaikuArn`
- `/SpecEx/LLM/SonnetArn`

To update a model, change the SSM parameter value via the AWS Console or CLI:

```bash
aws ssm put-parameter \
  --name "/SpecEx/LLM/HaikuArn" \
  --value "us.anthropic.claude-haiku-5-5" \
  --type String \
  --overwrite
```

**Rules when updating:**
- All ARNs must use the `us.` cross-region inference prefix (e.g., `us.anthropic.claude-...`).
- Only update `SonnetArn` with a Sonnet-family model — it's used for the main chat flow and has specific prompt/output handling tied to it.
- `HaikuArn` can be any fast, low-cost model suitable for query rewriting and answer verification.

> **Note:** The text generation role may only invoke the models listed in `textGenBedrockPolicyStatement` in `cdk/lib/api-stack.ts` (currently Claude Sonnet 5.5, 4.6 and 4.5, and Claude Haiku 5.5 and 4.5). To use any other model, add its inference profile and foundation model ARNs there and redeploy. New values take effect when the function next starts cold; publish a change to the function (or redeploy) to apply them at once.

For guardrail configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

---

## Database Schema Changes (Migrations)

Migrations live in `cdk/lambda/db_setup/migrations/`, follow a numbered naming convention, and are run by `node-pg-migrate` on every deployment of the DBFlow stack. See [`Docs/DATABASE_MIGRATIONS.md`](./DATABASE_MIGRATIONS.md) for details.

```javascript
// cdk/lambda/db_setup/migrations/007_add_new_feature_table.js
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS new_feature (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      name varchar NOT NULL,
      description text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS new_feature;`);
};
```

---

## Message/Token Limit Management

Message limits (messages per user per day, max characters per user and AI message, min exchanges before suggestion, temperature, top-p and the grounding thresholds) are admin-configurable at runtime in System Settings. They're stored in the `system_settings` table and re-read by the text generation Lambda, so no redeployment is needed to change them.

Two limits are fixed in CDK instead: the per-user rate of 10 messages a minute (`MESSAGE_RATE_LIMIT_PER_MINUTE` on the WebSocket default route and text generation functions) and the WAF rate rules, both in `cdk/lib/api-stack.ts`.

For details on how to configure these via the admin dashboard, see the User Guide.

---

## Data Ingestion Modifications

The ingestion pipeline is handled by `cdk/lambda/knowledgeBase/` (Python Lambda). To add new file types or processing logic, modify `main.py` and the `helpers/` modules; a new source type also needs a value in the `data_source_type` enum (a DB migration) and the matching upload prefix and content type in the presigned URL helpers. The web crawler data sources created at deployment are defined in `WEB_DATA_SOURCES` in `cdk/lib/knowledge-base-stack.ts`. See [`Docs/KNOWLEDGE_BASE_DOCUMENTATION.md`](./KNOWLEDGE_BASE_DOCUMENTATION.md) for the full workflow.

---

## Deployment & Testing

**CDK / Backend:**
```bash
cd cdk
npm install
npm run build
npx cdk deploy
```

**Python Lambda dependencies:**
Python Lambdas (`textGeneration`, `knowledgeBase`) do not auto-install `requirements.txt` at deploy time — dependencies are either bundled manually or come from Lambda layers. If you add a new Python dependency, you'll need to either add a layer or set up a bundling step in CDK.

**Frontend:**
```bash
cd frontend
npm install
npm run build   # production build
```

Run the dev server manually with `npm run dev` (Vite).

**CI/CD:** See `Docs/DEPLOYMENT_GUIDE.md` for pipeline specifics.

---

## Encryption & KMS Keys

By default, all encrypted resources in this project (RDS, S3, Secrets Manager, OpenSearch Serverless, DynamoDB, SQS, AWS Backup) use AWS managed or AWS owned keys. No configuration is required to use them, but they offer limited control over key rotation, auditing, and cross-account access.

If your organization requires customer-managed KMS keys (CMKs), see [`Docs/AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md) for a full list of affected resources and the exact CDK property changes needed in each stack.

---

## Troubleshooting & Best Practices

- **Lambda Timeout**: Increase `timeout` in the CDK function definition.
- **Memory/Latency**: Increase `memorySize`; check VPC and RDS proxy config.
- **Database**: Verify `SM_DB_CREDENTIALS` in Secrets Manager and RDS proxy endpoint.
- **Cognito**: Check the user pool and client IDs in the Amplify app's environment variables (or `frontend/.env.local` when running locally; see `frontend/README.md`).
- **Guardrails**: See `Docs/BEDROCK_GUARDRAILS.md` for topic policies, allow rules, and testing.
- **Logging**: CloudWatch logs are the primary debugging source for all Lambdas.
