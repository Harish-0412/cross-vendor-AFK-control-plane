import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { Sandbox, SandboxConfig, SandboxManager as ISandboxManager, SessionConfig } from '@freebuff/protocol';
import { SandboxManager } from '@freebuff/sandbox';
import type { OpenCodeProcessOptions } from './types';

const execFileAsync = promisify(execFile);

export interface OpenCodeProcessController {
  detect(): Promise<{ path: string; version: string } | null>;
  validate(): Promise<{ valid: boolean; version?: string; errors: string[] }>;
  start(config: SessionConfig): Promise<Sandbox>;
  stop(sandbox: Sandbox, force: boolean): Promise<void>;
  getSandbox(sandboxId: string): Sandbox | undefined;
  watchStdout(sandbox: Sandbox, onLine: (line: string) => void, onClose: () => void): void;
}

export class OpenCodeProcessManager implements OpenCodeProcessController {
  private readonly binaryPath: string;
  private readonly minimumVersion: string;

  constructor(private readonly sandboxManager: ISandboxManager = new SandboxManager(), options: OpenCodeProcessOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.OPENCODE_BINARY ?? 'opencode';
    this.minimumVersion = options.minimumVersion ?? '1.0.0';
  }

  async detect(): Promise<{ path: string; version: string } | null> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, ['--version'], { windowsHide: true, timeout: 5_000 });
      const version = stdout.trim().replace(/^v/, '');
      return /^\d+\.\d+\.\d+/.test(version) ? { path: this.binaryPath, version } : null;
    } catch { return null; }
  }

  async validate(): Promise<{ valid: boolean; version?: string; errors: string[] }> {
    const detected = await this.detect();
    if (!detected) return { valid: false, errors: [`OpenCode binary not found: ${this.binaryPath}`] };
    if (compareVersions(detected.version, this.minimumVersion) < 0) {
      return { valid: false, version: detected.version, errors: [`OpenCode ${this.minimumVersion}+ is required; found ${detected.version}`] };
    }
    return { valid: true, version: detected.version, errors: [] };
  }

  async start(config: SessionConfig): Promise<Sandbox> {
    const args = ['run', '--format', 'json'];
    if (config.model) args.push('--model', config.model);
    if (config.approvalMode === 'auto') args.push('--auto');
    if (config.prompt) args.push(config.prompt);
    const sandboxConfig: SandboxConfig = {
      projectRoot: config.projectRoot, agentBinary: this.binaryPath, agentArgs: args,
      env: config.env ?? {}, resourceLimits: config.resourceLimits ?? {},
      networkPolicy: { mode: config.sandbox?.networkPolicy === 'none' ? 'deny-all' : 'allow-all' },
      writablePaths: [config.projectRoot], readablePaths: [config.projectRoot], deniedPaths: [],
      profile: config.sandbox?.profile ?? 'standard', labels: { adapter: 'opencode' },
    };
    return this.sandboxManager.create(sandboxConfig);
  }

  async stop(sandbox: Sandbox, force: boolean): Promise<void> {
    if (force) await sandbox.kill('SIGTERM');
    else await sandbox.stop();
    await this.sandboxManager.destroy(sandbox.id);
  }

  getSandbox(sandboxId: string): Sandbox | undefined {
    return this.sandboxManager.get(sandboxId);
  }

  watchStdout(sandbox: Sandbox, onLine: (line: string) => void, onClose: () => void): void {
    const lines = createInterface({ input: sandbox.stdout });
    lines.on('line', onLine);
    void once(sandbox.stdout, 'end').then(() => { lines.close(); onClose(); });
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) { const difference = (a[index] ?? 0) - (b[index] ?? 0); if (difference) return difference; }
  return 0;
}
