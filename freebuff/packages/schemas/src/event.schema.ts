import { EVENT_ID_PREFIX, EVENT_ID_LENGTH, EVENT_VERSION } from '@freebuff/protocol';
import { z } from 'zod';

const EventTypeValues = [
  'session.created',
  'session.started',
  'session.status_changed',
  'session.output',
  'session.message',
  'session.tool_call',
  'session.tool_result',
  'session.tool_error',
  'session.file_changed',
  'session.approval_required',
  'session.approval_granted',
  'session.approval_denied',
  'session.checkpoint',
  'session.thinking',
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.crashed',
  'gateway.status',
  'sandbox.created',
  'sandbox.destroyed',
  'policy.violation',
  'system.error',
] as const;

export const EventTypeSchema = z.enum(EventTypeValues);

export const EventIdSchema = z
  .string()
  .startsWith(EVENT_ID_PREFIX)
  .length(EVENT_ID_PREFIX.length + EVENT_ID_LENGTH);

export const SessionOutputPayloadSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  content: z.string(),
  timestamp: z.coerce.date(),
});

export const SessionMessagePayloadSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  thinking: z.string().optional(),
  turnNumber: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ToolCallPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  error: z.string().optional(),
  timestamp: z.coerce.date(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const ToolResultPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});

export const FileChangedPayloadSchema = z.object({
  path: z.string().min(1),
  action: z.enum(['created', 'modified', 'deleted', 'renamed']),
  diff: z.string().optional(),
  oldPath: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  timestamp: z.coerce.date(),
});

export const ApprovalRequiredPayloadSchema = z.object({
  approvalId: z.string().min(1),
  action: z.string().min(1),
  description: z.string().min(1),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  scope: z.string().min(1),
  affectedResources: z.array(z.string()).optional(),
  requiresReason: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  requestedAt: z.coerce.date(),
  toolCallId: z.string().optional(),
});

export const ApprovalDecisionPayloadSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['granted', 'denied']),
  decidedAt: z.coerce.date(),
  decidedBy: z.string().min(1),
  reason: z.string().optional(),
});

export const SessionMetricsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  fileOperations: z.number().int().nonnegative(),
  approvalsRequested: z.number().int().nonnegative(),
  approvalsGranted: z.number().int().nonnegative(),
  approvalsDenied: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative().optional(),
  cacheMisses: z.number().int().nonnegative().optional(),
  latencyP50Ms: z.number().int().nonnegative().optional(),
  latencyP95Ms: z.number().int().nonnegative().optional(),
});

export const SessionCompletedPayloadSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  summary: z.string(),
  turnsCompleted: z.number().int().nonnegative(),
  metrics: SessionMetricsSchema,
});

export const SessionFailedPayloadSchema = z.object({
  errorCode: z.string().min(1),
  errorMessage: z.string().min(1),
  stack: z.string().optional(),
  fatal: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

export const SessionCheckpointPayloadSchema = z.object({
  checkpointId: z.string().min(1),
  turnNumber: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  timestamp: z.coerce.date(),
  digest: z.string().min(1),
});

export const SessionThinkingPayloadSchema = z.object({
  phase: z.enum(['planning', 'analyzing', 'reflecting', 'deciding', 'executing']),
  content: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
  estimatedRemainingMs: z.number().int().nonnegative().optional(),
});

export const PolicyViolationPayloadSchema = z.object({
  policyId: z.string().min(1),
  policyName: z.string().min(1),
  severity: z.enum(['warning', 'error', 'critical']),
  description: z.string().min(1),
  blocked: z.boolean(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const PayloadSchemaMap: Record<string, z.ZodType> = {
  'session.output': SessionOutputPayloadSchema,
  'session.message': SessionMessagePayloadSchema,
  'session.tool_call': ToolCallPayloadSchema,
  'session.tool_result': ToolResultPayloadSchema,
  'session.tool_error': ToolResultPayloadSchema,
  'session.file_changed': FileChangedPayloadSchema,
  'session.approval_required': ApprovalRequiredPayloadSchema,
  'session.approval_granted': ApprovalDecisionPayloadSchema,
  'session.approval_denied': ApprovalDecisionPayloadSchema,
  'session.completed': SessionCompletedPayloadSchema,
  'session.failed': SessionFailedPayloadSchema,
  'session.checkpoint': SessionCheckpointPayloadSchema,
  'session.thinking': SessionThinkingPayloadSchema,
  'policy.violation': PolicyViolationPayloadSchema,
};

export const EventEnvelopeSchema = z.object({
  eventId: EventIdSchema,
  eventType: EventTypeSchema,
  eventVersion: z.number().int().positive().default(EVENT_VERSION),
  sessionId: z.string().min(1),
  deviceId: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.coerce.date(),
  correlationId: z.string().optional(),
  parentEventId: z.string().optional(),
  payload: z.unknown(),
});

export const StrictEventEnvelopeSchema = EventEnvelopeSchema.superRefine((val, ctx) => {
  const payloadSchema = PayloadSchemaMap[val.eventType];
  if (payloadSchema) {
    const result = payloadSchema.safeParse(val.payload);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['payload', ...issue.path],
        });
      }
    }
  }
});

export function validateEvent(data: unknown) {
  return StrictEventEnvelopeSchema.safeParse(data);
}

export function validateEventEnvelope(data: unknown) {
  return EventEnvelopeSchema.safeParse(data);
}

export function validateEventId(id: string) {
  return EventIdSchema.safeParse(id);
}
