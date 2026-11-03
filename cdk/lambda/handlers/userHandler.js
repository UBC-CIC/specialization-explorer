const postgres = require("postgres");
const { getCorsHeaders } = require("./utils/cors.js");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const crypto = require("crypto");
const { validateUUID } = require("./utils/validation.js");
const { auditLog } = require("./utils/audit.js");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 100;

let sqlConnection;
const secretsManager = new SecretsManagerClient();

// Per-user credential exchanged at /user/publicToken for a token bound to this user.
// Only the hash is stored (users.user_key_hash); must stay in sync with publicTokenFunction.js.
const generateUserKey = () => {
  const userKey = crypto.randomBytes(32).toString("hex");
  const userKeyHash = crypto.createHash("sha256").update(userKey).digest("hex");
  return { userKey, userKeyHash };
};

// Timing-safe comparison of a presented key against users.user_key_hash; a missing hash never matches
const matchesKeyHash = (userKey, storedHash) => {
  if (!storedHash) return false;
  const providedHash = crypto.createHash("sha256").update(userKey).digest();
  const storedBuf = Buffer.from(storedHash, "hex");
  return storedBuf.length === providedHash.length && crypto.timingSafeEqual(providedHash, storedBuf);
};

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const getSecretValueCommand = new GetSecretValueCommand({
        SecretId: process.env.SM_DB_CREDENTIALS,
      });
      const secretResponse = await secretsManager.send(getSecretValueCommand);
      const credentials = JSON.parse(secretResponse.SecretString);

      const connectionConfig = {
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: true },
      };

      sqlConnection = postgres(connectionConfig);
      await sqlConnection`SELECT 1`;
      console.log("Database connection initialized successfully");
    } catch (error) {
      console.error("Error initializing database connection:", error);
      throw error;
    }
  }
};

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event),
    body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

// The caller's identity, taken from the verified token. Anonymous tokens have none.
const getAuthenticatedUserId = (event) => {
  const userId = event.requestContext?.authorizer?.userId;
  return validateUUID(userId).valid ? userId.toLowerCase() : null;
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
  response.body = JSON.stringify({ error: "Internal server error" });
};

