/**
 * Admission control for the gateway lifecycle.
 *
 * Shutdown is not a single instant. Between "still working normally" and
 * "process gone" there is a window in which the gateway must stop taking new
 * work while letting existing work finish — and, critically, must keep the
 * tunnel up throughout so the final events of those sessions still reach the
 * Control Plane. Tearing the tunnel down first loses exactly the events that
 * explain why a session ended.
 */

export type AdmissionPhase = 'running' | 'draining' | 'aborting' | 'stopped';

export interface AdmissionPolicy {
  /** New sessions accepted? */
  acceptsNewSessions: boolean;
  /** In-flight sessions allowed to continue? */
  continuesInFlight: boolean;
  /** Tunnel kept open for event delivery? */
  tunnelOpen: boolean;
}

export const ADMISSION_POLICY: Record<AdmissionPhase, AdmissionPolicy> = {
  running: { acceptsNewSessions: true, continuesInFlight: true, tunnelOpen: true },
  draining: { acceptsNewSessions: false, continuesInFlight: true, tunnelOpen: true },
  aborting: { acceptsNewSessions: false, continuesInFlight: false, tunnelOpen: true },
  stopped: { acceptsNewSessions: false, continuesInFlight: false, tunnelOpen: false },
};

/**
 * Thrown when a session is refused because of the lifecycle phase rather than
 * anything wrong with the request. Carries `retryAfterMs` so the Control Plane
 * can answer `503` with a `Retry-After` header instead of a generic 500, and
 * so the router knows this device is temporarily unavailable rather than
 * broken.
 */
export class SessionAdmissionError extends Error {
  readonly code = 'GATEWAY_NOT_ACCEPTING_SESSIONS';
  readonly phase: AdmissionPhase;
  readonly retryAfterMs: number;

  constructor(phase: AdmissionPhase, retryAfterMs = 30_000) {
    super(
      phase === 'stopped'
        ? 'Gateway has stopped and is not accepting sessions'
        : `Gateway is ${phase} and is not accepting new sessions`,
    );
    this.name = 'SessionAdmissionError';
    this.phase = phase;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isSessionAdmissionError(err: unknown): err is SessionAdmissionError {
  return err instanceof SessionAdmissionError;
}
