/**
 * Process exit codes, following the BSD sysexits.h convention.
 *
 * A supervisor (systemd, launchd, Docker, a shell loop) restarts a gateway
 * that failed for a temporary reason and should NOT restart one that failed
 * because its config is wrong or its device was revoked — restarting those
 * just produces a crash loop that buries the real cause. Distinct exit codes
 * are how that decision gets communicated without parsing logs.
 */
export const ExitCode = {
  /** Clean shutdown. */
  OK: 0,
  /** Command line usage error. */
  USAGE: 64,
  /** Input data was incorrect (e.g. malformed config file). */
  DATAERR: 65,
  /** A required service is unavailable and is not expected to recover. */
  UNAVAILABLE: 69,
  /** Internal software error — a bug. */
  SOFTWARE: 70,
  /** Temporary failure; the supervisor SHOULD retry. */
  TEMPFAIL: 75,
  /** Remote system returned something protocol-illegal (version mismatch). */
  PROTOCOL: 76,
  /** Permission denied — device revoked, auth rejected. Do NOT retry. */
  NOPERM: 77,
  /** Configuration error. Do NOT retry until a human fixes it. */
  CONFIG: 78,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** True when a supervisor should restart the process after this exit code. */
export function isRetryableExit(code: number): boolean {
  return code === ExitCode.TEMPFAIL || code === ExitCode.SOFTWARE;
}

export function exitCodeName(code: number): string {
  const entry = Object.entries(ExitCode).find(([, value]) => value === code);
  return entry ? entry[0] : `UNKNOWN(${code})`;
}
