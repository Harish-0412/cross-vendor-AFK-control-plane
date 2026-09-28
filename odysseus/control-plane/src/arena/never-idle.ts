/**
 * Never idle: when an agent hits its plan limit mid-task, the work moves on.
 *
 * On every finished session this looks for a usage-limit message. When it
 * finds one it records the limit (with the reset time the provider gave) and
 * then, in order of preference:
 *
 *  1. hands the task to another vendor's agent on the same machine, in the
 *     same folder, with a brief of what the first agent already did; or
 *  2. when no other agent is available, schedules the same agent to continue
 *     once its limit resets.
 *
 * A chain of hand-offs is capped, so two limited agents cannot pass a task
 * back and forth, and launches of a limited agent can be redirected before
 * they fail.
 */
import { randomUUID } from 'node:crypto';

import type { SessionRecord } from '../types';

import { detectLimit } from './limit-detector';
import { agentName, TERMINAL_SESSION_STATES, type ArenaRuntime } from './runtime';
import {
  DEFAULT_NEVER_IDLE,
  type Handoff,
  type NeverIdleSettings,
  type ScheduledResume,
  type VendorLimit,
} from './types';

/** Tried in this order when the user has not chosen one. */
const DEFAULT_PREFERENCE = ['claude-code', 'codex', 'opencode', 'antigravity', 'freebuff'];
const TICK_MS = 60_000;
/** A scheduled resume that cannot start for this long (machine offline) is given up. */
const RESUME_GRACE_MS = 24 * 60 * 60_000;

export type ArenaNotifier = (userId: string, message: Record<string, unknown>) => void;

export class NeverIdleService {
  private timer: NodeJS.Timeout | undefined;
  private readonly handled = new Set<string>();

