import type {
  EventType,
  FileChangedPayload,
  SessionCompletedPayload,
  SessionFailedPayload,
  SessionMessagePayload,
  SessionThinkingPayload,
  ToolCallPayload,
  ToolResultPayload,
  ApprovalRequiredPayload,
} from '@freebuff/protocol';

export type ScenarioName =
  | 'simple'
  | 'with_approval'
  | 'failed'
  | 'cancelled'
  | 'long_task'
  | 'multi_turn'
  | 'crash_midway'
  | 'thinking_only'
  | 'file_edits'
  | 'approvals_chain';

export interface ScenarioEventTemplate {
  type: EventType;
  delayMs?: number;
  payloadFactory?: (ctx: ScenarioContext) => unknown;
}

export interface ScenarioContext {
  sessionId: string;
  config: ScenarioConfig;
  turn: number;
  eventIndex: number;
  totalEvents: number;
  variables: Record<string, unknown>;
}

export interface ScenarioConfig {
  scenario: ScenarioName;
  baseDelayMs?: number;
  jitterMs?: number;
  failureAtTurn?: number;
  crashAtEvent?: number;
  approvalCount?: number;
  messageCount?: number;
  toolCallCount?: number;
  fileChangeCount?: number;
  totalDurationMs?: number;
  customEvents?: Array<{ type: EventType; payload?: unknown; delayMs?: number }>;
  seed?: number;
}

export const DEFAULT_SCENARIO_CONFIG: Required<
  Pick<
    ScenarioConfig,
    | 'baseDelayMs'
    | 'jitterMs'
    | 'approvalCount'
    | 'messageCount'
    | 'toolCallCount'
    | 'fileChangeCount'
  >
> = {
  baseDelayMs: 150,
  jitterMs: 50,
  approvalCount: 1,
  messageCount: 3,
  toolCallCount: 2,
  fileChangeCount: 2,
};

const sampleDiffs: Record<string, string> = {
  calculator: `diff --git a/calculator.ts b/calculator.ts
new file mode 100644
index 0000000..5f4dcc3
--- /dev/null
+++ b/calculator.ts
@@ -0,0 +1,10 @@
+export function add(a: number, b: number): number {
+  return a + b;
+}
+
+export function subtract(a: number, b: number): number {
+  return a - b;
+}
+
+export function multiply(a: number, b: number): number {
+  return a * b;`,
  test: `diff --git a/calculator.test.ts b/calculator.test.ts
new file mode 100644
index 0000000..8a3f2b1
--- /dev/null
+++ b/calculator.test.ts
@@ -0,0 +1,12 @@
+import { describe, expect, test } from 'vitest';
+import { add, subtract, multiply } from './calculator';
+
+describe('calculator', () => {
+  test('add returns sum', () => {
+    expect(add(2, 3)).toBe(5);
+  });
+  test('subtract returns difference', () => {
+    expect(subtract(5, 2)).toBe(3);
+  });`,
  readme: `diff --git a/README.md b/README.md
index 1234567..abcdefg 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,7 @@
 # My Project

+## Features
+
+- Fast calculator operations
+- Well-tested with 100% coverage
+- Zero dependencies`,
};

const sampleFiles = [
  'calculator.ts',
  'calculator.test.ts',
  'README.md',
  'utils.ts',
  'index.ts',
  'types.ts',
];

export function buildSimpleScenario(config: ScenarioConfig): ScenarioEventTemplate[] {
  const delay = config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs;
  const fileCount = Math.min(
    config.fileChangeCount ?? DEFAULT_SCENARIO_CONFIG.fileChangeCount,
    sampleFiles.length,
  );
  const toolCount = config.toolCallCount ?? DEFAULT_SCENARIO_CONFIG.toolCallCount;
  const messageCount = config.messageCount ?? DEFAULT_SCENARIO_CONFIG.messageCount;

  const events: ScenarioEventTemplate[] = [
    { type: 'session.started', delayMs: delay },
    { type: 'session.thinking', delayMs: delay, payloadFactory: () => sampleThinking('planning') },
  ];

  for (let i = 0; i < messageCount; i++) {
    events.push({
      type: 'session.message',
      delayMs: delay,
      payloadFactory: (ctx) => sampleAssistantMessage(ctx.turn),
    });
    if (i < toolCount) {
      events.push({
        type: 'session.tool_call',
        delayMs: delay,
        payloadFactory: (ctx) => sampleToolCall(ctx.turn),
      });
      events.push({
        type: 'session.tool_result',
        delayMs: delay,
        payloadFactory: (ctx) => sampleToolResult(ctx.turn),
      });
    }
    if (i < fileCount) {
      events.push({
        type: 'session.file_changed',
        delayMs: delay,
        payloadFactory: () => sampleFileChanged(i),
      });
    }
  }

  events.push({
    type: 'session.completed',
    delayMs: delay,
    payloadFactory: (ctx) => sampleCompleted(ctx),
  });

  return events;
}

