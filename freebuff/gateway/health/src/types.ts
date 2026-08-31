/**
 * Health Module Types
 *
 * Provides heartbeat, resource monitoring, and component health checks
 * for the Gateway. Used for:
 * - Self-monitoring and diagnostics
 * - Control plane health reporting (future tunnel integration)
 * - Alerting when the gateway is degraded
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ComponentHealth {
  /** Component name (e.g., 'session-registry', 'adapter-manager', 'sandbox-manager') */
  name: string;

  /** Current health status */
  status: HealthStatus;

  /** Human-readable description */
  message?: string;

  /** When this check was last performed */
  lastCheckedAt: Date;

  /** How long this component has been in its current status */
  durationMs: number;

  /** Check-specific metrics */
  metrics?: Record<string, unknown>;

  /** Any issues detected */
  issues?: string[];
}

export interface ResourceSnapshot {
  /** CPU usage percentage (0-100) */
  cpuPercent: number;

  /** RSS memory in MB */
  memoryMb: number;

  /** Total system memory in MB */
  memoryTotalMb: number;

  /** Percentage of memory used */
  memoryUsedPercent: number;

  /** Active OS-level processes/threads */
  activeProcesses: number;

  /** Open file descriptors */
  openFiles: number;

  /** Load average [1m, 5m, 15m] */
  loadAverage: number[];

  /** Disk usage percentage */
  diskUsagePercent: number;

  /** When this snapshot was taken */
  measuredAt: Date;
}

export interface HealthReport {
  /** Overall gateway health */
  status: HealthStatus;

  /** Gateway ID */
  gatewayId: string;

  /** Device ID */
  deviceId: string;

  /** Gateway uptime in milliseconds */
  uptimeMs: number;

  /** When the gateway was started */
  startedAt: Date;

  /** When this report was generated */
  generatedAt: Date;

  /** Heartbeat sequence number */
  heartbeatSequence: number;

  /** Per-component health checks */
  components: ComponentHealth[];

  /** Current resource usage */
  resources: ResourceSnapshot;

  /** Active session count */
  activeSessions: number;

  /** Total events processed */
  totalEventsProcessed: number;

  /** Heartbeat interval in ms */
  heartbeatIntervalMs: number;

  /** Whether the heartbeat is currently overdue */
  heartbeatOverdue: boolean;

  /** Any global issues */
  issues?: string[];
}

export interface HealthCheckFn {
  (): ComponentHealth | Promise<ComponentHealth>;
}

export interface HealthModuleOptions {
  /** Gateway ID */
  gatewayId: string;

  /** Device ID */
  deviceId: string;

  /** Heartbeat interval in ms (0 = disabled) */
  heartbeatIntervalMs?: number;

  /** Maximum heartbeat overdue threshold before degraded */
  heartbeatOverdueThresholdMs?: number;

  /** Custom health check functions to register */
  checks?: Array<{ name: string; check: HealthCheckFn }>;
}

export const DEFAULT_HEALTH_OPTIONS: Required<
  Pick<HealthModuleOptions, 'heartbeatIntervalMs' | 'heartbeatOverdueThresholdMs'>
> = {
  heartbeatIntervalMs: 10_000,
  heartbeatOverdueThresholdMs: 30_000,
};
