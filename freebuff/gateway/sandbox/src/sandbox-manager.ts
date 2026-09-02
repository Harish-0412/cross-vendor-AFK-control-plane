import { SANDBOX_CLEANUP_INTERVAL_MS, DEFAULT_SANDBOX_PROFILE } from '@freebuff/config';
import type {
  SandboxManager as ISandboxManager,
  Sandbox,
  SandboxConfig,
  SandboxState,
  SandboxCapabilities,
  SandboxCleanupReport,
  Platform,
} from '@freebuff/protocol';
import {
  isTerminalSandboxState,
  SANDBOX_PROFILE_DEFAULTS,
  DEFAULT_DENIED_PATHS,
} from '@freebuff/protocol';

import type { PlatformSandboxBase } from './platform-base';
import { createLinuxSandbox } from './platforms/linux';
import { createMacOSSandbox } from './platforms/macos';
import { createWindowsSandbox } from './platforms/windows';
import { getPlatform, getProfile } from './profiles';

export { getProfile, getPlatform, listProfiles } from './profiles';
export type { SandboxCapabilities, SandboxCleanupReport };

type SandboxInstance = PlatformSandboxBase & Sandbox;

export class SandboxManager implements ISandboxManager {
  private readonly sandboxes: Map<string, SandboxInstance> = new Map();
  private totalCreated = 0;
  private totalDestroyed = 0;
  private orphansCleaned = 0;
  private readonly platform: Platform;
  private capabilitiesCache?: SandboxCapabilities;
  private supportedCache?: boolean;
  private cleanupTimer?: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor() {
    this.platform = getPlatform();
  }

  async create(
    config: Partial<SandboxConfig> & Pick<SandboxConfig, 'projectRoot'>,
  ): Promise<Sandbox> {
    if (this.shuttingDown) {
      throw new Error('SandboxManager is shutting down');
    }

    const fullConfig = this.normalizeConfig(config);
    let sandbox: SandboxInstance | null = null;

    switch (this.platform) {
      case 'linux':
        sandbox = createLinuxSandbox(fullConfig) as SandboxInstance | null;
        break;
      case 'darwin':
        sandbox = createMacOSSandbox(fullConfig) as SandboxInstance | null;
        break;
      case 'win32':
        sandbox = createWindowsSandbox(fullConfig) as SandboxInstance | null;
        break;
    }

    if (!sandbox) {
      throw new Error(
        `Sandbox creation failed: no platform implementation available for ${this.platform}`,
      );
    }

    this.sandboxes.set(sandbox.id, sandbox);
    this.totalCreated++;

    try {
      await sandbox.start();
    } catch (err) {
      this.sandboxes.delete(sandbox.id);
      void sandbox.destroy().catch(() => undefined);
      throw err;
    }

    this.ensureCleanupTimer();
    return sandbox;
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;
    try {
      await sandbox.destroy();
    } finally {
      this.sandboxes.delete(sandboxId);
      this.totalDestroyed++;
    }
  }

  get(sandboxId: string): Sandbox | undefined {
    return this.sandboxes.get(sandboxId);
  }

  list(): Sandbox[] {
    return Array.from(this.sandboxes.values());
  }

