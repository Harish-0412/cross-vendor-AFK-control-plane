# Transport & Reconnect Spike

Outbound-only WebSocket connection with reliable reconnect, message ordering, and duplicate detection.

## Architecture

```
spikes/transport/
├── src/
│   ├── index.ts              # Main entry point
│   ├── types.ts              # Shared types
│   ├── ws-client.ts          # WebSocket client with reconnect
│   ├── ws-server.ts          # Test WebSocket server
│   ├── reconnect.ts          # Reconnection state machine
│   ├── message-queue.ts      # Outbound message queue with acks
│   ├── auth.ts               # Authentication handling
│   └── protocol.ts           # Message protocol definitions
├── test-scenarios/
│   ├── basic-connection.md
│   ├── network-drop.md
│   ├── message-ordering.md
│   └── auth-recovery.md
└── README.md
```

## Protocol

### Message Envelope
```typescript
interface GatewayMessage {
  type: 'event' | 'command' | 'ack' | 'heartbeat' | 'auth' | 'auth_response';
  id: string;                 // Unique message ID (UUID)
  sequence: number;           // Monotonic sequence number
  correlationId?: string;     // For request/response pairing
  payload: any;
  timestamp: number;          // Unix milliseconds
}
```

### Connection States
```
CONNECTED → DISCONNECTED → RECONNECTING → DEGRADED → RECONCILING → CONNECTED
```

### Sequence Number Management
- Client maintains `lastSequenceSent` and `lastSequenceAcked`
- Server maintains `lastSequenceReceived` per client
- On reconnect: client sends `lastSequenceAcked`, server replays missing events

## Quick Start

```bash
cd spikes/transport
npm install
npm run build

# Start test server
npm run server

# Run client tests
npm run test:basic
npm run test:reconnect
npm run test:ordering
npm run test:auth
```

## Client Usage

```typescript
import { GatewayClient, ConnectionState } from './src';

const client = new GatewayClient({
  url: 'wss://control-plane.example.com/ws',
  deviceId: 'dev_abc123',
  authToken: 'Bearer token...',
  reconnect: {
    maxAttempts: 10,
    baseDelay: 1000,
    maxDelay: 30000,
    jitter: 0.1
  }
});

client.on('stateChange', (state) => {
  console.log('State:', state);
});

client.on('message', (msg) => {
  console.log('Received:', msg.type, msg.payload);
});

await client.connect();

// Send event
await client.sendEvent('session.output', { sessionId: 'sess_123', data: 'hello' });

// Send command with acknowledgment
const response = await client.sendCommand('session.stop', { sessionId: 'sess_123' });
```

## Reconnection Logic

```typescript
const RECONNECT_CONFIG = {
  maxAttempts: 10,
  baseDelay: 1000,      // 1 second
  maxDelay: 30000,      // 30 seconds
  jitter: 0.1,          // 10% jitter
  backoffMultiplier: 2  // Exponential backoff
};

async function reconnectWithBackoff(attempt: number): Promise<void> {
  const delay = Math.min(
    RECONNECT_CONFIG.baseDelay * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt),
    RECONNECT_CONFIG.maxDelay
  );
  
  const jitter = delay * RECONNECT_CONFIG.jitter * Math.random();
  await sleep(delay + jitter);
}
```

## Message Acknowledgment Flow

```
Client                          Server
  |                               |
  |--- event (seq=1) ------------>|
  |                               |
  |<-- ack (seq=1) ---------------|
  |                               |
  |--- event (seq=2) ------------>|
  |                               |
  |<-- ack (seq=2) ---------------|
  |                               |
  [Network partition]
  |                               |
  |--- event (seq=3) ------------>| (lost)
  |                               |
  [Reconnect]
  |                               |
  |--- reconnect (lastAck=2) ---->|
  |                               |
  |<-- replay (seq=3) ------------|
  |                               |
  |--- ack (seq=3) -------------->|
```

## Test Scenarios

### 1. Basic Connection
- Connect to test server
- Verify TLS encryption
- Send/receive messages
- Clean disconnect

### 2. Network Drop
- Establish connection
- Simulate network drop (kill connection)
- Verify automatic reconnect
- Verify message continuity

### 3. Message Ordering
- Send 100 messages rapidly
- Verify in-order delivery
- Verify no duplicates

### 4. Auth Recovery
- Connect with valid token
- Expire token
- Verify re-authentication
- Verify seamless resume

## Security

- TLS 1.3 required
- Mutual authentication (client cert + server cert)
- Token-based auth with refresh
- Message signing for integrity
- Rate limiting on server

## Observability

- Connection state metrics
- Message latency histograms
- Reconnect frequency counter
- Duplicate message counter
- Queue depth gauge