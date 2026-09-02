import * as os from 'node:os';

import type {
  HealthReport,
  HealthStatus,
  ComponentHealth,
  ResourceSnapshot,
  HealthCheckFn,
  HealthModuleOptions,
} from './types';
import { DEFAULT_HEALTH_OPTIONS } from './types';

/**
 * HealthModule - Gateway self-monitoring, heartbeat, and resource tracking.
 *
 * Features:
 * - Periodic heartbeat with configurable interval
 * - System resource monitoring (CPU, memory, load, disk)
 * - Pluggable component health checks
 * - Overall health status aggregation
 * - Heartbeat overdue detection
 */
export class HealthModule {
  private readonly gatewayId: string;
  private readonly deviceId: string;
  private readonly startedAt: Date;
  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private heartbeatSequence = 0;
  private lastHeartbeatAt?: Date;
  private heartbeatOverdueThresholdMs: number;
  private componentChecks: Map<string, HealthCheckFn> = new Map();
  private lastResourceSnapshot: ResourceSnapshot;
  private totalEventsProcessed = 0;
  private eventListeners: Set<(report: HealthReport) => void> = new Set();
  private shuttingDown = false;

  constructor(options: HealthModuleOptions) {
    this.gatewayId = options.gatewayId;
    this.deviceId = options.deviceId;
    this.startedAt = new Date();
    this.heartbeatOverdueThresholdMs =
      options.heartbeatOverdueThresholdMs ?? DEFAULT_HEALTH_OPTIONS.heartbeatOverdueThresholdMs;
    this.lastResourceSnapshot = this.takeResourceSnapshot();

    // Register default resource check
    this.registerCheck('resources', () => this.checkResources());

    // Register any custom checks
    if (options.checks) {
      for (const { name, check } of options.checks) {
        this.registerCheck(name, check);
      }
    }

    // Start heartbeat if interval > 0
    const interval = options.heartbeatIntervalMs ?? DEFAULT_HEALTH_OPTIONS.heartbeatIntervalMs;
    if (interval > 0) {
      this.startHeartbeat(interval);
    }
  }

  /**
   * Register a named health check function.
   */
  registerCheck(name: string, check: HealthCheckFn): void {
    this.componentChecks.set(name, check);
  }

  /**
   * Remove a named health check.
   */
  unregisterCheck(name: string): boolean {
    return this.componentChecks.delete(name);
  }

  /**
   * Increment the event counter (called by the gateway for each processed event).
   */
  recordEvent(): void {
    this.totalEventsProcessed++;
  }

  /**
   * Record multiple events at once.
   */
  recordEvents(count: number): void {
    this.totalEventsProcessed += count;
  }

