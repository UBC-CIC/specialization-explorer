# Specialization Explorer Frontend

React 19 + TypeScript app built with Vite, Tailwind CSS and shadcn/ui. The React Compiler is enabled through `babel-plugin-react-compiler` in `vite.config.ts`. In deployment the app is built and hosted by AWS Amplify (see the [Deployment Guide](../Docs/DEPLOYMENT_GUIDE.md)).

## Environment variables

Amplify sets these at build time from the CDK outputs. To run the app locally, put them in `frontend/.env.local` (do not commit it), using the values from the Amplify app's environment variables:

| Variable | Value |
| --- | --- |
| `VITE_API_ENDPOINT` | REST API stage URL |
| `VITE_WEBSOCKET_URL` | WebSocket URL including the stage, e.g. `wss://<id>.execute-api.<region>.amazonaws.com/prod` |
| `VITE_COGNITO_USER_POOL_ID` | Cognito user pool ID |
| `VITE_COGNITO_USER_POOL_CLIENT_ID` | Cognito app client ID |

Amplify also sets `VITE_AWS_REGION` and `VITE_IDENTITY_POOL_ID`, which the current code does not read.

The API only answers origins listed in the `/<STACK-PREFIX>-Api/API/AllowedOrigins` SSM parameter, so `http://localhost:5173` must be in that list for local development (see "Adding Custom Allowed Origins" in the Deployment Guide).

## Commands

- `npm install`: install dependencies
- `npm run dev`: start the Vite dev server
- `npm run build`: type-check and build to `dist/`
- `npm run lint`: run ESLint

## Layout

`src/` contains `pages/` (route-level pages), `components/` (including `Admin/`, `ChatInterface/` and the shadcn `ui/` primitives), `providers/` (React context for the user, sidebar and view state), `hooks/`, `lib/`, `functions/`, `layouts/` and `types/`. The `@` import alias maps to `src/`.
