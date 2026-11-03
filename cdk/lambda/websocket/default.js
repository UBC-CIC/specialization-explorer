const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const {
  DynamoDBClient,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} = require("@aws-sdk/client-dynamodb");
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validateUUID = (value, fieldName = "id") => {
  if (!value || typeof value !== "string") return { valid: false, error: `${fieldName} is required` };
  if (!UUID_REGEX.test(value.trim())) return { valid: false, error: `${fieldName} must be a valid UUID` };
  return { valid: true };
};

const sanitizeString = (value, maxLength = 10000) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maxLength);
};

const lambda = new LambdaClient({});
const dynamodb = new DynamoDBClient({});

// The endpoint comes from configuration, never from the request
const endpoint = (process.env.WEBSOCKET_API_ENDPOINT || "").replace(/^wss:\/\//, "https://");
const apigw = endpoint ? new ApiGatewayManagementApiClient({ endpoint }) : null;

const parseLimit = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// WAF cannot be associated with a WebSocket API, so the message rate is enforced here, per user,
// before the text generation function is invoked. Keying on the user (from the $connect
// authorizer) rather than the connection stops a client from opening extra connections to
// get more messages. The daily quota is still enforced by text generation.
const RATE_WINDOW_SECONDS = 60;
const MESSAGE_RATE_LIMIT = parseLimit(process.env.MESSAGE_RATE_LIMIT_PER_MINUTE, 10);
const WARMUP_RATE_LIMIT = parseLimit(process.env.WARMUP_RATE_LIMIT_PER_MINUTE, 2);

const RATE_LIMIT_MESSAGE = "You're sending messages too quickly. Please wait a minute and try again.";
const UNAVAILABLE_MESSAGE = "Sorry, your message could not be sent. Please try again.";

// Counts one request in the user's current fixed window. Returns false when the window is full.
// The conditional update is atomic, so concurrent requests cannot exceed the limit.
const consumeRateLimit = async (userId, kind, limit) => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % RATE_WINDOW_SECONDS);

  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: process.env.RATE_LIMIT_TABLE_NAME,
        Key: { pk: { S: `${kind}#${userId}#${windowStart}` } },
        UpdateExpression: "SET #expiresAt = if_not_exists(#expiresAt, :expiresAt) ADD #count :one",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "requestCount", "#expiresAt": "expiresAt" },
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":limit": { N: String(limit) },
          // Kept one extra window so an item is never removed while it is still in use
          ":expiresAt": { N: String(windowStart + 2 * RATE_WINDOW_SECONDS) },
        },
      })
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException || error?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
};

// Sends an error the chat page shows in place of the pending reply
const notifyClient = async (connectionId, error, message) => {
  if (!apigw) {
    console.error("WEBSOCKET_API_ENDPOINT is not set");
    return;
  }
  try {
    await apigw.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ type: "error", error, message }),
      })
    );
  } catch (postError) {
    console.error("Failed to notify client", { connectionId, error: postError?.name });
  }
};

exports.handler = async (event) => {
  console.log("WebSocket message received:", {
    connectionId: event.requestContext.connectionId,
    routeKey: event.requestContext.routeKey,
    // Omit body to avoid logging sensitive data like user_id and chat_session_id
    timestamp: new Date().toISOString(),
  });

  try {
    const body = JSON.parse(event.body);
    const { action, query, chat_session_id, is_intro_message, message_id } = body;

    // Sent by the chat page on load and periodically while it is open, so the text
    // generation function is initialized before the user's first message arrives
    if (action === "warmup") {
      // A warm-up only saves latency, so it is skipped when over the limit or when the
      // limit cannot be checked
      const warmupUserId = event.requestContext?.authorizer?.userId;
      if (!validateUUID(warmupUserId, "user_id").valid) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      let warmupAllowed = false;
      try {
        warmupAllowed = await consumeRateLimit(warmupUserId, "warmup", WARMUP_RATE_LIMIT);
      } catch (error) {
        console.error("Rate limit check failed; skipping warm-up", { error: error?.name });
      }
      if (!warmupAllowed) {
        return { statusCode: 200 };
      }

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.TEXT_GEN_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify({ warmup: true }),
        })
      );
      return { statusCode: 200 };
    }

    if (action === "generate_text") {
      // Identity comes from the authorizer on $connect, never from the message body
      const authenticatedUserId = event.requestContext?.authorizer?.userId;
      const userValidation = validateUUID(authenticatedUserId, "user_id");
      if (!userValidation.valid) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
      }

      // Validate inputs before invoking text generation Lambda
      const sanitizedQuery = sanitizeString(query, 10000);
      if (!sanitizedQuery) {
        return { statusCode: 400, body: JSON.stringify({ error: "query is required and must be a non-empty string" }) };
      }

      const sessionValidation = validateUUID(chat_session_id, "chat_session_id");
      if (!sessionValidation.valid) {
        return { statusCode: 400, body: JSON.stringify({ error: sessionValidation.error }) };
      }

      // Client-generated id for the user message, so a repeated request is not saved or answered twice
      if (message_id !== undefined) {
        const messageIdValidation = validateUUID(message_id, "message_id");
        if (!messageIdValidation.valid) {
          return { statusCode: 400, body: JSON.stringify({ error: messageIdValidation.error }) };
        }
      }

      // Checked after validation so malformed requests do not use up the user's allowance.
      // If the limit cannot be checked the message is refused rather than sent unmetered.
      const connectionId = event.requestContext.connectionId;
      let allowed;
      try {
        allowed = await consumeRateLimit(authenticatedUserId, "message", MESSAGE_RATE_LIMIT);
      } catch (error) {
        console.error("Rate limit check failed", { connectionId, error: error?.name });
        await notifyClient(connectionId, "MESSAGE_NOT_SENT", UNAVAILABLE_MESSAGE);
        return { statusCode: 503, body: JSON.stringify({ error: "Service unavailable" }) };
      }
      if (!allowed) {
        console.warn("Message rate limit exceeded", { connectionId });
        await notifyClient(connectionId, "RATE_LIMITED", RATE_LIMIT_MESSAGE);
        return { statusCode: 429, body: JSON.stringify({ error: "Rate limit exceeded" }) };
      }

      // Invoke the text generation Lambda function
      const textGenPayload = {
        pathParameters: {
          id: chat_session_id,
        },
        body: JSON.stringify({
          query: sanitizedQuery,
          is_intro_message: is_intro_message,
          ...(message_id !== undefined && { message_id: message_id.trim() }),
        }),
        requestContext: {
          connectionId: event.requestContext.connectionId,
          domainName: event.requestContext.domainName,
          stage: event.requestContext.stage,
          authorizer: { userId: authenticatedUserId },
        },
      };

      console.log("Invoking text generation function", {
        connectionId: event.requestContext.connectionId,
      });

      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.TEXT_GEN_FUNCTION_NAME,
          InvocationType: "Event", // Asynchronous invocation
          Payload: JSON.stringify(textGenPayload),
        })
      );

      console.log("Text generation function invoked successfully:", result);

      return { statusCode: 200 };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Unknown action" }),
    };
  } catch (error) {
    console.error("Error processing WebSocket message:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
