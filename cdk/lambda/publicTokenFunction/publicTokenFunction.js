const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");
const postgres = require("postgres");
const { getCorsHeaders } = require("./cors.js");
const crypto = require("crypto");
const { randomUUID } = crypto;

// Must match the verification options in the user and WebSocket authorizers
const TOKEN_OPTIONS = { algorithm: "HS256", issuer: "specex-public-token", audience: "specex-api" };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let sqlConnection;

const initConnection = async () => {
  if (!sqlConnection) {
    const secretResponse = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
    );
    const credentials = JSON.parse(secretResponse.SecretString);
    sqlConnection = postgres({
      host: process.env.RDS_PROXY_ENDPOINT,
      port: credentials.port,
      username: credentials.username,
      password: credentials.password,
      database: credentials.dbname,
      ssl: { rejectUnauthorized: true },
    });
  }
};

// Compares the SHA-256 of the presented key with users.user_key_hash.
// A user with no stored hash (revoked, or created before keys were stored) never matches.
const verifyUserKey = async (userId, userKey) => {
  await initConnection();
  const rows = await sqlConnection`
    SELECT user_key_hash FROM users WHERE id = ${userId}
  `;
  const storedHash = rows[0]?.user_key_hash;
  if (!storedHash) return false;
  const providedHash = crypto.createHash("sha256").update(userKey).digest();
  const storedBuf = Buffer.from(storedHash, "hex");
  return storedBuf.length === providedHash.length && crypto.timingSafeEqual(providedHash, storedBuf);
};

// Structured record of a credential check or token issuance. The presented key is never logged.
const auditTokenEvent = (event, { outcome, userId, jti }) =>
  console.log(
    JSON.stringify({
      audit: true,
      timestamp: new Date().toISOString(),
      requestId: event.requestContext?.requestId,
      actor: userId || "anonymous",
      sourceIp: event.requestContext?.identity?.sourceIp,
      action: `${event.httpMethod} ${event.resource}`,
      outcome,
      ...(jti && { jti }),
    })
  );

exports.handler = async (event) => {
  try {
    if (!cachedSecret || Date.now() > cacheExpiry) {
      const response = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
      );
      cachedSecret = JSON.parse(response.SecretString).jwtSecret;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
    }

    // Optional "Authorization: UserKey <userId>:<userKey>" binds the token to a user.
    // Without it the token is anonymous (no sub) and cannot act as any user.
    let subject;
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (authHeader?.startsWith("UserKey ")) {
      const [userId, userKey] = authHeader.slice("UserKey ".length).trim().split(":");
      if (!UUID_REGEX.test(userId || "") || !userKey || !(await verifyUserKey(userId.toLowerCase(), userKey))) {
        auditTokenEvent(event, {
          outcome: "denied",
          userId: UUID_REGEX.test(userId || "") ? userId.toLowerCase() : undefined,
        });
        return {
          statusCode: 401,
          headers: await getCorsHeaders(event),
          body: JSON.stringify({ error: "Invalid user credentials" }),
        };
      }
      subject = userId.toLowerCase();
    }

    const jti = randomUUID();
    const token = jwt.sign(
      {
        ...(subject && { sub: subject }),
        role: "user",
        jti,  // Unique token ID for tracing a token through the logs
        iat: Math.floor(Date.now() / 1000)  // Explicit issued-at timestamp
      },
      cachedSecret,
      { expiresIn: "15m", ...TOKEN_OPTIONS }  // Reduced to 15 minutes for better security
    );
    auditTokenEvent(event, { outcome: "success", userId: subject, jti });
    return {
      statusCode: 200,
      headers: await getCorsHeaders(event),
      body: JSON.stringify({ token }),
    };
  } catch (error) {
    console.error("Token generation error:", error);
    return {
      statusCode: 500,
      headers: await getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to generate token" }),
    };
  }
};
