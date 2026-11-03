import { useEffect, useRef, useCallback, useState } from "react";

interface WebSocketMessage {
  type: "start" | "chunk" | "complete" | "error";
  content?: string;
  message?: string;
  sources?: string[];
}

// Lambda does not guarantee how long an idle execution environment survives; 5 minutes is a
// common keep-warm interval and stays under API Gateway's 10 minute WebSocket idle timeout
const WARMUP_INTERVAL_MS = 5 * 60 * 1000;

interface UseWebSocketOptions {
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

/**
 * Keeps a WebSocket connection open.
 *
 * `getUrl` is called for every connection attempt, so the URL (and any token in it) is fresh
 * when the socket opens. The WebSocket authorizer only checks the token on $connect, so an open
 * socket is never closed to refresh it; a new URL is requested only after the socket closes.
 * Pass null to keep the socket closed.
 */
export const useWebSocket = (
  getUrl: (() => Promise<string | null>) | null,
  options: UseWebSocketOptions = {}
) => {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isManualDisconnectRef = useRef(false);
  const isResolvingUrlRef = useRef(false);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("disconnected");

  // Store callbacks and the URL source in refs so changing them never reconnects the socket
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const getUrlRef = useRef(getUrl);
  getUrlRef.current = getUrl;
  const isEnabled = getUrl !== null;

  // Lets the reconnect timer call the current connect function
  const connectRef = useRef<() => void>(() => {});

  // Asks the server to warm the text generation Lambda so the next message skips its cold start.
  // The same message keeps the connection inside API Gateway's 10 minute idle timeout.
  const sendWarmup = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ action: "warmup" }));
      } catch (error) {
        console.error("[WebSocket] Error sending warm-up:", error);
      }
    }
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  // Warm immediately, then repeat only while the tab is visible
  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    if (document.visibilityState !== "visible") {
      return;
    }
    sendWarmup();
    heartbeatIntervalRef.current = window.setInterval(
      sendWarmup,
      WARMUP_INTERVAL_MS
    );
  }, [sendWarmup, stopHeartbeat]);

  const scheduleReconnect = useCallback(() => {
    if (isManualDisconnectRef.current) {
      console.log("[WebSocket] Manual disconnect, not reconnecting");
      return;
    }

    if (reconnectAttemptsRef.current >= 10) {
      console.log("[WebSocket] Max reconnection attempts reached");
      setConnectionState("error");
      return;
    }

    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = Math.min(
      1000 * Math.pow(2, reconnectAttemptsRef.current),
      30000
    );
    console.log(
      `[WebSocket] Scheduling reconnect attempt ${
        reconnectAttemptsRef.current + 1
      }/10 in ${delay}ms`
    );

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null;
      reconnectAttemptsRef.current++;
      connectRef.current();
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    const resolveUrl = getUrlRef.current;
    if (
      !resolveUrl ||
      isResolvingUrlRef.current ||
      wsRef.current?.readyState === WebSocket.CONNECTING ||
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    setConnectionState("connecting");

    let url: string | null;
    isResolvingUrlRef.current = true;
    try {
      url = await resolveUrl();
    } catch (error) {
      console.error("[WebSocket] Failed to get connection URL:", error);
      isResolvingUrlRef.current = false;
      if (isManualDisconnectRef.current) {
        return;
      }
      setConnectionState("error");
      scheduleReconnect();
      return;
    }
    isResolvingUrlRef.current = false;

    // The hook was disconnected or unmounted while the URL was being fetched
    if (isManualDisconnectRef.current) {
      return;
    }

    if (!url) {
      setConnectionState("disconnected");
      return;
    }

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WebSocket] Connected successfully");
        setConnectionState("connected");
        reconnectAttemptsRef.current = 0;
        startHeartbeat();
        callbacksRef.current.onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          if (typeof event.data === "string" && event.data.length > 1_000_000) {
            console.warn("[WebSocket] Received message string exceeds 1MB, ignoring");
            return;
          }

          const message: WebSocketMessage = JSON.parse(event.data);

          console.log("[WebSocket] Received message");

          callbacksRef.current.onMessage?.(message);
        } catch (error) {
          console.error("[WebSocket] Error parsing message:", error);
        }
      };

      ws.onclose = (event) => {
        console.log(
          `[WebSocket] Disconnected - Code: ${event.code}, Reason: ${event.reason}`
        );

        // A socket closed by disconnect() has already been replaced or cleared
        if (wsRef.current !== ws) {
          return;
        }

        wsRef.current = null;
        setConnectionState("disconnected");
        stopHeartbeat();
        callbacksRef.current.onDisconnect?.();

        if (isManualDisconnectRef.current) {
          return;
        }

        // Reconnect with a fresh URL now that the socket is closed. API Gateway closes
        // connections normally (1001) at its idle timeout and maximum connection duration.
        if (event.code !== 1000 && event.code !== 1001) {
          console.log("[WebSocket] Abnormal closure, attempting to reconnect...");
          scheduleReconnect();
        } else if (document.visibilityState === "visible") {
          console.log("[WebSocket] Normal closure, reconnecting...");
          scheduleReconnect();
        } else {
          console.log("[WebSocket] Normal closure, reconnecting when the tab is visible");
        }
      };

      ws.onerror = (error) => {
        console.error("[WebSocket] Connection error:", error);
        setConnectionState("error");
        callbacksRef.current.onError?.(error);
      };
    } catch (error) {
      console.error("[WebSocket] Error creating WebSocket:", error);
      setConnectionState("error");
      scheduleReconnect();
    }
  }, [startHeartbeat, stopHeartbeat, scheduleReconnect]);

  connectRef.current = connect;

  const disconnect = useCallback(() => {
    console.log("[WebSocket] Manual disconnect requested");
    isManualDisconnectRef.current = true;

    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopHeartbeat();

    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.close(1000, "Manual disconnect");
    }

    setConnectionState("disconnected");
    reconnectAttemptsRef.current = 0;
  }, [stopHeartbeat]);

  const sendMessage = useCallback(
    (message: any) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          const messageStr = JSON.stringify(message);
          console.log("[WebSocket] Sending message");
          wsRef.current.send(messageStr);
          return true;
        } catch (error) {
          console.error("[WebSocket] Error sending message:", error);
          return false;
        }
      }

      console.warn(
        `[WebSocket] Cannot send message - Connection state: ${connectionState}`
      );
      return false;
    },
    [connectionState]
  );

  const forceReconnect = useCallback(() => {
    console.log("[WebSocket] Force reconnect requested");
    isManualDisconnectRef.current = false;
    reconnectAttemptsRef.current = 0;

    disconnect();

    setTimeout(() => {
      isManualDisconnectRef.current = false;
      connect();
    }, 1000);
  }, [disconnect, connect]);

  // Stop warming while the tab is hidden. When it becomes visible again, warm right away,
  // reconnecting first if API Gateway closed the idle connection in the meantime.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        stopHeartbeat();
        return;
      }

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        startHeartbeat();
      } else if (isEnabled && !isManualDisconnectRef.current) {
        reconnectAttemptsRef.current = 0;
        connect();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isEnabled, connect, startHeartbeat, stopHeartbeat]);

  // Connect once streaming is enabled. A new getUrl function does not reconnect the socket.
  useEffect(() => {
    if (isEnabled) {
      isManualDisconnectRef.current = false;
      connect();
    }

    return () => {
      isManualDisconnectRef.current = true;
      disconnect();
    };
  }, [isEnabled, connect, disconnect]);

  const isConnected = wsRef.current?.readyState === WebSocket.OPEN;

  return {
    sendMessage,
    connect,
    disconnect,
    forceReconnect,
    isConnected,
    connectionState,
  };
};
