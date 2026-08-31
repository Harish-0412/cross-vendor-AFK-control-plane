import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import type { SandboxCapabilities } from '@freebuff/protocol';
import { PlatformSandboxBase } from '../platform-base';
import type { SandboxConfig } from '@freebuff/protocol';
import { getProfile, resolveProfilePaths, getHomeDir } from '../profiles';

const execFileAsync = promisify(execFile);

export class LinuxSandbox extends PlatformSandboxBase {
  static readonly capabilities: SandboxCapabilities = {
    filesystemIsolation: true,
    processIsolation: true,
    networkIsolation: true,
    cpuLimits: true,
    memoryLimits: true,
    diskLimits: true,
    processLimits: true,
    rootless: false,
    checkpointRestore: true,
  };

  get capabilities(): SandboxCapabilities {
    return { ...LinuxSandbox.capabilities };
  }

  static isSupported(): boolean {
    return process.platform === 'linux';
  }

  private cgroupPath?: string;

  async start(): Promise<void> {
    await this.ensureProjectRoot();
    const profile = getProfile(this.config.profile);
    const resolved = resolveProfilePaths(profile, this.config.projectRoot, getHomeDir());

    const useDocker = await this.haveDocker();
    if (useDocker) {
      await this.startDockerContainer(resolved, profile);
    } else {
      await this.startLightweight(resolved, profile);
    }
  }

  protected async refreshResourceUsage(): Promise<void> {
    const now = new Date();
    if (!this.process || this.pid === 0) {
      this.resourceSample.measuredAt = now;
      return;
    }
    try {
      const stat = await fs.readFile(`/proc/${this.pid}/stat`, 'utf8').catch(() => '');
      const status = await fs.readFile(`/proc/${this.pid}/status`, 'utf8').catch(() => '');

      if (stat) {
        const parts = stat.split(' ');
        const vmPeakMatch = status.match(/VmRSS:\s+(\d+)/);
        const rssKb = vmPeakMatch ? Number(vmPeakMatch[1]) : 0;
        const memoryMb = Math.round(rssKb / 1024);
        const threadsMatch = status.match(/Threads:\s+(\d+)/);
        const threads = threadsMatch ? Number(threadsMatch[1]) : 1;

        this.peakMemory = Math.max(this.peakMemory, memoryMb);
        this.peakProcesses = Math.max(this.peakProcesses, threads);

        this.resourceSample = {
          cpuPercent: 0,
          memoryMb,
          memoryPeakMb: this.peakMemory,
          activeProcesses: threads,
          peakProcesses: this.peakProcesses,
          openFiles: 0,
          networkBytesSent: this.bytesSent,
          networkBytesReceived: this.bytesReceived,
          diskReadBytes: this.diskRead,
          diskWriteBytes: this.diskWrite,
          measuredAt: now,
        };
      } else {
        this.resourceSample.measuredAt = now;
      }
    } catch {
      this.resourceSample.measuredAt = now;
    }
  }

  private async haveDocker(): Promise<boolean> {
    try {
      const r = await execFileAsync('docker', ['--version'], { timeout: 1000 });
      return /^Docker version/i.test(r.stdout.trim());
    } catch {
      return false;
    }
  }

  private async startDockerContainer(
    resolved: ReturnType<typeof resolveProfilePaths>,
    _profile: ReturnType<typeof getProfile>,
  ): Promise<void> {
    const cpuQuota = (this.config.resourceLimits.cpuPercent ?? 100) * 1000;
    const memory = `${this.config.resourceLimits.memoryMb ?? 2048}m`;
    const args = [
      'run',
      '--rm',
      '--interactive',
      '--network', this.config.networkPolicy.mode === 'deny-all' ? 'none' : 'bridge',
      '--memory', memory,
      '--cpus', `${(this.config.resourceLimits.cpuPercent ?? 100) / 100}`,
      '--cpu-quota', String(cpuQuota),
      '--read-only',
      '--tmpfs', '/tmp:size=100m',
      '--mount', `type=bind,src=${this.config.projectRoot},dst=/workspace,rw`,
      '--workdir', '/workspace',
      '--pids-limit', String(this.config.resourceLimits.maxProcesses ?? 20),
      '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ...this.buildEnvFlags(this.config.env),
      'node:20-slim',
      this.config.agentBinary,
      ...this.config.agentArgs,
    ];

    this.config.metadata = { ...this.config.metadata ?? {}, runtime: 'docker', networkMode: this.config.networkPolicy.mode, readonlyRootfs: true, resolvedPaths: resolved };
    this.spawnProcess('docker', args, {}, os.tmpdir());
  }

  private async startLightweight(
    resolved: ReturnType<typeof resolveProfilePaths>,
    profile: ReturnType<typeof getProfile>,
  ): Promise<void> {
    const env = {
      ...this.config.env,
      HOME: this.config.projectRoot,
      TMPDIR: `${this.config.projectRoot}/tmp`,
      PATH: '/usr/local/bin:/usr/bin:/bin',
    };
    try {
      await fs.mkdir(`${this.config.projectRoot}/tmp`, { recursive: true });
    } catch {
      // swallow
    }
    this.config.metadata = {
      ...this.config.metadata ?? {},
      runtime: 'lightweight',
      unshare: false,
      cgroupV2: this.cgroupPath !== undefined,
      processLimits: profile.process.maxProcesses,
      resolvedPaths: resolved,
    };
    this.spawnProcess(this.config.agentBinary, this.config.agentArgs, env);
  }

  private buildEnvFlags(env: Record<string, string>): string[] {
    const flags: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      flags.push('--env', `${k}=${v}`);
    }
    return flags;
  }
}

export function createLinuxSandbox(config: SandboxConfig): LinuxSandbox | null {
  if (!LinuxSandbox.isSupported()) return null;
  return new LinuxSandbox(config);
}
