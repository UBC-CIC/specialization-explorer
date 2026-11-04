const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

const secretsManager = new SecretsManagerClient();
let cachedSecrets;
let cacheExpiry = 0;

// Keys are re-read this often, so a rotation reaches warm containers promptly
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
// A token lives 15 minutes and keys are cached for up to 5, so the key that was current
// before a rotation is honoured only this long after it. Rotating again retires a key.
const PREVIOUS_KEY_GRACE_MS = 25 * 60 * 1000;

const loadSigningSecrets = async () => {
  if (cachedSecrets && Date.now() < cacheExpiry) return cachedSecrets;

  const current = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET, VersionStage: "AWSCURRENT" })
  );
  const secrets = [JSON.parse(current.SecretString).jwtSecret];

  if (current.CreatedDate && Date.now() - current.CreatedDate.getTime() < PREVIOUS_KEY_GRACE_MS) {
    try {
      const previous = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET, VersionStage: "AWSPREVIOUS" })
      );
      secrets.push(JSON.parse(previous.SecretString).jwtSecret);
    } catch (error) {
      if (error.name !== "ResourceNotFoundException") throw error;
    }
  }

  cachedSecrets = secrets;
  cacheExpiry = Date.now() + SECRET_CACHE_TTL_MS;
  return secrets;
};

const verifyToken = (token, secrets, options) => {
  let signatureError;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret, options);
    } catch (error) {
      if (error.message !== "invalid signature") throw error;
      signatureError = error;
    }
  }
  throw signatureError;
};

const ANONYMOUS_RESOURCES = [
  "POST/user",
  "GET/system_message/*",
  "GET/system-settings/*",
];

exports.handler = async (event) => {
  const token = event.authorizationToken?.replace("Bearer ", "");

  if (!token) {
    console.warn("No token provided");
    throw new Error("Unauthorized");
  }

  try {
    const decoded = verifyToken(token, await loadSigningSecrets(), {
      algorithms: ["HS256"],
      issuer: "specex-public-token",
      audience: "specex-api",
    });

    // methodArn format: arn:aws:execute-api:region:account:apiId/stage/method/resource
    const arnParts = event.methodArn.split('/');
    const apiGatewayArnPrefix = arnParts.slice(0, 2).join('/'); // arn:aws:execute-api:region:account:apiId/stage

    // Tokens bound to a user (sub) may call the user-tier API. Anonymous tokens
    // can only create a user and read the shared public settings.
    const resources = decoded.sub
      ? [`${apiGatewayArnPrefix}/*/*`]
      : ANONYMOUS_RESOURCES.map((r) => `${apiGatewayArnPrefix}/${r}`);

    const policy = generatePolicy(decoded.sub || "anonymous", "Allow", resources);
    // The admin plane has its own authorizer; never let a user token reach it
    policy.policyDocument.Statement.push({
      Action: "execute-api:Invoke",
      Effect: "Deny",
      Resource: [`${apiGatewayArnPrefix}/*/admin/*`],
    });
    // Only the verified identity is passed on; other token claims are not trusted downstream
    policy.context = decoded.sub ? { userId: decoded.sub } : {};
    return policy;
  } catch (err) {
    console.error("Authorization error:", err.message);
    throw new Error("Unauthorized");
  }
};

function generatePolicy(principalId, effect, resources) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resources,
        },
      ],
    },
  };
}