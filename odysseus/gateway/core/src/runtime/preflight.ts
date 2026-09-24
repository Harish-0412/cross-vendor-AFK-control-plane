/**
 * Startup preflight checks.
 *
 * The purpose is to convert failures that would otherwise surface later as
 * something opaque — an auth rejection caused by clock skew, a session that
 * dies because its project root is read-only — into a specific startup error
 * with a remedy attached. Each check returns its own remedy line so the
 * operator does not have to guess.
 */
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

import type { Logger } from './logger';

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightResult {
  name: string;
  status: PreflightStatus;
  message: string;
  /** What the operator should do about it. Present on warn/fail. */
  remedy?: string;
  durationMs: number;
}

export interface PreflightReport {
  ok: boolean;
  results: PreflightResult[];
  failures: PreflightResult[];
  warnings: PreflightResult[];
}

export interface PreflightCheck {
  name: string;
  run: () => Promise<Omit<PreflightResult, 'name' | 'durationMs'>>;
}

/** Largest tolerated difference between local time and Control Plane time. */
export const MAX_CLOCK_SKEW_MS = 120_000;

export async function runPreflight(
  checks: PreflightCheck[],
  logger?: Logger,
): Promise<PreflightReport> {
  const results: PreflightResult[] = [];

  for (const check of checks) {
    const startedAt = Date.now();
    let result: PreflightResult;
    try {
      const outcome = await check.run();
      result = { name: check.name, ...outcome, durationMs: Date.now() - startedAt };
    } catch (err) {
      result = {
        name: check.name,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        remedy: 'The check itself threw; this is a bug in the preflight check.',
        durationMs: Date.now() - startedAt,
      };
    }
    results.push(result);

    const fields = {
      check: result.name,
      durationMs: result.durationMs,
      detail: result.message,
      ...(result.remedy ? { remedy: result.remedy } : {}),
    };
    if (result.status === 'fail') logger?.error('preflight.fail', fields);
    else if (result.status === 'warn') logger?.warn('preflight.warn', fields);
    else logger?.debug('preflight.pass', fields);
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  return { ok: failures.length === 0, results, failures, warnings };
}

// ---------------------------------------------------------------- checks

export function nodeVersionCheck(minimumMajor = 20): PreflightCheck {
  return {
    name: 'node-version',
    run: async () => {
      const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      if (major >= minimumMajor) {
        return { status: 'pass' as const, message: `Node ${process.versions.node}` };
      }
      return {
        status: 'fail' as const,
        message: `Node ${process.versions.node} is below the required v${minimumMajor}`,
        remedy: `Install Node.js v${minimumMajor} or newer.`,
      };
    },
  };
}

export function controlPlaneUrlCheck(url: string | undefined): PreflightCheck {
  return {
    name: 'control-plane-url',
    run: async () => {
      if (!url) {
        return {
          status: 'warn' as const,
          message: 'No Control Plane URL configured; running local-only',
          remedy: 'Set controlPlane.url (or ODYSSEUS_CONTROL_PLANE_URL) to enable remote control.',
        };
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return {
          status: 'fail' as const,
          message: `Control Plane URL is not a valid URL: ${url}`,
          remedy: 'Use a ws:// or wss:// URL, e.g. wss://control.example.com/ws/tunnel',
        };
      }
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return {
          status: 'fail' as const,
          message: `Control Plane URL must be ws:// or wss://, got ${parsed.protocol}//`,
          remedy: 'The tunnel is a WebSocket. Use wss:// in production, ws:// only on localhost.',
        };
      }
      if (parsed.protocol === 'ws:' && !isLocalHost(parsed.hostname)) {
        return {
          status: 'warn' as const,
          message: `Unencrypted ws:// to a non-local host (${parsed.hostname})`,
          remedy: 'Use wss:// — session output and diffs cross this link.',
        };
      }
      return { status: 'pass' as const, message: url };
    },
  };
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function identityCheck(identity: {
  deviceId: string;
  sign: (data: string) => string;
}): PreflightCheck {
  return {
    name: 'device-identity',
    run: async () => {
      if (!identity.deviceId) {
        return {
          status: 'fail' as const,
          message: 'Device identity has no deviceId',
          remedy: 'Delete ~/.odysseus/device-keys.json and re-run pairing.',
        };
      }
      // Signing is exercised here rather than trusted, because a key that
      // loads but cannot sign fails later as an opaque auth rejection.
      const probe = identity.sign(`preflight:${identity.deviceId}`);
      if (!probe) {
        return {
          status: 'fail' as const,
          message: 'Device key loaded but produced an empty signature',
          remedy: 'Key material is corrupt. Delete ~/.odysseus/device-keys.json and re-pair.',
        };
      }
      return { status: 'pass' as const, message: `signing key OK (${identity.deviceId})` };
    },
  };
}

export function projectRootsCheck(roots: string[]): PreflightCheck {
  return {
    name: 'project-roots',
    run: async () => {
      if (roots.length === 0) {
        return {
          status: 'warn' as const,
          message: 'No project roots configured',
          remedy: 'Set projectRoots so sessions have somewhere to run.',
        };
      }
      const problems: string[] = [];
      for (const root of roots) {
        try {
          const info = await stat(root);
          if (!info.isDirectory()) {
            problems.push(`${root} is not a directory`);
            continue;
          }
          await access(root, fsConstants.W_OK);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          problems.push(
            code === 'ENOENT' ? `${root} does not exist` : `${root} is not writable (${code})`,
          );
        }
      }
      if (problems.length > 0) {
        return {
          status: 'fail' as const,
          message: problems.join('; '),
          remedy: 'Every project root must exist and be writable by the gateway user.',
        };
      }
      return { status: 'pass' as const, message: `${roots.length} root(s) writable` };
    },
  };
}

export function adaptersCheck(registeredCount: number, installedCount: number): PreflightCheck {
  return {
    name: 'adapters',
    run: async () => {
      if (registeredCount === 0) {
        return {
          status: 'fail' as const,
          message: 'No agent adapters registered',
          remedy: 'At least the mock adapter should register; check allowedAdapters.',
        };
      }
      if (installedCount === 0) {
        return {
          status: 'warn' as const,
          message: `${registeredCount} adapter(s) registered but none report as installed`,
          remedy: 'Install an agent CLI (e.g. opencode) or sessions can only run against mock.',
        };
      }
      return {
        status: 'pass' as const,
        message: `${installedCount}/${registeredCount} adapter(s) installed`,
      };
    },
  };
}

/**
 * What the sandbox on this machine actually enforces.
 *
 * The whole proposition of this project is leaving an agent running while you
 * are not at the keyboard, so "how contained is it" is not a detail — it is
 * the thing the user is trusting. The capability flags are reported by the
 * platform sandbox; this states them in one line at startup instead of leaving
 * them to be discovered from source.
 *
 * A machine with no enforcement still starts. It warns, because refusing to
 * run would not make anyone safer — it would just move the work somewhere with
 * no warning at all.
 */
export function sandboxIsolationCheck(
  platform: string,
  capabilities: {
    filesystemIsolation: boolean;
    networkIsolation: boolean;
    processLimits: boolean;
    memoryLimits: boolean;
  },
): PreflightCheck {
  return {
    name: 'sandbox',
    run: async () => {
      const enforced = (
        [
          ['filesystem', capabilities.filesystemIsolation],
          ['network', capabilities.networkIsolation],
          ['process limits', capabilities.processLimits],
          ['memory limits', capabilities.memoryLimits],
        ] as const
      )
        .filter(([, on]) => on)
        .map(([name]) => name);

      if (enforced.length === 0) {
        return {
          status: 'warn' as const,
          message: `No sandbox enforcement on ${platform}: an agent runs with your own file and network access`,
          remedy:
            platform === 'win32'
              ? 'Windows has no enforcing sandbox here. Give sessions a project root that ' +
                'contains nothing you would mind an agent reading, and keep approval mode on ' +
                'for anything that writes.'
              : 'Install Docker (Linux) so sessions run in a container, or restrict the project root.',
        };
      }
      if (!capabilities.filesystemIsolation) {
        return {
          status: 'warn' as const,
          message: `Partial sandbox on ${platform}: ${enforced.join(', ')} enforced, filesystem not`,
          remedy: 'An agent can read any file you can. Choose the project root accordingly.',
        };
      }
      return { status: 'pass' as const, message: `Sandbox enforces ${enforced.join(', ')}` };
    },
  };
}

/**
 * Clock skew between this machine and the Control Plane.
 *
 * Signed handshakes carry timestamps and certificates carry validity windows,
 * so a skewed clock produces auth failures whose error messages point nowhere
 * near the real cause. Checking it explicitly turns a multi-hour debugging
 * session into one line at startup.
 */
export function clockSkewCheck(getServerTime: () => Promise<Date | null>): PreflightCheck {
  return {
    name: 'clock-skew',
    run: async () => {
      let serverTime: Date | null;
      try {
        serverTime = await getServerTime();
      } catch (err) {
        return {
          status: 'warn' as const,
          message: `Could not read Control Plane time: ${
            err instanceof Error ? err.message : String(err)
          }`,
          remedy: 'Clock skew is unverified; the Control Plane may be unreachable.',
        };
      }
      if (!serverTime) {
        return { status: 'warn' as const, message: 'Control Plane time unavailable; skew unknown' };
      }
      const skewMs = Math.abs(Date.now() - serverTime.getTime());
      if (skewMs > MAX_CLOCK_SKEW_MS) {
        return {
          status: 'fail' as const,
          message: `Local clock differs from Control Plane by ${Math.round(skewMs / 1000)}s`,
          remedy: 'Enable NTP time sync. Signed handshakes and certificates are time-sensitive.',
        };
      }
      return { status: 'pass' as const, message: `skew ${skewMs}ms` };
    },
  };
}