exports.handler = async (event) => {
  const response = await createResponse(event);
  let data;

  try {
    // Ensure connection is initialized before proceeding
    await initConnection();
    const pathData = event.httpMethod + " " + event.resource;

    switch (pathData) {
      case "POST /user": {
        const body = parseBody(event.body);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Request body must be a JSON object" });
          break;
        }

        // Default role is student
        const role = "student";
        const userId = crypto.randomUUID();

        // Emails given by anonymous callers are unverified, so they are kept as a contact address
        // in metadata.contact_email and never written to users.email, which links a row to a
        // verified Cognito identity at sign-up. Responses report whichever of the two is set.
        let contactEmail = null;
        if (body.email !== undefined && body.email !== null && body.email !== "") {
          const candidate = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          if (candidate.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(candidate)) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "Invalid email format" });
            break;
          }
          contactEmail = candidate;
        }

        let displayName = null;
        const rawDisplayName = body.display_name ?? body.displayName;
        if (rawDisplayName !== undefined && rawDisplayName !== null && rawDisplayName !== "") {
          displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : "";
          if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: `display_name must be a non-empty string of at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
            });
            break;
          }
        }

        // Anonymous callers cannot set metadata; the only key stored is the server-built contact_email
        const metadata = contactEmail ? { contact_email: contactEmail } : {};

        const now = new Date();
        const { userKey, userKeyHash } = generateUserKey();

        // Create a new row (email can be null)
        const result = await sqlConnection`
          INSERT INTO users (
            id, email, display_name, role,
            created_at, last_seen_at,
            metadata, user_key_hash
          )
          VALUES (
            ${userId}, NULL, ${displayName}, ${role},
            ${now}, ${now},
            ${metadata}, ${userKeyHash}
          )
          RETURNING
            id, COALESCE(email, metadata->>'contact_email') AS email, display_name, role,
            created_at, last_seen_at, metadata
        `;

        const row = result[0];

        data = {
          userId: row.id,
          userKey,
          email: row.email,
          display_name: row.display_name,
          role: row.role,
          created_at: row.created_at,
          last_seen_at: row.last_seen_at,
          metadata: row.metadata,
        };

        response.body = JSON.stringify(data);
        break;
      }

      case "GET /user/{user_id}": {
        const authenticatedUserId = getAuthenticatedUserId(event);
        if (!authenticatedUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Authentication required" });
          break;
        }

        const userId = event.pathParameters?.user_id;
        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }
        if (userId.toLowerCase() !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "Access denied" });
          break;
        }

        const user = await sqlConnection`
          SELECT id, COALESCE(email, metadata->>'contact_email') AS email,
                display_name, role, created_at, last_seen_at,
                messages_sent, messages_window_started_at, metadata
          FROM users
          WHERE id = ${userId}
        `;

        if (user.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        // update last_seen_at
        await sqlConnection`
          UPDATE users SET last_seen_at = NOW() WHERE id = ${userId}
        `;

        response.body = JSON.stringify(user[0]);
        break;
      }

      // Update's user with email so they no longer will be anonymous
      case "PUT /user/{user_id}": {
        const authenticatedUserId = getAuthenticatedUserId(event);
        if (!authenticatedUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Authentication required" });
          break;
        }

        const userId = event.pathParameters?.user_id;
        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }
        if (userId.toLowerCase() !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "Access denied" });
          break;
        }

        let parsedBody = {};

        try {
          parsedBody = event.body ? JSON.parse(event.body) : {};
        } catch (err) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Request body must be valid JSON" });
          break;
        }

        const rawEmail = parsedBody.email;

        if (typeof rawEmail !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "email is required and must be a string" });
          break;
        }

        const normalizedEmail = rawEmail.trim().toLowerCase();

        if (!normalizedEmail) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "email cannot be empty" });
          break;
        }

        if (!EMAIL_REGEX.test(normalizedEmail)) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Invalid email format" });
          break;
        }

        const existingUser = await sqlConnection`
          SELECT id
          FROM users
          WHERE id = ${userId}
        `;

        if (existingUser.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        const updatedUser = await sqlConnection`
          UPDATE users
          SET
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object('contact_email', ${normalizedEmail}::text),
            last_seen_at = NOW()
          WHERE id = ${userId}
          RETURNING
            id,
            COALESCE(email, metadata->>'contact_email') AS email,
            display_name,
            role,
            created_at,
            last_seen_at,
            messages_sent,
            messages_window_started_at,
            metadata
        `;

        response.statusCode = 200;
        response.body = JSON.stringify(updatedUser[0]);
        break;
      }

      // Replaces the user's key after verifying the current one; the previous key stops working immediately
      case "POST /user/{user_id}/key": {
        const authenticatedUserId = getAuthenticatedUserId(event);
        if (!authenticatedUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Authentication required" });
          break;
        }

        const userId = event.pathParameters?.user_id;
        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }
        if (userId.toLowerCase() !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "Access denied" });
          break;
        }

        const rotateBody = parseBody(event.body);
        const currentKey = rotateBody?.currentKey;

        const existing = await sqlConnection`
          SELECT user_key_hash FROM users WHERE id = ${userId}
        `;
        if (existing.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        // The token alone is not enough: the caller must also hold the current key
        if (typeof currentKey !== "string" || !matchesKeyHash(currentKey, existing[0].user_key_hash)) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Invalid user credentials" });
          break;
        }

        const { userKey, userKeyHash } = generateUserKey();
        // Matching on the hash that was just verified keeps two concurrent rotations from both succeeding
        const rotated = await sqlConnection`
          UPDATE users
          SET user_key_hash = ${userKeyHash},
              user_key_version = user_key_version + 1
          WHERE id = ${userId} AND user_key_hash = ${existing[0].user_key_hash}
          RETURNING user_key_version
        `;

        if (rotated.length === 0) {
          response.statusCode = 409;
          response.body = JSON.stringify({ error: "User key was changed concurrently" });
          break;
        }

        response.body = JSON.stringify({ userKey });
        break;
      }

      case "GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history": {
        const authenticatedUserId = getAuthenticatedUserId(event);
        if (!authenticatedUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Authentication required" });
          break;
        }

        const userId = event.pathParameters?.user_id;
        const chatSessionId = event.pathParameters?.chat_session_id;

        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }
        if (userId.toLowerCase() !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "Access denied" });
          break;
        }
        const sessionIdValidation = validateUUID(chatSessionId, "chat_session_id");
        if (!sessionIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: sessionIdValidation.error });
          break;
        }

        // Validate user exists (optional but nice)
        const userExists = await sqlConnection`
          SELECT id FROM users WHERE id = ${userId}
        `;
        if (userExists.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        // Validate chat session exists AND belongs to user
        const chatSession = await sqlConnection`
          SELECT id, user_id
          FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;
        if (chatSession.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Chat session not found" });
          break;
        }
        if (chatSession[0].user_id !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "You can only access your own chat sessions" });
          break;
        }

        const limit = Math.min(parseInt(event.queryStringParameters?.limit) || 200, 1000);
        const offset = parseInt(event.queryStringParameters?.offset) || 0;

        const rows = await sqlConnection`
          SELECT
            id,
            chat_session_id,
            sender,
            content,
            sources,
            warning,
            created_at,
            COUNT(*) OVER() as total_count
          FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}
          ORDER BY created_at ASC, id ASC
          LIMIT ${limit} OFFSET ${offset}
        `;

        const total = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
        const messages = rows.map(({ total_count, ...msg }) => msg);

        data = {
          chat_session_id: chatSessionId,
          user_id: userId,
          messages,
          pagination: {
            limit,
            offset,
            total,
            hasMore: offset + limit < total,
          },
        };

        response.statusCode = 200;
        response.body = JSON.stringify(data);
        break;
      }

      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    handleError(error, response);
  }

  auditLog(event, response);
  console.log({ statusCode: response.statusCode });
  return response;
};
