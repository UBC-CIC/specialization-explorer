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

**Example** (change the primary brand color and sidebar background):

```css
/* frontend/src/index.css */
:root {
  --primary: rgb(23, 68, 103);
  --sidebar: rgb(23, 68, 103);
}

.dark {
  --primary: rgb(23, 68, 103);
  --sidebar: rgb(23, 68, 103);
}
```

For component-specific overrides, search for hex codes or Tailwind classes directly in `frontend/src/components/`.

---

## Admin & Public Token

The project uses a dual access model:

- **Admin users**: Authenticated via Cognito. Admin-only APIs require a Cognito token and are restricted by the admin authorizer in `OpenAPI_Swagger_Definition.yaml` and `cdk/lib/api-stack.ts`.
- **Public users**: `lambda/publicTokenFunction/publicTokenFunction.js` generates a short-lived JWT for unauthenticated users. The frontend requests and caches this via `frontend/src/providers/UserSessionContext.tsx`.

Key files:
- `cdk/lib/api-stack.ts` — Cognito UserPool and API authorizer setup
- `cdk/lambda/publicTokenFunction/publicTokenFunction.js` — public token generation and expiry
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

1. Add the Lambda handler in `cdk/lambda/handlers/<your-handler>.js` (Node) or a new Python module.
2. Define a new `lambda.Function` in `cdk/lib/api-stack.ts`.
3. Wire up the API Gateway route and authorizer in `api-stack.ts`.
4. Update `OpenAPI_Swagger_Definition.yaml` to reflect the new endpoint.
5. Run `npx cdk deploy`.

Example (Node.js):

```typescript
const myHandler = new lambda.Function(this, `${id}-MyHandler`, {
  runtime: lambda.Runtime.NODEJS_24_X,
  code: lambda.Code.fromAsset("lambda"),
  handler: "handlers/myHandler.handler",
  environment: {
    SM_DB_CREDENTIALS: db.secretPathUser.secretName,
    RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
  },
});

const myResource = this.api.root.addResource("my-feature");
myResource.addMethod("POST", new apigw.LambdaIntegration(myHandler), {
  authorizer: this.adminAuthorizer,
});
```

Existing handlers in `cdk/lambda/handlers/` (e.g., `adminHandler.js`, `chatSessionHandler.js`) are good patterns to follow.

---

## Modifying Frontend Components

Frontend code is in `frontend/src/`:
- `pages/` — route-level pages
- `components/` — reusable UI blocks
- `providers/` — React context (e.g., `UserSessionContext`, `ModeContext`)

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

The text generation Lambda uses two models: **Haiku** (fast, used for query rewriting and for verifying answers) and **Sonnet** (main chat model). Their ARNs are stored as SSM parameters:

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

> **Note:** If you switch to a different model family, you'll also need to update the IAM policy on the `lambdaTextGen` role to allow `bedrock:InvokeModel` for the new model ARN. This is configured in `cdk/lib/api-stack.ts` under `textGenBedrockPolicyStatement`.

For guardrail configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

---

## Database Schema Changes (Migrations)

Migrations live in `cdk/lambda/db_setup/migrations/` and follow a numbered naming convention.

```javascript
// cdk/lambda/db_setup/migrations/015_add_new_feature_table.js
exports.up = async function (knex) {
  return knex.schema.createTable('new_feature', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.text('description');
    table.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  return knex.schema.dropTable('new_feature');
};
```

---

## Message/Token Limit Management

Token and message limits (daily token limit, max characters per message, min exchanges before suggestion, etc.) are admin-configurable at runtime — they're stored in the database and loaded by the Lambda on startup. No redeployment is needed to change them.

For details on how to configure these via the admin dashboard, see the User Guide.

---

## Data Ingestion Modifications

The ingestion pipeline is handled by `cdk/lambda/knowledgeBase/` (Python Lambda). To add new file types or processing logic, modify `main.py` and the `helpers/` modules. Add a DB migration if new metadata tables are needed.

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

By default, all encrypted resources in this project (RDS, S3, Secrets Manager, OpenSearch Serverless) use AWS managed keys. No configuration is required to use them, but they offer limited control over key rotation, auditing, and cross-account access.

If your organization requires customer-managed KMS keys (CMKs), see [`Docs/AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md) for a full list of affected resources and the exact CDK property changes needed in each stack.

---

## Troubleshooting & Best Practices

- **Lambda Timeout**: Increase `timeout` in the CDK function definition.
- **Memory/Latency**: Increase `memorySize`; check VPC and RDS proxy config.
- **Database**: Verify `SM_DB_CREDENTIALS` in Secrets Manager and RDS proxy endpoint.
- **Cognito**: Check user pool and client IDs in `frontend/.env`.
- **Guardrails**: See `Docs/BEDROCK_GUARDRAILS.md` for topic policies, allow rules, and testing.
- **Logging**: CloudWatch logs are the primary debugging source for all Lambdas.
