// Token verification happens in the $connect authorizer (authorizer.js);
// this handler only runs for connections that were already authorized.
exports.handler = async (event) => {
  console.log("WebSocket connection authorized", {
    connectionId: event.requestContext?.connectionId,
    userId: event.requestContext?.authorizer?.userId,
    domainName: event.requestContext?.domainName,
    stage: event.requestContext?.stage,
    timestamp: new Date().toISOString(),
  });

  return { statusCode: 200 };
};
