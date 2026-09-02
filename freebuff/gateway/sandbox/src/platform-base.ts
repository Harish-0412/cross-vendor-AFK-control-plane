import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import type {
  Sandbox as ISandbox,
  SandboxConfig,
  SandboxState,
  SandboxStatus,
  SandboxResourceUsage,
  SandboxCapabilities,
} from '@freebuff/protocol';
import {
  generateSandboxId,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_FORCE_KILL_DELAY_MS,
} from '@freebuff/protocol';

export interface SandboxExitInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export abstract class PlatformSandboxBase implements ISandbox {
  readonly id: string;
  readonly createdAt: Date;
  readonly projectRoot: string;
  readonly state: SandboxState = 'creating';
  protected readonly config: SandboxConfig;
  protected process: ChildProcess | null = null;
  protected _pid = 0;
  protected startedAt: Date | null = null;
  protected stoppedAt: Date | null = null;
  protected destroyedAt: Date | null = null;
  protected exitInfo: SandboxExitInfo | null = null;
  protected errorMessage: string | null = null;
  protected resourceSample: SandboxResourceUsage;
  protected peakMemory = 0;
  protected peakProcesses = 0;
  protected bytesSent = 0;
  protected bytesReceived = 0;
  protected diskRead = 0;
  protected diskWrite = 0;
  protected readonly emitter: EventEmitter = new EventEmitter();
  protected readlineStdout: Interface | null = null;
  protected readlineStderr: Interface | null = null;
  protected exitPromise: Promise<SandboxExitInfo> | null = null;
  protected exitResolver: ((info: SandboxExitInfo) => void) | null = null;

  /**
   * Isolation details recorded by the platform implementation as it applies
   * them — which runtime was used, which limits were requested, how paths
   * resolved. Write-only from the platform's side and surfaced through
   * `diagnostics` for logging and audit.
   *
   * Platforms previously wrote this onto the caller's `SandboxConfig`, which
   * both mutated an input the caller still owned and set a property that did
   * not exist on the type.
   */
  protected readonly appliedIsolation: Record<string, unknown> = {};

  /** Isolation details recorded during setup. Safe to log or audit. */
  get diagnostics(): Readonly<Record<string, unknown>> {
    return { ...this.appliedIsolation };
  }

  /** Merge a set of isolation details into the diagnostics record. */
  protected recordIsolation(details: Record<string, unknown>): void {
    Object.assign(this.appliedIsolation, details);
  }

  constructor(config: SandboxConfig) {
    this.id = generateSandboxId();
    this.createdAt = new Date();
    this.projectRoot = config.projectRoot;
    this.config = config;
    this.resourceSample = {
      cpuPercent: 0,
      memoryMb: 0,
      memoryPeakMb: 0,
      activeProcesses: 0,
      peakProcesses: 0,
      openFiles: 0,
      networkBytesSent: 0,
      networkBytesReceived: 0,
      diskReadBytes: 0,
      diskWriteBytes: 0,
      measuredAt: this.createdAt,
    };
  }

  get pid(): number {
    return this._pid;
  }

  protected set pid(value: number) {
    this._pid = value;
  }

  setState(next: SandboxState): void {
    (this as { state: SandboxState }).state = next;
  }

  abstract get capabilities(): SandboxCapabilities;

  abstract start(): Promise<void>;

