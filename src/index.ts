type EventType = "open" | "message" | "close" | "reconnect" | "error";
type Listener = (payload: any) => void;

interface ReconnectOptions {
  retryDelay?: number;
  maxRetryDelay?: number;
  connectionTimeout?: number;
  backoffFactor?: number;
  WebSocketConstructor?: typeof WebSocket;
  healthCheckInterval?: number;
  watchingInactivityTimeout?: number;
}

export class ReconnectingWebSocket {
  options: Required<ReconnectOptions & { url: string }>;

  ws?: WebSocket;
  abortController?: AbortController;

  connectTimeout?: ReturnType<typeof setTimeout>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  healthCheckInterval?: ReturnType<typeof setInterval>;
  inactivityTimeout?: ReturnType<typeof setTimeout>;

  retryCount = 0;
  forcedClose = false;
  wasConnected = false;

  // Store event handlers so we can remove them when cleaning up
  private openFn?: (event: Event) => void;
  private msgFn?: (event: MessageEvent) => void;
  private closeFn?: (event: CloseEvent) => void;
  private errorFn?: (event: Event) => void;
  private abortHandler?: () => void;

  listeners: Record<EventType, Listener[]> = {
    open: [],
    message: [],
    close: [],
    reconnect: [],
    error: [],
  };

  // Queue for messages sent when socket is not open
  private messageQueue: Parameters<WebSocket["send"]>[] = [];

  get readyState() {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  get bufferedAmount() {
    return this.ws?.bufferedAmount ?? 0;
  }

  constructor(url: string, options: ReconnectOptions = {}) {
    this.options = {
      url,
      retryDelay: options.retryDelay ?? 1000,
      maxRetryDelay: options.maxRetryDelay ?? 30_000,
      connectionTimeout: options.connectionTimeout ?? 10_000,
      backoffFactor: options.backoffFactor ?? 2,
      WebSocketConstructor: options.WebSocketConstructor ?? WebSocket,
      healthCheckInterval: options.healthCheckInterval ?? 30_000,
      watchingInactivityTimeout: options.watchingInactivityTimeout ?? 0, // disabled by default, set to 300_000 for 5 minutes
    };

    this.connect();
  }

  connect() {
    // Reset forcedClose flag to allow reconnection for new connection attempts
    // This ensures that manual reconnections (via connect()) can auto-reconnect
    this.forcedClose = false;

    // Remove event listeners from old socket
    if (this.openFn) this.ws?.removeEventListener("open", this.openFn);
    if (this.msgFn) this.ws?.removeEventListener("message", this.msgFn);
    if (this.closeFn) this.ws?.removeEventListener("close", this.closeFn);
    if (this.errorFn) this.ws?.removeEventListener("error", this.errorFn);

    // Close old socket if still connecting or open
    if (
      this.ws?.readyState === WebSocket.CONNECTING ||
      this.ws?.readyState === WebSocket.OPEN
    ) {
      this.ws?.close();
    }

    // Clear any pending timers (this also removes abort listener from old controller)
    this.clearTimers();

    // Create new abort controller
    this.abortController = new AbortController();
    this.abortHandler = () => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    };

    this.abortController.signal.addEventListener("abort", this.abortHandler);

    // Create new socket
    this.ws = new this.options.WebSocketConstructor(this.options.url);

    this.connectTimeout = setTimeout(() => {
      this.abortController?.abort();
    }, this.options.connectionTimeout);

    // Create and store new event handlers
    // Capture the new socket reference to check against in handlers
    const currentWs = this.ws;

    this.openFn = (event: Event) => {
      // Only process if event is from the current socket
      if (event.target === currentWs && this.ws === currentWs) {
        const isReconnect = this.wasConnected;

        this.clearTimers();
        this.retryCount = 0;
        this.wasConnected = true;
        this.startHealthCheck();
        this.startInactivityTimer();

        this.runWithFinalizer(
          () => {
            this.emit("open", event);

            if (isReconnect) {
              this.emit("reconnect", event);
            }
          },
          () => {
            // Flush queued messages even if a listener throws during open/reconnect.
            this.flushMessageQueue();
          },
        );
      }
    };

    this.msgFn = (event: MessageEvent) => {
      // Only process if event is from the current socket
      if (event.target === currentWs && this.ws === currentWs) {
        this.resetInactivityTimer();
        this.emit("message", event);
      }
    };

    this.closeFn = (event: CloseEvent) => {
      // Only process if event is from the current socket
      if (event.target === currentWs && this.ws === currentWs) {
        const shouldReconnect = !this.forcedClose;

        this.stopHealthCheck();
        this.stopInactivityTimer();

        this.runWithFinalizer(
          () => {
            this.emit("close", { code: event.code, reason: event.reason });
          },
          () => {
            if (shouldReconnect) {
              this.scheduleReconnect();
            }
          },
        );
      }
    };

    this.errorFn = (event: Event) => {
      // Only process if event is from the current socket
      if (event.target === currentWs && this.ws === currentWs) {
        this.emit("error", event);
      }
    };

    // Add event listeners to new socket
    currentWs.addEventListener("open", this.openFn);
    currentWs.addEventListener("message", this.msgFn);
    currentWs.addEventListener("close", this.closeFn);
    currentWs.addEventListener("error", this.errorFn);
  }

