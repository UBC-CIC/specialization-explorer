const crypto = require("crypto");
const { getCorsHeaders } = require("./utils/cors.js");
const { validateUUID, sanitizeString } = require("./utils/validation.js");
const { auditLog } = require("./utils/audit.js");
const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const MAX_TITLE_LENGTH = 200;
const MAX_METADATA_LENGTH = 4096;

let sqlConnection;
const secretsManager = new SecretsManagerClient();

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
    const authenticatedUserId = getAuthenticatedUserId(event);
    if (!authenticatedUserId) {
      response.statusCode = 401;
      response.body = JSON.stringify({ error: "Authentication required" });
      auditLog(event, response);
      return response;
    }

    await initConnection();
    const pathData = event.httpMethod + " " + event.resource;

    switch (pathData) {
      case "GET /chat_sessions/user/{user_id}": {
        const userId = event.pathParameters?.user_id;

        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        if (userId.toLowerCase() !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "Access denied" });
          break;
        }

        const sessions = await sqlConnection`
          SELECT id, user_id, title, created_at, last_active_at, metadata
          FROM chat_sessions
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
        `;

        data = sessions;
        response.body = JSON.stringify(data);
        break;
      }

      case "POST /chat_sessions": {
        const body = parseBody(event.body);
        const userId = authenticatedUserId;

        const title = sanitizeString(body.title, MAX_TITLE_LENGTH);
        const metadata = body.metadata ?? {};

        if (
          typeof metadata !== "object" ||
          Array.isArray(metadata) ||
          JSON.stringify(metadata).length > MAX_METADATA_LENGTH
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: `metadata must be an object of at most ${MAX_METADATA_LENGTH} characters`,
          });
          break;
        }

        // Validate user exists
        const userExists = await sqlConnection`
          SELECT id FROM users WHERE id = ${userId}
        `;
        if (userExists.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        const now = new Date();

        const chatSessionId = crypto.randomUUID();

        const inserted = await sqlConnection`
          INSERT INTO chat_sessions (
            id, user_id, title, created_at, last_active_at, metadata
          )
          VALUES (
            ${chatSessionId}, ${userId}, ${title}, ${now}, ${now}, ${metadata}
          )
          RETURNING id, user_id, title, created_at, last_active_at, metadata
        `;

        response.statusCode = 201;
        data = inserted[0];
        response.body = JSON.stringify(data);
        break;
      }

      case "PUT /chat_sessions/{chat_session_id}": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        const sessionIdValidation = validateUUID(chatSessionId, "chat_session_id");
        if (!sessionIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: sessionIdValidation.error });
          break;
        }

        const body = parseBody(event.body);
        const title = sanitizeString(body.title, MAX_TITLE_LENGTH);

        if (!title) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "title is required" });
          break;
        }

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
          response.body = JSON.stringify({ error: "You can only rename your own chat sessions" });
          break;
        }

        const updated = await sqlConnection`
          UPDATE chat_sessions
          SET title = ${title}, last_active_at = NOW()
          WHERE id = ${chatSessionId}
          RETURNING id, user_id, title, created_at, last_active_at, metadata
        `;

        response.statusCode = 200;
        data = updated[0];
        response.body = JSON.stringify(data);
        break;
      }

      case "GET /chat_sessions/{chat_session_id}/chat_history": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        const sessionIdValidation = validateUUID(chatSessionId, "chat_session_id");
        if (!sessionIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: sessionIdValidation.error });
          break;
        }

        const chatSessionResult = await sqlConnection`
          SELECT id, user_id
          FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;

        if (chatSessionResult.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Chat session not found" });
          break;
        }

        // Ownership validation (mandatory)
        const ownerId = chatSessionResult[0].user_id;
        if (ownerId !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({
            error: "Access denied",
            message: "You do not have permission to access this chat session",
          });
          break;
        }

        // Fetch messages
        const messages = await sqlConnection`
          SELECT id, chat_session_id, sender, content, sources, created_at
          FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}
          ORDER BY created_at ASC, id ASC
        `;

        data = {
          chat_session_id: chatSessionResult[0].id,
          messages,
        };

        response.statusCode = 200;
        response.body = JSON.stringify(data);
        break;
      }

      case "DELETE /chat_sessions/{chat_session_id}": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        const sessionIdValidation = validateUUID(chatSessionId, "chat_session_id");
        if (!sessionIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: sessionIdValidation.error });
          break;
        }

        // Verify the chat session exists and belongs to the user
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
          response.body = JSON.stringify({ error: "You can only delete your own chat sessions" });
          break;
        }

        // The session's messages are removed by the ON DELETE CASCADE foreign key
        await sqlConnection`
          DELETE FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;

        response.statusCode = 204;
        response.body = "";
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