export function buildApprovalScenario(config: ScenarioConfig): ScenarioEventTemplate[] {
  const delay = config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs;
  const approvalCount = config.approvalCount ?? DEFAULT_SCENARIO_CONFIG.approvalCount;
  const events: ScenarioEventTemplate[] = [
    { type: 'session.started', delayMs: delay },
    { type: 'session.thinking', delayMs: delay, payloadFactory: () => sampleThinking('analyzing') },
    {
      type: 'session.message',
      delayMs: delay,
      payloadFactory: (ctx) => sampleAssistantMessage(ctx.turn),
    },
  ];

  for (let i = 0; i < approvalCount; i++) {
    events.push({
      type: 'session.tool_call',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolCall(ctx.turn, 'git_push'),
    });
    events.push({
      type: 'session.approval_required',
      delayMs: delay,
      payloadFactory: (ctx) => sampleApprovalRequired(i, ctx),
    });
    events.push({
      type: 'session.approval_granted',
      delayMs: delay * 3,
      payloadFactory: (ctx) => sampleApprovalDecision(i, true, ctx),
    });
    events.push({
      type: 'session.tool_result',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolResult(ctx.turn),
    });
  }

  events.push({
    type: 'session.file_changed',
    delayMs: delay,
    payloadFactory: () => sampleFileChanged(0),
  });
  events.push({
    type: 'session.completed',
    delayMs: delay,
    payloadFactory: (ctx) => sampleCompleted(ctx),
  });

  return events;
}

export function buildFailedScenario(config: ScenarioConfig): ScenarioEventTemplate[] {
  const delay = config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs;
  return [
    { type: 'session.started', delayMs: delay },
    { type: 'session.thinking', delayMs: delay, payloadFactory: () => sampleThinking('planning') },
    {
      type: 'session.message',
      delayMs: delay,
      payloadFactory: (ctx) => sampleAssistantMessage(ctx.turn),
    },
    {
      type: 'session.tool_call',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolCall(ctx.turn),
    },
    {
      type: 'session.tool_error',
      delayMs: delay,
      payloadFactory: (ctx) => ({
        toolCallId: `call_${ctx.sessionId.slice(-6)}_${ctx.eventIndex}`,
        toolName: 'write_file',
        success: false,
        error: 'Permission denied: cannot write to /etc/passwd',
        durationMs: 12,
      }),
    },
    {
      type: 'session.failed',
      delayMs: delay,
      payloadFactory: (ctx): SessionFailedPayload => ({
        errorCode: 'EACCES',
        errorMessage: 'Tool execution failed: Permission denied',
        fatal: true,
        durationMs: (ctx.eventIndex + 1) * (delay + 50),
      }),
    },
  ];
}

export function buildCancelledScenario(config: ScenarioConfig): ScenarioEventTemplate[] {
  const delay = config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs;
  return [
    { type: 'session.started', delayMs: delay },
    { type: 'session.thinking', delayMs: delay, payloadFactory: () => sampleThinking('planning') },
    {
      type: 'session.message',
      delayMs: delay,
      payloadFactory: (ctx) => sampleAssistantMessage(ctx.turn),
    },
    {
      type: 'session.cancelled',
      delayMs: delay,
      payloadFactory: () => ({
        reason: 'User requested cancellation',
        cancelledBy: 'user',
        cancelledAt: new Date(),
      }),
    },
  ];
}

