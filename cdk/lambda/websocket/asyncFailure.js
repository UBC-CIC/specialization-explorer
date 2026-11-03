const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} = require("@aws-sdk/client-apigatewaymanagementapi");

// Consumes the on-failure records Lambda writes when an asynchronous text generation invocation
// fails or expires, and tells the waiting client that its request did not complete.
// Record format: https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html

// WebSocket connection ids are short base64-like strings, e.g. "L0SM9cOFvHcCIhw="
const CONNECTION_ID_REGEX = /^[A-Za-z0-9+/=_-]{1,128}$/;

const ERROR_MESSAGE = "Sorry, the response could not be generated. Please try again.";

// The endpoint comes from configuration, never from the record, so a record cannot redirect posts
const endpoint = (process.env.WEBSOCKET_API_ENDPOINT || "").replace(/^wss:\/\//, "https://");
const apigw = endpoint ? new ApiGatewayManagementApiClient({ endpoint }) : null;

const getConnectionId = (record) => {
  const payload = record?.requestPayload;
  if (!payload || payload.warmup === true) return null;
  const connectionId = payload.requestContext?.connectionId;
  if (typeof connectionId !== "string" || !CONNECTION_ID_REGEX.test(connectionId)) return null;
  return connectionId;
};

exports.handler = async (event) => {
  const batchItemFailures = [];

  for (const message of event.Records || []) {
    let record;
    try {
      record = JSON.parse(message.body);
    } catch {
      console.error("Discarding failure record that is not valid JSON", { messageId: message.messageId });
      continue;
    }

    // Log only the failure metadata; the request payload contains the user's query
    console.warn("Text generation invocation failed", {
      messageId: message.messageId,
      condition: record?.requestContext?.condition,
      approximateInvokeCount: record?.requestContext?.approximateInvokeCount,
      functionError: record?.responseContext?.functionError,
    });

    const connectionId = getConnectionId(record);
    if (!connectionId) continue;

    if (!apigw) {
      console.error("WEBSOCKET_API_ENDPOINT is not set");
      batchItemFailures.push({ itemIdentifier: message.messageId });
      continue;
    }

    try {
      await apigw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ type: "error", error: "GENERATION_FAILED", message: ERROR_MESSAGE }),
        })
      );
    } catch (error) {
      if (error instanceof GoneException || error?.name === "GoneException") {
        // The client has already disconnected; nothing is waiting for the error
        continue;
      }
      console.error("Failed to notify client of text generation failure", {
        messageId: message.messageId,
        error: error?.name,
      });
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }

  return { batchItemFailures };
};
