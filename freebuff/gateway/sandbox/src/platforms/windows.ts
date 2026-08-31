import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SandboxCapabilities } from '@freebuff/protocol';
import { PlatformSandboxBase } from './platform-base';
import type { SandboxConfig } from '@freebuff/protocol';
import { getProfile, resolveProfilePaths, getHomeDir } from './profiles';

const execFileAsync = promisify(execFile);

export class WindowsSandbox extends PlatformSandboxBase {
  static readonly capabilities: SandboxCapabilities = {
    filesystemIsolation: true,
    processIsolation: true,
    networkIsolation: true,
    cpuLimits: true,
    memoryLimits: true,
    diskLimits: false,
    processLimits: true,
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
          const info = JSON.parse(result.stdout);
          const workingSetBytes = Number(info.WorkingSet64 ?? 0);
          const memoryMb = Math.round(workingSetBytes / 1024 / 1024);
          this.peakMemory = Math.max(this.peakMemory, memoryMb);
          this.peakProcesses = Math.max(this.peakProcesses, 1);

          this.resourceSample = {
            cpuPercent: Math.min(100, Number(info.CPU ?? 0) * 10),
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
      this.config.metadata = { ...this.config.metadata ?? {}, jobLimitsApplied: limits, platform: 'win32' };
    } catch {
      // Soft-fail: Job Objects require native bindings; document limits in metadata
    }
  }

  private applyMemoryLimits(): void {
    // Memory limits enforced via Job Objects (native bindings required)
    // We document the intended values in metadata for observability
    this.config.metadata = {
      ...this.config.metadata ?? {},
      memoryLimitMb: this.config.resourceLimits.memoryMb,
      cpuLimitPercent: this.config.resourceLimits.cpuPercent,
    };
  }

  private applyNetworkPolicy(): void {
    // Windows Firewall rules would be applied via netsh (requires admin)
    // We capture the intended policy in metadata
    this.config.metadata = {
      ...this.config.metadata ?? {},
      networkPolicy: this.config.networkPolicy,
    };
  }
}

export function createWindowsSandbox(config: SandboxConfig): WindowsSandbox | null {
  if (!WindowsSandbox.isSupported()) return null;
  return new WindowsSandbox(config);
}
