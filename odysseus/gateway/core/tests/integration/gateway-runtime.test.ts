import type { GatewayOptions, SessionConfig } from '@odysseus/protocol';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { createGateway, type GatewayImpl } from '../../src/gateway';
import { SessionAdmissionError } from '../../src/runtime/admission';
import { ExitCode } from '../../src/runtime/exit-codes';
import { createLogger } from '../../src/runtime/logger';
import {
  createGatewayRuntime,
  type GatewayRuntime,
  type RuntimeState,
} from '../../src/runtime/gateway-runtime';
import { nodeVersionCheck, runPreflight, type PreflightCheck } from '../../src/runtime/preflight';

const BASE_OPTIONS: GatewayOptions = {
  sandboxEnabled: false,
  apiServer: { enabled: false },
  logLevel: 'error',
};

function sessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    adapter: 'mock',
    projectRoot: process.cwd(),
    prompt: 'runtime lifecycle test',
    ...overrides,
  } as SessionConfig;
}

/** Collects signal handlers so tests can fire them deterministically. */
function makeSignalHarness() {
  const handlers = new Map<NodeJS.Signals, () => void>();
  return {
    onSignal: (signal: NodeJS.Signals, handler: () => void) => {
      handlers.set(signal, handler);
    },
    fire: (signal: NodeJS.Signals) => {
      const handler = handlers.get(signal);
      if (!handler) throw new Error(`No handler installed for ${signal}`);
      handler();
    },
  };
}

