/**
 * GatewayRuntime — the supervisor that owns the gateway process lifecycle.
 *
 * `GatewayImpl` is a library: it can do everything and starts nothing. This is
 * the thing that decides when it starts, what happens when a subsystem fails,
 * and how the process ends. Every state transition is observable and the exit
 * code is derived from the state the process died in, so a supervisor
 * (systemd, Docker, a shell loop) can tell "retry me" from "a human must fix
 * this" without parsing logs.
 *
 * The restart-intensity idea is borrowed from Erlang/OTP supervisors: a child
 * that fails more than `maxRestarts` times within `restartWindowMs` escalates
 * to the parent instead of restarting forever. Without that bound, automatic
 * reconnect degenerates into an invisible crash loop.
 */
import type { GatewayImpl } from '../gateway';

import { ExitCode, type ExitCodeValue } from './exit-codes';
import type { Logger } from './logger';
import { createNullLogger } from './logger';
import { runPreflight, type PreflightCheck, type PreflightReport } from './preflight';

export type RuntimeState =
  | 'starting'
  | 'preflight'
  | 'local_ready'
  | 'connecting'
  | 'online'
  | 'degraded'
  | 'draining'
  | 'aborting'
  | 'stopped'
  | 'fatal';

export interface RuntimeStateChange {
  from: RuntimeState;
  to: RuntimeState;
  reason?: string | undefined;
  at: Date;
}

/**
 * How a failure should be treated. Mirrors the failure taxonomy: only some
 * failures are worth retrying, and retrying the others produces a crash loop
 * that buries the cause.
 */
export type FailureClass =
  | 'transient' // network blip — retry with backoff, unbounded
  | 'auth_retryable' // pairing pending — retry slowly, a human must act
  | 'auth_fatal' // revoked — stop, never retry
  | 'protocol' // version mismatch — stop
  | 'config' // bad configuration — stop
  | 'internal'; // a bug

const FAILURE_EXIT: Record<FailureClass, ExitCodeValue> = {
  transient: ExitCode.TEMPFAIL,
  auth_retryable: ExitCode.TEMPFAIL,
  auth_fatal: ExitCode.NOPERM,
  protocol: ExitCode.PROTOCOL,
  config: ExitCode.CONFIG,
  internal: ExitCode.SOFTWARE,
};

export interface RestartPolicy {
  /** Failures tolerated inside the window before escalating to fatal. */
  maxRestarts: number;
  restartWindowMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestarts: 10,
  restartWindowMs: 60_000,
};

