import { COMMAND_ID_PREFIX, COMMAND_ID_LENGTH, COMMAND_VERSION } from '@freebuff/protocol';
import { z } from 'zod';

export const CommandTypeSchema = z.enum([
  'session.start',
  'session.stop',
  'session.pause',
  'session.resume',
  'session.message',
  'session.approve',
  'session.deny',
  'session.input',
  'system.ping',
  'system.shutdown',
]);

export const CommandIdSchema = z
  .string()
  .startsWith(COMMAND_ID_PREFIX)
  .length(COMMAND_ID_PREFIX.length + COMMAND_ID_LENGTH);

export const StartSessionCommandSchema = z.object({
  config: z.object({
    projectRoot: z.string().min(1),
    adapter: z.string().min(1),
    prompt: z.string().optional(),
  }),
});

export const StopSessionCommandSchema = z.object({
  reason: z.string().optional(),
  force: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const SendMessageCommandSchema = z.object({
  message: z.string().min(1),
  role: z.enum(['user', 'system']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ApprovalDecisionCommandSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['granted', 'denied']),
  reason: z.string().optional(),
  decidedBy: z.string().optional(),
});

export const SessionInputCommandSchema = z.object({
  data: z.string(),
  stream: z.enum(['stdin', 'control']),
});

export const CommandResultSchema = z.object({
  commandId: CommandIdSchema,
  success: z.boolean(),
  executedAt: z.coerce.date(),
  completedAt: z.coerce.date(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .optional(),
});

export const CommandEnvelopeSchema = z.object({
  commandId: CommandIdSchema,
  commandType: CommandTypeSchema,
  commandVersion: z.number().int().positive().default(COMMAND_VERSION),
  sessionId: z.string().optional(),
  targetAgentId: z.string().optional(),
  issuedAt: z.coerce.date(),
  correlationId: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  payload: z.unknown(),
});

export function validateCommand(data: unknown) {
  return CommandEnvelopeSchema.safeParse(data);
}

export function validateCommandResult(data: unknown) {
  return CommandResultSchema.safeParse(data);
}

export function validateCommandId(id: string) {
  return CommandIdSchema.safeParse(id);
}
