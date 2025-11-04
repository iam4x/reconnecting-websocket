import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { ReconnectingWebSocket } from ".";

describe("ReconnectingWebSocket", () => {
  let created: any[];
  let originalSetTimeout: typeof setTimeout;
  let originalClearTimeout: typeof clearTimeout;
  let originalSetInterval: typeof setInterval;
  let originalClearInterval: typeof clearInterval;
  let timeouts: Map<number, () => void>;
  let intervals: Map<number, () => void>;
  let timerId: number;
  let flushTimers: () => void;

  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    // ensure instance properties match code expectations
    readyState: number = FakeWebSocket.CONNECTING;
    sentData: any[] = [];
    bufferedAmount: number = 0;
    constructor(_url: string, _protocols?: string | string[]) {
      super();
      created.push(this);
      this.readyState = FakeWebSocket.CONNECTING;
      this.bufferedAmount = 0;
    }
    send(data: any) {
      this.sentData.push(data);
      // Simulate buffering when not open
      if (this.readyState !== FakeWebSocket.OPEN) {
        this.bufferedAmount +=
          typeof data === "string" ? data.length : data.byteLength || 0;
      }
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent("close"));
    }
  }

  // attach constants on prototype for compatibility
  Object.assign(FakeWebSocket.prototype, {
    OPEN: FakeWebSocket.OPEN,
    CONNECTING: FakeWebSocket.CONNECTING,
    CLOSED: FakeWebSocket.CLOSED,
  });

  beforeEach(() => {
    created = [];
    // stub timers with manual queue
    timeouts = new Map();
    intervals = new Map();
    timerId = 1;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;

    globalThis.setTimeout = ((fn: (...args: any[]) => void) => {
      const id = timerId++;
      timeouts.set(id, fn as () => void);
      return id as any;
    }) as unknown as typeof setTimeout;

    globalThis.clearTimeout = ((id?: any) => {
      timeouts.delete(id);
    }) as unknown as typeof clearTimeout;

    globalThis.setInterval = ((fn: (...args: any[]) => void) => {
      const id = timerId++;
      intervals.set(id, fn as () => void);
      return id as any;
    }) as unknown as typeof setInterval;

    globalThis.clearInterval = ((id?: any) => {
      intervals.delete(id);
    }) as unknown as typeof clearInterval;

    flushTimers = () => {
      const timeoutFns = Array.from(timeouts.values());
      const intervalFns = Array.from(intervals.values());
      // Clear timeouts after execution (they only fire once)
      timeouts.clear();
      // Keep intervals in the map (they fire repeatedly)
      // Execute all intervals
      for (const fn of timeoutFns) fn();
      for (const fn of intervalFns) fn();
    };
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  it("should dispatch open event", async () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });
    const openPromise = new Promise((resolve) =>
      ws.addEventListener("open", resolve),
    );
    // simulate open
    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    // flush the scheduled dispatch in onOpen
    flushTimers();
    await openPromise;
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
  });

  it("should send data when open", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });
    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    ws.send("hello");
    expect(instance.sentData).toEqual(["hello"]);
  });

  it("should reconnect on close", () => {
    new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 1000,
      maxRetryDelay: 2000,
      backoffFactor: 2,
      connectionTimeout: 1000,
    });
    expect(created.length).toBe(1);
    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    // simulate close
    instance.dispatchEvent(new CloseEvent("close"));
    // flush the scheduled reconnect
    flushTimers();
    expect(created.length).toBe(2);
  });

  it("should not reconnect after forced close", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 1000,
    });
    const instance = created[0];
    ws.close();
    instance.dispatchEvent(new CloseEvent("close"));
    // flush any timers (should be none)
    flushTimers();
    expect(created.length).toBe(1);
  });

  it("should dispatch message", () => {
    const wsObj = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });
    const msgs: any[] = [];
    wsObj.addEventListener("message", (ev: MessageEvent) => msgs.push(ev.data));

    const instance = created[0];
    // simulate message and error on underlying socket
    instance.dispatchEvent(new MessageEvent("message", { data: "hello-msg" }));
    // flush async dispatch
    flushTimers();

    expect(msgs).toEqual(["hello-msg"]);
  });

  it("should reconnect on connection timeout", () => {
    // use 0 timeout for immediate abort
    new ReconnectingWebSocket("ws://timeout", {
      WebSocketConstructor: FakeWebSocket as any,
      connectionTimeout: 0,
      retryDelay: 100,
      maxRetryDelay: 200,
      backoffFactor: 2,
    });
    expect(created.length).toBe(1);
    // trigger timeout abort
    flushTimers();
    // trigger reconnect
    flushTimers();
    expect(created.length).toBe(2);
  });

  it("should dispatch close event on connection timeout", () => {
    const wsObj = new ReconnectingWebSocket("ws://timeout", {
      WebSocketConstructor: FakeWebSocket as any,
      connectionTimeout: 0,
    });
    const closes: any[] = [];
    wsObj.addEventListener("close", (ev: CloseEvent) => closes.push(ev));
    // trigger abort and onClose dispatch
    flushTimers(); // abort and schedule reconnect + dispatch close
    flushTimers(); // dispatch the close event
    expect(closes.length).toBe(1);
  });

  it("should return CLOSED readyState after forced close", () => {
    const wsObj = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });
    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    wsObj.close();
    expect(wsObj.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("should remove event listener", async () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });
    let calls = 0;

    function onOpen(this: ReconnectingWebSocket) {
      calls++;
    }

    ws.addEventListener("open", onOpen);
    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();
    expect(calls).toBe(1);
    ws.removeEventListener("open", onOpen);
    instance.dispatchEvent(new Event("open"));
    flushTimers();
    expect(calls).toBe(1);
  });

  it("should emit reconnect event when reconnecting after a disconnection", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 100,
    });

    const reconnects: Event[] = [];
    const opens: Event[] = [];

    ws.addEventListener("open", (event) => opens.push(event));
    ws.addEventListener("reconnect", (event) => reconnects.push(event));

    // First connection
    const firstInstance = created[0];
    firstInstance.readyState = FakeWebSocket.OPEN;
    firstInstance.dispatchEvent(new Event("open"));
    flushTimers();

    // Check that open was emitted but not reconnect for the first connection
    expect(opens.length).toBe(1);
    expect(reconnects.length).toBe(0);

    // Simulate a disconnection
    firstInstance.dispatchEvent(new CloseEvent("close"));
    flushTimers(); // Trigger reconnection

    // Second connection
    const secondInstance = created[1];
    secondInstance.readyState = FakeWebSocket.OPEN;
    secondInstance.dispatchEvent(new Event("open"));
    flushTimers();

    // Check that both open and reconnect were emitted for the second connection
    expect(opens.length).toBe(2);
    expect(reconnects.length).toBe(1);
  });

  it("should not emit reconnect on first connection", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const reconnects: Event[] = [];
    ws.addEventListener("reconnect", (event) => reconnects.push(event));

    // First connection
    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    // Check that reconnect was not emitted for the first connection
    expect(reconnects.length).toBe(0);
  });

  it("should dispatch error event", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const errors: Event[] = [];
    ws.addEventListener("error", (event) => errors.push(event));

    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    // Simulate error
    instance.dispatchEvent(new Event("error"));
    flushTimers();

    expect(errors.length).toBe(1);
  });

  it("should reconnect after error event", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 100,
    });

    const errors: Event[] = [];
    ws.addEventListener("error", (event) => errors.push(event));

    const firstInstance = created[0];
    firstInstance.readyState = FakeWebSocket.OPEN;
    firstInstance.dispatchEvent(new Event("open"));
    flushTimers();

    // Simulate error and close
    firstInstance.dispatchEvent(new Event("error"));
    firstInstance.dispatchEvent(new CloseEvent("close"));
    flushTimers(); // Trigger reconnect

    expect(errors.length).toBe(1);
    expect(created.length).toBe(2);
  });

  it("should handle multiple rapid close/open cycles", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 100,
    });

    const opens: Event[] = [];
    ws.addEventListener("open", (event) => opens.push(event));

    // First connection
    const firstInstance = created[0];
    firstInstance.readyState = FakeWebSocket.OPEN;
    firstInstance.dispatchEvent(new Event("open"));
    flushTimers();
    expect(opens.length).toBe(1);

    // Rapid close
    firstInstance.dispatchEvent(new CloseEvent("close"));
    flushTimers(); // Trigger reconnect

    // Second connection
    const secondInstance = created[1];
    secondInstance.readyState = FakeWebSocket.OPEN;
    secondInstance.dispatchEvent(new Event("open"));
    flushTimers();
    expect(opens.length).toBe(2);

    // Rapid close again
    secondInstance.dispatchEvent(new CloseEvent("close"));
    flushTimers(); // Trigger reconnect

    // Third connection
    const thirdInstance = created[2];
    thirdInstance.readyState = FakeWebSocket.OPEN;
    thirdInstance.dispatchEvent(new Event("open"));
    flushTimers();
    expect(opens.length).toBe(3);

    expect(created.length).toBe(3);
  });

  it("should return bufferedAmount from underlying socket", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    instance.bufferedAmount = 42;
    expect(ws.bufferedAmount).toBe(42);
  });

  it("should return 0 for bufferedAmount when socket is not connected", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    expect(ws.bufferedAmount).toBe(0);
  });

  it("should not send data when socket is undefined", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const instance = created[0];
    // Close and clear the socket
    ws.close();
    flushTimers();

    // Now ws.ws should be undefined
    // Try to send when socket is undefined
    ws.send("test message");

    // Should not have sent anything since socket was cleared
    expect(instance.sentData).toEqual([]);
  });

  it("should send data when socket exists (even if not fully open)", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const instance = created[0];
    // Socket exists but is CONNECTING
    expect(instance.readyState).toBe(FakeWebSocket.CONNECTING);

    // Send will be called on the socket (implementation doesn't check readyState)
    ws.send("before open");
    expect(instance.sentData).toEqual(["before open"]);

    // Open connection
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    // Send should still work
    ws.send("after open");
    expect(instance.sentData).toEqual(["before open", "after open"]);

    // Close connection (this clears ws.ws)
    ws.close();
    flushTimers();

    // Try to send after close (socket is now undefined)
    ws.send("after close");
    // Should only have messages sent before close
    expect(instance.sentData).toEqual(["before open", "after open"]);
  });

  it("should reconnect when readyState is not OPEN without close event (silent failure)", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      healthCheckInterval: 100,
      retryDelay: 50,
    });

    // First connection opens
    const firstInstance = created[0];
    firstInstance.readyState = FakeWebSocket.OPEN;
    firstInstance.dispatchEvent(new Event("open"));
    flushTimers();

    expect(created.length).toBe(1);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    // Simulate silent failure - socket enters bad state without close event
    firstInstance.readyState = FakeWebSocket.CLOSED;
    // Don't dispatch close event - this simulates the bug scenario

    // Trigger health check interval (should now detect the bad state and schedule reconnect)
    flushTimers();

    // Flush again to trigger the scheduled reconnect
    flushTimers();

    // Should have scheduled a reconnect, which will create a new socket
    expect(created.length).toBe(2);
  });

  it("should not start health check if healthCheckInterval is 0", () => {
    new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      healthCheckInterval: 0,
    });

    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    // Simulate silent failure
    instance.readyState = FakeWebSocket.CLOSED;

    // Flush timers - should not trigger reconnect since health check is disabled
    flushTimers();

    // Should not have reconnected
    expect(created.length).toBe(1);
  });

  it("should stop health check on forced close", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      healthCheckInterval: 100,
    });

    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    // Force close
    ws.close();
    flushTimers();

    // Simulate state change after close
    instance.readyState = FakeWebSocket.CLOSED;

    // Flush timers - health check should not trigger reconnect
    flushTimers();

    // Should not have reconnected
    expect(created.length).toBe(1);
  });
});