  async stop(timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS): Promise<number | null> {
    if (this.state === 'destroyed' || this.state === 'stopped' || this.state === 'error') {
      return this.exitInfo?.exitCode ?? null;
    }
    if (!this.process) {
      this.setState('stopped');
      this.stoppedAt = new Date();
      return null;
    }

    this.setState('stopped');
    this.stoppedAt = new Date();

    const proc = this.process;
    proc.removeAllListeners('error');

    const killedBeforeDeadline = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* swallow */
        }
        setTimeout(() => resolve(this.exitInfo?.exitCode ?? null), 100);
      }, timeoutMs);

      proc.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });

      try {
        if (process.platform === 'win32') {
          proc.kill();
        } else {
          proc.kill('SIGTERM');
        }
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* swallow */
        }
      }
    });

    return killedBeforeDeadline;
  }

  async kill(signal?: string): Promise<void> {
    if (!this.process) return;
    const sig =
      (signal as NodeJS.Signals) ?? (process.platform === 'win32' ? undefined : 'SIGKILL');
    try {
      this.process.kill(sig);
    } catch {
      try {
        this.process.kill('SIGKILL');
      } catch {
        /* swallow */
      }
    }
    this.setState('stopped');
    this.stoppedAt = new Date();
    await new Promise<void>((resolve) => setTimeout(() => resolve(), DEFAULT_FORCE_KILL_DELAY_MS));
  }

  async pause(): Promise<void> {
    if (this.state !== 'running' || !this.process) {
      throw new Error(`Cannot pause sandbox in state: ${this.state}`);
    }
    if (process.platform !== 'win32') {
      try {
        this.process.kill('SIGSTOP');
      } catch {
        /* swallow */
      }
    }
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused' || !this.process) {
      throw new Error(`Cannot resume sandbox in state: ${this.state}`);
    }
    if (process.platform !== 'win32') {
      try {
        this.process.kill('SIGCONT');
      } catch {
        /* swallow */
      }
    }
    this.setState('running');
  }

  async destroy(): Promise<void> {
    if (this.state === 'destroyed') return;
    try {
      await this.stop(1000);
    } catch {
      /* swallow */
    }
    try {
      await this.kill();
    } catch {
      /* swallow */
    }
    this.setState('destroyed');
    this.destroyedAt = new Date();
    if (this.readlineStdout) this.readlineStdout.close();
    if (this.readlineStderr) this.readlineStderr.close();
    this.emitter.removeAllListeners();
  }

  get stdin(): NodeJS.WritableStream {
    if (!this.process?.stdin) {
      throw new Error('Sandbox process not started or stdin unavailable');
    }
    return this.process.stdin;
  }

  get stdout(): NodeJS.ReadableStream {
    if (!this.process?.stdout) {
      throw new Error('Sandbox process not started or stdout unavailable');
    }
    return this.process.stdout;
  }

  get stderr(): NodeJS.ReadableStream {
    if (!this.process?.stderr) {
      throw new Error('Sandbox process not started or stderr unavailable');
    }
    return this.process.stderr;
  }

  async getStatus(): Promise<SandboxStatus> {
    const now = Date.now();
    const status: SandboxStatus = {
      id: this.id,
      state: this.state,
      pid: this._pid,
      projectRoot: this.projectRoot,
      createdAt: this.createdAt,
    };
    if (this.startedAt !== null) {
      status.startedAt = this.startedAt;
      status.uptimeMs = now - this.startedAt.getTime();
    }
    if (this.stoppedAt !== null) status.stoppedAt = this.stoppedAt;
    if (this.destroyedAt !== null) status.destroyedAt = this.destroyedAt;
    if (this.exitInfo !== null) {
      if (this.exitInfo.exitCode !== null) status.exitCode = this.exitInfo.exitCode;
      if (this.exitInfo.signal !== null) status.signal = this.exitInfo.signal;
    }
    if (this.errorMessage !== null) status.error = this.errorMessage;
    return status;
  }

  async getResourceUsage(): Promise<SandboxResourceUsage> {
    await this.refreshResourceUsage();
    return { ...this.resourceSample };
  }

  async isAlive(): Promise<boolean> {
    if (!this.process) return false;
    if (this.exitInfo !== null) return false;
    try {
      return this._pid > 0 && process.kill(this._pid, 0);
    } catch {
      return false;
    }
  }

  waitForExit(): Promise<{ exitCode: number | null; signal: string | null }> {
    const mapInfo = (
      info: SandboxExitInfo,
    ): { exitCode: number | null; signal: string | null } => ({
      exitCode: info.exitCode,
      signal: info.signal,
    });
    if (this.exitInfo) return Promise.resolve(mapInfo(this.exitInfo));
    if (this.exitPromise) return this.exitPromise.then(mapInfo);
    this.exitPromise = new Promise<SandboxExitInfo>((resolve) => {
      this.exitResolver = resolve;
    });
    return this.exitPromise.then(mapInfo);
  }

  protected abstract refreshResourceUsage(): Promise<void>;

  protected spawnProcess(
    command: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    spawnCwd?: string,
  ): ChildProcess {
    const cwd = spawnCwd ?? this.config.projectRoot;
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.config.env,
      ...extraEnv,
    };

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      // Never pass arguments verbatim on Windows. Verbatim mode skips Node's
      // quoting, so any argument containing a space (file paths, prompt text)
      // is split into multiple argv entries, and an argument containing quotes
      // can inject additional arguments into the child command line.
      windowsVerbatimArguments: false,
    });

    this.process = child;
    this.pid = child.pid ?? 0;

    child.on('error', (err) => {
      this.errorMessage = err.message;
      this.setState('error');
      this.emitter.emit('error', err);
    });

    child.on('spawn', () => {
      this.setState('running');
      this.startedAt = new Date();
      if (child.stdout) this.readlineStdout = createInterface({ input: child.stdout });
      if (child.stderr) this.readlineStderr = createInterface({ input: child.stderr });
      void this.refreshResourceUsage();
    });

    child.on('exit', (code, signal) => {
      const info: SandboxExitInfo = { exitCode: code, signal };
      this.exitInfo = info;
      if (!this.destroyedAt && this.state === 'running') {
        this.setState('stopped');
      }
      if (this.stoppedAt === null) this.stoppedAt = new Date();
      if (this.exitResolver !== null) {
        this.exitResolver(info);
        this.exitResolver = null;
      }
      this.emitter.emit('exit', info);
    });

    return child;
  }

  protected async ensureProjectRoot(): Promise<void> {
    try {
      await fs.access(this.config.projectRoot);
    } catch {
      await fs.mkdir(this.config.projectRoot, { recursive: true });
    }
  }

  protected resolvePath(target: string): string {
    return path.resolve(this.config.projectRoot, target);
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }
}
