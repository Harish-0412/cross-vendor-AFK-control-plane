import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { SandboxCapabilities, SandboxConfig } from '@odysseus/protocol';

import { PlatformSandboxBase } from '../platform-base';
import { getProfile, resolveProfilePaths, getHomeDir } from '../profiles';

const execFileAsync = promisify(execFile);

interface DockerInvocation {
  binary: string;
  args: string[];
}

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

    const dockerInvocation = this.resolveDockerInvocation();
    const runtime = (process.env.ODYSSEUS_SANDBOX_RUNTIME ?? 'auto').trim().toLowerCase();
    if (!['auto', 'docker', 'lightweight'].includes(runtime)) {
      throw new Error('ODYSSEUS_SANDBOX_RUNTIME must be one of: auto, docker, or lightweight');
    }

    if (runtime === 'docker' && dockerInvocation === null) {
      throw new Error(
        `Docker sandbox cannot execute host-only binary outside the project root: ${this.config.agentBinary}`,
      );
    }

    const dockerAvailable =
      runtime !== 'lightweight' && dockerInvocation !== null && (await this.haveDocker());
    if (runtime === 'docker' && !dockerAvailable) {
      throw new Error('Docker sandbox was requested, but its daemon is unavailable');
    }

    const useDocker = runtime === 'docker' || (runtime === 'auto' && dockerAvailable);
    if (useDocker && dockerInvocation) {
      await this.startDockerContainer(resolved, profile, dockerInvocation);
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
      // `docker --version` only proves that the client executable exists. CI
      // images and developer machines can have the CLI without a running
      // daemon, which made every sandboxed command exit with Docker's code
      // 125. Ask the daemon directly before selecting this runtime.
      const result = await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeout: 2000,
      });
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Convert host paths that are meaningful inside the project bind mount to
   * their `/workspace` equivalents. An executable installed elsewhere on the
   * host cannot be invoked from the generic container image, so in that case
   * the caller must use the lightweight runtime instead of claiming Docker
   * isolation while launching a process that can never start.
   */
  private resolveDockerInvocation(): DockerInvocation | null {
    const projectRoot = path.resolve(this.config.projectRoot);
    const toWorkspacePath = (value: string): string | null => {
      if (!path.isAbsolute(value)) return value;

      const relative = path.relative(projectRoot, path.resolve(value));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
      }

      if (relative === '') return '/workspace';
      return path.posix.join('/workspace', ...relative.split(path.sep));
    };

    let binary = this.config.agentBinary;
    if (path.resolve(binary) === path.resolve(process.execPath)) {
      // The official Node sandbox image has Node on PATH, while the host's
      // absolute tool-cache path does not exist inside that image.
      binary = 'node';
    } else if (path.isAbsolute(binary)) {
      const mappedBinary = toWorkspacePath(binary);
      if (mappedBinary === null) return null;
      binary = mappedBinary;
    }

    const args = this.config.agentArgs.map((argument) => toWorkspacePath(argument) ?? argument);
    return { binary, args };
  }

  private async startDockerContainer(
    resolved: ReturnType<typeof resolveProfilePaths>,
    _profile: ReturnType<typeof getProfile>,
    invocation: DockerInvocation,
  ): Promise<void> {
    const cpuQuota = (this.config.resourceLimits.cpuPercent ?? 100) * 1000;
    const memory = `${this.config.resourceLimits.memoryMb ?? 2048}m`;
    const args = [
      'run',
      '--rm',
      '--interactive',
      '--network',
      this.config.networkPolicy.mode === 'deny-all' ? 'none' : 'bridge',
      '--memory',
      memory,
      '--cpus',
      `${(this.config.resourceLimits.cpuPercent ?? 100) / 100}`,
      '--cpu-quota',
      String(cpuQuota),
      '--read-only',
      '--tmpfs',
      '/tmp:size=100m',
      '--mount',
      `type=bind,src=${this.config.projectRoot},dst=/workspace,rw`,
      '--workdir',
      '/workspace',
      '--pids-limit',
      String(this.config.resourceLimits.maxProcesses ?? 20),
      '--env',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ...this.buildEnvFlags(this.config.env),
      'node:20-slim',
      invocation.binary,
      ...invocation.args,
    ];

    this.recordIsolation({
      runtime: 'docker',
      networkMode: this.config.networkPolicy.mode,
      readonlyRootfs: true,
      resolvedPaths: resolved,
    });
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
    this.recordIsolation({
      runtime: 'lightweight',
      unshare: false,
      cgroupV2: this.cgroupPath !== undefined,
      processLimits: profile.process.maxProcesses,
      resolvedPaths: resolved,
    });
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
