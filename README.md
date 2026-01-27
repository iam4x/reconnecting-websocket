# @iam4x/reconnecting-websocket

A robust, TypeScript-first WebSocket client with automatic reconnection, exponential backoff, and comprehensive event handling.

## Features

- ✅ **Automatic Reconnection** - Automatically reconnects on connection loss with exponential backoff
- ✅ **Message Queueing** - Messages sent while disconnected are queued and delivered on reconnection
- ✅ **Connection Timeout** - Configurable timeout to detect stalled connections
- ✅ **Inactivity Detection** - Optionally reconnect when no messages are received within a timeout
- ✅ **Event-Driven API** - Familiar event listener pattern matching WebSocket API
- ✅ **TypeScript Support** - Full TypeScript definitions included
- ✅ **Customizable** - Configurable retry delays, backoff factors, and WebSocket implementations
- ✅ **Reconnect Events** - Separate `reconnect` event for tracking reconnection attempts
- ✅ **Memory Safe** - Proper cleanup of timers and event listeners

## Installation

```bash
bun add @iam4x/reconnecting-websocket
```

or

```bash
npm install @iam4x/reconnecting-websocket
```

## Quick Start

```typescript
import { ReconnectingWebSocket } from "@iam4x/reconnecting-websocket";

const ws = new ReconnectingWebSocket("wss://echo.websocket.org");

ws.addEventListener("open", () => {
  console.log("Connected!");
  ws.send("Hello, Server!");
});

ws.addEventListener("message", (event: MessageEvent) => {
  console.log("Received:", event.data);
});

ws.addEventListener("close", (event) => {
  console.log("Connection closed:", event.code, event.reason);
});

ws.addEventListener("reconnect", () => {
  console.log("Reconnected successfully!");
});

ws.addEventListener("error", (event: Event) => {
  console.error("WebSocket error:", event);
});
```

## API Reference

### Constructor

```typescript
new ReconnectingWebSocket(url: string, options?: ReconnectOptions)
```

Creates a new `ReconnectingWebSocket` instance and immediately attempts to connect.

#### Parameters

- `url` (string): The WebSocket server URL (e.g., `"wss://example.com"`)
- `options` (ReconnectOptions, optional): Configuration options (see below)

### Options

```typescript
interface ReconnectOptions {
  retryDelay?: number;           // Initial retry delay in ms (default: 1000)
  maxRetryDelay?: number;        // Maximum retry delay in ms (default: 30000)
  connectionTimeout?: number;    // Connection timeout in ms (default: 10000)
  backoffFactor?: number;        // Exponential backoff multiplier (default: 2)
  healthCheckInterval?: number;  // Health check interval in ms (default: 30000)
  watchingInactivityTimeout?: number; // Inactivity timeout in ms (default: 0, disabled)
  WebSocketConstructor?: typeof WebSocket; // Custom WebSocket implementation
}
```

#### Option Details

- **retryDelay**: The initial delay before the first reconnection attempt (in milliseconds)
- **maxRetryDelay**: The maximum delay between reconnection attempts. The delay will grow exponentially but won't exceed this value
- **connectionTimeout**: If a connection doesn't establish within this time, it will be aborted and retried
- **backoffFactor**: The multiplier for exponential backoff. Each retry delay is multiplied by this factor
- **healthCheckInterval**: Interval for checking if the socket is still healthy. Set to `0` to disable (default: 30000ms)
- **watchingInactivityTimeout**: If no message is received within this timeout, the connection will be closed and a reconnection attempt will be made. Useful for detecting silent connection failures or keeping connections alive on servers that expect regular activity. Set to `0` to disable (default: 0, disabled). A common value is `300000` (5 minutes)
- **WebSocketConstructor**: Allows you to provide a custom WebSocket implementation (useful for Node.js environments using libraries like `ws`)

### Methods

#### `addEventListener(event, listener)`

Adds an event listener to the socket.

```typescript
ws.addEventListener("open", (event: Event) => {
  // Handle open event
});
```

**Events:**
- `"open"` - Emitted when connection is established
- `"message"` - Emitted when a message is received (payload: `MessageEvent`)
- `"close"` - Emitted when connection closes (payload: `{ code: number, reason: string }`)
- `"reconnect"` - Emitted when successfully reconnected after a disconnection
- `"error"` - Emitted when an error occurs (payload: `Event`)

#### `removeEventListener(event, listener)`

Removes an event listener from the socket.

```typescript
const handler = (event: Event) => console.log("Connected");
ws.addEventListener("open", handler);
ws.removeEventListener("open", handler);
```

#### `send(data)`

Sends data through the WebSocket connection. If the socket is not open, messages are automatically queued and sent once the connection is established.