export function buildLongTaskScenario(config: ScenarioConfig): ScenarioEventTemplate[] {
  const delay = config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs;
  const messageCount = config.messageCount ?? 10;
  const toolCount = config.toolCallCount ?? 5;
  const fileCount = config.fileChangeCount ?? 3;

  const events: ScenarioEventTemplate[] = [
    { type: 'session.started', delayMs: delay },
    {
      type: 'session.thinking',
      delayMs: delay,
      payloadFactory: () => sampleThinking('planning', 10),
    },
  ];

  for (let i = 0; i < messageCount; i++) {
    if (i % 2 === 0) {
      events.push({
        type: 'session.thinking',
        delayMs: delay,
        payloadFactory: () =>
          sampleThinking(i % 2 === 0 ? 'analyzing' : 'executing', (i / messageCount) * 100),
      });
    }
    events.push({
      type: 'session.output',
      delayMs: Math.round(delay / 3),
      payloadFactory: (_ctx): Record<string, unknown> => ({
        stream: 'stdout',
        content: `[${new Date().toISOString()}] Processing step ${i + 1}/${messageCount}...\n`,
        timestamp: new Date(),
      }),
    });
    if (i < toolCount) {
      events.push({
        type: 'session.tool_call',
        delayMs: delay,
        payloadFactory: (ctx) => sampleToolCall(ctx.turn),
      });
      events.push({
        type: 'session.tool_result',
        delayMs: delay,
        payloadFactory: (ctx) => sampleToolResult(ctx.turn),
      });
    }
    if (i < fileCount) {
      events.push({
        type: 'session.file_changed',
        delayMs: delay,
        payloadFactory: () => sampleFileChanged(i),
      });
    }
  }

  events.push({
    type: 'session.completed',
    delayMs: delay,
    payloadFactory: (ctx) => sampleCompleted(ctx),
  });

  return events;
}

export function buildMultiTurnScenario(config: ScenarioConfig): ScenarioEventTemplate[] {
  const delay = config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs;
  return [
    { type: 'session.started', delayMs: delay },
    { type: 'session.thinking', delayMs: delay, payloadFactory: () => sampleThinking('planning') },
    {
      type: 'session.message',
      delayMs: delay,
      payloadFactory: () =>
        sampleAssistantMessageCustom(
          'I will create a calculator module. Would you like unit tests included?',
        ),
    },
    {
      type: 'session.message',
      delayMs: delay,
      payloadFactory: (): SessionMessagePayload => ({
        role: 'user',
        content: 'Yes, please add comprehensive tests with at least 80% coverage.',
        turnNumber: 1,
      }),
    },
    {
      type: 'session.thinking',
      delayMs: delay,
      payloadFactory: () => sampleThinking('deciding', 30),
    },
    {
      type: 'session.message',
      delayMs: delay,
      payloadFactory: () =>
        sampleAssistantMessageCustom(
          'Understood. Creating calculator.ts with add/subtract/multiply/divide plus Vitest tests.',
        ),
    },
    {
      type: 'session.tool_call',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolCall(ctx.turn, 'write_file'),
    },
    {
      type: 'session.tool_result',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolResult(ctx.turn),
    },
    { type: 'session.file_changed', delayMs: delay, payloadFactory: () => sampleFileChanged(0) },
    {
      type: 'session.tool_call',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolCall(ctx.turn, 'write_file'),
    },
    {
      type: 'session.tool_result',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolResult(ctx.turn),
    },
    { type: 'session.file_changed', delayMs: delay, payloadFactory: () => sampleFileChanged(1) },
    {
      type: 'session.tool_call',
      delayMs: delay,
      payloadFactory: (ctx) => sampleToolCall(ctx.turn, 'bash_exec'),
    },
    {
      type: 'session.tool_result',
      delayMs: delay,
      payloadFactory: (ctx) => ({
        ...sampleToolResult(ctx.turn),
        output: {
          exitCode: 0,
          stdout: 'Test Files 2 passed (2)\nTests 8 passed (8)\n',
          stderr: '',
        },
      }),
    },
    {
      type: 'session.message',
      delayMs: delay,
      payloadFactory: () =>
        sampleAssistantMessageCustom(
          'All done! Created calculator.ts, calculator.test.ts. 8 tests passing with 100% coverage.',
        ),
    },
    {
      type: 'session.completed',
      delayMs: delay,
      payloadFactory: (ctx) => sampleCompleted(ctx, 4),
    },
  ];
}

