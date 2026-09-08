import type { EventEnvelope, SessionConfig } from '@freebuff/protocol';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { createMockAdapter, type MockAdapter } from '../src/mock-adapter';

/**
 * Poll until `check` returns true, or fail the test when it never does.
 *
 * Replaces `new Promise(resolve => setInterval(async () => ...))`. setInterval
 * discards the promise an async callback returns, so a throw inside the poll
 * was swallowed and the test hung until the suite timeout instead of failing
 * with the real error. A condition that never becomes true now fails loudly
 * rather than hanging.
 */
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Poll until the session reaches a terminal state.
 *
 * Replaces `new Promise(resolve => setInterval(async () => ...))`, where the
 * async callback's rejection was discarded by setInterval: a throw from
 * getState hung the test until the suite timeout instead of failing it.
 */
async function waitForTerminalState(
  adapter: MockAdapter,
  sessionId: string,
  stream: { unsubscribe(): void },
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const state = await adapter.getState(sessionId);
      if (state === 'completed' || state === 'failed' || state === 'cancelled') return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Session ${sessionId} did not reach a terminal state in ${timeoutMs}ms`);
  } finally {
    stream.unsubscribe();
  }
}

describe('MockAdapter', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  test('metadata returns expected values', () => {
    const meta = adapter.metadata();
    expect(meta.id).toBe('mock');
    expect(meta.name).toBe('Mock Agent');
    expect(meta.capabilities.sessionCreation).toBe('supported');
    expect(meta.capabilities.approvalInterception).toBe('supported');
    expect(meta.platform).toEqual(expect.arrayContaining(['linux', 'darwin', 'win32']));
  });

  test('installOrDetect always succeeds', async () => {
    const result = await adapter.installOrDetect();
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBe('1.0.0');
  });

  test('validateEnvironment passes', async () => {
    const result = await adapter.validateEnvironment();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('startSession creates session with simple scenario', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      prompt: 'Hello',
    };
    const sessionId = await adapter.startSession(config);
    expect(sessionId).toMatch(/^sess_[a-f0-9]{24}$/);

    const session = await adapter.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.adapterId).toBe('mock');
    expect(session!.startTime).toBeInstanceOf(Date);
  });

  test('scenario events include started, tool calls, and completed', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: {
        scenario: 'simple',
        messageCount: 1,
        toolCallCount: 1,
        fileChangeCount: 1,
      },
    };
    const sessionId = await adapter.startSession(config);
    const events: EventEnvelope[] = [];

    const stream = adapter.streamEvents(sessionId, {
      onEvent: (e) => events.push(e),
    });

    await waitForTerminalState(adapter, sessionId, stream);

    const types = events.map((e) => e.eventType);
    expect(types).toContain('session.started');
    expect(types).toContain('session.tool_call');
    expect(types).toContain('session.tool_result');
    expect(types).toContain('session.file_changed');
    expect(types).toContain('session.completed');
  });

  test('failed scenario results in failed state', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: { scenario: 'failed' },
    };
    const sessionId = await adapter.startSession(config);

    await waitUntil(async () => {
      const state = await adapter.getState(sessionId);
      return state !== 'running' && state !== 'initializing';
    });

    const finalState = await adapter.getState(sessionId);
    expect(finalState).toBe('failed');
  });

  test('cancelled scenario results in cancelled state', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: { scenario: 'cancelled' },
    };
    const sessionId = await adapter.startSession(config);

    await waitUntil(async () => {
      const state = await adapter.getState(sessionId);
      return state !== 'running' && state !== 'initializing';
    });

    expect(await adapter.getState(sessionId)).toBe('cancelled');
  });

  test('abortSession cancels running session', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: {
        scenario: 'long_task',
        messageCount: 20,
        toolCallCount: 10,
      },
    };
    const sessionId = await adapter.startSession(config);
    await new Promise((r) => setTimeout(r, 200));

    await adapter.abortSession(sessionId, 'test abort', true);

    await waitUntil(async () => {
      const state = await adapter.getState(sessionId);
      return state === 'cancelled' || state === 'completed';
    });

    expect(await adapter.getState(sessionId)).toBe('cancelled');
  });

  test('collectDiff returns formatted diff', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
    };
    const sessionId = await adapter.startSession(config);
    const diff = await adapter.collectDiff(sessionId);
    expect(diff).toContain('diff --git');
    expect(diff).toContain('Mock Session');
  });

  test('submitApprovalDecision resolves approval flow', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: { scenario: 'with_approval', approvalCount: 1 },
    };
    const sessionId = await adapter.startSession(config);
    const approvalEvents: EventEnvelope[] = [];

    adapter.streamEvents(sessionId, {
      onEvent: (e) => {
        if (e.eventType === 'session.approval_required') approvalEvents.push(e);
      },
    });

    await waitUntil(() => approvalEvents.length > 0);

    const approvalPayload = approvalEvents[0]!.payload as { approvalId: string };
    expect(approvalPayload.approvalId).toBeDefined();
    await adapter.submitApprovalDecision(
      sessionId,
      approvalPayload.approvalId,
      true,
      'test approval',
    );

    await waitUntil(async () => {
      const state = await adapter.getState(sessionId);
      return state === 'completed';
    });
  });

  test('pauseSession and resumeSession work', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: { scenario: 'long_task', messageCount: 10, toolCallCount: 5 },
    };
    const sessionId = await adapter.startSession(config);
    await new Promise((r) => setTimeout(r, 200));

    await adapter.pauseSession(sessionId);
    expect(await adapter.getState(sessionId)).toBe('paused');
    await new Promise((r) => setTimeout(r, 300));

    await adapter.resumeSession(sessionId);
    expect(['running', 'completed', 'failed', 'cancelled']).toContain(
      await adapter.getState(sessionId),
    );
  });

  test('checkpointSession creates checkpoint event', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: { scenario: 'simple' },
    };
    const sessionId = await adapter.startSession(config);
    await new Promise((r) => setTimeout(r, 200));
    const chkId = await adapter.checkpointSession(sessionId);
    expect(chkId).toMatch(/^chk_/);
  });

  test('listScenarios returns all scenario names', () => {
    const scenarios = adapter.listScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
    const names = scenarios.map((s) => s.name);
    expect(names).toContain('simple');
    expect(names).toContain('with_approval');
    expect(names).toContain('failed');
    expect(names).toContain('cancelled');
    expect(names).toContain('long_task');
  });

  test('cleanupSession removes session from registry', async () => {
    const config: SessionConfig = {
      projectRoot: '/tmp/test',
      adapter: 'mock',
      metadata: { scenario: 'simple' },
    };
    const sessionId = await adapter.startSession(config);
    expect(await adapter.getSession(sessionId)).toBeDefined();
    await adapter.cleanupSession(sessionId);
    expect(await adapter.getSession(sessionId)).toBeUndefined();
  });
});
