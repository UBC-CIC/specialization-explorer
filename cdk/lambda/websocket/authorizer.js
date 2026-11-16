const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

const secretsManager = new SecretsManagerClient();
let cachedSecrets;
let cacheExpiry = 0;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// $connect authorizer: only tokens bound to a user (sub is a user UUID) are accepted.
// The verified user id is exposed to every later route on this connection via
// requestContext.authorizer.userId.
exports.handler = async (event) => {
  const token = event.queryStringParameters?.token;

  if (!token) {
    console.warn("WebSocket connect rejected: missing token");
    throw new Error("Unauthorized");
  }

  try {
    const decoded = verifyToken(token, await loadSigningSecrets(), {
      algorithms: ["HS256"],
      issuer: "specex-public-token",
      audience: "specex-api",
    });

    if (typeof decoded?.sub !== "string" || !UUID_REGEX.test(decoded.sub)) {
      console.warn("WebSocket connect rejected: token is not bound to a user");
      throw new Error("Unauthorized");
    }

    return {
      principalId: decoded.sub,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: event.methodArn,
          },
        ],
      },
      // Later routes use tokenExp (seconds since epoch) to end the connection when the token expires
      context: { userId: decoded.sub, tokenExp: decoded.exp },
    };
  } catch (error) {
    console.error("WebSocket connect rejected: invalid token", error?.message);
    throw new Error("Unauthorized");
  }
};