  async getStatus(sandboxId: string): Promise<import('@freebuff/protocol').SandboxStatus> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }
    return sandbox.getStatus();
  }

  listByState(state: SandboxState): Sandbox[] {
    return this.list().filter(async (s) => (await s.getStatus()).state === state);
  }

  getCapabilities(): SandboxCapabilities {
    if (this.capabilitiesCache) return { ...this.capabilitiesCache };
    const caps: SandboxCapabilities = {
      filesystemIsolation: false,
      processIsolation: false,
      networkIsolation: false,
      cpuLimits: false,
      memoryLimits: false,
      diskLimits: false,
      processLimits: false,
      rootless: false,
      checkpointRestore: false,
    };
    switch (this.platform) {
      case 'linux':
        Object.assign(
          caps,
          (createLinuxSandbox as unknown as { capabilities?: SandboxCapabilities }).capabilities ??
            caps,
        );
        break;
      case 'darwin':
        Object.assign(
          caps,
          (createMacOSSandbox as unknown as { capabilities?: SandboxCapabilities }).capabilities ??
            caps,
        );
        break;
      case 'win32':
        Object.assign(
          caps,
          (createWindowsSandbox as unknown as { capabilities?: SandboxCapabilities })
            .capabilities ?? caps,
        );
        break;
    }
    this.capabilitiesCache = caps;
    return { ...caps };
  }

  getPlatform(): Platform {
    return this.platform;
  }

  async isSupported(): Promise<boolean> {
    if (this.supportedCache !== undefined) return this.supportedCache;
    this.supportedCache = ['linux', 'darwin', 'win32'].includes(this.platform);
    return this.supportedCache;
  }

  async cleanupOrphans(): Promise<number> {
    const start = Date.now();
    let cleaned = 0;
    const toRemove: string[] = [];

    for (const [id, sb] of this.sandboxes.entries()) {
      const alive = await sb.isAlive().catch(() => false);
      if (!alive && isTerminalSandboxState((await sb.getStatus()).state)) {
        toRemove.push(id);
      } else if (!alive) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      try {
        await this.destroy(id);
        cleaned++;
      } catch {
        /* swallow */
      }
    }

    this.orphansCleaned += cleaned;
    void start;
    return cleaned;
  }

  async shutdown(timeoutMs = 30000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    const ids = Array.from(this.sandboxes.keys());
    const deadline = Date.now() + timeoutMs;

    for (const id of ids) {
      if (Date.now() > deadline) break;
      try {
        await this.destroy(id);
      } catch {
        /* swallow */
      }
    }

    if (this.sandboxes.size > 0) {
      const remaining = Array.from(this.sandboxes.values());
      for (const sb of remaining) {
        try {
          await sb.kill();
        } catch {
          /* swallow */
        }
      }
      this.sandboxes.clear();
    }
  }

  getStats() {
    return {
      active: this.sandboxes.size,
      totalCreated: this.totalCreated,
      totalDestroyed: this.totalDestroyed,
      orphansCleaned: this.orphansCleaned,
    };
  }

  private normalizeConfig(
    partial: Partial<SandboxConfig> & Pick<SandboxConfig, 'projectRoot'>,
  ): SandboxConfig {
    const profile = partial.profile ?? DEFAULT_SANDBOX_PROFILE;
    const defaults = SANDBOX_PROFILE_DEFAULTS[profile];
    const profileInfo = getProfile(profile);

    return {
      projectRoot: partial.projectRoot,
      agentBinary: partial.agentBinary ?? 'node',
      agentArgs: partial.agentArgs ?? [],
      env: partial.env ?? {},
      resourceLimits: {
        ...defaults.resourceLimits,
        ...(partial.resourceLimits ?? {}),
      },
      networkPolicy: partial.networkPolicy ?? {
        mode: defaults.networkMode,
        allowedDomains: profileInfo.network.allowedHosts,
        allowedPorts: profileInfo.network.allowedPorts,
        allowedHosts: profileInfo.network.allowedHosts,
        denyLocalhost: profileInfo.network.denyLocalhost,
      },
      writablePaths: partial.writablePaths ?? profileInfo.filesystem.writePaths,
      readablePaths: partial.readablePaths ?? profileInfo.filesystem.readPaths,
      deniedPaths: [
        ...(partial.deniedPaths ?? []),
        ...profileInfo.filesystem.denyPaths,
        ...DEFAULT_DENIED_PATHS,
      ],
      profile,
      labels: partial.labels,
    };
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer || this.shuttingDown) return;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOrphans().catch(() => undefined);
    }, SANDBOX_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }
}

export function createSandboxManager(): SandboxManager {
  return new SandboxManager();
}