describe('GatewayRuntime lifecycle', () => {
  let gateway: GatewayImpl;
  let runtime: GatewayRuntime | undefined;
  let exitCodes: number[];
  let states: RuntimeState[];

  beforeEach(() => {
    gateway = createGateway(BASE_OPTIONS);
    exitCodes = [];
    states = [];
    runtime = undefined;
  });

  afterEach(async () => {
    await gateway.shutdown(false, 2000);
  });

  function build(overrides: Partial<Parameters<typeof createGatewayRuntime>[0]> = {}) {
    const harness = makeSignalHarness();
    // Bind to THIS build's array rather than the describe-scope variable. A
    // runtime whose async shutdown outlives its test would otherwise push an
    // exit code into the next test's array.
    const sink = exitCodes;
    const rt = createGatewayRuntime({
      gateway,
      drainBudgetMs: 5_000,
      cleanupBudgetMs: 0,
      exit: (code) => sink.push(code),
      onSignal: harness.onSignal,
      ...overrides,
    });
    rt.onStateChange((change) => states.push(change.to));
    runtime = rt;
    return { runtime: rt, harness };
  }

  test('start with no Control Plane reaches degraded, not online', async () => {
    const { runtime: rt } = build();
    await rt.start();

    expect(states).toContain('preflight');
    expect(states).toContain('local_ready');
    expect(rt.state).toBe('degraded');
    expect(exitCodes).toEqual([]);
  });

  test('start with a Control Plane reaches online', async () => {
    const { runtime: rt } = build({ connect: async () => undefined });
    await rt.start();

    expect(rt.state).toBe('online');
    expect(states).toEqual(['preflight', 'local_ready', 'connecting', 'online']);
  });

  test('a failing preflight check is fatal with EX_CONFIG and never starts the gateway', async () => {
    const failing: PreflightCheck = {
      name: 'always-fails',
      run: async () => ({
        status: 'fail' as const,
        message: 'simulated failure',
        remedy: 'fix the thing',
      }),
    };
    const { runtime: rt } = build({ preflightChecks: [failing], connect: async () => undefined });
    await rt.start();

    expect(rt.state).toBe('fatal');
    expect(exitCodes).toEqual([ExitCode.CONFIG]);
    // Never attempted to connect.
    expect(states).not.toContain('connecting');
  });

  test('a failed initial connect degrades rather than dying', async () => {
    const { runtime: rt } = build({
      connect: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await rt.start();

    expect(rt.state).toBe('degraded');
    expect(exitCodes).toEqual([]);
  });

  // --- PR 1 acceptance: SIGTERM with a running session -------------------

  test('SIGTERM lets an in-flight session finish, then exits 0', async () => {
    const { runtime: rt, harness } = build({ connect: async () => undefined });
    await rt.start();

    const session = await gateway.createSession(sessionConfig());
    expect(session.id).toBeTruthy();

    harness.fire('SIGTERM');

    await waitFor(() => rt.state === 'stopped' || rt.state === 'fatal', 15_000);

    expect(rt.state).toBe('stopped');
    expect(states).toContain('draining');
    // The drain completed, so we never escalated to aborting.
    expect(states).not.toContain('aborting');
    expect(exitCodes).toEqual([ExitCode.OK]);
  }, 20_000);

  test('draining refuses new sessions with a retryable admission error', async () => {
    const { runtime: rt } = build({ connect: async () => undefined });
    await rt.start();

    const drainPromise = rt.stop('test drain');
    await waitFor(() => gateway.getAdmissionPhase() !== 'running', 5_000);

    await expect(gateway.createSession(sessionConfig())).rejects.toBeInstanceOf(
      SessionAdmissionError,
    );

    try {
      await gateway.createSession(sessionConfig());
    } catch (err) {
      const admission = err as SessionAdmissionError;
      expect(admission.code).toBe('GATEWAY_NOT_ACCEPTING_SESSIONS');
      expect(admission.retryAfterMs).toBeGreaterThan(0);
    }

    await drainPromise;
  }, 20_000);

  // --- PR 1 acceptance: SIGQUIT aborts but still flushes -----------------

  test('SIGQUIT aborts immediately and still flushes final events', async () => {
    const flushed: string[] = [];
    const { runtime: rt, harness } = build({
      connect: async () => undefined,
      cleanupBudgetMs: 50,
    });
    await rt.start();

    gateway.subscribeToEvents({
      onEvent: (event) => {
        flushed.push(event.eventType);
      },
    });

    await gateway.createSession(sessionConfig());

    harness.fire('SIGQUIT');
    await waitFor(() => rt.state === 'stopped', 15_000);

    expect(rt.state).toBe('stopped');
    expect(states).toContain('aborting');
    expect(exitCodes).toEqual([ExitCode.OK]);
    // Events emitted before/while aborting still reached subscribers.
    expect(flushed.length).toBeGreaterThan(0);
  }, 20_000);

  test('double SIGINT escalates to abort', async () => {
    const { runtime: rt, harness } = build({
      connect: async () => undefined,
      drainBudgetMs: 60_000, // long, so the first press would otherwise hang
    });
    await rt.start();
    await gateway.createSession(sessionConfig());

    harness.fire('SIGINT');
    await waitFor(() => rt.state === 'draining', 5_000);

    harness.fire('SIGINT'); // second press inside the window
    await waitFor(() => rt.state === 'stopped', 15_000);

    expect(states).toContain('aborting');
    expect(exitCodes).toEqual([ExitCode.OK]);
  }, 25_000);

  // --- restart intensity (OTP escalation) --------------------------------

  test('repeated transient failures escalate to fatal EX_TEMPFAIL', async () => {
    const { runtime: rt } = build({
      connect: async () => undefined,
      restartPolicy: { maxRestarts: 3, restartWindowMs: 60_000 },
    });
    await rt.start();

    for (let i = 0; i < 4; i++) rt.recordFailure('transient', new Error(`blip ${i}`));

    // The state flips synchronously; the exit happens after teardown, which is
    // deliberate — the process must not vanish before the gateway is stopped.
    expect(rt.state).toBe('fatal');
    await waitFor(() => exitCodes.length > 0, 10_000);
    expect(exitCodes).toEqual([ExitCode.TEMPFAIL]);
  }, 15_000);

  test('transient failures below the threshold do not escalate', async () => {
    const { runtime: rt } = build({
      connect: async () => undefined,
      restartPolicy: { maxRestarts: 5, restartWindowMs: 60_000 },
    });
    await rt.start();

    for (let i = 0; i < 5; i++) rt.recordFailure('transient', new Error(`blip ${i}`));

    expect(rt.state).toBe('online');
    expect(exitCodes).toEqual([]);
  });

  test('an auth_fatal failure exits 77 on the first occurrence', async () => {
    const { runtime: rt } = build({ connect: async () => undefined });
    await rt.start();

    rt.recordFailure('auth_fatal', new Error('device revoked'));

    expect(rt.state).toBe('fatal');
    await waitFor(() => exitCodes.length > 0, 10_000);
    expect(exitCodes).toEqual([ExitCode.NOPERM]);
  }, 15_000);

  test('a drain escalated to abort exits exactly once', async () => {
    // Regression: stop() waits on drain, abort() escalates past it, and then
    // stop() resumes and called finish() a second time. Two exits meant the
    // reported code was whichever landed last.
    const { runtime: rt, harness } = build({
      connect: async () => undefined,
      drainBudgetMs: 60_000,
      cleanupBudgetMs: 0,
    });
    await rt.start();
    await gateway.createSession(sessionConfig());

    harness.fire('SIGINT');
    await waitFor(() => rt.state === 'draining', 5_000);
    harness.fire('SIGINT');
    await waitFor(() => rt.state === 'stopped', 15_000);

    // Give the superseded stop() a chance to resume and try to exit again.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(exitCodes).toHaveLength(1);
    expect(exitCodes[0]).toBe(ExitCode.OK);
  }, 25_000);

  test('a fatal exit code is not overwritten by a later routine exit', async () => {
    const { runtime: rt } = build({ connect: async () => undefined });
    await rt.start();

    rt.recordFailure('auth_fatal', new Error('device revoked'));
    await waitFor(() => exitCodes.length > 0, 10_000);

    // A stop() arriving afterwards must not replace 77 with 0.
    await rt.stop('late stop');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exitCodes).toEqual([ExitCode.NOPERM]);
    expect(rt.getExitCode()).toBe(ExitCode.NOPERM);
  }, 20_000);

  test('tunnel loss degrades and reconnection restores online', async () => {
    const { runtime: rt } = build({ connect: async () => undefined });
    await rt.start();
    expect(rt.state).toBe('online');

    rt.notifyTunnelLost('socket closed');
    expect(rt.state).toBe('degraded');

    rt.notifyTunnelConnected();
    expect(rt.state).toBe('online');
  });
});

describe('preflight', () => {
  test('node version check passes on a supported runtime', async () => {
    const report = await runPreflight([nodeVersionCheck(18)]);
    expect(report.ok).toBe(true);
  });

  test('a failing check is collected with its remedy', async () => {
    const report = await runPreflight([
      {
        name: 'broken',
        run: async () => ({ status: 'fail' as const, message: 'nope', remedy: 'do the thing' }),
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.remedy).toBe('do the thing');
  });

  test('a check that throws is reported as a failure rather than crashing', async () => {
    const report = await runPreflight([
      {
        name: 'thrower',
        run: async () => {
          throw new Error('kaboom');
        },
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.message).toBe('kaboom');
  });
});

describe('structured logger', () => {
  test('emits one JSON object per line with bindings applied', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', pretty: false, sink: (l) => lines.push(l) });
    log.child({ deviceId: 'dev_123' }).info('tunnel.state_change', { from: 'a', to: 'b' });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record.event).toBe('tunnel.state_change');
    expect(record.deviceId).toBe('dev_123');
    expect(record.level).toBe('info');
    expect(typeof record.ts).toBe('string');
  });

  test('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', pretty: false, sink: (l) => lines.push(l) });
    log.debug('ignored');
    log.info('also.ignored');
    log.warn('kept');
    expect(lines).toHaveLength(1);
  });

  test('unwraps Error values that JSON.stringify would otherwise drop', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', pretty: false, sink: (l) => lines.push(l) });
    log.error('runtime.failure', { error: new Error('boom') });

    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record.error).toBe('boom');
    expect(typeof record.errorStack).toBe('string');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
