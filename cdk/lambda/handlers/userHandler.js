const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const crypto = require("crypto");

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
        ssl: { rejectUnauthorized: false },
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

const createResponse = () => ({
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Headers":
      "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
  },
  body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
  response.body = JSON.stringify({ error: "Internal server error" });
};

exports.handler = async (event) => {
  const response = createResponse();
  let data;

  try {
    // Ensure connection is initialized before proceeding
    await initConnection();
    const pathData = event.httpMethod + " " + event.resource;

    switch (pathData) {
      case "GET /user/exampleEndpoint":
        data = "Example endpoint invoked";
        response.body = JSON.stringify(data);
        break;

      case "POST /user": {
        const body = parseBody(event.body);

        // Default role is student
        const role = body.role || "student";
        if (!["student", "admin"].includes(role)) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Invalid role" });
          break;
        }

        const userId = crypto.randomUUID();
        const email = body.email || null;
        const displayName = body.display_name || body.displayName || null;
        const metadata = body.metadata || {};

        const now = new Date();

        // Create a new row (email can be null)
        const result = await sqlConnection`
          INSERT INTO users (
            id, email, display_name, role,
            created_at, last_seen_at,
            metadata
          )
          VALUES (
            ${userId}, ${email}, ${displayName}, ${role},
            ${now}, ${now},
            ${metadata}
          )
          RETURNING
            id, email, display_name, role,
            created_at, last_seen_at, metadata
        `;

        const row = result[0];

        data = {
          userId: row.id,
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
        const userId = event.pathParameters?.user_id;
        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        const user = await sqlConnection`
          SELECT id, email, display_name, role, created_at, last_seen_at,
                tokens_used, token_window_started_at, metadata
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

      // DEPRECATED by /user --> will delete later
      case "PUT /user/{user_id}": {
        const userId = event.pathParameters?.user_id;
        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        const body = parseBody(event.body);
        const email = body.email;
        const metadata = body.metadata;

        if (email === undefined && metadata === undefined) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "No update fields provided" });
          break;
        }

        if (email) {
          // Check if this email already exists for a DIFFERENT user
          const existing = await sqlConnection`
            SELECT id, email, display_name, role, created_at, last_seen_at, tokens_used, token_window_started_at, metadata
            FROM users 
            WHERE email = ${email} 
            LIMIT 1
          `;
          
          if (existing.length > 0 && existing[0].id !== userId) {
            // Email belongs to an existing account.
            const existingUser = existing[0];

            // SECURITY FIX: Prevent claiming of admin accounts by simply knowing their email.
            if (existingUser.role === 'admin') {
              response.statusCode = 403;
              response.body = JSON.stringify({ error: "Cannot merge into an administrator account. Please contact support." });
              break;
            }
            
            // "Log them in" to that account.
            // Try to delete the current temporary user to avoid orphaned rows
            try {
              // Delete child rows safely if needed, or just let DB cascade or fail
              // In this case we just ignore failure since it's an optimization to avoid clutter
              await sqlConnection`DELETE FROM users WHERE id = ${userId}`;
            } catch (err) {
              console.warn("Could not delete temporary user id", userId, err.message);
            }
            
            // Update the last_seen_at for the returned existing user
            await sqlConnection`UPDATE users SET last_seen_at = NOW() WHERE id = ${existingUser.id}`;
            existingUser.last_seen_at = new Date().toISOString();
            
            response.body = JSON.stringify(existingUser);
            break;
          }
        }

        // Build the dynamic update query
        // Because the user only wanted to set email/metadata, let's keep it simple:

        let updateQuery;
        if (email !== undefined && metadata !== undefined) {
          updateQuery = sqlConnection`
            UPDATE users
            SET email = ${email}, metadata = metadata || ${metadata}::jsonb, last_seen_at = NOW()
            WHERE id = ${userId}
            RETURNING id, email, display_name, role, created_at, last_seen_at, tokens_used, token_window_started_at, metadata
          `;
        } else if (email !== undefined) {
          updateQuery = sqlConnection`
            UPDATE users
            SET email = ${email}, last_seen_at = NOW()
            WHERE id = ${userId}
            RETURNING id, email, display_name, role, created_at, last_seen_at, tokens_used, token_window_started_at, metadata
          `;
        } else if (metadata !== undefined) {
          updateQuery = sqlConnection`
            UPDATE users
            SET metadata = metadata || ${metadata}::jsonb, last_seen_at = NOW()
            WHERE id = ${userId}
            RETURNING id, email, display_name, role, created_at, last_seen_at, tokens_used, token_window_started_at, metadata
          `;
        }

        const user = await updateQuery;

        if (user.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        response.body = JSON.stringify(user[0]);
        break;
      }

      case "POST /user_sessions":
        // After schema refactor, user_sessions no longer has a separate session_id column.
        // Create a new session row and use its primary key (id) as the public session UUID.
        const sessionBody = parseBody(event.body);
        const sessionRole = sessionBody.role || "student"; // default to 'student' if not provided

        const result = await sqlConnection`
          INSERT INTO user_sessions (role, created_at, last_active_at)
          VALUES (${sessionRole}, NOW(), NOW())
          RETURNING id, role, created_at
        `;

        data = {
          sessionId: result[0].id, // public session UUID
          userSessionId: result[0].id, // internal id is the same UUID
          role: result[0].role,
        };
        response.body = JSON.stringify(data);
        break;

      // DEPRECATED by /user/{user_id} --> will delete later
      case "GET /user_sessions/{session_id}":
        const sessionId = event.pathParameters?.session_id;
        if (!sessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Session ID is required" });
          break;
        }

        // Validate and get user session by primary key (id)
        const userSession = await sqlConnection`
          SELECT id, session_title, context, role, created_at, last_active_at, expires_at, metadata
          FROM user_sessions 
          WHERE id = ${sessionId}
        `;

        if (userSession.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User session not found" });
          break;
        }

        // Update last_active_at timestamp
        await sqlConnection`
          UPDATE user_sessions 
          SET last_active_at = NOW() 
          WHERE id = ${sessionId}
        `;

        data = {
          id: userSession[0].id,
          session_title: userSession[0].session_title,
          context: userSession[0].context,
          role: userSession[0].role,
          created_at: userSession[0].created_at,
          last_active_at: new Date().toISOString(), // Return updated timestamp
          expires_at: userSession[0].expires_at,
          metadata: userSession[0].metadata,
        };
        response.body = JSON.stringify(data);
        break;

      case "PUT /user_sessions/{session_id}":
        const updateSessionId = event.pathParameters?.session_id;
        if (!updateSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Session ID is required" });
          break;
        }

        const updateSessionBody = parseBody(event.body);
        const updateRole = updateSessionBody.role;

        if (!updateRole || !["student", "instructor"].includes(updateRole)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Valid role (student or instructor) is required",
          });
          break;
        }

        // Update the user session role
        const updatedSession = await sqlConnection`
          UPDATE user_sessions 
          SET role = ${updateRole}, last_active_at = NOW()
          WHERE id = ${updateSessionId}
          RETURNING id, session_title, context, role, created_at, last_active_at, expires_at, metadata
        `;

        if (updatedSession.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User session not found" });
          break;
        }

        data = updatedSession[0];
        response.body = JSON.stringify(data);
        break;

      case "GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history": {
        const userId = event.pathParameters?.user_id;
        const chatSessionId = event.pathParameters?.chat_session_id;

        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }
        if (!chatSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "chat_session_id is required" });
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
        if (chatSession[0].user_id !== userId) {
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

      // DEPRECATED by /user/{user_id}/chat_sessions/{chat_session_id}/chat_history --> will delete later
      case "GET /user_sessions/{session_id}/chat_sessions/{chat_session_id}/interactions":
        const sessionId1 = event.pathParameters?.session_id;
        const chatSessionId1 = event.pathParameters?.chat_session_id;
        if (!sessionId1) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Session ID is required" });
          break;
        }
        if (!chatSessionId1) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Chat Session ID is required",
          });
          break;
        }

        // Validate user session exists by primary key (id)
        const userSession1 = await sqlConnection`
          SELECT id FROM user_sessions WHERE id = ${sessionId1}
        `;

        if (userSession1.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User session not found" });
          break;
        }

        const limit = Math.min(
          parseInt(event.queryStringParameters?.limit) || 20,
          100
        );
        const offset = parseInt(event.queryStringParameters?.offset) || 0;

        // Fetch interactions for the specific chat session
        const interactionsResult = await sqlConnection`
          SELECT 
            id,
            chat_session_id,
            sender_role,
            query_text,
            response_text,
            message_meta,
            source_chunks,
            created_at,
            order_index,
            COUNT(*) OVER() as total_count
          FROM user_interactions
          WHERE chat_session_id = ${chatSessionId1}
          ORDER BY created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;

        const total =
          interactionsResult.length > 0
            ? parseInt(interactionsResult[0].total_count)
            : 0;
        const interactions = interactionsResult.map(
          ({ total_count, ...interaction }) => ({
            ...interaction,
            // Back-compat alias: legacy field name
            session_id: interaction.chat_session_id,
          })
        );

        data = {
          interactions,
          pagination: {
            limit,
            offset,
            total,
            hasMore: offset + limit < total,
          },
        };
        response.body = JSON.stringify(data);
        break;

      case "POST /user_sessions/{session_id}/interactions":
        const sessionId2 = event.pathParameters?.session_id;
        if (!sessionId2) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Session ID is required" });
          break;
        }

        // Validate user session by primary key
        const userSession2 = await sqlConnection`
          SELECT id FROM user_sessions WHERE id = ${sessionId2}
        `;

        if (userSession2.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User session not found" });
          break;
        }

        const userSessionId2 = userSession2[0].id;
        const createData = parseBody(event.body);
        const {
          chat_session_id,
          sender_role,
          query_text,
          response_text,
          message_meta,
          source_chunks,
          order_index,
        } = createData;

        if (!sender_role) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "sender_role is required" });
          break;
        }

        if (!chat_session_id) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "chat_session_id is required",
          });
          break;
        }

        // Ensure the chat session belongs to the provided user session
        const chatSessionCheck = await sqlConnection`
          SELECT id FROM chat_sessions WHERE id = ${chat_session_id} AND user_session_id = ${userSessionId2}
        `;
        if (chatSessionCheck.length === 0) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid chat_session_id for this session",
          });
          break;
        }

        const newInteraction = await sqlConnection`
          INSERT INTO user_interactions (chat_session_id, sender_role, query_text, response_text, message_meta, source_chunks, order_index)
          VALUES (${chat_session_id}, ${sender_role}, ${query_text || null}, ${response_text || null
          }, ${message_meta || {}}, ${source_chunks || []}, ${order_index || null
          })
          RETURNING id, chat_session_id, sender_role, query_text, response_text, message_meta, source_chunks, created_at, order_index
        `;

        response.statusCode = 201;
        data = {
          ...newInteraction[0],
          session_id: newInteraction[0].chat_session_id,
        };
        response.body = JSON.stringify(data);
        break;

      case "GET /interactions/{interaction_id}":
        const interactionId = event.pathParameters?.interaction_id;
        if (!interactionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Interaction ID is required",
          });
          break;
        }

        const interaction = await sqlConnection`
          SELECT id, chat_session_id, sender_role, query_text, response_text, message_meta, source_chunks, created_at, order_index
          FROM user_interactions
          WHERE id = ${interactionId}
        `;

        if (interaction.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Interaction not found" });
          break;
        }

        data = {
          ...interaction[0],
          session_id: interaction[0].chat_session_id,
        };
        response.body = JSON.stringify(data);
        break;

      case "PUT /interactions/{interaction_id}":
        const updateInteractionId = event.pathParameters?.interaction_id;
        if (!updateInteractionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Interaction ID is required",
          });
          break;
        }

        const updateData = parseBody(event.body);
        const {
          sender_role: updateSenderRole,
          query_text: updateQueryText,
          response_text: updateResponseText,
          message_meta: updateMessageMeta,
          source_chunks: updateSourceChunks,
          order_index: updateOrderIndex,
        } = updateData;

        const updated = await sqlConnection`
          UPDATE user_interactions 
          SET sender_role = ${updateSenderRole}, query_text = ${updateQueryText}, response_text = ${updateResponseText}, 
              message_meta = ${updateMessageMeta || {}}, source_chunks = ${updateSourceChunks || []
          }, order_index = ${updateOrderIndex}
          WHERE id = ${updateInteractionId}
          RETURNING id, chat_session_id, sender_role, query_text, response_text, message_meta, source_chunks, created_at, order_index
        `;

        if (updated.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Interaction not found" });
          break;
        }

        data = { ...updated[0], session_id: updated[0].chat_session_id };
        response.body = JSON.stringify(data);
        break;

      case "DELETE /interactions/{interaction_id}":
        const deleteInteractionId = event.pathParameters?.interaction_id;
        if (!deleteInteractionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Interaction ID is required",
          });
          break;
        }

        const deleted = await sqlConnection`
          DELETE FROM user_interactions WHERE id = ${deleteInteractionId} RETURNING id
        `;

        if (deleted.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Interaction not found" });
          break;
        }

        response.statusCode = 204;
        response.body = "";
        break;

      case "GET /user_sessions/{session_id}/analytics":
        const analyticsSessionId = event.pathParameters?.session_id;
        if (!analyticsSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Session ID is required" });
          break;
        }

        // Validate user session by primary key
        const userSessionAnalytics = await sqlConnection`
          SELECT id FROM user_sessions WHERE id = ${analyticsSessionId}
        `;

        if (userSessionAnalytics.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User session not found" });
          break;
        }

        const userSessionAnalyticsId = userSessionAnalytics[0].id;
        const analyticsLimit = Math.min(
          parseInt(event.queryStringParameters?.limit) || 20,
          100
        );
        const analyticsOffset =
          parseInt(event.queryStringParameters?.offset) || 0;

        const analyticsResult = await sqlConnection`
          SELECT 
            id, user_session_id, event_type, properties, created_at,
            COUNT(*) OVER() as total_count
          FROM analytics_events
          WHERE user_session_id = ${userSessionAnalyticsId}
          ORDER BY created_at DESC
          LIMIT ${analyticsLimit} OFFSET ${analyticsOffset}
        `;

        const analyticsTotal =
          analyticsResult.length > 0
            ? parseInt(analyticsResult[0].total_count)
            : 0;
        const analytics = analyticsResult.map(
          ({ total_count, ...event }) => event
        );

        data = {
          analytics,
          pagination: {
            limit: analyticsLimit,
            offset: analyticsOffset,
            total: analyticsTotal,
            hasMore: analyticsOffset + analyticsLimit < analyticsTotal,
          },
        };
        response.body = JSON.stringify(data);
        break;

      case "POST /user_sessions/{session_id}/analytics":
        const createAnalyticsSessionId = event.pathParameters?.session_id;
        if (!createAnalyticsSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Session ID is required" });
          break;
        }

        // Validate user session by primary key
        const userSessionCreate = await sqlConnection`
          SELECT id FROM user_sessions WHERE id = ${createAnalyticsSessionId}
        `;

        if (userSessionCreate.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User session not found" });
          break;
        }

        const userSessionCreateId = userSessionCreate[0].id;
        const analyticsData = parseBody(event.body);
        const { event_type, properties } = analyticsData;

        if (!event_type) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "event_type is required" });
          break;
        }

        const newAnalytics = await sqlConnection`
          INSERT INTO analytics_events (user_session_id, event_type, properties)
          VALUES (${userSessionCreateId}, ${event_type}, ${properties || {}})
          RETURNING id, user_session_id, event_type, properties, created_at
        `;

        response.statusCode = 201;
        data = newAnalytics[0];
        response.body = JSON.stringify(data);
        break;

      case "GET /analytics/{analytics_id}":
        const analyticsId = event.pathParameters?.analytics_id;
        if (!analyticsId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Analytics ID is required" });
          break;
        }

        const analyticsEvent = await sqlConnection`
          SELECT id, user_session_id, event_type, properties, created_at
          FROM analytics_events
          WHERE id = ${analyticsId}
        `;

        if (analyticsEvent.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({
            error: "Analytics event not found",
          });
          break;
        }

        data = analyticsEvent[0];
        response.body = JSON.stringify(data);
        break;

      case "PUT /analytics/{analytics_id}":
        const updateAnalyticsId = event.pathParameters?.analytics_id;
        if (!updateAnalyticsId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Analytics ID is required" });
          break;
        }

        const updateAnalyticsData = parseBody(event.body);
        const { event_type: updateEventType, properties: updateProperties } =
          updateAnalyticsData;

        const updatedAnalytics = await sqlConnection`
          UPDATE analytics_events 
          SET event_type = ${updateEventType}, properties = ${updateProperties || {}
          }
          WHERE id = ${updateAnalyticsId}
          RETURNING id, user_session_id, event_type, properties, created_at
        `;

        if (updatedAnalytics.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({
            error: "Analytics event not found",
          });
          break;
        }

        data = updatedAnalytics[0];
        response.body = JSON.stringify(data);
        break;

      case "DELETE /analytics/{analytics_id}":
        const deleteAnalyticsId = event.pathParameters?.analytics_id;
        if (!deleteAnalyticsId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Analytics ID is required" });
          break;
        }

        const deletedAnalytics = await sqlConnection`
          DELETE FROM analytics_events WHERE id = ${deleteAnalyticsId} RETURNING id
        `;

        if (deletedAnalytics.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({
            error: "Analytics event not found",
          });
          break;
        }

        response.statusCode = 204;
        response.body = "";
        break;

      // GET /public/config/userGuidelines - Public endpoint to fetch user guidelines
      case "GET /public/config/userGuidelines":
        try {
          const guidelinesResult = await sqlConnection`
            SELECT value FROM system_settings WHERE key = 'user_guidelines'
          `;

          const userGuidelines =
            guidelinesResult.length > 0 ? guidelinesResult[0].value : "";

          response.statusCode = 200;
          response.body = JSON.stringify({
            userGuidelines: userGuidelines,
          });
        } catch (error) {
          console.error("Error getting user guidelines:", error);
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "Failed to get user guidelines",
          });
        }
        break;

      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    handleError(error, response);
  }

  console.log(response);
  return response;
};
