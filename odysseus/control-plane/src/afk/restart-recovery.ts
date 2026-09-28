/**
 * Sessions that survive a reboot.
 *
 * When a gateway reconnects, the Control Plane asks it what it lost: the
 * sessions still in its on-disk journal from before it stopped abruptly
 * (the machine restarted, or the gateway was killed), and which sessions it
 * is actually running now.
 *
 *  - An interrupted session is marked crashed, its pending approvals are
 *    superseded, and the work continues in a new session on the same machine
 *    and folder. The continuation is started like any other session —
 *    through risk, policy and, where policy says so, an approval — and
 *    resumes the same agent conversation when the agent supports it
 *    (Claude Code `--resume`, Codex threads).
 *  - A session the Control Plane thinks is running but the gateway has no
 *    trace of is marked crashed too, instead of showing "running" forever.
 */
import type { TaskKind } from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { SessionRecord } from '../types';

export interface InterruptedSession {
  sessionId: string;
  adapter: string;
  projectRoot: string;
  prompt?: string;
  nativeSessionId?: string;
  startedAt: string;
}

export interface ContinuationStarter {
  startSession(input: {
    userId: string;
    deviceId: string;
    agentId: string;
    projectId?: string | undefined;
    projectRoot: string;
    prompt: string;
    taskKind: TaskKind;
    purpose: string;
    metadata: Record<string, unknown>;
  }): Promise<{ sessionId: string; state: string; error?: string }>;
}

export interface RecoveryResult {
  continued: Array<{ from: string; to: string; state: string; resumedConversation: boolean }>;
  lost: string[];
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'crashed']);
/** Sessions younger than this may still be starting on the gateway. */
const START_GRACE_MS = 60_000;

export class RestartRecovery {
  constructor(
    private readonly db: IDatabase,
    private readonly tunnel: TunnelServer,
    private readonly starter: ContinuationStarter,
    private readonly notify: (userId: string, message: Record<string, unknown>) => void = () =>
      undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async onGatewayConnected(deviceId: string): Promise<RecoveryResult> {
    const result: RecoveryResult = { continued: [], lost: [] };
    const device = await this.db.devices.findById(deviceId);
    if (!device) return result;
    const reply = await this.tunnel.sendCommandToDevice(
      deviceId,
      'session.interrupted',
      {},
      10_000,
    );
    const payload = unwrap(reply.payload) as
      { interrupted?: InterruptedSession[]; active?: string[] } | undefined;
    // A gateway too old to answer knows nothing to recover.
    if (!reply.acknowledged || !payload || !Array.isArray(payload.active)) return result;
    const active = new Set(payload.active);
    const interrupted = (payload.interrupted ?? []).filter(
      (entry) => typeof entry?.sessionId === 'string',
    );

    for (const entry of interrupted) {
      const session = await this.db.sessions.findById(entry.sessionId);
      if (!session || session.userId !== device.userId || TERMINAL.has(session.state)) continue;
      const continued = await this.continueSession(session, entry);
      if (continued) result.continued.push(continued);
    }

    const recovered = new Set(interrupted.map((entry) => entry.sessionId));
    for (const session of await this.db.sessions.listByDevice(deviceId)) {
      if (TERMINAL.has(session.state) || active.has(session.id) || recovered.has(session.id))
        continue;
      if (this.now().getTime() - session.startedAt.getTime() < START_GRACE_MS) continue;
      if (await this.awaitingStart(session.id)) continue;
      await this.endSession(
        session,
        'The workstation lost this session (it restarted or the gateway stopped)',
      );
      result.lost.push(session.id);
    }
    return result;
  }

  private async continueSession(
    session: SessionRecord,
    entry: InterruptedSession,
  ): Promise<RecoveryResult['continued'][number] | null> {
    const original = entry.prompt ?? session.config.prompt ?? '';
    const resumedConversation = Boolean(entry.nativeSessionId);
    const started = await this.starter.startSession({
      userId: session.userId,
      deviceId: session.deviceId,
      agentId: session.agentId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      projectRoot: session.projectRoot,
      prompt: continuationPrompt(original, resumedConversation),
      taskKind: 'implementation',
      purpose: 'continue after a restart',
      metadata: {
        resumedFrom: session.id,
        interruption: 'restart',
        ...(entry.nativeSessionId ? { resumeNativeSessionId: entry.nativeSessionId } : {}),
      },
    });
    const continuedIn = started.sessionId || undefined;
    await this.endSession(
      session,
      continuedIn
        ? `The workstation restarted while the agent was working; continued in ${continuedIn}`
        : `The workstation restarted while the agent was working; it could not be continued: ${started.error ?? 'unknown error'}`,
      continuedIn,
    );
    this.notify(session.userId, {
      type: 'session_continued',
      from: session.id,
      ...(continuedIn ? { to: continuedIn } : {}),
      state: started.state,
    });
    return continuedIn
      ? { from: session.id, to: continuedIn, state: started.state, resumedConversation }
      : null;
  }

  private async endSession(
    session: SessionRecord,
    reason: string,
    continuedIn?: string,
  ): Promise<void> {
    await this.db.sessions.update(session.id, {
      state: 'crashed',
      error: reason,
      completedAt: this.now(),
      ...(continuedIn
        ? { config: { ...session.config, metadata: { ...session.config.metadata, continuedIn } } }
        : {}),
    });
    // Approvals the old session was waiting on can no longer be acted on.
    for (const approval of await this.db.approvals.listBySession(session.id)) {
      if (approval.status !== 'pending') continue;
      await this.db.approvals.update(approval.id, {
        status: 'superseded',
        decidedAt: this.now(),
        decidedBy: 'system',
        reason: 'The session was interrupted when the workstation restarted',
      });
    }
  }

  /** A session held back by an approval has not reached the gateway yet. */
  private async awaitingStart(sessionId: string): Promise<boolean> {
    const approvals = await this.db.approvals.listBySession(sessionId);
    return approvals.some(
      (approval) =>
        approval.status === 'pending' &&
        (approval.details?.['pendingCommand'] as { commandType?: unknown } | undefined)
          ?.commandType === 'session.start',
    );
  }
}

export function continuationPrompt(original: string, resumedConversation: boolean): string {
  if (resumedConversation)
    return [
      'The workstation restarted while you were working, which stopped you mid-task.',
      'Continue where you left off. Check the current state of the files first — your earlier changes are still here, uncommitted — then finish the task and summarise what you did.',
    ].join(' ');
  return [
    'The workstation restarted while an agent was working on this task, which stopped it mid-task. Its earlier changes are still in this folder, uncommitted.',
    '',
    '## The task',
    '',
    original.trim().slice(0, 6_000) || '(The original task was not recorded.)',
    '',
    'Look at the current state of the files and what has already been done, then finish the task and summarise what you did.',
  ].join('\n');
}

function unwrap(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null && 'result' in payload
    ? (payload as { result: unknown }).result
    : payload;
}