export function buildScenario(config: ScenarioConfig): ScenarioEventTemplate[] {
  switch (config.scenario) {
    case 'simple':
      return buildSimpleScenario(config);
    case 'with_approval':
      return buildApprovalScenario(config);
    case 'failed':
      return buildFailedScenario(config);
    case 'cancelled':
      return buildCancelledScenario(config);
    case 'long_task':
      return buildLongTaskScenario(config);
    case 'multi_turn':
      return buildMultiTurnScenario(config);
    case 'crash_midway': {
      const base = buildSimpleScenario(config);
      const crashAt = config.crashAtEvent ?? Math.floor(base.length / 2);
      return base.slice(0, crashAt);
    }
    case 'thinking_only':
      return [
        { type: 'session.started' },
        ...Array.from({ length: 20 }, (_, i) => ({
          type: 'session.thinking' as EventType,
          delayMs: config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs,
          payloadFactory: () =>
            sampleThinking(i % 2 === 0 ? 'planning' : 'reflecting', (i / 20) * 100),
        })),
        { type: 'session.completed', payloadFactory: (ctx) => sampleCompleted(ctx) },
      ];
    case 'file_edits': {
      const delay = config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs;
      const count = config.fileChangeCount ?? 6;
      const evts: ScenarioEventTemplate[] = [{ type: 'session.started', delayMs: delay }];
      for (let i = 0; i < count; i++) {
        evts.push({
          type: 'session.file_changed',
          delayMs: delay,
          payloadFactory: () => sampleFileChanged(i),
        });
      }
      evts.push({
        type: 'session.completed',
        delayMs: delay,
        payloadFactory: (ctx) => sampleCompleted(ctx),
      });
      return evts;
    }
    case 'approvals_chain': {
      return buildApprovalScenario({ ...config, approvalCount: config.approvalCount ?? 4 });
    }
    default:
      return buildSimpleScenario(config);
  }
}

export function listScenarios(): Array<{
  name: ScenarioName;
  description: string;
  estimatedDurationMs: number;
}> {
  return [
    {
      name: 'simple',
      description: 'Basic task: message → tool calls → file changes → completed',
      estimatedDurationMs: 1800,
    },
    {
      name: 'with_approval',
      description: 'Requires approval before a protected tool can execute',
      estimatedDurationMs: 2500,
    },
    {
      name: 'failed',
      description: 'Fails at tool execution with permission error',
      estimatedDurationMs: 900,
    },
    { name: 'cancelled', description: 'Cancelled by user mid-execution', estimatedDurationMs: 600 },
    {
      name: 'long_task',
      description: 'Long-running task with many outputs, tools, and file ops',
      estimatedDurationMs: 8000,
    },
    {
      name: 'multi_turn',
      description: 'Multi-turn conversation with user input and responses',
      estimatedDurationMs: 3500,
    },
    {
      name: 'crash_midway',
      description: 'Process crashes midway through the event sequence',
      estimatedDurationMs: 1200,
    },
    {
      name: 'thinking_only',
      description: 'Emits 20 thinking events without tool calls',
      estimatedDurationMs: 3200,
    },
    {
      name: 'file_edits',
      description: 'Multiple file changes without other operations',
      estimatedDurationMs: 1500,
    },
    {
      name: 'approvals_chain',
      description: 'Chain of multiple approval decisions',
      estimatedDurationMs: 4500,
    },
  ];
}

function sampleThinking(
  phase: 'planning' | 'analyzing' | 'reflecting' | 'deciding' | 'executing',
  progress?: number,
): SessionThinkingPayload {
  const contents: Record<string, string> = {
    planning: 'Analyzing request and breaking into sub-tasks...',
    analyzing: 'Reviewing project structure and existing code patterns...',
    reflecting: 'Checking consistency and edge cases...',
    deciding: 'Choosing best approach from alternatives...',
    executing: 'Executing plan and generating artifacts...',
  };
  const payload: SessionThinkingPayload = {
    phase,
  };
  if (contents[phase] !== undefined) {
    payload.content = contents[phase];
  } else {
    payload.content = 'Thinking...';
  }
  if (progress !== undefined) {
    payload.progress = progress;
    payload.estimatedRemainingMs = Math.round(1000 * (100 - progress));
  }
  return payload;
}

function sampleAssistantMessage(turn: number): SessionMessagePayload {
  const messages = [
    'I will analyze your request and create a plan to implement it.',
    'Now implementing the first component with appropriate type safety.',
    'Adding unit tests to validate the implementation...',
    'Running tests and verifying everything works correctly.',
    'All tasks completed successfully. Here is a summary of changes.',
  ];
  return {
    role: 'assistant',
    content: messages[turn % messages.length]!,
    turnNumber: turn,
  };
}

function sampleAssistantMessageCustom(content: string): SessionMessagePayload {
  return { role: 'assistant', content };
}

function sampleToolCall(turn: number, overrideName?: string): ToolCallPayload {
  const tools = ['write_file', 'read_file', 'bash_exec', 'search_codebase', 'edit_file'];
  const toolName = overrideName ?? tools[turn % tools.length]!;
  return {
    toolCallId: `call_${Date.now().toString(36)}_${turn}`,
    toolName,
    arguments: {
      path: toolName.includes('file') ? sampleFiles[turn % sampleFiles.length]! : undefined,
      command: toolName === 'bash_exec' ? `npm run build --if-present 2>&1 | head -20` : undefined,
      query: toolName === 'search_codebase' ? 'calculator utilities' : undefined,
      content:
        toolName === 'write_file'
          ? sampleDiffs.calculator
              ?.split('@@')[0]
              ?.replace(/^diff.*$/gm, '')
              .trim()
          : undefined,
    },
    timestamp: new Date(),
  };
}