export interface GatewayRuntimeOptions {
  gateway: GatewayImpl;
  logger?: Logger;
  preflightChecks?: PreflightCheck[];
  /** Dials the Control Plane. Absent means local-only operation. */
  connect?: () => Promise<void>;
  /** How long in-flight sessions get after SIGTERM. */
  drainBudgetMs?: number;
  /** Extra time after sessions end to flush logs, diffs and audit events. */
  cleanupBudgetMs?: number;
  /** Window in which a second SIGINT escalates to a forceful stop. */
  doubleSignalWindowMs?: number;
  restartPolicy?: RestartPolicy;
  /** Injectable for tests. */
  exit?: (code: number) => void;
  /** Injectable for tests. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

const TERMINAL_STATES: ReadonlySet<RuntimeState> = new Set<RuntimeState>(['stopped', 'fatal']);

export class GatewayRuntime {
  private readonly gateway: GatewayImpl;
  private readonly log: Logger;
  private readonly preflightChecks: PreflightCheck[];
  private readonly connectFn: (() => Promise<void>) | undefined;
  private readonly drainBudgetMs: number;
  private readonly cleanupBudgetMs: number;
  private readonly doubleSignalWindowMs: number;
  private readonly restartPolicy: RestartPolicy;
  private readonly exitFn: (code: number) => void;
  private readonly onSignalFn: (signal: NodeJS.Signals, handler: () => void) => void;

  private _state: RuntimeState = 'starting';
  private readonly stateListeners = new Set<(change: RuntimeStateChange) => void>();
  private failureTimestamps: number[] = [];
  private stopping = false;
  private lastInterruptAt = 0;
  private exitCode: ExitCodeValue = ExitCode.OK;

  constructor(options: GatewayRuntimeOptions) {
    this.gateway = options.gateway;
    this.log = options.logger ?? createNullLogger();
    this.preflightChecks = options.preflightChecks ?? [];
    this.connectFn = options.connect;
    this.drainBudgetMs = options.drainBudgetMs ?? 120_000;
    this.cleanupBudgetMs = options.cleanupBudgetMs ?? 5_000;
    this.doubleSignalWindowMs = options.doubleSignalWindowMs ?? 5_000;
    this.restartPolicy = options.restartPolicy ?? DEFAULT_RESTART_POLICY;
    this.exitFn = options.exit ?? ((code: number) => process.exit(code));
    this.onSignalFn =
      options.onSignal ??
      ((signal, handler) => {
        process.on(signal, handler);
      });
  }

  get state(): RuntimeState {
    return this._state;
  }

  onStateChange(listener: (change: RuntimeStateChange) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(to: RuntimeState, reason?: string): void {
    if (this._state === to) return;
    if (TERMINAL_STATES.has(this._state)) return;

    const change: RuntimeStateChange = { from: this._state, to, reason, at: new Date() };
    this._state = to;
    this.log.info('runtime.state_change', {
      from: change.from,
      to: change.to,
      ...(reason ? { reason } : {}),
    });
    for (const listener of this.stateListeners) {
      try {
        listener(change);
      } catch (err) {
        this.log.warn('runtime.listener_error', { error: err as Error });
      }
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Boot the gateway: preflight, become locally usable, then dial the Control
   * Plane. Resolves once the process is in a steady state; it does not block
   * until shutdown.
   */
  async start(): Promise<void> {
    this.installSignalHandlers();

    this.setState('preflight');
    const report = await runPreflight(this.preflightChecks, this.log);
    this.reportPreflight(report);
    if (!report.ok) {
      return this.fatal('config', `${report.failures.length} preflight check(s) failed`);
    }

    // Local readiness comes before the tunnel on purpose: a gateway that
    // cannot reach the cloud is still useful for local sessions, and saying so
    // explicitly is better than conflating "no tunnel" with "not working".
    this.setState('local_ready');

    if (!this.connectFn) {
      this.log.warn('runtime.local_only', {
        detail: 'No Control Plane configured; remote control is unavailable',
      });
      this.setState('degraded', 'no control plane configured');
      return;
    }

    this.setState('connecting');
    try {
      await this.connectFn();
      this.setState('online');
    } catch (err) {
      // A failed first dial is not fatal by itself — the tunnel client retries.
      this.log.warn('runtime.initial_connect_failed', { error: err as Error });
      this.setState('degraded', 'initial connect failed');
      this.recordFailure('transient', err);
    }
  }

  private reportPreflight(report: PreflightReport): void {
    for (const result of report.results) {
      if (result.status === 'pass') continue;
      const line = `${result.name}: ${result.message}`;
      if (result.status === 'fail') {
        this.log.error('preflight.failed', { check: result.name, detail: line, remedy: result.remedy });
      } else {
        this.log.warn('preflight.warning', { check: result.name, detail: line, remedy: result.remedy });
      }
    }
  }

  /** Called by the tunnel wiring when the connection is established or lost. */
  notifyTunnelConnected(): void {
    if (this._state === 'connecting' || this._state === 'degraded') {
      this.setState('online', 'tunnel connected');
    }
  }

  notifyTunnelLost(reason?: string): void {
    if (this._state === 'online' || this._state === 'connecting') {
      this.setState('degraded', reason ?? 'tunnel lost');
    }
  }

  /**
   * Record a subsystem failure. Applies the OTP restart-intensity rule: too
   * many failures inside the window escalates to fatal rather than retrying
   * forever.
   */
  recordFailure(failureClass: FailureClass, error?: unknown): void {
    const message = error instanceof Error ? error.message : error ? String(error) : undefined;
    this.log.warn('runtime.failure', {
      class: failureClass,
      ...(message ? { detail: message } : {}),
    });

    // Non-retryable classes escalate on the first occurrence.
    if (
      failureClass === 'auth_fatal' ||
      failureClass === 'protocol' ||
      failureClass === 'config'
    ) {
      void this.fatal(failureClass, message ?? `${failureClass} failure`);
      return;
    }

    const now = Date.now();
    this.failureTimestamps = this.failureTimestamps.filter(
      (ts) => now - ts < this.restartPolicy.restartWindowMs,
    );
    this.failureTimestamps.push(now);

    if (this.failureTimestamps.length > this.restartPolicy.maxRestarts) {
      void this.fatal(
        'transient',
        `restart intensity exceeded: ${this.failureTimestamps.length} failures in ` +
          `${this.restartPolicy.restartWindowMs}ms`,
      );
    }
  }

  // -------------------------------------------------------------- shutdown

