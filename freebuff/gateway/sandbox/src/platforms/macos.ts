import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SandboxCapabilities, SandboxConfig } from '@freebuff/protocol';

import { PlatformSandboxBase } from '../platform-base';
import { getProfile, resolveProfilePaths, getHomeDir } from '../profiles';

const execFileAsync = promisify(execFile);

export class MacOSSandbox extends PlatformSandboxBase {
  static readonly capabilities: SandboxCapabilities = {
    filesystemIsolation: true,
    processIsolation: true,
    networkIsolation: false,
    cpuLimits: false,
    memoryLimits: false,
    diskLimits: false,
    processLimits: true,
    rootless: true,
    checkpointRestore: false,
  };

  get capabilities(): SandboxCapabilities {
    return { ...MacOSSandbox.capabilities };
  }

  static isSupported(): boolean {
    return process.platform === 'darwin';
  }

  private seatbeltProfilePath?: string;

  async start(): Promise<void> {
    await this.ensureProjectRoot();
    const profile = getProfile(this.config.profile);
    const resolved = resolveProfilePaths(profile, this.config.projectRoot, getHomeDir());

    this.seatbeltProfilePath = await this.writeSeatbeltProfile(resolved);

    const sandboxExists = await this.commandExists('sandbox-exec');
    if (sandboxExists) {
      const args = [
        '-f',
        this.seatbeltProfilePath,
        '-p',
        `(version 1) (allow default)`,
        this.config.agentBinary,
        ...this.config.agentArgs,
      ];
      this.recordIsolation({
        runtime: 'seatbelt',
        seatbeltProfile: this.seatbeltProfilePath,
        resolvedPaths: resolved,
      });
      this.spawnProcess('sandbox-exec', args, this.buildEnv());
    } else {
      this.recordIsolation({
        runtime: 'direct',
        resolvedPaths: resolved,
        warning: 'sandbox-exec not available, using direct execution',
      });
      this.spawnProcess(this.config.agentBinary, this.config.agentArgs, this.buildEnv());
    }
  }

  protected async refreshResourceUsage(): Promise<void> {
    const now = new Date();
    if (!this.process || this.pid === 0) {
      this.resourceSample.measuredAt = now;
      return;
    }
    try {
      const result = await execFileAsync(
        'ps',
        ['-o', 'pid=,%cpu=,rss=,thcount=', '-p', String(this.pid)],
        { timeout: 1000 },
      );
      const line = result.stdout.trim().split(/\s+/).filter(Boolean);
      if (line.length >= 4) {
        const cpuPercent = Math.min(100, Number(line[1] ?? 0));
        const rssKb = Number(line[2] ?? 0);
        const threads = Number(line[3] ?? 1);
        const memoryMb = Math.round(rssKb / 1024);
        this.peakMemory = Math.max(this.peakMemory, memoryMb);
        this.peakProcesses = Math.max(this.peakProcesses, threads);

        this.resourceSample = {
          cpuPercent,
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

  private buildEnv(): Record<string, string> {
    return {
      ...this.config.env,
      HOME: this.config.projectRoot,
      TMPDIR: `${this.config.projectRoot}/tmp`,
      PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
    };
  }

  private async commandExists(cmd: string): Promise<boolean> {
    try {
      await execFileAsync('which', [cmd], { timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }

  private async writeSeatbeltProfile(
    resolved: ReturnType<typeof resolveProfilePaths>,
  ): Promise<string> {
    const profile = this.config.profile;
    const workspace = this.config.projectRoot;
    const deny = resolved.filesystem.denyPaths
      .map((p) => `(deny file-read* (literal "${p}"))`)
      .join('\n');
    const allowWrites = resolved.filesystem.writePaths
      .filter((p) => !p.includes('$'))
      .map((p) => `(allow file-write* (subpath "${p}"))`)
      .join('\n');
    const networkBlock =
      this.config.networkPolicy.mode === 'deny-all'
        ? '(deny network*)'
        : this.config.networkPolicy.mode === 'allow-list'
          ? `(allow network-outbound (regex "(${(
              this.config.networkPolicy.allowedHosts ?? ['localhost', '127.0.0.1']
            )
              .map((h) => h.replace(/\./g, '\\.'))
              .join('|')})"))`
          : '';
    const seatbelt = `
(version 1)
(debug deny)
(allow default)
${deny}
${allowWrites}
${networkBlock}
(deny process-exec (regex "^(/usr|/sbin|/bin)/(sudo|su|doas|ssh|scp|rsync)$"))
; Profile: ${profile}, Workspace: ${workspace}
`;
    const filePath = `${workspace}/.freebuff-sb-${Date.now()}.sb`;
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(filePath, seatbelt, { mode: 0o600 }),
    );
    return filePath;
  }
}

export function createMacOSSandbox(config: SandboxConfig): MacOSSandbox | null {
  if (!MacOSSandbox.isSupported()) return null;
  return new MacOSSandbox(config);
}
