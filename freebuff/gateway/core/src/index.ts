export * from './gateway';
export * from './session-registry';
export * from './project-manager';
export * from './agent-manager';
export * from './event-bus';
export * from './api-server';

// Re-export new Phase 1 modules
export { CheckpointStore, createCheckpointStore } from '@freebuff/checkpoint';
export type { SessionCheckpoint, CheckpointStoreStats, ReconnectState } from '@freebuff/checkpoint';
export { HealthModule, createHealthModule } from '@freebuff/health';
export type {
  HealthReport,
  HealthStatus,
  ComponentHealth,
  ResourceSnapshot,
} from '@freebuff/health';
export { TunnelClient, createTunnelClient } from '@freebuff/tunnel';
export type { TunnelConfig, TunnelState, TunnelMessage, TunnelStats } from '@freebuff/tunnel';
