# Integration Harness

Disposable test program to validate agent control capabilities before building production Gateway.

## Quick Start

```bash
# Install dependencies
cd spikes/integration-harness
npm install

# Build
npm run build

# Run basic session test with mock agent
npm run test:mock -- --scenario basic-session

# Run with OpenCode (if installed)
npm run test:opencode -- --scenario basic-session
```

## Architecture

```
spikes/integration-harness/
├── src/
│   ├── index.ts              # Main CLI entry point
│   ├── types.ts              # Shared type definitions
│   ├── harness.ts            # Core IntegrationHarness class
│   ├── agents/
│   │   ├── base.ts           # BaseAgentAdapter abstract class
│   │   ├── opencode.ts       # OpenCode adapter
│   │   └── mock.ts           # Mock agent adapter
│   └── utils/
│       ├── logger.ts         # Structured logging
│       ├── process.ts        # Process management utilities
│       └── events.ts         # Event parsing/normalization
├── test-scenarios/
│   ├── basic-session.md
│   ├── multi-prompt.md
│   └── crash-recovery.md
└── package.json
```

## Type Definitions

```typescript
// src/types.ts

export interface AgentConfig {
  agent: string;
  workspace: string;
  prompt: string;
  model?: string;
  approvalMode?: 'auto' | 'ask' | 'never';
  env?: Record<string, string>;
  timeout?: number;
  maxTurns?: number;
}

export interface Session {
  id: string;
  agent: string;
  pid: number;
  startTime: Date;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  workspace: string;
  config: AgentConfig;
}

export interface AgentEvent {
  type: string;
  timestamp: Date;
  sequence: number;
  payload: any;
  raw?: string;
}

export interface HarnessResult {
  session: Session;
  events: AgentEvent[];
  exitCode: number | null;
  duration: number;
  success: boolean;
  error?: string;
}

export interface IntegrationHarness {
  detect(agent: string): Promise<boolean>;
  start(config: AgentConfig): Promise<Session>;
  prompt(sessionId: string, message: string): Promise<void>;
  captureOutput(sessionId: string): AsyncIterable<AgentEvent>;
  followUp(sessionId: string, message: string): Promise<void>;
  stop(sessionId: string): Promise<HarnessResult>;
}
```

## CLI Usage

```bash
# List available agents
npx ts-node src/index.ts list-agents

# Detect installed agents
npx ts-node src/index.ts detect

# Run basic session
npx ts-node src/index.ts run --agent mock --prompt "Create a hello world function"

# Run with specific scenario
npx ts-node src/index.ts run --agent opencode --scenario basic-session

# Run multi-prompt scenario
npx ts-node src/index.ts run --agent mock --scenario multi-prompt

# Run crash recovery test
npx ts-node src/index.ts run --agent mock --scenario crash-recovery
```

## Test Scenarios

### 1. Basic Session (`basic-session.md`)
```
1. Detect agent
2. Start session with prompt "Create a simple calculator function"
3. Capture all output events
4. Verify session completes successfully
5. Stop session
6. Verify cleanup (no orphan processes)
```

### 2. Multi-Prompt (`multi-prompt.md`)
```
1. Start session with initial prompt
2. Capture initial response
3. Send follow-up prompt "Add unit tests"
4. Verify context maintained (references previous code)
5. Send second follow-up "Add error handling"
6. Verify cumulative context
7. Stop session
```

### 3. Crash Recovery (`crash-recovery.md`)
```
1. Start session
2. Send prompt that takes time
3. Force kill process (SIGKILL)
4. Verify no orphan processes
5. Restart harness
6. Verify session state recoverable (if agent supports)
```

## Event Normalization

All agents produce different event formats. The harness normalizes to:

```typescript
interface NormalizedEvent {
  eventId: string;           // Unique event ID
  eventType: EventType;      // Standardized type
  sessionId: string;
  sequence: number;          // Monotonic sequence
  timestamp: Date;
  payload: any;              // Agent-specific payload
  rawEvent: any;             // Original agent event
}

type EventType = 
  | 'session.started'
  | 'session.completed'
  | 'session.failed'
  | 'session.cancelled'
  | 'assistant.message'
  | 'assistant.thinking'
  | 'tool.call'
  | 'tool.result'
  | 'tool.error'
  | 'file.read'
  | 'file.write'
  | 'file.edit'
  | 'file.delete'
  | 'bash.exec'
  | 'bash.output'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied'
  | 'error';
```

## Mock Agent

The mock agent generates deterministic events for testing:

```bash
# Events generated in sequence:
# 1. session.started
# 2. assistant.thinking (planning)
# 3. assistant.message (initial response)
# 4. tool.call (file_write)
# 5. tool.result (success)
# 6. file.write (confirmation)
# 7. assistant.message (completion)
# 8. session.completed
```

Configurable via `MockAgentConfig`:
```typescript
interface MockAgentConfig {
  scenario: 'basic' | 'multi-turn' | 'approval' | 'error' | 'crash';
  delay?: number;           // ms between events
  shouldCrash?: boolean;    // Simulate crash at specific turn
  approvalRequired?: boolean;
}
```

## OpenCode Adapter

Wraps `opencode run --headless --json` process:

```typescript
class OpenCodeAdapter extends BaseAgentAdapter {
  async start(config: AgentConfig): Promise<Session> {
    const args = [
      'run',
      '--headless',
      '--json',
      '--prompt', config.prompt,
      '--workspace', config.workspace
    ];
    
    if (config.approvalMode) {
      args.push('--approval-mode', config.approvalMode);
    }
    if (config.model) {
      args.push('--model', config.model);
    }
    
    return this.spawnProcess('opencode', args, config);
  }
  
  parseEvent(line: string): NormalizedEvent | null {
    // Parse OpenCode JSON lines to normalized events
  }
}
```

## Output

Test runs produce structured results:

```json
{
  "session": {
    "id": "sess_abc123",
    "agent": "mock",
    "pid": 12345,
    "startTime": "2026-08-31T10:00:00.000Z",
    "status": "completed",
    "workspace": "/tmp/test-workspace"
  },
  "events": [...],
  "exitCode": 0,
  "duration": 5432,
  "success": true
}
```

## CI Integration

```yaml
# .github/workflows/integration-harness.yml
name: Integration Harness Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: cd spikes/integration-harness && npm ci
      - run: cd spikes/integration-harness && npm run build
      - run: cd spikes/integration-harness && npm run test:mock
      - run: cd spikes/integration-harness && npm run test:opencode
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```