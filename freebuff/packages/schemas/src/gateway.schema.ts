import { z } from 'zod';

import { DEFAULT_API_HOST, DEFAULT_API_PORT, DEFAULT_SHUTDOWN_TIMEOUT_MS, GATEWAY_VERSION } from '@freebuff/protocol';

export const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace']);

export const GatewayFeaturesSchema = z.object({
  sandboxIsolation: z.boolean(),
  secretRedaction: z.boolean(),
  approvalWorkflow: z.boolean(),
  checkpointRecovery: z.boolean(),
  localApiServer: z.boolean(),
  tunnelClient: z.boolean(),
});

export const ResourceUsageSchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  memoryMb: z.number().nonnegative(),
  memoryTotalMb: z.number().nonnegative(),
  memoryUsedMb: z.number().nonnegative(),
  activeProcesses: z.number().int().nonnegative(),
  diskUsagePercent: z.number().min(0).max(100),
  loadAverage: z.array(z.number().nonnegative()).length(3),
});

export const SandboxStatusInfoSchema = z.object({
  available: z.boolean(),
  active: z.number().int().nonnegative(),
  totalCreated: z.number().int().nonnegative(),
  totalDestroyed: z.number().int().nonnegative(),
  orphansCleaned: z.number().int().nonnegative(),
});

export const GatewayStatusSchema = z.object({
  version: z.string().default(GATEWAY_VERSION),
  gatewayId: z.string().min(1),
  deviceId: z.string().min(1),
  uptimeMs: z.number().int().nonnegative(),
  startedAt: z.coerce.date(),
  activeSessions: z.number().int().nonnegative(),
  totalSessions: z.number().int().nonnegative(),
  failedSessions: z.number().int().nonnegative(),
  agents: z.array(z.any()),
  resources: ResourceUsageSchema,
  sandbox: SandboxStatusInfoSchema,
  features: GatewayFeaturesSchema,
});

export const ApiServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default(DEFAULT_API_HOST),
  port: z.number().int().positive().default(DEFAULT_API_PORT),
  allowRemote: z.boolean().default(false),
});

export const RedactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  customPatterns: z
    .array(
      z.object({
        name: z.string().min(1),
        pattern: z.string().min(1),
        replacement: z.string().optional(),
      }),
    )
    .optional(),
});

export const GatewayOptionsSchema = z.object({
  gatewayId: z.string().optional(),
  deviceId: z.string().optional(),
  projectRoots: z.array(z.string()).optional(),
  allowedAdapters: z.array(z.string()).optional(),
  sandboxEnabled: z.boolean().default(true),
  apiServer: ApiServerConfigSchema.optional(),
  redaction: RedactionConfigSchema.optional(),
  logLevel: LogLevelSchema.default('info'),
  shutdownTimeoutMs: z.number().int().positive().default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
});

export function validateGatewayOptions(data: unknown) {
  return GatewayOptionsSchema.safeParse(data);
}

export function validateGatewayStatus(data: unknown) {
  return GatewayStatusSchema.safeParse(data);
}
