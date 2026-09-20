/**
 * Capability enforcement and per-adapter circuit breaking.
 *
 * `AgentCapabilities` already existed and `AgentRouter` already read it, but
 * nothing enforced it. A session could ask for `approvalMode: 'ask'` against an
 * adapter whose `approvalInterception` is `unsupported`; it started happily and
 * the approval silently never fired. In a product whose premise is governed
 * autonomy, an approval that quietly does not happen is a governance failure,
 * not a UX wrinkle.
 *
 * The rule comes from LSP and MCP: a feature that has not been advertised is
 * not available, and asking for it is an error rather than a discovery made at
 * call time.
 *
 * The circuit breaker is the OTP restart-intensity idea applied per adapter —
 * bounded retries with escalation, instead of unbounded retries that look like
 * progress.
 */
import type { AgentCapabilities, CapabilityLevel, SessionConfig } from '@odysseus/protocol';

export type CapabilityName = keyof AgentCapabilities;

/**
 * What `partial` means, per capability.
 *
 * Without this table `partial` just means "we did not decide", and each
 * adapter interprets it differently. Enforcement needs a stated contract.
 */
export const PARTIAL_CAPABILITY_SEMANTICS: Record<CapabilityName, string> = {
  sessionCreation: 'Sessions start, but some configuration fields are ignored.',
  promptDelivery: 'Prompts are delivered, but only between turns — not mid-turn.',
  streaming: 'Output arrives in batches rather than token by token.',
  cancellation: 'Cancellation is requested cooperatively and may not be immediate.',
  diffCollection: 'Diffs cover tracked files only; untracked changes may be missed.',
  approvalInterception:
    'Some actions can be intercepted, but not all; unlisted actions proceed without approval.',
  checkpointRecovery: 'Sessions can resume, but in-flight turn state is lost.',
  multiTurn: 'Multi-turn works within one process lifetime only.',
  fileOperations: 'File edits are supported; renames and deletes may not be reported.',
  toolExecution: 'Tool calls run, but structured results may be unavailable.',
};

export interface CapabilityRequirement {
  capability: CapabilityName;
  /** Lowest acceptable level. */
  minimum: Exclude<CapabilityLevel, 'unsupported'>;
  reason: string;
}

export interface CapabilityViolation {
  capability: CapabilityName;
  required: CapabilityLevel;
  actual: CapabilityLevel;
  reason: string;
}

const LEVEL_RANK: Record<CapabilityLevel, number> = {
  unsupported: 0,
  partial: 1,
  supported: 2,
};

/**
 * Work out what a session configuration actually needs from an adapter.
 *
 * Only requirements implied by the config are returned, so a session that does
 * not ask for approvals is not blocked by an adapter that cannot do them.
 */
export function requirementsForSession(config: SessionConfig): CapabilityRequirement[] {
  const requirements: CapabilityRequirement[] = [
    {
      capability: 'sessionCreation',
      minimum: 'partial',
      reason: 'every session must be creatable',
    },
  ];

  if (config.approvalMode === 'ask') {
    requirements.push({
      capability: 'approvalInterception',
      minimum: 'partial',
      reason:
        "approvalMode 'ask' requires the adapter to intercept actions before they run; " +
        'without it the session would run unsupervised while appearing governed',
    });
  }

  if (config.prompt !== undefined) {
    requirements.push({
      capability: 'promptDelivery',
      minimum: 'partial',
      reason: 'the session was created with a prompt',
    });
  }

  if (config.maxTurns !== undefined && config.maxTurns > 1) {
    requirements.push({
      capability: 'multiTurn',
      minimum: 'partial',
      reason: 'maxTurns > 1 requires multi-turn support',
    });
  }

  if (config.sandbox) {
    requirements.push({
      capability: 'toolExecution',
      minimum: 'partial',
      reason: 'a sandbox is only meaningful when the adapter executes tools',
    });
  }

  return requirements;
}

/** Requirements the adapter cannot meet. Empty means the session may proceed. */
export function findCapabilityViolations(
  capabilities: AgentCapabilities,
  requirements: CapabilityRequirement[],
): CapabilityViolation[] {
  const violations: CapabilityViolation[] = [];
  for (const requirement of requirements) {
    const actual = capabilities[requirement.capability] ?? 'unsupported';
    if (LEVEL_RANK[actual] < LEVEL_RANK[requirement.minimum]) {
      violations.push({
        capability: requirement.capability,
        required: requirement.minimum,
        actual,
        reason: requirement.reason,
      });
    }
  }
  return violations;
}

/** Thrown before a process is started, so nothing has run yet. */
export class CapabilityError extends Error {
  readonly code = 'ADAPTER_CAPABILITY_UNSUPPORTED';
  readonly adapterId: string;
  readonly violations: CapabilityViolation[];

  constructor(adapterId: string, violations: CapabilityViolation[]) {
    const detail = violations
      .map((v) => `${v.capability} is "${v.actual}" but "${v.required}" is required — ${v.reason}`)
      .join('; ');
    super(`Adapter "${adapterId}" cannot satisfy this session: ${detail}`);
    this.name = 'CapabilityError';
    this.adapterId = adapterId;
    this.violations = violations;
  }
}

// -------------------------------------------------------- circuit breaker

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** First cooldown; doubles on each re-open, capped at maxCooldownMs. */
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  cooldownMs: number;
  lastError: string | null;
}

/**
 * One circuit per adapter.
 *
 * An adapter whose CLI is broken should not be retried on every session: each
 * attempt costs a process spawn and a timeout, and the user sees a slow failure
 * rather than a clear one. Once open, the adapter reports unhealthy, which
 * `system.inventory` already surfaces and `AgentRouter` already filters on — so
 * it drops out of fleet routing without any extra plumbing.
 */
export class AdapterCircuit {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private cooldownMs: number;
  private lastError: string | null = null;

  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.baseCooldownMs = options.baseCooldownMs ?? 60_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 15 * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = this.baseCooldownMs;
  }

  /** Current state, moving open -> half_open once the cooldown has elapsed. */
  getState(): CircuitState {
    if (this.state === 'open' && this.openedAt !== null) {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
      }
    }
    return this.state;
  }

  /** Whether a session may be attempted right now. */
  allowsAttempt(): boolean {
    return this.getState() !== 'open';
  }

  recordSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.cooldownMs = this.baseCooldownMs;
    this.lastError = null;
  }

  recordFailure(error?: unknown): void {
    this.lastError = error instanceof Error ? error.message : error ? String(error) : null;

    // A failed trial in half_open re-opens immediately with a longer cooldown,
    // rather than waiting to accumulate the full threshold again.
    if (this.getState() === 'half_open') {
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.state = 'open';
      this.openedAt = this.now();
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      cooldownMs: this.cooldownMs,
      lastError: this.lastError,
    };
  }
}

/** Raised when an adapter's circuit is open. */
export class AdapterUnavailableError extends Error {
  readonly code = 'ADAPTER_CIRCUIT_OPEN';
  readonly adapterId: string;
  readonly snapshot: CircuitSnapshot;

  constructor(adapterId: string, snapshot: CircuitSnapshot) {
    super(
      `Adapter "${adapterId}" is temporarily unavailable after ` +
        `${snapshot.consecutiveFailures} consecutive failures` +
        (snapshot.lastError ? ` (last error: ${snapshot.lastError})` : ''),
    );
    this.name = 'AdapterUnavailableError';
    this.adapterId = adapterId;
    this.snapshot = snapshot;
  }
}