  /**
   * Generate a full health report.
   */
  async getReport(): Promise<HealthReport> {
    const now = new Date();
    const uptimeMs = now.getTime() - this.startedAt.getTime();
    const resources = this.takeResourceSnapshot();
    this.lastResourceSnapshot = resources;

    const components: ComponentHealth[] = [];
    for (const [name, check] of this.componentChecks) {
      try {
        const result = await Promise.race([
          Promise.resolve(check()),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Health check '${name}' timed out (5s)`)), 5000),
          ),
        ]);
        components.push(result);
      } catch (err) {
        components.push({
          name,
          status: 'unhealthy',
          message: err instanceof Error ? err.message : String(err),
          lastCheckedAt: now,
          durationMs: 0,
        });
      }
    }

    const status = this.aggregateHealth(components, resources);
    const heartbeatOverdue = this.isHeartbeatOverdue();

    if (heartbeatOverdue) {
      components.push({
        name: 'heartbeat',
        status: 'degraded',
        message: `Heartbeat overdue by ${this.getHeartbeatOverdueMs()}ms`,
        lastCheckedAt: now,
        durationMs: this.getHeartbeatOverdueMs(),
      });
    }

    return {
      status,
      gatewayId: this.gatewayId,
      deviceId: this.deviceId,
      uptimeMs,
      startedAt: this.startedAt,
      generatedAt: now,
      heartbeatSequence: this.heartbeatSequence,
      components,
      resources,
      activeSessions: 0, // provided by gateway integration
      totalEventsProcessed: this.totalEventsProcessed,
      heartbeatIntervalMs: this.lastHeartbeatAt ? this.getHeartbeatInterval() : 0,
      heartbeatOverdue,
    };
  }

  /**
   * Get the current overall health status (quick check).
   */
  async getStatus(): Promise<HealthStatus> {
    const report = await this.getReport();
    return report.status;
  }

  /**
   * Get the last resource snapshot without re-measuring.
   */
  getLastResourceSnapshot(): ResourceSnapshot {
    return { ...this.lastResourceSnapshot };
  }

  /**
   * Get the current heartbeat sequence number.
   */
  getHeartbeatSequence(): number {
    return this.heartbeatSequence;
  }

  /**
   * Check if the heartbeat is overdue.
   */
  isHeartbeatOverdue(): boolean {
    if (!this.lastHeartbeatAt) return false;
    return this.getHeartbeatOverdueMs() > this.heartbeatOverdueThresholdMs;
  }

  /**
   * Get how long since the last heartbeat in ms.
   */
  getHeartbeatOverdueMs(): number {
    if (!this.lastHeartbeatAt) return 0;
    return Date.now() - this.lastHeartbeatAt.getTime();
  }

  /**
   * Subscribe to periodic health reports.
   */
  onReport(listener: (report: HealthReport) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Start the heartbeat timer.
   */
  private startHeartbeat(intervalMs: number): void {
    const beat = async (): Promise<void> => {
      if (this.shuttingDown) return;
      this.heartbeatSequence++;
      this.lastHeartbeatAt = new Date();

      try {
        const report = await this.getReport();
        for (const listener of this.eventListeners) {
          try {
            listener(report);
          } catch {
            // swallow listener errors
          }
        }
      } catch {
        // swallow heartbeat errors
      }
    };

    this.heartbeatTimer = setInterval(() => {
      void beat();
    }, intervalMs);

    this.heartbeatTimer.unref?.();
    // Trigger immediate first heartbeat
    this.lastHeartbeatAt = new Date();
  }

  /**
   * Get the configured heartbeat interval.
   */
  private getHeartbeatInterval(): number {
    // Return a default if timer isn't running
    return DEFAULT_HEALTH_OPTIONS.heartbeatIntervalMs;
  }

  /**
   * Take a system resource snapshot.
   */
  private takeResourceSnapshot(): ResourceSnapshot {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg();
    const cpus = os.cpus();
    const cpuPercent = Math.min(
      100,
      Math.round(((loadAvg[0] ?? 0) / Math.max(1, cpus.length)) * 100),
    );
    const memoryUsedPercent = Math.round((usedMem / totalMem) * 100);

    const nodeUsage = process.memoryUsage?.();
    const memoryMb = nodeUsage
      ? Math.round(nodeUsage.rss / 1024 / 1024)
      : Math.round(usedMem / 1024 / 1024);

    return {
      cpuPercent,
      memoryMb,
      memoryTotalMb: Math.round(totalMem / 1024 / 1024),
      memoryUsedPercent,
      activeProcesses: 1,
      openFiles: 0,
      loadAverage: [...loadAvg],
      diskUsagePercent: 0,
      measuredAt: new Date(),
    };
  }

  /**
   * Default resource health check.
   */
  private checkResources(): ComponentHealth {
    const now = new Date();
    const resources = this.lastResourceSnapshot;

    const issues: string[] = [];
    let status: HealthStatus = 'healthy';

    if (resources.cpuPercent > 90) {
      issues.push(`CPU usage critically high: ${resources.cpuPercent}%`);
      status = 'unhealthy';
    } else if (resources.cpuPercent > 75) {
      issues.push(`CPU usage elevated: ${resources.cpuPercent}%`);
      status = 'degraded';
    }

    if (resources.memoryUsedPercent > 90) {
      issues.push(`Memory usage critically high: ${resources.memoryUsedPercent}%`);
      status = 'unhealthy';
    } else if (resources.memoryUsedPercent > 80) {
      issues.push(`Memory usage elevated: ${resources.memoryUsedPercent}%`);
      if (status !== 'unhealthy') status = 'degraded';
    }

    return {
      name: 'resources',
      status,
      message: issues.length > 0 ? issues.join('; ') : 'System resources nominal',
      lastCheckedAt: now,
      durationMs: 0,
      metrics: {
        cpuPercent: resources.cpuPercent,
        memoryMb: resources.memoryMb,
        memoryUsedPercent: resources.memoryUsedPercent,
        loadAverage: resources.loadAverage,
      },
      issues: issues.length > 0 ? issues : undefined,
    };
  }

  /**
   * Aggregate component health into a single status.
   */
  private aggregateHealth(
    components: ComponentHealth[],
    _resources: ResourceSnapshot,
  ): HealthStatus {
    if (components.length === 0) return 'healthy';

    let hasUnhealthy = false;
    let hasDegraded = false;

    for (const comp of components) {
      if (comp.status === 'unhealthy') hasUnhealthy = true;
      if (comp.status === 'degraded') hasDegraded = true;
    }

    if (hasUnhealthy) return 'unhealthy';
    if (hasDegraded) return 'degraded';
    return 'healthy';
  }

  /**
   * Shutdown the health module, stopping the heartbeat timer.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- async signature is part of the module contract; teardown is synchronous
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.eventListeners.clear();
    this.componentChecks.clear();
  }
}

export function createHealthModule(options: HealthModuleOptions): HealthModule {
  return new HealthModule(options);
}
