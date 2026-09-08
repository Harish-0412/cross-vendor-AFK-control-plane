import type { ControlPlaneConfig } from './types';

export const DEFAULT_CONTROL_PLANE_CONFIG: ControlPlaneConfig = {
  host: process.env.CONTROL_PLANE_HOST || '0.0.0.0',
  port: parseInt(process.env.CONTROL_PLANE_PORT || '4000', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-freebuff-control-plane-change-in-prod-2026',
  jwtExpiresInSec: parseInt(process.env.JWT_EXPIRES_IN_SEC || '86400', 10), // 24 hours
  refreshTokenExpiresInSec: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_SEC || '604800', 10), // 7 days
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['*'],
  pairingCodeTtlSec: parseInt(process.env.PAIRING_CODE_TTL_SEC || '300', 10), // 5 mins
  heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '60000', 10), // 60s
};

export function loadConfig(overrides: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig {
  return {
    ...DEFAULT_CONTROL_PLANE_CONFIG,
    ...overrides,
  };
}