  constructor(
    private readonly runtime: ArenaRuntime,
    private readonly notify: ArenaNotifier = () => undefined,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runDueResumes().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ------------------------------------------------------------- settings

  async settings(userId: string): Promise<NeverIdleSettings> {
    const stored = await this.runtime.db.documents.get<NeverIdleSettings>(
      'never_idle_settings',
      userId,
    );
    return { ...DEFAULT_NEVER_IDLE, ...(stored?.data ?? {}) };
  }

  async saveSettings(
    userId: string,
    input: Partial<NeverIdleSettings>,
  ): Promise<NeverIdleSettings> {
    const current = await this.settings(userId);
    const next: NeverIdleSettings = {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
      resumeAfterReset:
        typeof input.resumeAfterReset === 'boolean'
          ? input.resumeAfterReset
          : current.resumeAfterReset,
      maxHandoffs:
        typeof input.maxHandoffs === 'number' && Number.isFinite(input.maxHandoffs)
          ? Math.max(0, Math.min(6, Math.floor(input.maxHandoffs)))
          : current.maxHandoffs,
      fallbackOrder: Array.isArray(input.fallbackOrder)
        ? input.fallbackOrder.filter((id): id is string => typeof id === 'string').slice(0, 8)
        : current.fallbackOrder,
    };
    await this.runtime.db.documents.put('never_idle_settings', userId, userId, next);
    return next;
  }

  // ---------------------------------------------------------------- limits

  /** Limits still in force, newest first. Expired ones are dropped as they are read. */
  async activeLimits(userId: string, now = new Date()): Promise<VendorLimit[]> {
    const records = await this.runtime.db.documents.listByUser<VendorLimit>(
      'vendor_limits',
      userId,
    );
    const active: VendorLimit[] = [];
    for (const record of records) {
      if (Date.parse(record.data.resetsAt) > now.getTime()) active.push(record.data);
      else await this.runtime.db.documents.delete('vendor_limits', record.id);
    }
    return active.sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  }

  async clearLimit(userId: string, deviceId: string, agentId: string): Promise<void> {
    const id = limitId(userId, deviceId, agentId);
    const record = await this.runtime.db.documents.get<VendorLimit>('vendor_limits', id);
    if (record?.userId === userId) await this.runtime.db.documents.delete('vendor_limits', id);
  }

  async handoffs(userId: string, limit = 30): Promise<Handoff[]> {
    const records = await this.runtime.db.documents.listByUser<Handoff>('handoffs', userId);
    return records
      .map((record) => record.data)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  async scheduled(userId: string): Promise<ScheduledResume[]> {
    const records = await this.runtime.db.documents.listByUser<ScheduledResume>(
      'scheduled_resumes',
      userId,
    );
    return records
      .map((record) => record.data)
      .filter((resume) => resume.state === 'waiting')
      .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
  }

  async cancelScheduled(userId: string, id: string): Promise<void> {
    const record = await this.runtime.db.documents.get<ScheduledResume>('scheduled_resumes', id);
    if (!record || record.userId !== userId) throw new Error('Scheduled resume not found');
    await this.runtime.db.documents.put('scheduled_resumes', id, userId, {
      ...record.data,
      state: 'cancelled',
    });
  }

  /**
   * Before launching `agentId`: when it is at its limit and never-idle is on,
   * the agent to use instead. Null means launch as asked.
   */
  async substituteForLaunch(
    userId: string,
    deviceId: string,
    agentId: string,
  ): Promise<{ agentId: string; reason: string } | null> {
    const settings = await this.settings(userId);
    if (!settings.enabled) return null;
    const limits = await this.activeLimits(userId);
    const limit = limits.find((item) => item.deviceId === deviceId && item.agentId === agentId);
    if (!limit) return null;
    const alternative = await this.pickAlternative(deviceId, agentId, settings, limits);
    if (!alternative) return null;
    return {
      agentId: alternative,
      reason: `${agentName(agentId)} is at its usage limit until ${limit.resetsAt}; started ${agentName(alternative)} instead.`,
    };
  }

  // ------------------------------------------------------------- the hook

  /** Called for every session that reached a final state. */
  async onSessionFinished(sessionId: string): Promise<void> {
    if (this.handled.has(sessionId)) return;
    const session = await this.runtime.db.sessions.findById(sessionId);
    if (!session || !TERMINAL_SESSION_STATES.has(session.state)) return;
    this.handled.add(sessionId);
    if (this.handled.size > 5_000) this.handled.clear();

    const output = await this.runtime.output(sessionId).catch(() => null);
    const signal = detectLimit({
      agentId: session.agentId,
      state: session.state,
      error: session.error,
      tail: output?.text ?? '',
    });

    if (!signal) {
      // A session that finished normally proves the agent is not limited.
      if (session.state === 'completed') {
        await this.clearLimit(session.userId, session.deviceId, session.agentId).catch(
          () => undefined,
        );
      }
      return;
    }

    const limit: VendorLimit = {
      agentId: session.agentId,
      deviceId: session.deviceId,
      detectedAt: new Date().toISOString(),
      resetsAt: signal.resetsAt.toISOString(),
      resetKnown: signal.resetKnown,
      message: signal.message,
      sessionId,
    };
    await this.runtime.db.documents.put(
      'vendor_limits',
      limitId(session.userId, session.deviceId, session.agentId),
      session.userId,
      limit,
    );
    this.notify(session.userId, { type: 'vendor_limit', limit });

    // Contest and benchmark attempts are compared as they are; moving one to
    // another vendor would make the comparison meaningless.
    const metadata = session.config.metadata ?? {};
    if (typeof metadata['arena'] === 'string') return;

    const settings = await this.settings(session.userId);
    if (!settings.enabled) return;
    await this.continueElsewhere(
      session,
      limit,
      settings,
      output?.finalMessage ?? '',
      output?.filesChanged ?? [],
    );
  }

  private async continueElsewhere(
    session: SessionRecord,
    limit: VendorLimit,
    settings: NeverIdleSettings,
    lastMessage: string,
    filesChanged: string[],
  ): Promise<void> {
    const metadata = session.config.metadata ?? {};
    const chainId =
      typeof metadata['handoffChainId'] === 'string' ? metadata['handoffChainId'] : session.id;
    const depth = typeof metadata['handoffDepth'] === 'number' ? metadata['handoffDepth'] : 0;
    const originalPrompt =
      typeof metadata['originalPrompt'] === 'string'
        ? metadata['originalPrompt']
        : (session.config.prompt ?? '');
    const base: Omit<Handoff, 'kind' | 'reason'> = {
      id: `handoff_${randomUUID().replace(/-/g, '')}`,
      userId: session.userId,
      chainId,
      depth: depth + 1,
      fromSessionId: session.id,
      fromAgentId: session.agentId,
      resetsAt: limit.resetsAt,
      projectRoot: session.projectRoot,
      createdAt: new Date().toISOString(),
    };

    if (!originalPrompt.trim()) {
      await this.record({
        ...base,
        kind: 'no_alternative',
        reason: 'The session had no task to continue.',
      });
      return;
    }
    if (depth >= settings.maxHandoffs) {
      await this.record({
        ...base,
        kind: 'no_alternative',
        reason: `Stopped after ${settings.maxHandoffs} hand-offs in a row, so agents do not keep passing the task around.`,
      });
      return;
    }

    const limits = await this.activeLimits(session.userId);
    const alternative = this.runtime.isOnline(session.deviceId)
      ? await this.pickAlternative(session.deviceId, session.agentId, settings, limits)
      : null;

    const chain = {
      handoffChainId: chainId,
      handoffDepth: depth + 1,
      handoffFrom: session.id,
      handoffFromAgent: session.agentId,
      handoffReason: limit.message,
      originalPrompt,
    };

    if (alternative) {
      const started = await this.runtime.startSession({
        userId: session.userId,
        deviceId: session.deviceId,
        agentId: alternative,
        projectId: session.projectId,
        projectRoot: session.projectRoot,
        prompt: handoffPrompt(
          session.agentId,
          limit.message,
          originalPrompt,
          lastMessage,
          filesChanged,
        ),
        taskKind: 'implementation',
        purpose: 'never-idle hand-off',
        metadata: chain,
      });
      await this.markHandedOff(session, started.sessionId, alternative);
      await this.record({
        ...base,
        kind: 'handoff',
        toAgentId: alternative,
        ...(started.sessionId ? { toSessionId: started.sessionId } : {}),
        reason: `${agentName(session.agentId)} hit its usage limit. ${agentName(alternative)} continues the task.`,
        ...(started.error ? { error: started.error } : {}),
      });
      return;
    }

    if (settings.resumeAfterReset) {
      const resume: ScheduledResume = {
        id: `resume_${randomUUID().replace(/-/g, '')}`,
        userId: session.userId,
        deviceId: session.deviceId,
        agentId: session.agentId,
        fromSessionId: session.id,
        chainId,
        depth: depth + 1,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        projectRoot: session.projectRoot,
        prompt: resumePrompt(originalPrompt, lastMessage, filesChanged),
        // A minute past the reset, so the provider has actually reset.
        runAt: new Date(Date.parse(limit.resetsAt) + 60_000).toISOString(),
        state: 'waiting',
      };
      await this.runtime.db.documents.put('scheduled_resumes', resume.id, session.userId, resume);
      await this.record({
        ...base,
        kind: 'scheduled_resume',
        toAgentId: session.agentId,
        reason: `No other agent is available, so ${agentName(session.agentId)} will continue when its limit resets.`,
      });
      return;
    }

    await this.record({
      ...base,
      kind: 'no_alternative',
      reason:
        'No other agent is available on this machine and resuming after the reset is turned off.',
    });
  }

  private async pickAlternative(
    deviceId: string,
    currentAgentId: string,
    settings: NeverIdleSettings,
    limits: VendorLimit[],
  ): Promise<string | null> {
    const installed = await this.runtime.installedAgents(deviceId).catch(() => [] as string[]);
    const limited = new Set(
      limits.filter((item) => item.deviceId === deviceId).map((item) => item.agentId),
    );
    const order = [
      ...settings.fallbackOrder,
      ...DEFAULT_PREFERENCE.filter((id) => !settings.fallbackOrder.includes(id)),
      ...installed,
    ];
    return (
      order.find(
        (id) =>
          id !== currentAgentId &&
          installed.includes(id) &&
          !limited.has(id) &&
          // The mock agent is for testing; it only stands in for itself.
          (id !== 'mock' || currentAgentId === 'mock'),
      ) ?? null
    );
  }

  private async markHandedOff(session: SessionRecord, toSessionId: string, toAgentId: string) {
    await this.runtime.db.sessions.update(session.id, {
      config: {
        ...session.config,
        metadata: {
          ...(session.config.metadata ?? {}),
          handedOffTo: toSessionId,
          handedOffToAgent: toAgentId,
        },
      },
    });
  }

  private async record(handoff: Handoff): Promise<void> {
    await this.runtime.db.documents.put('handoffs', handoff.id, handoff.userId, handoff);
    this.notify(handoff.userId, { type: 'handoff', handoff });
  }

  // ------------------------------------------------------------- resumes

  async runDueResumes(now = new Date()): Promise<void> {
    const records = await this.runtime.db.documents.listAll<ScheduledResume>('scheduled_resumes');
    for (const record of records) {
      const resume = record.data;
      if (resume.state !== 'waiting' || Date.parse(resume.runAt) > now.getTime()) continue;
      if (!this.runtime.isOnline(resume.deviceId)) {
        if (now.getTime() - Date.parse(resume.runAt) > RESUME_GRACE_MS) {
          await this.saveResume({
            ...resume,
            state: 'failed',
            error: 'The machine stayed offline',
          });
        }
        continue;
      }
      const started = await this.runtime.startSession({
        userId: resume.userId,
        deviceId: resume.deviceId,
        agentId: resume.agentId,
        projectId: resume.projectId,
        projectRoot: resume.projectRoot,
        prompt: resume.prompt,
        taskKind: 'implementation',
        purpose: 'never-idle resume after reset',
        metadata: {
          handoffChainId: resume.chainId,
          handoffDepth: resume.depth,
          handoffFrom: resume.fromSessionId,
          handoffFromAgent: resume.agentId,
          handoffReason: 'Usage limit reset',
        },
      });
      await this.saveResume({
        ...resume,
        state: started.state === 'failed' ? 'failed' : 'started',
        ...(started.sessionId ? { startedSessionId: started.sessionId } : {}),
        ...(started.error ? { error: started.error } : {}),
      });
      if (started.sessionId) {
        const from = await this.runtime.db.sessions.findById(resume.fromSessionId);
        if (from) await this.markHandedOff(from, started.sessionId, resume.agentId);
      }
      this.notify(resume.userId, { type: 'resume_started', resume, sessionId: started.sessionId });
    }
  }

  private saveResume(resume: ScheduledResume): Promise<void> {
    return this.runtime.db.documents.put('scheduled_resumes', resume.id, resume.userId, resume);
  }
}

function limitId(userId: string, deviceId: string, agentId: string): string {
  return `${userId}__${deviceId}__${agentId}`;
}

const brief = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n… [truncated]`;

function progressSection(lastMessage: string, filesChanged: string[]): string {
  const files = filesChanged.length
    ? filesChanged
        .slice(0, 40)
        .map((file) => `- ${file}`)
        .join('\n')
    : '- (none reported — run `git status` to see the current changes)';
  const said = lastMessage.trim() ? brief(lastMessage.trim(), 2_000) : '(nothing)';
  return `## Where the work got to\n\nFiles changed so far:\n${files}\n\nThe last thing the previous agent said:\n\n${said}`;
}

export function handoffPrompt(
  fromAgentId: string,
  limitMessage: string,
  originalPrompt: string,
  lastMessage: string,
  filesChanged: string[],
): string {
  return [
    `You are taking over a coding task from ${agentName(fromAgentId)}, which stopped because it hit its usage limit ("${limitMessage}").`,
    'Its work so far is already in this folder as uncommitted changes. Build on it: do not start over, and do not revert what it did unless it is wrong.',
    '',
    '## The task',
    '',
    brief(originalPrompt.trim(), 6_000),
    '',
    progressSection(lastMessage, filesChanged),
    '',
    'Finish the task, then summarise what you did and anything still left.',
  ].join('\n');
}

export function resumePrompt(
  originalPrompt: string,
  lastMessage: string,
  filesChanged: string[],
): string {
  return [
    'Your usage limit has reset. Continue the coding task you were working on in this folder; your earlier changes are still here, uncommitted.',
    '',
    '## The task',
    '',
    brief(originalPrompt.trim(), 6_000),
    '',
    progressSection(lastMessage, filesChanged),
    '',
    'Finish the task, then summarise what you did.',
  ].join('\n');
}
