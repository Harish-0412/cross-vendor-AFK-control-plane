/**
 * §4.4 of the pre-deployment audit: /api/v1/auth/login and /register had no
 * attempt-counting, backoff, or lockout at all — unlimited password-guessing
 * against any known email, and unlimited account-creation spam.
 *
 * Structurally the same sliding-window-per-key pattern already proven in
 * `gateway/pairing/src/code-generator.ts`'s PairingRateLimiter (Phase 2),
 * reimplemented here rather than imported: the Gateway and the Control Plane
 * are separate deployables, and importing a Gateway-side package into the
 * Control Plane (or vice versa) would be a layering violation neither of
 * them currently has — pairing's rate limiter is also conceptually coupled
 * to pairing codes specifically (`recordAttempt(code)`), whereas this one is
 * generic over any string key (an email, an IP, or the two combined).
 */

export interface AuthRateLimiterConfig {
  /** Sliding window size in ms. Default: 15 minutes. */
  windowMs: number;
  /** Max attempts allowed per key within the window. Default: 5 for login, 10 for register. */
  maxAttemptsPerWindow: number;
}

export const DEFAULT_LOGIN_RATE_LIMIT: AuthRateLimiterConfig = {
  windowMs: 15 * 60 * 1000,
  maxAttemptsPerWindow: 5,
};

export const DEFAULT_REGISTER_RATE_LIMIT: AuthRateLimiterConfig = {
  windowMs: 60 * 60 * 1000,
  maxAttemptsPerWindow: 10,
};

interface WindowEntry {
  count: number;
  windowStartedAt: number;
}

export class AuthRateLimiter {
  private readonly config: AuthRateLimiterConfig;
  private readonly attempts: Map<string, WindowEntry> = new Map();

  constructor(config: AuthRateLimiterConfig) {
    this.config = config;
  }

  /**
   * Returns true if `key` is currently allowed to attempt (has not exceeded
   * maxAttemptsPerWindow within the current sliding window). Does not itself
   * record an attempt — call `recordAttempt` for that, so a caller can check
   * "am I locked out" before doing any real work (e.g. a DB lookup) and
   * separately record the attempt only when it's actually made.
   */
  isAllowed(key: string): boolean {
    const entry = this.attempts.get(key);
    if (!entry) return true;
    const now = Date.now();
    if (now - entry.windowStartedAt >= this.config.windowMs) {
      // Window has fully elapsed; this key is no longer rate-limited.
      return true;
    }
    return entry.count < this.config.maxAttemptsPerWindow;
  }

  /** Record one attempt against `key`, starting a fresh window if the previous one elapsed. */
  recordAttempt(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.windowStartedAt >= this.config.windowMs) {
      this.attempts.set(key, { count: 1, windowStartedAt: now });
      return;
    }
    entry.count++;
  }

  /** How many seconds until `key`'s window resets, or 0 if not currently limited. */
  retryAfterSeconds(key: string): number {
    const entry = this.attempts.get(key);
    if (!entry) return 0;
    const elapsed = Date.now() - entry.windowStartedAt;
    const remaining = this.config.windowMs - elapsed;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  /** Drop expired entries. Call periodically to bound memory; not required for correctness. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.attempts.entries()) {
      if (now - entry.windowStartedAt >= this.config.windowMs) {
        this.attempts.delete(key);
      }
    }
  }

  /** Test/ops visibility: current attempt count for a key. */
  getAttemptCount(key: string): number {
    const entry = this.attempts.get(key);
    if (!entry) return 0;
    if (Date.now() - entry.windowStartedAt >= this.config.windowMs) return 0;
    return entry.count;
  }
}

export function createAuthRateLimiter(config: AuthRateLimiterConfig): AuthRateLimiter {
  return new AuthRateLimiter(config);
}
