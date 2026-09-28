/**
 * Resolve an agent CLI name to something `spawn` can actually execute.
 *
 * On Windows, CLIs installed with npm are `.cmd` batch shims (`opencode.cmd`,
 * `claude.cmd`), not executables. `spawn('opencode')` without a shell fails
 * with ENOENT — so the adapter reported the agent as not installed even when it
 * was. Spawning the `.cmd` directly is refused by Node too (CVE-2024-27980).
 *
 * The tempting fix is `shell: true`. That would be a command-injection hole
 * here: the session prompt — typed on a phone, relayed through the Control
 * Plane — is one of the arguments, and with a shell the arguments are
 * concatenated into a command line. So instead this reads the shim, finds the
 * real target it launches, and runs that directly with an argument array.
 *
 * npm's cmd-shim writes one of two shapes:
 *   "%dp0%\node_modules\pkg\bin\tool.exe"   %*          native binary
 *   "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*       node script
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ResolvedCommand {
  /** The executable to spawn. */
  command: string;
  /** Arguments that must precede the caller's own (e.g. the script path). */
  prefixArgs: string[];
}

interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The node binary used to run script shims. */
  nodePath?: string;
}

export function resolveCommand(name: string, options: ResolveOptions = {}): ResolvedCommand {
  const platform = options.platform ?? process.platform;
  const unresolved = { command: name, prefixArgs: [] };
  if (platform !== 'win32') return unresolved;

  const env = options.env ?? process.env;
  const nodePath = options.nodePath ?? process.execPath;
  const lower = name.toLowerCase();

  // An explicit path: use it as given, unwrapping it if it is a shim.
  if (name.includes('\\') || name.includes('/')) {
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return fromShim(name, nodePath) ?? unresolved;
    }
    return unresolved;
  }

  const pathValue = env['Path'] ?? env['PATH'] ?? '';
  for (const dir of pathValue.split(';').filter(Boolean)) {
    const exe = join(dir, `${name}.exe`);
    if (existsSync(exe)) return { command: exe, prefixArgs: [] };

    const shim = join(dir, `${name}.cmd`);
    if (existsSync(shim)) {
      const resolved = fromShim(shim, nodePath);
      if (resolved) return resolved;
    }
  }

  // Not found: return the bare name so the caller fails the way it always did,
  // with a "not installed" result rather than a confusing resolution error.
  return unresolved;
}

/** Read an npm cmd-shim and return the target it launches. */
export function fromShim(shimPath: string, nodePath: string): ResolvedCommand | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  const base = dirname(shimPath);
  const targets: string[] = [];
  for (const match of text.matchAll(/"%~?dp0%?\\([^"]+)"/gi)) {
    const relative = match[1];
    if (!relative) continue;
    targets.push(join(base, ...relative.split('\\')));
  }

  // The shim also mentions a local node.exe it prefers when present; that is
  // the interpreter, not the target.
  const target = targets.filter((candidate) => !/[\\/]node\.exe$/i.test(candidate)).pop();
  if (!target || !existsSync(target)) return null;

  if (target.toLowerCase().endsWith('.exe')) return { command: target, prefixArgs: [] };
  return { command: nodePath, prefixArgs: [target] };
}
