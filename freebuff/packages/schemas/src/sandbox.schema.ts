import { SANDBOX_ID_PREFIX, SANDBOX_ID_LENGTH } from '@freebuff/protocol';
import { z } from 'zod';

import { ResourceLimitsSchema } from './session.schema';

export const SandboxStateSchema = z.enum([
  'creating',
  'running',
  'paused',
  'stopped',
  'destroyed',
  'error',
]);

export const SandboxProfileSchema = z.enum(['strict', 'standard', 'permissive']);
export const NetworkPolicyModeSchema = z.enum(['deny-all', 'allow-list', 'allow-all']);

export const SandboxIdSchema = z
  .string()
  .startsWith(SANDBOX_ID_PREFIX)
  .length(SANDBOX_ID_PREFIX.length + SANDBOX_ID_LENGTH);

export const NetworkPolicySchema = z.object({
  mode: NetworkPolicyModeSchema,
  allowedDomains: z.array(z.string()).optional(),
  allowedPorts: z.array(z.number().int().positive()).optional(),
  allowedHosts: z.array(z.string()).optional(),
  denyLocalhost: z.boolean().optional(),
});

export const SandboxConfigSchema = z.object({
  projectRoot: z.string().min(1),
  agentBinary: z.string().min(1),
  agentArgs: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  resourceLimits: ResourceLimitsSchema,
  networkPolicy: NetworkPolicySchema,
  writablePaths: z.array(z.string()),
  readablePaths: z.array(z.string()),
  deniedPaths: z.array(z.string()),
  profile: SandboxProfileSchema,
  labels: z.record(z.string(), z.string()).optional(),
});

export const SandboxStatusSchema = z.object({
  id: SandboxIdSchema,
  state: SandboxStateSchema,
  pid: z.number().int(),
  projectRoot: z.string().min(1),
  createdAt: z.coerce.date(),
  startedAt: z.coerce.date().optional(),
  stoppedAt: z.coerce.date().optional(),
  destroyedAt: z.coerce.date().optional(),
  uptimeMs: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  error: z.string().optional(),
});

export const SandboxResourceUsageSchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  memoryMb: z.number().nonnegative(),
  memoryPeakMb: z.number().nonnegative(),
  activeProcesses: z.number().int().nonnegative(),
  peakProcesses: z.number().int().nonnegative(),
  openFiles: z.number().int().nonnegative(),
  networkBytesSent: z.number().int().nonnegative(),
  networkBytesReceived: z.number().int().nonnegative(),
  diskReadBytes: z.number().int().nonnegative(),
  diskWriteBytes: z.number().int().nonnegative(),
  measuredAt: z.coerce.date(),
});

export const SandboxCapabilitiesSchema = z.object({
  filesystemIsolation: z.boolean(),
  processIsolation: z.boolean(),
  networkIsolation: z.boolean(),
  cpuLimits: z.boolean(),
  memoryLimits: z.boolean(),
  diskLimits: z.boolean(),
  processLimits: z.boolean(),
  rootless: z.boolean(),
  checkpointRestore: z.boolean(),
});

export function validateSandboxConfig(data: unknown) {
  return SandboxConfigSchema.safeParse(data);
}

export function validateSandboxStatus(data: unknown) {
  return SandboxStatusSchema.safeParse(data);
}

export function validateSandboxId(id: string) {
  return SandboxIdSchema.safeParse(id);
}