  emit(event: EventType, payload: any) {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }

  private runWithFinalizer(action: () => void, finalizer?: () => void) {
    let didThrow = false;
    let thrown: unknown;

    try {
      action();
    } catch (error) {
      didThrow = true;
      thrown = error;
    } finally {
      if (finalizer) {
        try {
          finalizer();
        } catch (error) {
          if (!didThrow) {
            didThrow = true;
            thrown = error;
          }
        }
      }
    }

    if (didThrow) {
      throw thrown;
    }
  }

  scheduleReconnect() {
    // Clear any existing reconnect timeout first to prevent multiple reconnects
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    const { retryDelay, backoffFactor, maxRetryDelay } = this.options;

    const delay = Math.min(
      retryDelay * Math.pow(backoffFactor, this.retryCount),
      maxRetryDelay,
    );

    this.retryCount += 1;
    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }

  startHealthCheck() {
    this.stopHealthCheck();

    if (this.options.healthCheckInterval <= 0) {
      return;
    }

    this.healthCheckInterval = setInterval(() => {
      // Only check if we're not forcing a close and we expect to be connected
      if (this.forcedClose) {
        return;
      }

      // If we've been connected before and the socket is not OPEN, trigger reconnection
      if (this.wasConnected && this.readyState !== WebSocket.OPEN) {
        // Clear the existing socket reference since it's in a bad state
        if (this.ws) {
          // Don't emit close event since we didn't receive one - this is a silent failure
          this.ws = undefined;
        }
        this.stopHealthCheck();
        this.scheduleReconnect();
      }
    }, this.options.healthCheckInterval);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  startInactivityTimer() {
    this.stopInactivityTimer();

    if (this.options.watchingInactivityTimeout <= 0) {
      return;
    }

    this.inactivityTimeout = setTimeout(() => {
      // Only trigger if we're not forcing a close and we expect to be connected
      if (this.forcedClose) {
        return;
      }

      const shouldReconnect = !this.forcedClose;

      // Proactively trigger reconnection due to inactivity
      // Don't rely on the close event as it may never fire on a stalled connection
      if (this.ws) {
        // Stop health check to prevent it from also triggering reconnection
        this.stopHealthCheck();

        // Remove event listeners to prevent any late events from interfering
        if (this.openFn) this.ws.removeEventListener("open", this.openFn);
        if (this.msgFn) this.ws.removeEventListener("message", this.msgFn);
        if (this.closeFn) this.ws.removeEventListener("close", this.closeFn);
        if (this.errorFn) this.ws.removeEventListener("error", this.errorFn);

        // Try to close the socket (may hang on stalled connections, but we don't wait)
        this.ws.close();

        // Clear the socket reference
        this.ws = undefined;

        this.runWithFinalizer(
          () => {
            // Emit close event to listeners with a special code indicating inactivity timeout.
            this.emit("close", { code: 4000, reason: "Inactivity timeout" });
          },
          () => {
            if (shouldReconnect) {
              // Schedule reconnection directly without waiting for close event.
              this.scheduleReconnect();
            }
          },
        );
      }
    }, this.options.watchingInactivityTimeout);
  }

  stopInactivityTimer() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = undefined;
    }
  }

  resetInactivityTimer() {
    if (this.options.watchingInactivityTimeout > 0) {
      this.startInactivityTimer();
    }
  }

  clearTimers() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    if (this.abortController && this.abortHandler) {
      this.abortController.signal.removeEventListener(
        "abort",
        this.abortHandler,
      );
      this.abortController = undefined;
      this.abortHandler = undefined;
    } else if (this.abortController) {
      this.abortController = undefined;
    }

    this.stopHealthCheck();
    this.stopInactivityTimer();
  }

  addEventListener(event: EventType, listener: Listener) {
    this.listeners[event].push(listener);
  }

  removeEventListener(event: EventType, listener: Listener) {
    this.listeners[event] = this.listeners[event].filter((l) => l !== listener);
  }

  send(...args: Parameters<WebSocket["send"]>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(...args);
    } else {
      this.messageQueue.push(args);
    }
  }

  private flushMessageQueue() {
    while (
      this.messageQueue.length > 0 &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      const args = this.messageQueue.shift()!;
      this.ws.send(...args);
    }
  }

  close(...args: Parameters<WebSocket["close"]>) {
    this.forcedClose = true;
    this.clearTimers();

    // Clear the message queue on forced close
    this.messageQueue = [];

    if (this.ws) {
      // Remove event listeners before closing to prevent memory leaks
      if (this.openFn) this.ws.removeEventListener("open", this.openFn);
      if (this.msgFn) this.ws.removeEventListener("message", this.msgFn);
      if (this.closeFn) this.ws.removeEventListener("close", this.closeFn);
      if (this.errorFn) this.ws.removeEventListener("error", this.errorFn);

      this.ws.close(...args);
      this.ws = undefined;
    }
  }
}
