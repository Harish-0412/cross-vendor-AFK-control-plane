# ADR-001: Protocol Design Decisions

| Status: Accepted
| Date: 2026-08-31
| Author: Harish-0412

## Context

The Freebuff AFK Control Plane requires a normalized event and command protocol to enable consistent, type-safe communication between:
- Gateway Core ↔ Agent Adapters
- Gateway Core ↔ Sandbox Manager
- Gateway Core ↔ Local API Server
- Local API Server ↔ Control Plane Tunnel (future)

Without a shared protocol, each component would define its own types, leading to inconsistency, validation gaps, and incompatibilities across the vendor adapters.

## Decisions

### 1. Event Envelope Format

We use a single normalized `EventEnvelope` with the following required fields:

```typescript
interface EventEnvelope {
  eventId: string;        // evt_ + 32 hex chars (crypto-random)
  eventType: EventType; // Discriminator enum
  eventVersion: number;  // Schema version, starts at 1
  sessionId: string;    // Owning session
  sequence: number;    // Monotonic per-session sequence
  occurredAt: Date;     // Event timestamp (source clock)
  payload: unknown;   // Type-specific payload
}
```

Optional fields: `deviceId`, `correlationId`, `parentEventId`

**Rationale:**

- **eventId: Unique, cryptographically-random ID enables dedup across retries
- **sequence**: Strictly monotonic per-session ordering enables replay, gap detection
- **eventVersion**: Allows payload schema evolution without breaking consumers
- **correlationId**: Tracing across async boundaries (request/response pairs)
- **unknown payload**: Forces consumers to validate against schemas

### 2. Command Envelope Format

Symmetric to event envelope for request/response patterns:

```typescript
interface CommandEnvelope {
  commandId: string;       // cmd_ prefix
  commandType: CommandType;
  commandVersion: number;
  sessionId?: string;
  issuedAt: Date;
  payload: unknown;
}
```

Every command produces a `CommandResult` with `{ commandId, success, result/error }`.

### 3. ID Generation

All IDs use the same pattern: `{prefix}_{hex_random_bytes}`.

| Entity | Prefix | Length |
|--------|--------|--------|
| Session | sess_ | 24 hex |
| Event | evt_ | 32 hex |
| Command | cmd_ | 24 hex |
| Project | proj_ | 24 hex |
| Sandbox | sbx_ | 24 hex |
| Device | dev_ | 32 hex |
| Gateway | gw_ | 24 hex |
| Approval | appr_ | 20 hex |
| Checkpoint | chk_ | 20 hex |

Generated via `crypto.randomBytes()` for cryptographic unguessability.

### 4. Zod Runtime Validation

All protocol types have corresponding Zod schemas in `@freebuff/schemas`. Every boundary must validate:
1. Parse → validate with Zod → pass into business logic

Schema failures produce structured error with  All components MUST NOT trust unvalidated inputs.

### 5. Session State Machine

```
initializing → running → waiting_for_approval → running → completed
                                             ↘ paused → running
                                             ↘ cancelled
                                             ↘ failed
                                             ↘ crashed
```

Terminal states: completed, failed, cancelled, crashed - no transitions from these.

### 6. Event Type Naming Convention

`{domain}.{action_past_tense}`:
- `session.created`, `session.completed`, `session.failed`
- `session.tool_call`, `session.tool_result`, `session.tool_error`
- `session.approval_required`, `session.approval_granted`, `session.approval_denied`

Exception: `session.message` (noun form is unambiguous in this domain).

### 7. Timestamp Format

All timestamps in envelopes are Date objects serialized as ISO 8601 strings on the wire.
Use monotonic `Date.now() internal elapsed-time calculations (avoiding clock-skew issues duration measurements.

## Consequences

### Positive
- Strict validation at every boundary
- Consistent event ordering gap-detectable (via sequence numbers)
- Evolvable via eventVersion / commandVersion
- Easy log aggregation / audit-chain auditability
- TypeScript type-safety + runtime Zod runtime double safety = correctness
- Clear upgrade path for schemas

### Negative
- Payload flexibility reduced flexibility
- Adds overhead of double-safety, not trust unknown everywhere schema parsing / performance-critical hot paths

### Mitigated by:
performance-critical streaming (tool  Batch schema  internal components validated at The cost
