/**
 * Spawns and supervises `claude` processes.
 *
 * Signal handling follows the documented headless behaviour:
 *   SIGINT  — ends the current turn and records a result
 *   SIGTERM — leaves the turn unfinished (exit code 143)
 * So a cooperative cancel sends SIGINT first and only escalates to SIGKILL if
 * the process does not exit. Using SIGTERM for a normal cancel would discard
 * the turn's result, which is the work the user asked for.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { SessionConfig } from '@odysseus/protocol';

import type { ClaudeProcessOptions } from './types';

export interface ClaudeRun {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the process exit code. */
  exited: Promise<number | null>;
}

export interface ClaudeProcessController {
  detect(): Promise<{ path: string; version: string } | null>;
  validate(): Promise<{ valid: boolean; version?: string; errors: string[]; warnings: string[] }>;
  /** Start a prompt run. `resumeSessionId` continues an existing conversation. */
  run(options: {
    prompt: string;
    projectRoot: string;
    config?: SessionConfig | undefined;
    resumeSessionId?: string | undefined;
  }): ClaudeRun;
  /** Graceful turn end, escalating to a kill after `graceMs`. */
  stop(child: ChildProcessWithoutNullStreams, force: boolean, graceMs?: number): Promise<void>;
}

/** Exit code Claude Code uses when SIGTERM stops a run. */
export const SIGTERM_EXIT_CODE = 143;

/**
 * Map an Odysseus approval mode onto a Claude Code permission mode.
 *
 * `ask` is deliberately absent: interactive per-call approval needs a
 * `--permission-prompt-tool` MCP host, which this adapter does not provide.
 * The adapter advertises `approvalInterception: 'unsupported'` so the gateway
 * rejects such sessions up front rather than running them ungoverned.
 */
export function permissionModeFor(approvalMode: SessionConfig['approvalMode']): string {
  switch (approvalMode) {
    case 'never':
      // Deny anything that would prompt. The locked-down posture.
      return 'dontAsk';
    case 'auto':
      // A classifier reviews actions instead of a human.
      return 'auto';
    default:
      return 'dontAsk';
  }
}

export class ClaudeProcessManager implements ClaudeProcessController {
  private readonly binary: string;
  private readonly options: ClaudeProcessOptions;

  constructor(options: ClaudeProcessOptions = {}) {
    this.options = options;
    this.binary = options.binaryPath ?? 'claude';
  }

  async detect(): Promise<{ path: string; version: string } | null> {
    const timeoutMs = this.options.detectTimeoutMs ?? 5000;
    try {
      const output = await this.execCapture([this.binary, '--version'], timeoutMs);
      if (output.code !== 0) return null;
      // `claude --version` prints something like "2.1.10 (Claude Code)".
      const version = output.stdout.trim().split(/\s+/)[0] ?? 'unknown';
      return { path: this.binary, version };
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
    const errors: string[] = [];
    const warnings: string[] = [];

    const detected = await this.detect();
    if (!detected) {
      errors.push(
        'Claude Code CLI not found. Install it and ensure `claude` is on PATH, ' +
          'or set binaryPath in the adapter options.',
      );
      return { valid: false, errors, warnings };
    }

    // In bare mode Claude Code never reads OAuth credentials or the keychain,
    // so an API key is required. Outside bare mode a subscription login works.
    if (this.options.bare !== false && !process.env.ANTHROPIC_API_KEY) {
      warnings.push(
        'ANTHROPIC_API_KEY is not set. Bare mode does not read subscription ' +
          'credentials, so runs will fail to authenticate.',
      );
    }

    return { valid: true, version: detected.version, errors, warnings };
  }

  /** Build the argv for a headless run. */
  buildArgs(options: {
    prompt: string;
    config?: SessionConfig | undefined;
    resumeSessionId?: string | undefined;
  }): string[] {
    const args: string[] = [];

    // --bare keeps a gateway-run session reproducible: no host hooks, no
    // plugins, no MCP servers from the repo, no implicit CLAUDE.md.
    if (this.options.bare !== false) args.push('--bare');

    args.push('-p', options.prompt);

    // stream-json requires --verbose; without it Claude Code rejects the combination.
    args.push('--output-format', 'stream-json', '--verbose');

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    const model = options.config?.model ?? this.options.model;
    if (model) args.push('--model', model);

    args.push('--permission-mode', permissionModeFor(options.config?.approvalMode));

    // Nobody is at a terminal, so anything that would prompt must be denied
    // rather than left waiting for an answer that will never come.
    args.push('--permission-prompts', 'none');

    if (options.config?.maxTurns !== undefined) {
      args.push('--max-turns', String(options.config.maxTurns));
    }

    if (this.options.extraArgs?.length) args.push(...this.options.extraArgs);

    return args;
  }

  run(options: {
    prompt: string;
    projectRoot: string;
    config?: SessionConfig | undefined;
    resumeSessionId?: string | undefined;
  }): ClaudeRun {
    const args = this.buildArgs(options);

    const child = spawn(this.binary, args, {
      cwd: options.projectRoot,
      env: { ...process.env, ...(options.config?.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Detached on POSIX so the whole process group can be signalled: Claude
      // Code spawns Bash tool children, and killing only the parent orphans
      // them.
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams;

    // stdin is closed immediately: the prompt came in via -p, and an open
    // stdin makes Claude Code wait rather than exit after the result.
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }

    const exited = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code));
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

    if (force) {
      this.signal(child, 'SIGKILL');
      return;
    }

    // SIGINT ends the turn and still records a result; SIGTERM would discard it.
    this.signal(child, 'SIGINT');

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('close', () => resolve(true))),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), graceMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);

    if (!exited) this.signal(child, 'SIGKILL');
  }

  /** Signal the process group where the platform supports it. */
  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) {
        // Negative pid targets the group, reaching Bash tool children too.
        process.kill(-child.pid, signal);
        return;
      }
      child.kill(signal);
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  /** Stream stdout line by line. */
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
    const reader = createInterface({ input: child.stderr, crlfDelay: Infinity });
    reader.on('line', onLine);
  }

  private execCapture(
    argv: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const [command, ...rest] = argv;
      if (!command) return reject(new Error('empty command'));

      const child = spawn(command, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(new Error(`${command} ${rest.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
}
