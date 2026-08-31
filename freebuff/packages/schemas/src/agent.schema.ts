import { z } from 'zod';

export const CapabilityLevelSchema = z.enum(['supported', 'partial', 'unsupported']);
export const PlatformSchema = z.enum(['linux', 'darwin', 'win32']);

export const AgentCapabilitiesSchema = z.object({
  sessionCreation: CapabilityLevelSchema,
  promptDelivery: CapabilityLevelSchema,
  streaming: CapabilityLevelSchema,
  cancellation: CapabilityLevelSchema,
  diffCollection: CapabilityLevelSchema,
  approvalInterception: CapabilityLevelSchema,
  checkpointRecovery: CapabilityLevelSchema,
  multiTurn: CapabilityLevelSchema,
  fileOperations: CapabilityLevelSchema,
  toolExecution: CapabilityLevelSchema,
});

export const AgentMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.array(PlatformSchema),
  capabilities: AgentCapabilitiesSchema,
  description: z.string().optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  license: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const AgentHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']),
  lastCheckAt: z.coerce.date(),
  issues: z.array(z.string()).optional(),
  checks: z.record(z.string(), z.enum(['pass', 'fail', 'skip'])).optional(),
});

export const AgentInfoSchema = z.object({
  metadata: AgentMetadataSchema,
  installed: z.boolean(),
  installPath: z.string().optional(),
  detectedVersion: z.string().optional(),
  health: AgentHealthSchema,
  lastDetectedAt: z.coerce.date(),
});

export const AgentInstallationResultSchema = z.object({
  success: z.boolean(),
  installedVersion: z.string().optional(),
  path: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .optional(),
});

export const AgentValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  checks: z.record(z.string(), z.boolean()),
});

export function validateAgentMetadata(data: unknown) {
  return AgentMetadataSchema.safeParse(data);
}

export function validateAgentInfo(data: unknown) {
  return AgentInfoSchema.safeParse(data);
}
