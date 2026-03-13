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

  it("should still reconnect when a close listener throws", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 100,
    });

    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    ws.addEventListener("close", () => {
      throw new Error("close listener boom");
    });

    expect(() => instance.dispatchEvent(new CloseEvent("close"))).toThrow(
      "close listener boom",
    );

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

  it("should finish open lifecycle work when an open listener throws", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 100,
    });

    const instance = created[0];
    ws.send("queued-before-open");

    ws.addEventListener("open", () => {
      throw new Error("open listener boom");
    });

    instance.readyState = FakeWebSocket.OPEN;

    expect(() => instance.dispatchEvent(new Event("open"))).toThrow(
      "open listener boom",
    );

    expect(instance.sentData).toEqual(["queued-before-open"]);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(ws.wasConnected).toBe(true);

    instance.dispatchEvent(new CloseEvent("close"));
    flushTimers();

    expect(created.length).toBe(2);
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

  it("should queue messages when socket is not open and send on open", () => {
    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const instance = created[0];
    // Socket exists but is CONNECTING
    expect(instance.readyState).toBe(FakeWebSocket.CONNECTING);

    // Send will queue the message since socket is not open
    ws.send("before open");
    expect(instance.sentData).toEqual([]);

    // Open connection
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    // Queued message should now be sent, then send another
    ws.send("after open");
    expect(instance.sentData).toEqual(["before open", "after open"]);

    // Close connection (this clears ws.ws and the queue)
    ws.close();
    flushTimers();

    // Try to send after close (message will be queued but queue was cleared)
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

  it("should not schedule multiple reconnect timeouts when scheduleReconnect is called multiple times", () => {
    // This test exposes the bug: if scheduleReconnect() is called multiple times
    // before the timeout fires, multiple reconnect attempts will be made

    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 100, // Short delay for testing
    });

    const firstInstance = created[0];
    firstInstance.readyState = FakeWebSocket.OPEN;
    firstInstance.dispatchEvent(new Event("open"));
    flushTimers();

    expect(created.length).toBe(1);

    // Close the connection - this triggers scheduleReconnect() from closeFn
    // This schedules the first reconnect timeout
    firstInstance.dispatchEvent(new CloseEvent("close"));
    // Don't flush yet - we want the timeout to still be pending

    // At this point, scheduleReconnect() has been called once and a timeout is scheduled
    // Now call scheduleReconnect() again before the first timeout fires
    // This simulates a scenario where both close handler and health check call it
    // Bug: This schedules a second timeout without clearing the first one
    ws.scheduleReconnect();

    // With the bug: two timeouts are now scheduled, both will fire
    // After the fix: the second call should clear the first timeout, so only one fires

    // Count initial socket count before reconnects fire
    const initialCount = created.length;
    expect(initialCount).toBe(1);

    // Flush timers to let reconnect timeouts fire
    // With the bug: both timeouts fire, causing connect() to be called twice
    // After the fix: only one timeout fires, causing connect() to be called once
    flushTimers();

    // Verify the number of connection attempts
    // Expected: 2 sockets total (1 initial + 1 reconnect)
    // With bug: 3 sockets total (1 initial + 2 reconnects from both timeouts)
    const finalCount = created.length;

    // The bug: if scheduleReconnect doesn't clear previous timeout,
    // we'll have more connections than expected
    // This test will FAIL with the bug because created.length will be 3 instead of 2
    expect(finalCount).toBe(initialCount + 1);
  });

  it("should reset forcedClose flag when connect() is called after close()", () => {
    // This test exposes the bug: forcedClose flag is never reset after close(),
    // so manual reconnections won't auto-reconnect if they disconnect

    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
      retryDelay: 100,
    });

    const firstInstance = created[0];
    firstInstance.readyState = FakeWebSocket.OPEN;
    firstInstance.dispatchEvent(new Event("open"));
    flushTimers();

    expect(created.length).toBe(1);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    // Close the connection - this sets forcedClose = true
    ws.close();
    flushTimers();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(created.length).toBe(1); // Should not have reconnected

    // Manually reconnect by calling connect()
    // After calling connect(), forcedClose should be reset to false
    // so that if this new connection closes, it can reconnect automatically
    ws.connect();

    const secondInstance = created[1];
    expect(created.length).toBe(2);
    secondInstance.readyState = FakeWebSocket.OPEN;
    secondInstance.dispatchEvent(new Event("open"));
    flushTimers();

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    // Now close the second connection (not via ws.close(), but via event)
    // This simulates an unexpected disconnection
    // Bug: With forcedClose still true, it won't reconnect
    // After fix: With forcedClose reset to false, it should reconnect
    secondInstance.dispatchEvent(new CloseEvent("close"));
    flushTimers(); // Trigger reconnect if scheduled

    // Flush again to let reconnect timeout fire
    flushTimers();

    // Verify reconnection behavior
    // Expected: Should reconnect (created.length = 3)
    // With bug: Won't reconnect because forcedClose is still true (created.length = 2)
    // This test will FAIL with the bug because created.length will be 2 instead of 3
    expect(created.length).toBe(3);
  });

  it("should remove event listeners from socket when close() is called", () => {
    // This test exposes the memory leak: event listeners are not removed from socket
    // when close() is called, preventing proper garbage collection

    const ws = new ReconnectingWebSocket("ws://test", {
      WebSocketConstructor: FakeWebSocket as any,
    });

    const instance = created[0];
    instance.readyState = FakeWebSocket.OPEN;
    instance.dispatchEvent(new Event("open"));
    flushTimers();

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    // Track removeEventListener calls to verify listeners are removed
    let removeEventListenerCallCount = 0;
    const originalRemoveEventListener =
      instance.removeEventListener.bind(instance);
    instance.removeEventListener = function (...args: any[]) {
      removeEventListenerCallCount++;
      return originalRemoveEventListener(...args);
    };

    // Close the connection
    // Bug: Event listeners are not removed, causing memory leak
    // After fix: All 4 event listeners (open, message, close, error) should be removed
    ws.close();

    // Verify that removeEventListener was called for all event listeners
    // Expected: 4 calls (one for each listener: open, message, close, error)
    // With bug: 0 calls (listeners are not removed)
    // This test will FAIL with the bug because removeEventListenerCallCount will be 0 instead of 4
    expect(removeEventListenerCallCount).toBe(4);
  });

  describe("message queue", () => {
    it("should queue messages sent before socket opens and send them when connected", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
      });

      const instance = created[0];
      // Socket is in CONNECTING state
      expect(instance.readyState).toBe(FakeWebSocket.CONNECTING);

      // Send messages before socket is open
      ws.send("message1");
      ws.send("message2");
      ws.send("message3");

      // Messages should NOT be sent to the underlying socket yet (it's not open)
      expect(instance.sentData).toEqual([]);

      // Open the connection
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      flushTimers();

      // Now all queued messages should have been sent in order
      expect(instance.sentData).toEqual(["message1", "message2", "message3"]);
    });

    it("should queue messages sent after socket closes and send them when reconnected", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        retryDelay: 100,
      });

      const firstInstance = created[0];
      // Open first connection
      firstInstance.readyState = FakeWebSocket.OPEN;
      firstInstance.dispatchEvent(new Event("open"));
      flushTimers();

      // Send a message while connected
      ws.send("connected-message");
      expect(firstInstance.sentData).toEqual(["connected-message"]);

      // Simulate unexpected close (triggers reconnect)
      firstInstance.dispatchEvent(new CloseEvent("close"));
      flushTimers(); // Trigger reconnect scheduling

      // At this point, socket is reconnecting (second instance created)
      expect(created.length).toBe(2);
      const secondInstance = created[1];

      // Send messages while disconnected/reconnecting
      ws.send("queued1");
      ws.send("queued2");

      // Messages should NOT be sent to new socket yet (it's not open)
      expect(secondInstance.sentData).toEqual([]);

      // Open second connection
      secondInstance.readyState = FakeWebSocket.OPEN;
      secondInstance.dispatchEvent(new Event("open"));
      flushTimers();

      // Now queued messages should have been sent to second instance
      expect(secondInstance.sentData).toEqual(["queued1", "queued2"]);
    });

    it("should send immediately when socket is already open", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
      });

      const instance = created[0];
      // Open the connection
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      flushTimers();

      // Send message while connected
      ws.send("immediate-message");

      // Should be sent immediately
      expect(instance.sentData).toEqual(["immediate-message"]);
    });

    it("should preserve message order across reconnections", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        retryDelay: 100,
      });

      const firstInstance = created[0];
      // Send messages before first open
      ws.send("pre-open-1");
      ws.send("pre-open-2");

      expect(firstInstance.sentData).toEqual([]);

      // Open first connection
      firstInstance.readyState = FakeWebSocket.OPEN;
      firstInstance.dispatchEvent(new Event("open"));
      flushTimers();

      // Pre-open messages should be sent
      expect(firstInstance.sentData).toEqual(["pre-open-1", "pre-open-2"]);

      // Send while connected
      ws.send("connected");
      expect(firstInstance.sentData).toEqual([
        "pre-open-1",
        "pre-open-2",
        "connected",
      ]);

      // Disconnect
      firstInstance.dispatchEvent(new CloseEvent("close"));
      flushTimers();

      const secondInstance = created[1];

      // Send while disconnected
      ws.send("queued-1");
      ws.send("queued-2");

      expect(secondInstance.sentData).toEqual([]);

      // Reconnect
      secondInstance.readyState = FakeWebSocket.OPEN;
      secondInstance.dispatchEvent(new Event("open"));
      flushTimers();

      // Queued messages should be sent in order
      expect(secondInstance.sentData).toEqual(["queued-1", "queued-2"]);
    });

    it("should clear queue when forcedClose is called", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
      });

      const instance = created[0];
      // Socket is in CONNECTING state
      expect(instance.readyState).toBe(FakeWebSocket.CONNECTING);

      // Queue some messages
      ws.send("message1");
      ws.send("message2");

      // Force close
      ws.close();
      flushTimers();

      // Manually reconnect
      ws.connect();
      const secondInstance = created[1];
      secondInstance.readyState = FakeWebSocket.OPEN;
      secondInstance.dispatchEvent(new Event("open"));
      flushTimers();

      // Queued messages from before close() should be discarded
      expect(secondInstance.sentData).toEqual([]);
    });
  });

  describe("watching inactivity", () => {
    it("should not start inactivity timer when watchingInactivityTimeout is 0 (default)", () => {
      new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        // watchingInactivityTimeout defaults to 0 (disabled)
      });

      const instance = created[0];
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      flushTimers();

      // Simulate no messages received for a long time
      flushTimers();
      flushTimers();

      // Should NOT have reconnected because watchingInactivityTimeout is 0 by default
      expect(created.length).toBe(1);
    });

    it("should reconnect when no message is received within inactivity timeout", () => {
      new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        watchingInactivityTimeout: 100,
        retryDelay: 50,
      });

      const instance = created[0];
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      flushTimers();

      expect(created.length).toBe(1);

      // Flush the inactivity timeout - this should close the socket
      flushTimers();

      // Flush the reconnect timeout
      flushTimers();

      // Should have reconnected due to inactivity
      expect(created.length).toBe(2);
    });

    it("should reset inactivity timer when message is received", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        watchingInactivityTimeout: 100,
        retryDelay: 50,
      });

      const instance = created[0];
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      // Don't flush yet - the inactivity timer is pending

      expect(created.length).toBe(1);

      // Receive a message - this should reset the inactivity timer
      // The old timer is cleared and a new one is started
      instance.dispatchEvent(new MessageEvent("message", { data: "hello" }));

      // Receive another message - this resets the timer again
      instance.dispatchEvent(new MessageEvent("message", { data: "world" }));

      // Now flush - only the latest inactivity timer should fire
      // But since we just received a message, the timer was just reset
      // So we're still connected
      expect(created.length).toBe(1);
      expect(ws.readyState).toBe(FakeWebSocket.OPEN);

      // Now flush to trigger the inactivity timeout
      flushTimers();
      // Reconnect
      flushTimers();

      // Now it should have reconnected after the inactivity timeout
      expect(created.length).toBe(2);
    });

    it("should default inactivity timeout to 0 (disabled)", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
      });

      // Check that the default timeout is 0 (disabled)
      expect(ws.options.watchingInactivityTimeout).toBe(0);
    });

    it("should not reconnect after forced close even with inactivity timeout", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        watchingInactivityTimeout: 100,
      });

      const instance = created[0];
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      flushTimers();

      // Force close
      ws.close();
      flushTimers();

      // Even if inactivity timer was somehow still running, it should not reconnect
      flushTimers();
      flushTimers();

      // Should not have reconnected
      expect(created.length).toBe(1);
    });

    it("should stop inactivity timer on close", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        watchingInactivityTimeout: 100,
        retryDelay: 50,
      });

      const instance = created[0];
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      // Don't flush here - inactivity timer is pending

      expect(created.length).toBe(1);

      // Close the connection normally (not via inactivity)
      // This should stop the inactivity timer
      instance.dispatchEvent(new CloseEvent("close"));

      // The close handler should have stopped the inactivity timer
      // and scheduled a reconnect
      flushTimers(); // Trigger reconnect

      // Should have reconnected due to close event
      expect(created.length).toBe(2);

      // The second instance opens
      const secondInstance = created[1];
      secondInstance.readyState = FakeWebSocket.OPEN;
      secondInstance.dispatchEvent(new Event("open"));

      // Verify we're on the second instance
      expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    });

    it("should emit close event when inactivity timeout triggers reconnect", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        watchingInactivityTimeout: 100,
        retryDelay: 50,
      });

      const closes: any[] = [];
      ws.addEventListener("close", (ev) => closes.push(ev));

      const instance = created[0];
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));
      flushTimers();

      // Flush the inactivity timeout - should trigger close
      flushTimers();

      // Should have received close event
      expect(closes.length).toBe(1);
    });

    it("should still reconnect when an inactivity close listener throws", () => {
      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        watchingInactivityTimeout: 100,
        retryDelay: 50,
      });

      const instance = created[0];
      instance.readyState = FakeWebSocket.OPEN;
      instance.dispatchEvent(new Event("open"));

      ws.addEventListener("close", () => {
        throw new Error("inactivity close listener boom");
      });

      expect(() => flushTimers()).toThrow("inactivity close listener boom");

      flushTimers();

      expect(created.length).toBe(2);
    });

    it("should restart inactivity timer after reconnection", () => {
      new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: FakeWebSocket as any,
        watchingInactivityTimeout: 100,
        retryDelay: 50,
      });

      // First connection
      const firstInstance = created[0];
      firstInstance.readyState = FakeWebSocket.OPEN;
      firstInstance.dispatchEvent(new Event("open"));
      flushTimers();

      expect(created.length).toBe(1);

      // Inactivity triggers close
      flushTimers();
      // Reconnect scheduled
      flushTimers();

      expect(created.length).toBe(2);

      // Second connection
      const secondInstance = created[1];
      secondInstance.readyState = FakeWebSocket.OPEN;
      secondInstance.dispatchEvent(new Event("open"));
      flushTimers();

      // Now the second connection should also have an inactivity timer
      // Flush again to trigger inactivity on second connection
      flushTimers();
      // Reconnect
      flushTimers();

      // Should have created a third connection
      expect(created.length).toBe(3);
    });

    it("should reconnect even when close event never fires (stalled connection)", () => {
      // This test simulates a truly stalled connection where calling close()
      // does NOT fire the close event (e.g., dead TCP connection, NAT timeout)

      // Create a special FakeWebSocket that does NOT dispatch close event
      class StalledFakeWebSocket extends EventTarget {
        static OPEN = 1;
        static CONNECTING = 0;
        static CLOSED = 3;
        readyState: number = StalledFakeWebSocket.CONNECTING;
        sentData: any[] = [];
        bufferedAmount: number = 0;
        constructor(_url: string, _protocols?: string | string[]) {
          super();
          created.push(this);
          this.readyState = StalledFakeWebSocket.CONNECTING;
          this.bufferedAmount = 0;
        }
        send(data: any) {
          this.sentData.push(data);
        }
        close() {
          // Simulate stalled connection: set readyState but DO NOT dispatch close event
          // This simulates a dead connection where the closing handshake hangs
          this.readyState = StalledFakeWebSocket.CLOSED;
          // NOTE: Intentionally NOT dispatching close event
        }
      }

      Object.assign(StalledFakeWebSocket.prototype, {
        OPEN: StalledFakeWebSocket.OPEN,
        CONNECTING: StalledFakeWebSocket.CONNECTING,
        CLOSED: StalledFakeWebSocket.CLOSED,
      });

      const ws = new ReconnectingWebSocket("ws://test", {
        WebSocketConstructor: StalledFakeWebSocket as any,
        watchingInactivityTimeout: 100,
        retryDelay: 50,
      });

      const closes: any[] = [];
      ws.addEventListener("close", (ev) => closes.push(ev));

      // First connection
      const firstInstance = created[0];
      expect(created.length).toBe(1);

      // Open the connection
      firstInstance.readyState = StalledFakeWebSocket.OPEN;
      firstInstance.dispatchEvent(new Event("open"));

      // At this point, inactivity timer has been started
      // Don't flush yet - verify we're connected
      expect(ws.readyState).toBe(StalledFakeWebSocket.OPEN);

      // Flush timers - this triggers the inactivity timeout
      // The inactivity handler calls this.ws.close()
      // With StalledFakeWebSocket, close() does NOT fire the close event
      // BUG: Without the close event, closeFn never runs, scheduleReconnect is never called
      flushTimers();

      // Flush again to execute any scheduled reconnect timeout
      flushTimers();

      // Flush once more just to be sure
      flushTimers();

      // With the current (buggy) implementation:
      // - The inactivity timeout fires and calls ws.close()
      // - close() sets readyState to CLOSED but doesn't fire close event
      // - closeFn never runs, so scheduleReconnect() is never called
      // - No new connection is created
      // - closes array is empty because we never emitted close

      // With the fix:
      // - The inactivity handler should emit close and schedule reconnect directly
      // - A new connection should be created
      // - closes array should have 1 entry

      // This assertion will FAIL with the buggy implementation (created.length will be 1)
      // After the fix, it should pass (created.length will be 2)
      expect(closes.length).toBe(1);
      expect(created.length).toBe(2);
    });
  });
});
