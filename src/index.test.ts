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

  it("should not process events from old socket when connect() is called multiple times", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const opens: Event[] = [];
    const messages: MessageEvent[] = [];
    ws.addEventListener("open", (event) => opens.push(event));
    ws.addEventListener("message", (event: MessageEvent) =>
      messages.push(event),
    );

    // First connection attempt
    const firstInstance = created[0];
    expect(created.length).toBe(1);

    // Before first connection completes, trigger another connect()
    // This simulates a race condition where connect() is called again
    ws.connect();

    // Second connection attempt should be created
    const secondInstance = created[1];
    expect(created.length).toBe(2);

    // Now fire events on BOTH sockets
    // The first socket should be ignored, only second socket's events should be processed
    firstInstance.readyState = FakeWebSocket.OPEN;
    firstInstance.dispatchEvent(new Event("open"));
    firstInstance.dispatchEvent(
      new MessageEvent("message", { data: "from-first" }),
    );

    secondInstance.readyState = FakeWebSocket.OPEN;
    secondInstance.dispatchEvent(new Event("open"));
    secondInstance.dispatchEvent(
      new MessageEvent("message", { data: "from-second" }),
    );

    flushTimers();

    // Only the second socket's events should be processed
    // This test will fail if events from the first socket are still processed
    expect(opens.length).toBe(1);
    expect(messages.length).toBe(1);
    expect(messages[0].data).toBe("from-second");
  });

  it("should clean up abort signal listeners when connect() is called multiple times", () => {
    // This test exposes the memory leak bug: abort signal listeners accumulate
    // when connect() is called multiple times because old listeners aren't removed

    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      connectionTimeout: 1000,
    });

    const firstInstance = created[0];
    expect(created.length).toBe(1);
    firstInstance.readyState = FakeWebSocket.CONNECTING;

    // Access the first abort controller via type assertion (for testing)
    const firstAbortController = ws.abortController;
    expect(firstAbortController).toBeDefined();

    // Count how many listeners are attached to the first abort signal
    // We can't directly count, but we can verify cleanup by checking
    // if manually aborting the old controller causes issues

    // Call connect() again - this creates a new abort controller
    // Bug: The old abort controller's signal listener is NOT removed
    ws.connect();

    const secondInstance = created[1];
    expect(created.length).toBe(2);
    secondInstance.readyState = FakeWebSocket.CONNECTING;

    const secondAbortController = ws.abortController;
    expect(secondAbortController).toBeDefined();
    expect(secondAbortController).not.toBe(firstAbortController);

    // Verify the first abort controller still has its listener attached (the bug)
    // We can't directly count listeners, but we can test by manually aborting
    // the old controller and verifying it doesn't interfere

    // Verify second socket is in CONNECTING state
    expect(secondInstance.readyState).toBe(FakeWebSocket.CONNECTING);

    // Manually abort the first (old) abort controller
    // Bug: If the listener wasn't cleaned up, it will fire and check this.ws
    // Since this.ws is now the second socket, the old handler will incorrectly
    // close the second socket because it's CONNECTING
    firstAbortController?.abort();

    // The bug: The old abort handler fires and checks this.ws (which is secondInstance)
    // Since secondInstance is CONNECTING, the old handler closes it (BUG!)
    // This test will FAIL with the bug because secondInstance will be CLOSED
    // After the fix, aborting the old controller should NOT affect the current socket
    // because the listener will have been removed

    // Verify the second socket was NOT closed by the old abort handler
    // With the bug present, this will fail because secondInstance.readyState will be CLOSED
    expect(secondInstance.readyState).toBe(FakeWebSocket.CONNECTING);

    // Verify second connection can still proceed normally
    secondInstance.readyState = FakeWebSocket.OPEN;
    secondInstance.dispatchEvent(new Event("open"));
    flushTimers();

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
  });
});
