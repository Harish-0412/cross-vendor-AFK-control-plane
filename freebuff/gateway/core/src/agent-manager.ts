import { AGENT_DETECTION_CACHE_TTL_MS } from '@freebuff/config';
import type {
  AgentAdapter,
  AgentInfo,
  AgentHealth,
  AgentInstallationResult,
  AgentValidationResult,
} from '@freebuff/protocol';
import { createDefaultAgentHealth } from '@freebuff/protocol';

interface AgentRecord {
  adapter: AgentAdapter;
  info: AgentInfo;
  lastDetectedAt: Date;
  cacheExpiresAt: Date;
  pendingDetection?: Promise<AgentInfo> | undefined;
}

export class AgentManager {
  private agents: Map<string, AgentRecord> = new Map();
  private cacheTtlMs: number;

  constructor(options: { cacheTtlMs?: number } = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? AGENT_DETECTION_CACHE_TTL_MS;
  }

  register(adapter: AgentAdapter): void {
    const metadata = adapter.metadata();
    const existing = this.agents.get(metadata.id);
    const now = new Date();

    const info: AgentInfo = existing?.info ?? {
      metadata,
      installed: false,
      health: createDefaultAgentHealth(),
      lastDetectedAt: now,
    };

    this.agents.set(metadata.id, {
      adapter,
      info,
      lastDetectedAt: info.lastDetectedAt,
      cacheExpiresAt: new Date(now.getTime() - 1),
    });
  }

  unregister(adapterId: string): boolean {
    return this.agents.delete(adapterId);
  }

  get(adapterId: string): AgentAdapter | undefined {
    return this.agents.get(adapterId)?.adapter;
  }

  getOrThrow(adapterId: string): AgentAdapter {
    const adapter = this.get(adapterId);
    if (!adapter) throw new Error(`Agent adapter not registered: ${adapterId}`);
    return adapter;
  }

  list(): AgentAdapter[] {
    return Array.from(this.agents.values()).map((r) => r.adapter);
  }

  has(adapterId: string): boolean {
    return this.agents.has(adapterId);
  }

  async detectAll(force = false): Promise<AgentInfo[]> {
    const results: AgentInfo[] = [];
    for (const id of Array.from(this.agents.keys())) {
      results.push(await this.detect(id, force));
    }
    return results.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  async detect(adapterId: string, force = false): Promise<AgentInfo> {
    const record = this.agents.get(adapterId);
    if (!record) throw new Error(`Agent adapter not registered: ${adapterId}`);

    if (!force && record.cacheExpiresAt.getTime() > Date.now()) {
      return { ...record.info };
    }

    if (record.pendingDetection) {
      return record.pendingDetection;
    }

    const detection = this.performDetection(record.adapter);
    record.pendingDetection = detection;
    try {
      const info = await detection;
      const now = new Date();
      record.info = info;
      record.lastDetectedAt = now;
      record.cacheExpiresAt = new Date(now.getTime() + this.cacheTtlMs);
      return { ...info };
    } finally {
      record.pendingDetection = undefined;
    }
  }

  listInfos(): AgentInfo[] {
    return Array.from(this.agents.values()).map((r) => ({ ...r.info }));
  }

  private async performDetection(adapter: AgentAdapter): Promise<AgentInfo> {
    const metadata = adapter.metadata();
    const now = new Date();
    const health: AgentHealth = {
      status: 'healthy',
      lastCheckAt: now,
      issues: [],
      checks: {},
    };

    let installResult: AgentInstallationResult;
    try {
      installResult = await adapter.installOrDetect();
    } catch (err) {
      health.status = 'unhealthy';
      health.issues?.push(`Detection failed: ${err instanceof Error ? err.message : String(err)}`);
      health.checks = { detect: 'fail' };
      return {
        metadata,
        installed: false,
        health,
        lastDetectedAt: now,
      };
    }

    health.checks = {
      detect: installResult.success ? 'pass' : 'fail',
    };

    if (!installResult.success) {
      health.status = 'unhealthy';
      if (installResult.error) {
        health.issues?.push(installResult.error.message);
      }
      return {
        metadata,
        installed: false,
        health,
        lastDetectedAt: now,
      };
    }

    if (installResult.warnings && installResult.warnings.length > 0) {
      health.status = 'degraded';
      health.issues = [...(health.issues ?? []), ...installResult.warnings];
    }

    let validation: AgentValidationResult;
    try {
      validation = await adapter.validateEnvironment();
    } catch (err) {
      validation = {
        valid: false,
        errors: [err instanceof Error ? err.message : String(err)],
        warnings: [],
        checks: { environment: false },
      };
    }

    health.checks = {
      ...health.checks,
      ...Object.fromEntries(
        Object.entries(validation.checks).map(([k, v]) => [k, v ? 'pass' : 'fail']),
      ),
    };

    if (!validation.valid) {
      health.status = 'unhealthy';
      health.issues = [...(health.issues ?? []), ...validation.errors];
    } else if (validation.warnings.length > 0 && health.status === 'healthy') {
      health.status = 'degraded';
      health.issues = [...(health.issues ?? []), ...validation.warnings];
    }

    return {
      metadata,
      installed: installResult.success,
      installPath: installResult.path,
      detectedVersion: installResult.installedVersion,
      health,
      lastDetectedAt: now,
    };
  }

  invalidateCache(adapterId?: string): void {
    const now = new Date(Date.now() - 1);
    if (adapterId) {
      const record = this.agents.get(adapterId);
      if (record) record.cacheExpiresAt = now;
    } else {
      for (const record of this.agents.values()) {
        record.cacheExpiresAt = now;
      }
    }
  }

  clear(): void {
    this.agents.clear();
  }

  getRegisteredCount(): number {
    return this.agents.size;
  }

  getInstalledCount(): number {
    return this.listInfos().filter((i) => i.installed).length;
  }
}

export function createAgentManager(
  options?: ConstructorParameters<typeof AgentManager>[0],
): AgentManager {
  return new AgentManager(options);
}
