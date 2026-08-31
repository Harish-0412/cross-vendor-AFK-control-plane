import { z } from 'zod';

import {
  SESSION_ID_PREFIX,
  SESSION_ID_LENGTH,
} from '@freebuff/protocol';

export const SessionStateSchema = z.enum([
  'initializing',
  'running',
  'waiting_for_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'crashed',
]);

export const ResourceLimitsSchema = z.object({
  cpuPercent: z.number().int().min(1).max(100).optional(),
  memoryMb: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxFileSize: z.number().int().positive().optional(),
  maxProcesses: z.number().int().positive().optional(),
  maxOpenFiles: z.number().int().positive().optional(),
});

export const SandboxConfigRefSchema = z.object({
  profile: z.enum(['strict', 'standard', 'permissive']),
  networkPolicy: z.enum(['none', 'localhost', 'outbound', 'full']).optional(),
});

export const SessionConfigSchema = z.object({
  projectRoot: z.string().min(1),
  adapter: z.string().min(1),
  prompt: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
  resourceLimits: ResourceLimitsSchema.optional(),
  sandbox: SandboxConfigRefSchema.optional(),
  approvalMode: z.enum(['auto', 'ask', 'never']).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SessionErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  stack: z.string().optional(),
  fatal: z.boolean(),
  retryable: z.boolean(),
});

export const SessionIdSchema = z
  .string()
  .startsWith(SESSION_ID_PREFIX)
  .length(SESSION_ID_PREFIX.length + SESSION_ID_LENGTH);

export const SessionSchema = z.object({
  id: SessionIdSchema,
  projectId: z.string().min(1),
  adapterId: z.string().min(1),
  state: SessionStateSchema,
  processId: z.number().int().optional(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date().optional(),
  sandboxId: z.string().optional(),
  sequenceNumber: z.number().int().nonnegative(),
  lastEventAt: z.coerce.date().optional(),
  error: SessionErrorSchema.optional(),
  metadata: z.record(z.string(), z.unknown()),
});

export const SessionFilterSchema = z.object({
  projectId: z.string().optional(),
  adapterId: z.string().optional(),
  state: z.array(SessionStateSchema).optional(),
  startedAfter: z.coerce.date().optional(),
  startedBefore: z.coerce.date().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const SessionSummarySchema = z.object({
  id: SessionIdSchema,
  state: SessionStateSchema,
  adapterId: z.string().min(1),
  projectId: z.string().min(1),
  startTime: z.coerce.date(),
  endTime: z.coerce.date().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  eventCount: z.number().int().nonnegative(),
  lastEventType: z.string().optional(),
});

export function validateSession(data: unknown) {
  return SessionSchema.safeParse(data);
}

export function validateSessionConfig(data: unknown) {
  return SessionConfigSchema.safeParse(data);
}

export function validateSessionId(id: string) {
  return SessionIdSchema.safeParse(id);
}
