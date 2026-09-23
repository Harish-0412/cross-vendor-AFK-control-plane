import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SessionConfig } from '@odysseus/protocol';

export interface CodexRun {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<number | null>;
}
export interface CodexProcessController {
  detect(): Promise<{ path: string; version: string } | null>;
  validate(): Promise<{ valid: boolean; version?: string; errors: string[]; warnings: string[] }>;
  run(options: {
    prompt: string;
    projectRoot: string;
    config?: SessionConfig;
    threadId?: string;
  }): CodexRun;
  stop(child: ChildProcessWithoutNullStreams, force: boolean, graceMs?: number): Promise<void>;
  watchStdout(
    child: ChildProcessWithoutNullStreams,
    onLine: (line: string) => void,
    onClose: () => void,
  ): void;
  watchStderr(child: ChildProcessWithoutNullStreams, onLine: (line: string) => void): void;
}

/** Uses argv arrays only: prompts and project paths are never interpreted by a shell. */
export class CodexProcessManager implements CodexProcessController {
  constructor(private readonly binary = 'codex') {}

  async detect(): Promise<{ path: string; version: string } | null> {
    try {
      const result = await this.capture(['--version']);
      if (result.code !== 0) return null;
      return { path: this.binary, version: result.stdout.trim().split(/\s+/).at(-1) ?? 'unknown' };
    } catch {
      return null;
    }
  }

  async validate(): Promise<{
    valid: boolean;
    version?: string;
    errors: string[];
    warnings: string[];
  }> {
    const detected = await this.detect();
    if (!detected)
      return { valid: false, errors: ['Codex CLI was not found on PATH'], warnings: [] };
    try {
      const login = await this.capture(['login', 'status']);
      if (login.code !== 0)
        return {
          valid: false,
          version: detected.version,
          errors: ['Codex is installed but not signed in. Run: codex login'],
          warnings: [],
        };
      return { valid: true, version: detected.version, errors: [], warnings: [] };
    } catch {
      return {
        valid: false,
        version: detected.version,
        errors: ['Could not verify Codex login status'],
        warnings: [],
      };
    }
  }

  buildArgs(options: { prompt: string; config?: SessionConfig; threadId?: string }): string[] {
    const args = ['exec'];
    if (options.threadId) args.push('resume', options.threadId);
    args.push('--json');
    if (!options.threadId) args.push('--sandbox', sandboxFor(options.config?.sandbox?.profile));
    if (options.config?.model) args.push('--model', options.config.model);
    // The prompt is a single argv value, never stdin. No bypass-approval flag is
    // used: Codex's sandbox remains the enforcement boundary for unattended runs.
    args.push(options.prompt);
    return args;
  }

  run(options: {
    prompt: string;
    projectRoot: string;
    config?: SessionConfig;
    threadId?: string;
  }): CodexRun {
    const child = spawn(this.binary, this.buildArgs(options), {
      cwd: options.projectRoot,
      env: { ...process.env, ...(options.config?.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    child.stdin.end();
    const exited = new Promise<number | null>((resolve) => {
      child.once('close', resolve);
      child.once('error', () => resolve(null));
    });
    return { child, exited };
  }

  async stop(
    child: ChildProcessWithoutNullStreams,
    force: boolean,
    graceMs = 10_000,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signal(child, force ? 'SIGKILL' : 'SIGINT');
    if (force) return;
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('close', () => resolve(true))),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
      }),
    ]);
    if (!exited) signal(child, 'SIGKILL');
  }

  watchStdout(
    child: ChildProcessWithoutNullStreams,
    onLine: (line: string) => void,
    onClose: () => void,
  ): void {
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', onLine);
    reader.once('close', onClose);
  }
  watchStderr(child: ChildProcessWithoutNullStreams, onLine: (line: string) => void): void {
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', onLine);
  }
  private capture(args: string[]): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Codex detection timed out'));
      }, 5000);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
    });
  }
}

function sandboxFor(
  profile: SessionConfig['sandbox'] extends infer _T
    ? 'strict' | 'standard' | 'permissive' | undefined
    : never,
) {
  return profile === 'strict' ? 'read-only' : 'workspace-write';
}
function signal(child: ChildProcessWithoutNullStreams, value: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value);
    else child.kill(value);
  } catch {
    /* already exited */
  }
}
