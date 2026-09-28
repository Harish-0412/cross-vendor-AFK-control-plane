/**
 * Agent Trace records for Odysseus sessions and commits.
 *
 * A session's record covers its working-tree diff (from the review bundle)
 * and is built on request; a commit's record covers exactly what Odysseus
 * committed, is attached to the commit as a git note on the workstation, and
 * is kept here too. Both carry, under `dev.odysseus`, the session, the agent
 * and every approval decided along the way — so a line answers "which agent
 * wrote this, and who approved it?"
 */
import { randomUUID } from 'node:crypto';

import {
  buildAgentTrace,
  GATEWAY_VERSION,
  ODYSSEUS_TRACE_NAMESPACE,
  traceModelId,
  type AgentTraceContributor,
  type AgentTraceRecord,
  type OdysseusTraceMetadata,
} from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { SessionRecord } from '../types';

const COLLECTION = 'agent_traces';

interface StoredTrace {
  kind: 'session' | 'commit';
  sessionId: string;
  /** For session records: the review bundle the record was built from. */
  bundleGeneratedAt?: string;
  record: AgentTraceRecord;
}

export interface CommitResult {
  hash: string;
  diff: string;
  diffTruncated?: boolean;
}

export class AgentTraces {
  constructor(
    private readonly db: IDatabase,
    private readonly tunnel: TunnelServer,
    private readonly options: { frontendUrl?: string | undefined } = {},
  ) {}

  /** The session's record and one per commit Odysseus made for it. */
  async list(
    session: SessionRecord,
  ): Promise<{ session: AgentTraceRecord | null; commits: AgentTraceRecord[] }> {
    const stored = await this.db.documents.listByUser<StoredTrace>(COLLECTION, session.userId);
    const commits = stored
      .map((item) => item.data)
      .filter((item) => item.kind === 'commit' && item.sessionId === session.id)
      .map((item) => item.record)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { session: await this.forSession(session), commits };
  }

  /**
   * The record for a session's working tree, from its review bundle's diff.
   * Rebuilt only when the bundle is, so its id stays stable between requests.
   */
  async forSession(session: SessionRecord): Promise<AgentTraceRecord | null> {
    const bundle = session.reviewBundle;
    if (!bundle?.diff) return null;
    const generatedAt = new Date(bundle.generatedAt).toISOString();
    const id = `trace_session_${session.id}`;
    const existing = await this.db.documents.get<StoredTrace>(COLLECTION, id);
    if (existing?.data.bundleGeneratedAt === generatedAt) return existing.data.record;

    const record = buildAgentTrace({
      id: randomUUID(),
      timestamp: new Date(),
      diff: bundle.diff,
      contributor: await this.contributor(session),
      ...this.conversation(session),
      tool: { name: 'odysseus', version: GATEWAY_VERSION },
      metadata: { [ODYSSEUS_TRACE_NAMESPACE]: await this.evidence(session, false) },
    });
    await this.db.documents.put<StoredTrace>(COLLECTION, id, session.userId, {
      kind: 'session',
      sessionId: session.id,
      bundleGeneratedAt: generatedAt,
      record,
    });
    return record;
  }

  /**
   * After Odysseus commits for a session: build the record for exactly what
   * was committed, attach it to the commit as a git note, and keep it.
   */
  async recordCommit(session: SessionRecord, result: CommitResult): Promise<AgentTraceRecord> {
    const record = buildAgentTrace({
      id: randomUUID(),
      timestamp: new Date(),
      diff: result.diff,
      contributor: await this.contributor(session),
      ...this.conversation(session),
      vcs: { type: 'git', revision: result.hash },
      tool: { name: 'odysseus', version: GATEWAY_VERSION },
      metadata: {
        [ODYSSEUS_TRACE_NAMESPACE]: {
          ...(await this.evidence(session, true)),
          ...(result.diffTruncated ? { truncated: true } : {}),
        },
      },
    });
    await this.db.documents.put<StoredTrace>(
      COLLECTION,
      `trace_commit_${result.hash}`,
      session.userId,
      {
        kind: 'commit',
        sessionId: session.id,
        record,
      },
    );
    await this.tunnel.sendCommandToDevice(session.deviceId, 'git.trace_note', {
      sessionId: session.id,
      projectRoot: session.projectRoot,
      revision: result.hash,
      record,
    });
    return record;
  }

  private conversation(session: SessionRecord): { conversationUrl?: string } {
    const base = this.options.frontendUrl?.replace(/\/+$/, '');
    return base ? { conversationUrl: `${base}/sessions/${encodeURIComponent(session.id)}` } : {};
  }

  /** The agent, and the model it said it was running when it said so. */
  private async contributor(session: SessionRecord): Promise<AgentTraceContributor> {
    const events = await this.db.events.listBySession(session.id, 0, 50).catch(() => []);
    let model: string | undefined;
    for (const event of events) {
      const payload = event.envelope.payload as { model?: unknown } | undefined;
      if (typeof payload?.model === 'string' && payload.model) {
        model = payload.model;
        break;
      }
    }
    const modelId = traceModelId(session.agentId, model);
    return { type: 'ai', ...(modelId ? { model_id: modelId } : {}) };
  }

  /** Who approved what during the session. Names, never email addresses. */
  private async evidence(
    session: SessionRecord,
    committed: boolean,
  ): Promise<OdysseusTraceMetadata> {
    const approvals = await this.db.approvals.listBySession(session.id);
    const names = new Map<string, string>();
    const nameOf = async (id: string | undefined): Promise<string | undefined> => {
      if (!id || id === 'policy' || id === 'system') return id;
      if (!names.has(id))
        names.set(id, (await this.db.users.findById(id))?.name ?? 'a team member');
      return names.get(id);
    };
    return {
      sessionId: session.id,
      agentId: session.agentId,
      deviceId: session.deviceId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      committed,
      approvals: await Promise.all(
        approvals
          .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
          .map(async (approval) => {
            const risk = approval.details?.['risk'] as { level?: unknown } | undefined;
            const level =
              typeof risk?.level === 'string' ? risk.level : approval.details?.['riskClass'];
            const decidedBy = await nameOf(approval.decidedBy);
            return {
              id: approval.id,
              action: approval.actionType,
              description: approval.description,
              ...(typeof level === 'string' ? { riskLevel: level } : {}),
              decision: approval.status,
              ...(decidedBy ? { decidedBy } : {}),
              ...(approval.decidedAt ? { decidedAt: approval.decidedAt.toISOString() } : {}),
            };
          }),
      ),
    };
  }
}