```typescript
ws.send("Hello, Server!");
ws.send(JSON.stringify({ type: "ping" }));
```

**Note:** Messages sent while disconnected are queued and delivered in order when the socket opens. The queue is cleared if `close()` is called.

#### `close(code?, reason?)`

Closes the WebSocket connection and prevents automatic reconnection.

```typescript
ws.close(); // Close with default code
ws.close(1000, "Normal closure"); // Close with code and reason
```

After calling `close()`, the socket will not automatically reconnect. Create a new instance to reconnect.

### Properties

#### `readyState`

Returns the current ready state of the WebSocket connection.

```typescript
if (ws.readyState === WebSocket.OPEN) {
  ws.send("Data");
}
```

**Values:**
- `WebSocket.CONNECTING` (0) - Connection is being established
- `WebSocket.OPEN` (1) - Connection is open and ready
- `WebSocket.CLOSED` (3) - Connection is closed

#### `bufferedAmount`

Returns the number of bytes of data that have been queued using `send()` but not yet transmitted.

```typescript
if (ws.bufferedAmount === 0) {
  ws.send("Large message");
}
```

**Note:** Returns `0` if the socket is not connected.

## Examples

### Custom Retry Configuration

```typescript
const ws = new ReconnectingWebSocket("wss://api.example.com", {
  retryDelay: 500,        // Start with 500ms delay
  maxRetryDelay: 60000,   // Cap at 60 seconds
  backoffFactor: 1.5,     // Gentle backoff
  connectionTimeout: 5000 // 5 second timeout
});
```

### Inactivity Timeout

Use `watchingInactivityTimeout` to automatically reconnect when no messages are received for a period of time. This is useful for detecting silent connection failures or when the server expects regular activity:

```typescript
const ws = new ReconnectingWebSocket("wss://api.example.com", {
  watchingInactivityTimeout: 300000, // Reconnect if no message received for 5 minutes
});

ws.addEventListener("message", (event: MessageEvent) => {
  // Each message received resets the inactivity timer
  console.log("Received:", event.data);
});

ws.addEventListener("close", (event) => {
  // This will fire when inactivity timeout triggers a reconnect
  console.log("Connection closed:", event.code, event.reason);
});
```

### Using with Node.js

```typescript
import WebSocket from "ws";
import { ReconnectingWebSocket } from "@iam4x/reconnecting-websocket";

const ws = new ReconnectingWebSocket("wss://api.example.com", {
  WebSocketConstructor: WebSocket as any,
});
```

### Handling Reconnections

Messages sent while disconnected are automatically queued and delivered when the connection is restored:

```typescript
const ws = new ReconnectingWebSocket("wss://api.example.com");

ws.addEventListener("reconnect", () => {
  console.log("Reconnected! Resuming operations...");
});

// Safe to call anytime - messages are queued if disconnected
ws.send("message1");
ws.send("message2");

// When socket opens/reconnects, queued messages are sent automatically
```

**Note:** Calling `close()` clears the message queue. Messages queued before a forced close are discarded.

### Error Handling

```typescript
ws.addEventListener("error", (event: Event) => {
  console.error("WebSocket error occurred:", event);
  // Error events typically precede close events
  // The socket will automatically attempt to reconnect
});

ws.addEventListener("close", (event) => {
  if (event.code !== 1000) {
    console.warn("Connection closed unexpectedly:", event.code, event.reason);
  }
});
```

### Manual Connection Management

```typescript
const ws = new ReconnectingWebSocket("wss://api.example.com");

// Later, close the connection
ws.close();

// To reconnect, create a new instance
const ws2 = new ReconnectingWebSocket("wss://api.example.com");
```

## Reconnection Behavior

The library uses exponential backoff for reconnection attempts:

1. **First retry**: After `retryDelay` milliseconds
2. **Second retry**: After `retryDelay * backoffFactor` milliseconds
3. **Third retry**: After `retryDelay * backoffFactor²` milliseconds
4. **And so on...** up to `maxRetryDelay`

Example with defaults (`retryDelay: 1000`, `backoffFactor: 2`, `maxRetryDelay: 30000`):
- Attempt 1: Wait 1 second
- Attempt 2: Wait 2 seconds
- Attempt 3: Wait 4 seconds
- Attempt 4: Wait 8 seconds
- Attempt 5: Wait 16 seconds
- Attempt 6+: Wait 30 seconds (max)

## TypeScript Support

Full TypeScript definitions are included. The library is written in TypeScript and exports all necessary types.

```typescript
import type { ReconnectingWebSocket } from "@iam4x/reconnecting-websocket";
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
