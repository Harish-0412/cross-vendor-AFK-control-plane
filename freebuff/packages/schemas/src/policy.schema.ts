import { z } from 'zod';

/**
 * §7 — Policy API schemas.
 *
 * Zod schemas for the policy/audit API request/response bodies,
 * added to @freebuff/schemas alongside the existing
 * command/device/event/session schemas.
 */

/** A single policy rule (match + effect) */
export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  match: z.object({
    capability: z
      .enum([
        'filesystem.read',
        'filesystem.write',
        'filesystem.delete',
        'process.exec',
        'network.access',
        'package.install',
        'git.commit',
        'git.push',
        'git.branch_create',
        'git.pull_request_create',
        'deployment.execute',
        'secret.read',
      ])
      .optional(),
    riskClass: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    resourcePattern: z.string().optional(),
    projectId: z.string().optional(),
    trustProfile: z
      .enum(['supervised', 'trusted-afk', 'read-only', 'locked', 'default'])
      .optional(),
  }),
  effect: z.enum(['allow', 'deny', 'require_approval']),
  requiredRole: z.enum(['owner', 'admin']).optional(),
  priority: z.number().int().min(0).max(1000),
});

/** Request body for creating a new policy version */
export const CreatePolicyVersionSchema = z.object({
  description: z.string().min(1).max(500),
  rules: z.array(PolicyRuleSchema).max(100),
});

/** Response body for a policy version */
export const PolicyVersionSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  ruleCount: z.number().int(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
  isActive: z.boolean(),
});

/** Response body for the active policy version */
export const ActivePolicyVersionSchema = PolicyVersionSchema;

/** Decision response from policy evaluation */
export const PolicyEvaluateResponseSchema = z.object({
  decision: z.enum(['allow', 'deny', 'require_approval']),
  policyVersion: z.string(),
  reason: z.string().optional(),
  requiredRole: z.enum(['owner', 'admin']).optional(),
  expiresAt: z.string().datetime().optional(),
  matchedRules: z.array(z.string()).optional(),
});

/** Request body for policy evaluation (internal, Gateway→Control-Plane) */
export const PolicyEvaluateRequestSchema = z.object({
  capability: z
    .enum([
      'filesystem.read',
      'filesystem.write',
      'filesystem.delete',
      'process.exec',
      'network.access',
      'package.install',
      'git.commit',
      'git.push',
      'git.branch_create',
      'git.pull_request_create',
      'deployment.execute',
      'secret.read',
    ])
    .optional(),
  riskClass: z.enum(['low', 'medium', 'high', 'critical']).optional().default('low'),
  resource: z.string().optional(),
  force: z.boolean().optional(),
  projectId: z.string().optional(),
  trustProfile: z
    .enum(['supervised', 'trusted-afk', 'read-only', 'locked', 'default'])
    .optional()
    .default('default'),
  deviceId: z.string().min(1),
  sessionId: z.string().optional(),
  userId: z.string().min(1),
});

/** Audit event entry */
export const AuditEventSchema = z.object({
  id: z.string(),
  sequence: z.number().int().min(1),
  timestamp: z.string().datetime(),
  actor: z.object({
    type: z.enum(['user', 'device', 'system']),
    id: z.string(),
  }),
  sessionId: z.string().optional(),
  deviceId: z.string().optional(),
  action: z.string(),
  decision: z.enum(['allow', 'deny', 'require_approval', 'granted', 'denied', 'timeout']),
  policyVersion: z.string().optional(),
  matchedRules: z.array(z.string()).optional(),
  previousHash: z.string().length(64),
  hash: z.string().length(64),
});

/** Audit verify response */
export const AuditVerifyResponseSchema = z.object({
  valid: z.boolean(),
  firstBrokenIndex: z.number().int().optional(),
  timestamp: z.string().datetime(),
});

/** Audit list query parameters */
export const AuditListQuerySchema = z.object({
  sessionId: z.string().optional(),
  deviceId: z.string().optional(),
  actorType: z.enum(['user', 'device', 'system']).optional(),
  actorId: z.string().optional(),
  decision: z
    .enum(['allow', 'deny', 'require_approval', 'granted', 'denied', 'timeout'])
    .optional(),
  fromSequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

/** Types derived from schemas */
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type CreatePolicyVersionRequest = z.infer<typeof CreatePolicyVersionSchema>;
export type PolicyVersionResponse = z.infer<typeof PolicyVersionSchema>;
export type PolicyEvaluateResponse = z.infer<typeof PolicyEvaluateResponseSchema>;
export type PolicyEvaluateRequest = z.infer<typeof PolicyEvaluateRequestSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponseSchema>;
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;
