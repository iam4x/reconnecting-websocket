type EventType = "open" | "message" | "close" | "reconnect" | "error";
type Listener = (payload: any) => void;

interface ReconnectOptions {
  retryDelay?: number;
  maxRetryDelay?: number;
  connectionTimeout?: number;
  backoffFactor?: number;
  WebSocketConstructor?: typeof WebSocket;
}

export class ReconnectingWebSocket {
  options: Required<ReconnectOptions & { url: string }>;

  ws?: WebSocket;
  abortController?: AbortController;

  connectTimeout?: ReturnType<typeof setTimeout>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;

  retryCount = 0;
  forcedClose = false;
  wasConnected = false;

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
    };

    this.connect();
  }

  connect() {
    this.abortController = new AbortController();
    this.abortController.signal.addEventListener("abort", () => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    });

    this.ws = new this.options.WebSocketConstructor(this.options.url);

    this.connectTimeout = setTimeout(() => {
      this.abortController?.abort();
    }, this.options.connectionTimeout);

    this.ws.addEventListener("open", (event) => {
      this.clearTimers();
      this.retryCount = 0;
      this.emit("open", event);

      // Emit reconnect event if this was a reconnection after a disconnection
      if (this.wasConnected) {
        this.emit("reconnect", event);
      }

      this.wasConnected = true;
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.emit("message", event);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      this.emit("close", { code: event.code, reason: event.reason });

      if (!this.forcedClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener("error", (event: Event) => {
      this.emit("error", event);
      // Error will typically cause connection to close, triggering reconnect
    });
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

  clearTimers() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    if (this.abortController) {
      this.abortController = undefined;
    }
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
