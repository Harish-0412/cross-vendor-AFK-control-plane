import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SandboxCapabilities, SandboxConfig } from '@odysseus/protocol';

import { PlatformSandboxBase } from '../platform-base';
import { getProfile, resolveProfilePaths, getHomeDir } from '../profiles';

const execFileAsync = promisify(execFile);

/**
 * What this sandbox actually enforces on Windows: nothing.
 *
 * Job Objects, AppContainer and firewall rules all need either native bindings
 * or an elevated process, and neither is present here. `start()` therefore
 * spawns the agent as an ordinary child process with the user's own rights and
 * records the limits it *would* have applied as metadata, which is useful for
 * observability and is not a restriction.
 *
 * These flags used to claim filesystem, process and network isolation. They
 * are the answer to "can I let an agent run unattended on this machine", so
 * claiming an isolation that does not exist is worse than having none: it
 * invites exactly the unattended run that the isolation was supposed to make
 * safe. `sandboxIsolationCheck` turns this into a visible startup warning.
 */
export class WindowsSandbox extends PlatformSandboxBase {
  static readonly capabilities: SandboxCapabilities = {
    filesystemIsolation: false,
    processIsolation: false,
    networkIsolation: false,
    cpuLimits: false,
    memoryLimits: false,
    diskLimits: false,
    processLimits: false,
    // True, and the only one that is: the agent runs as the signed-in user
    // rather than as an administrator.
    rootless: true,
    checkpointRestore: false,
  };

  get capabilities(): SandboxCapabilities {
    return { ...WindowsSandbox.capabilities };
  }

  static isSupported(): boolean {
    return process.platform === 'win32';
  }

  async start(): Promise<void> {
    await this.ensureProjectRoot();
    const profile = getProfile(this.config.profile);
    const resolved = resolveProfilePaths(profile, this.config.projectRoot, getHomeDir());

    const allowedEnv = this.buildAllowedEnvironment(this.config.env);
    const sanitizedCmd = this.sanitizeCommand(this.config.agentBinary);

    // Recorded on every sandbox so that anything reading the isolation
    // metadata — logs, the session record, a support question — sees what was
    // actually in force rather than what was configured.
    this.recordIsolation({
      enforced: false,
      enforcedBy: 'none',
      note:
        'Windows: limits below are recorded intent, not enforcement. The agent runs ' +
        'as an ordinary child process with your own file and network access.',
    });

    this.applyJobObjectSetup(resolved.process.maxProcesses);

    this.spawnProcess(sanitizedCmd, this.config.agentArgs, allowedEnv);

    this.applyMemoryLimits();
    this.applyNetworkPolicy();
  }

  protected async refreshResourceUsage(): Promise<void> {
    const now = new Date();
    if (!this.process || this.pid === 0) {
      this.resourceSample.measuredAt = now;
      return;
    }
    try {
      const result = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Id ${this.pid} | Select-Object CPU, WorkingSet64, Id | ConvertTo-Json`,
        ],
        { windowsHide: true, timeout: 1000 },
      );
      if (result.stdout.trim()) {
        try {
          // PowerShell output is untrusted shape; read the two fields we use
          // defensively rather than letting JSON.parse's `any` spread through
          // the resource sample.
          const info = JSON.parse(result.stdout) as Record<string, unknown>;
          const workingSetBytes = Number(info['WorkingSet64'] ?? 0);
          const memoryMb = Math.round(workingSetBytes / 1024 / 1024);
          this.peakMemory = Math.max(this.peakMemory, memoryMb);
          this.peakProcesses = Math.max(this.peakProcesses, 1);

          this.resourceSample = {
            cpuPercent: Math.min(100, Number(info['CPU'] ?? 0) * 10),
            memoryMb,
            memoryPeakMb: this.peakMemory,
            activeProcesses: 1,
            peakProcesses: this.peakProcesses,
            openFiles: 0,
            networkBytesSent: this.bytesSent,
            networkBytesReceived: this.bytesReceived,
            diskReadBytes: this.diskRead,
            diskWriteBytes: this.diskWrite,
            measuredAt: now,
          };
        } catch {
          this.resourceSample.measuredAt = now;
        }
      }
    } catch {
      this.resourceSample.measuredAt = now;
    }
  }

  private buildAllowedEnvironment(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = { ...env };
    const blockedVars = [
      'USERNAME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'PATH',
    ];
    for (const key of blockedVars) {
      if (!result[key]) {
        result[key] = process.env[key] ?? '';
      }
    }
    result.TEMP = `${this.config.projectRoot}\\tmp`;
    result.TMP = `${this.config.projectRoot}\\tmp`;
    return result;
  }

  private sanitizeCommand(binary: string): string {
    if (/[;&|>`$]/.test(binary)) {
      throw new Error('Potentially unsafe characters in agent command');
    }
    return binary;
  }

  private applyJobObjectSetup(maxProcesses: number): void {
    try {
      const limits = {
        ProcessMemoryLimit: this.config.resourceLimits.memoryMb,
        JobMemoryLimit: this.config.resourceLimits.memoryMb,
        MaxProcesses: maxProcesses,
        CpuLimit: this.config.resourceLimits.cpuPercent,
      };
      this.recordIsolation({ jobLimitsApplied: limits, platform: 'win32' });
    } catch {
      // Soft-fail: Job Objects require native bindings; document limits in metadata
    }
  }

  private applyMemoryLimits(): void {
    // Memory limits enforced via Job Objects (native bindings required)
    // We document the intended values in metadata for observability
    this.recordIsolation({
      memoryLimitMb: this.config.resourceLimits.memoryMb,
      cpuLimitPercent: this.config.resourceLimits.cpuPercent,
    });
  }

  private applyNetworkPolicy(): void {
    // Windows Firewall rules would be applied via netsh (requires admin)
    // We capture the intended policy in metadata
    this.recordIsolation({
      networkPolicy: this.config.networkPolicy,
    });
  }
}

export function createWindowsSandbox(config: SandboxConfig): WindowsSandbox | null {
  if (!WindowsSandbox.isSupported()) return null;
  return new WindowsSandbox(config);
}
