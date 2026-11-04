const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { CognitoJwtVerifier } = require("aws-jwt-verify");

// Create a Secrets Manager client
const secretsManager = new SecretsManagerClient();

let { SM_COGNITO_CREDENTIALS } = process.env;

// Create the verifier outside the Lambda handler (= during cold start),
// so the cache can be reused for subsequent invocations. Then, only during the
// first invocation, will the verifier actually need to fetch the JWKS.
let jwtVerifier;

async function initializeConnection() {
  try {
    // Retrieve the secret from AWS Secrets Manager
    const getSecretValueCommand = new GetSecretValueCommand({
      SecretId: SM_COGNITO_CREDENTIALS,
    });
    const secretResponse = await secretsManager.send(getSecretValueCommand);

    const credentials = JSON.parse(secretResponse.SecretString);

    jwtVerifier = CognitoJwtVerifier.create({
      userPoolId: credentials.VITE_COGNITO_USER_POOL_ID,
      tokenUse: "id",
      groups: "admin",
      clientId: credentials.VITE_COGNITO_USER_POOL_CLIENT_ID,
    });
  } catch (error) {
    console.error("Error initializing JWT verifier:", error);
    throw new Error("Failed to initialize JWT verifier");
  }
}

exports.handler = async (event) => {
  if (!jwtVerifier) {
    await initializeConnection();
  }

  const accessToken = event.authorizationToken.toString();
  let payload;

  try {
    payload = await jwtVerifier.verify(accessToken);

    // Modify the response output
    const parts = event.methodArn.split("/");
    const resource = parts.slice(0, 2).join("/") + "/*/admin/*";

    return {
      principalId: payload.sub, // The principal user identification associated with the token sent by the client.
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: resource,
          },
        ],
      },
      context: {
        userId: payload.sub,
        email: payload.email,
        role: "admin",
      },
    };
  } catch (error) {
    console.error("Authorization error:", error);
    // API Gateway wants this *exact* error message, otherwise it returns 500 instead of 401:
    throw new Error("Unauthorized");
  }
};