function sampleToolResult(turn: number): ToolResultPayload {
  const outputs = [
    'File written successfully (452 bytes)',
    'File contents: export const foo = "bar"',
    { exitCode: 0, stdout: 'build successful\n', stderr: '' },
    '3 matches across 2 files',
    'File updated (3 lines added, 1 removed)',
  ];
  return {
    toolCallId: `call_${Date.now().toString(36)}_${turn}`,
    toolName: 'write_file',
    success: true,
    output: outputs[turn % outputs.length],
    durationMs: 25 + (turn % 10) * 5,
  };
}

function sampleFileChanged(index: number): FileChangedPayload {
  const keys = Object.keys(sampleDiffs);
  const key = keys[index % keys.length]!;
  const path =
    key === 'calculator' ? 'calculator.ts' : key === 'test' ? 'calculator.test.ts' : 'README.md';
  const actions: Array<FileChangedPayload['action']> = ['created', 'modified', 'deleted'];
  const payload: FileChangedPayload = {
    path,
    action: index === 0 ? 'created' : actions[index % actions.length]!,
    sizeBytes: 300 + index * 150,
    timestamp: new Date(),
  };
  const diff = sampleDiffs[key];
  if (diff !== undefined) {
    payload.diff = diff;
  }
  return payload;
}

function sampleApprovalRequired(index: number, ctx: ScenarioContext): ApprovalRequiredPayload {
  const items = [
    {
      action: 'git_push',
      desc: 'Push changes to remote repository',
      risk: 'high' as const,
      scope: 'git:push',
    },
    {
      action: 'npm_install',
      desc: 'Install external npm packages',
      risk: 'medium' as const,
      scope: 'filesystem:write',
    },
    {
      action: 'bash_exec',
      desc: 'Execute shell command: sudo systemctl restart',
      risk: 'critical' as const,
      scope: 'system:admin',
    },
    {
      action: 'env_read',
      desc: 'Read environment variable: AWS_SECRET_ACCESS_KEY',
      risk: 'high' as const,
      scope: 'secrets:read',
    },
  ];
  const item = items[index % items.length]!;
  const payload: ApprovalRequiredPayload = {
    approvalId: `appr_${ctx.sessionId.slice(-6)}_${index}`,
    action: item.action,
    description: item.desc,
    riskLevel: item.risk,
    scope: item.scope,
    requiresReason: item.risk === 'critical',
    timeoutMs: 600000,
    requestedAt: new Date(),
  };
  if (item.scope.includes('git')) {
    payload.affectedResources = ['origin/main'];
  }
  return payload;
}

function sampleApprovalDecision(index: number, approved: boolean, ctx: ScenarioContext) {
  return {
    approvalId: `appr_${ctx.sessionId.slice(-6)}_${index}`,
    decision: approved ? ('granted' as const) : ('denied' as const),
    decidedAt: new Date(),
    decidedBy: 'user',
    reason: approved ? 'Approved via API' : 'Denied by user',
  };
}

function sampleCompleted(ctx: ScenarioContext, turnsOverride?: number): SessionCompletedPayload {
  const turns = turnsOverride ?? Math.max(1, ctx.turn);
  const duration =
    ctx.totalEvents * ((ctx.config.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs) + 30);
  return {
    exitCode: 0,
    signal: null,
    durationMs: duration,
    summary: `Completed ${ctx.config.scenario} scenario successfully.`,
    turnsCompleted: turns,
    metrics: {
      inputTokens: 320 + turns * 40,
      outputTokens: 540 + turns * 80,
      totalTokens: 860 + turns * 120,
      toolCalls: Math.min(ctx.config.toolCallCount ?? DEFAULT_SCENARIO_CONFIG.toolCallCount, turns),
      fileOperations: Math.min(
        ctx.config.fileChangeCount ?? DEFAULT_SCENARIO_CONFIG.fileChangeCount,
        turns,
      ),
      approvalsRequested:
        ctx.config.approvalCount ?? (ctx.config.scenario === 'with_approval' ? 1 : 0),
      approvalsGranted:
        ctx.config.scenario === 'with_approval' ? (ctx.config.approvalCount ?? 1) : 0,
      approvalsDenied: 0,
      cacheHits: 0,
      cacheMisses: 0,
      latencyP50Ms: 140,
      latencyP95Ms: 310,
    },
  };
}