  /**
   * Graceful stop: close admission, let in-flight sessions finish inside the
   * drain budget, then tear down. The tunnel stays up for the whole drain so
   * the final events of those sessions still reach the Control Plane.
   */
  async stop(reason = 'stop requested'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const active = this.gateway.getActiveSessionCount();
    this.setState('draining', reason);
    this.log.info('runtime.draining', { activeSessions: active, budgetMs: this.drainBudgetMs });

    const result = await this.gateway.drain(this.drainBudgetMs);
    if (result.drained) {
      this.log.info('runtime.drained', { waitedMs: result.waitedMs });
    } else {
      this.log.warn('runtime.drain_timeout', {
        remaining: result.remaining,
        waitedMs: result.waitedMs,
        detail: 'Drain budget expired; aborting remaining sessions',
      });
      this.setState('aborting', 'drain budget expired');
      this.gateway.beginAborting();
    }

    await this.teardown(result.drained);
    this.setState('stopped', reason);
    this.finish(ExitCode.OK);
  }

  /** Forceful stop: abort in-flight sessions now, but still flush final events. */
  async abort(reason = 'abort requested'): Promise<void> {
    if (this.stopping && this._state === 'aborting') return;
    this.stopping = true;

    const active = this.gateway.getActiveSessionCount();
    this.setState('aborting', reason);
    this.gateway.beginAborting();
    this.log.warn('runtime.aborting', { activeSessions: active, reason });

    await this.teardown(false);
    this.setState('stopped', reason);
    this.finish(ExitCode.OK);
  }

  /**
   * Shut the gateway down and give queued events a bounded window to flush.
   *
   * The cleanup budget exists because the last events of a session — the
   * failure, the diff, the audit record — are emitted during teardown and are
   * the most diagnostically valuable ones. Exiting the instant sessions end
   * reliably loses them.
   */
  private async teardown(graceful: boolean): Promise<void> {
    try {
      await this.gateway.shutdown(graceful);
    } catch (err) {
      this.log.error('runtime.shutdown_error', { error: err as Error });
    }

    if (this.cleanupBudgetMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.cleanupBudgetMs));
      this.log.debug('runtime.cleanup_complete', { budgetMs: this.cleanupBudgetMs });
    }
  }

  private async fatal(failureClass: FailureClass, reason: string): Promise<void> {
    const code = FAILURE_EXIT[failureClass];
    this.log.error('runtime.fatal', { class: failureClass, reason, exitCode: code });
    this.setState('fatal', reason);

    if (!this.stopping) {
      this.stopping = true;
      try {
        this.gateway.beginAborting();
        await this.gateway.shutdown(false);
      } catch {
        /* already failing; do not mask the original cause */
      }
    }
    this.finish(code);
  }

  private finish(code: ExitCodeValue): void {
    this.exitCode = code;
    this.exitFn(code);
  }

  getExitCode(): ExitCodeValue {
    return this.exitCode;
  }

  // --------------------------------------------------------------- signals

  /**
   * Signal semantics follow the Buildkite agent's contract, which is the
   * clearest in this category:
   *
   *   SIGTERM — graceful: finish current work, then disconnect
   *   SIGQUIT — forceful: cancel current work and disconnect
   *   SIGINT  — interactive: first press behaves as SIGTERM; a second press
   *             inside the window escalates to SIGQUIT
   *
   * The double-Ctrl+C escalation matters because the human at the terminal is
   * the only one who knows whether the agent's half-finished work is worth
   * waiting for. Killing it silently is data loss wearing a UX costume.
   */
  private installSignalHandlers(): void {
    this.onSignalFn('SIGTERM', () => {
      this.log.info('runtime.signal', { signal: 'SIGTERM', action: 'graceful stop' });
      void this.stop('SIGTERM');
    });

    this.onSignalFn('SIGQUIT', () => {
      this.log.info('runtime.signal', { signal: 'SIGQUIT', action: 'forceful abort' });
      void this.abort('SIGQUIT');
    });

    this.onSignalFn('SIGINT', () => {
      const now = Date.now();
      const isSecondPress = now - this.lastInterruptAt < this.doubleSignalWindowMs;
      this.lastInterruptAt = now;

      if (isSecondPress) {
        this.log.warn('runtime.signal', { signal: 'SIGINT', action: 'escalating to abort' });
        void this.abort('SIGINT (second press)');
        return;
      }

      const active = this.gateway.getActiveSessionCount();
      if (active > 0) {
        this.log.info('runtime.signal', {
          signal: 'SIGINT',
          action: 'graceful stop',
          activeSessions: active,
          hint: `press Ctrl+C again within ${Math.round(
            this.doubleSignalWindowMs / 1000,
          )}s to abort ${active} running session(s)`,
        });
      } else {
        this.log.info('runtime.signal', { signal: 'SIGINT', action: 'graceful stop' });
      }
      void this.stop('SIGINT');
    });
  }
}

export function createGatewayRuntime(options: GatewayRuntimeOptions): GatewayRuntime {
  return new GatewayRuntime(options);
}
