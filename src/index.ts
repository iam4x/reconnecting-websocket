type EventType = "open" | "message" | "close" | "reconnect" | "error";
type Listener = (payload: any) => void;

interface ReconnectOptions {
  retryDelay?: number;
  maxRetryDelay?: number;
  connectionTimeout?: number;
  backoffFactor?: number;
  WebSocketConstructor?: typeof WebSocket;
  healthCheckInterval?: number;
}

export class ReconnectingWebSocket {
  options: Required<ReconnectOptions & { url: string }>;

  ws?: WebSocket;
  abortController?: AbortController;

  connectTimeout?: ReturnType<typeof setTimeout>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  healthCheckInterval?: ReturnType<typeof setInterval>;

  retryCount = 0;
  forcedClose = false;
  wasConnected = false;

  // Store event handlers so we can remove them when cleaning up
  private openFn?: (event: Event) => void;
  private messageFn?: (event: MessageEvent) => void;
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
    };

    this.connect();
  }

  connect() {
    // Remove event listeners from old socket
    if (this.openFn) this.ws?.removeEventListener("open", this.openFn);
    if (this.messageFn) this.ws?.removeEventListener("message", this.messageFn);
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
        this.clearTimers();
        this.retryCount = 0;
        this.emit("open", event);

        // Emit reconnect event if this was a reconnection after a disconnection
        if (this.wasConnected) {
          this.emit("reconnect", event);
        }

        this.wasConnected = true;
        this.startHealthCheck();
      }
    };

    this.messageFn = (event: MessageEvent) => {
      // Only process if event is from the current socket
      if (event.target === currentWs && this.ws === currentWs) {
        this.emit("message", event);
      }
    };

    this.closeFn = (event: CloseEvent) => {
      // Only process if event is from the current socket
      if (event.target === currentWs && this.ws === currentWs) {
        this.stopHealthCheck();
        this.emit("close", { code: event.code, reason: event.reason });

        if (!this.forcedClose) {
          this.scheduleReconnect();
        }
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
    currentWs.addEventListener("message", this.messageFn);
    currentWs.addEventListener("close", this.closeFn);
    currentWs.addEventListener("error", this.errorFn);
  }

  emit(event: EventType, payload: any) {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }

  scheduleReconnect() {
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
  }

  addEventListener(event: EventType, listener: Listener) {
    this.listeners[event].push(listener);
  }

  removeEventListener(event: EventType, listener: Listener) {
    this.listeners[event] = this.listeners[event].filter((l) => l !== listener);
  }

  send(...args: Parameters<WebSocket["send"]>) {
    this.ws?.send(...args);
  }

  close(...args: Parameters<WebSocket["close"]>) {
    this.forcedClose = true;
    this.clearTimers();

    if (this.ws) {
      this.ws.close(...args);
      this.ws = undefined;
    }
  }
}
