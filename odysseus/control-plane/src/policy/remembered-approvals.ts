/**
 * "Approve and remember": one tap turns an approval into a narrow standing
 * rule, so the same agent doing exactly the same thing does not ask again.
 *
 * The rules are deliberately small:
 *
 *  - They match exactly one command, path, branch or step kind — never a
 *    pattern — plus the agent and the project (or session) it was approved in.
 *  - They never approve more risk than the approval they came from, so a rule
 *    made for `git push origin feature/x` cannot approve a force-push.
 *  - Critical actions cannot be remembered at all.
 *  - They only turn "ask a person" into "allow". The deny floor and every
 *    deny rule run first, so a remembered rule can never unblock a denial.
 *  - Project rules expire after 30 days; session rules end with the session.
 *
 * They are the user's own: stored per user, listed and revoked from the
 * Approvals page, and every use is written to the audit log by the policy
 * service.
 */
import { randomUUID } from 'node:crypto';

import { isCapability, isRiskClass } from '@odysseus/policy-engine';
import type { RiskClass } from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import type { ApprovalRecord, SessionRecord } from '../types';

export type RememberScope = 'session' | 'project';

export interface RememberedApproval {
  id: string;
  userId: string;
  /** The capability approved, e.g. `process.exec` or `git.push`. */
  capability: string;
  /** Exactly the command approved, with whitespace collapsed. */
  command?: string;
  /** Exactly the path, branch, pull request or `orchestration:<role>` approved. */
  resource?: string;
  agentId?: string;
  projectId?: string;
  /** Session rules match only their own session. */
  sessionId?: string;
  scope: RememberScope;
  /** The risk of what was approved; the rule never approves more. */
  maxRiskLevel: RiskClass;
  description: string;
  createdAt: string;
  createdFromApprovalId: string;
  expiresAt?: string;
  uses: number;
  lastUsedAt?: string;
}

export interface RememberMatchInput {
  userId: string;
  capability: string;
  riskClass: RiskClass;
  command?: string | undefined;
  resource?: string | undefined;
  agentId?: string | undefined;
  projectId?: string | undefined;
  sessionId?: string | undefined;
}

export class RememberError extends Error {}

const PROJECT_RULE_DAYS = 30;
const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const COLLECTION = 'remembered_approvals';

export class RememberedApprovals {
  constructor(
    private readonly db: IDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Make a rule from an approval the user has just granted. */
  async remember(
    approval: ApprovalRecord,
    session: SessionRecord,
    scope: RememberScope,
  ): Promise<RememberedApproval> {
    if (approval.status !== 'granted')
      throw new RememberError('Only a granted approval can be remembered');
    const details = approval.details ?? {};
    const risk = details['risk'] as { level?: unknown } | undefined;
    const level = isRiskClass(risk?.level) ? risk.level : details['riskClass'];
    if (!isRiskClass(level))
      throw new RememberError('Odysseus cannot tell how risky this is, so it cannot remember it');
    if (level === 'critical')
      throw new RememberError('Critical actions always need a person; they cannot be remembered');

    const capability = isCapability(details['capability'])
      ? details['capability']
      : isCapability(approval.actionType)
        ? approval.actionType
        : undefined;
    if (!capability) throw new RememberError('This kind of approval cannot be remembered');
    const command =
      typeof details['command'] === 'string' ? normalise(details['command']) : undefined;
    const resource = typeof details['resource'] === 'string' ? details['resource'] : undefined;
    if (!command && !resource)
      throw new RememberError(
        'Odysseus cannot see exactly what was approved, so it cannot remember it',
      );

    const effectiveScope: RememberScope =
      scope === 'project' && session.projectId ? 'project' : 'session';
    const now = this.now();
    const rule: RememberedApproval = {
      id: `rem_${randomUUID().replace(/-/g, '')}`,
      userId: approval.userId,
      capability,
      ...(command ? { command } : { resource: resource! }),
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(effectiveScope === 'project'
        ? { projectId: session.projectId! }
        : { sessionId: session.id }),
      scope: effectiveScope,
      maxRiskLevel: level,
      description: describe(session.agentId, capability, command, resource, effectiveScope),
      createdAt: now.toISOString(),
      createdFromApprovalId: approval.id,
      ...(effectiveScope === 'project'
        ? { expiresAt: new Date(now.getTime() + PROJECT_RULE_DAYS * 86_400_000).toISOString() }
        : {}),
      uses: 0,
    };
    await this.db.documents.put(COLLECTION, rule.id, rule.userId, rule);
    return rule;
  }

  /** The user's rules that are still in force, newest first. */
  async list(userId: string): Promise<RememberedApproval[]> {
    const now = this.now().getTime();
    const records = await this.db.documents.listByUser<RememberedApproval>(COLLECTION, userId);
    return records
      .map((record) => record.data)
      .filter((rule) => !rule.expiresAt || Date.parse(rule.expiresAt) > now)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async revoke(userId: string, id: string): Promise<RememberedApproval | null> {
    const record = await this.db.documents.get<RememberedApproval>(COLLECTION, id);
    if (!record || record.userId !== userId) return null;
    await this.db.documents.delete(COLLECTION, id);
    return record.data;
  }

  /** The rule that allows this action without asking, if there is one. */
  async match(input: RememberMatchInput): Promise<RememberedApproval | null> {
    if (!input.command && !input.resource) return null;
    const command = input.command ? normalise(input.command) : undefined;
    for (const rule of await this.list(input.userId)) {
      if (rule.capability !== input.capability) continue;
      if (RISK_ORDER[input.riskClass] > RISK_ORDER[rule.maxRiskLevel]) continue;
      if (rule.command !== undefined ? rule.command !== command : rule.resource !== input.resource)
        continue;
      if (rule.agentId && rule.agentId !== input.agentId) continue;
      if (rule.projectId && rule.projectId !== input.projectId) continue;
      if (rule.sessionId && rule.sessionId !== input.sessionId) continue;
      const used = { ...rule, uses: rule.uses + 1, lastUsedAt: this.now().toISOString() };
      await this.db.documents.put(COLLECTION, rule.id, rule.userId, used);
      return used;
    }
    return null;
  }
}

function normalise(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function describe(
  agentId: string | undefined,
  capability: string,
  command: string | undefined,
  resource: string | undefined,
  scope: RememberScope,
): string {
  const who = agentId ?? 'This agent';
  const what = command
    ? `run \`${command.length > 60 ? `${command.slice(0, 59)}…` : command}\``
    : resource?.startsWith('orchestration:')
      ? `start ${resource.slice('orchestration:'.length)} steps`
      : `${VERBS[capability] ?? capability} ${resource}`;
  const where =
    scope === 'project' ? `in this project for ${PROJECT_RULE_DAYS} days` : 'in this session';
  return `${who} may ${what} ${where}`;
}

const VERBS: Record<string, string> = {
  'filesystem.read': 'read',
  'filesystem.write': 'write',
  'filesystem.delete': 'delete',
  'network.access': 'connect to',
  'package.install': 'install',
  'git.commit': 'commit to',
  'git.push': 'push to',
  'git.branch_create': 'create branch',
  'git.pull_request_create': 'open pull request',
  'secret.read': 'read secret',
  'deployment.execute': 'deploy to',
};
