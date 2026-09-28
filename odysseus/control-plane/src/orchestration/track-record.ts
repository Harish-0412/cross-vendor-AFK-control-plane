/**
 * How each agent has done on a project, so the router can prefer the one
 * that tends to get it right here — not on a public benchmark.
 *
 * Evidence, from the last 90 days of the user's own work:
 *
 *  - Sessions: finished counts for the agent, failed or crashed against it.
 *    Stopping at a plan limit is not the agent's fault and is left out, as
 *    are cancellations.
 *  - Agent-team runs: a builder's work is credited when the tester's run
 *    that follows it passes or the reviewer approves it, and counted against
 *    it when the tests fail or the reviewer sends it back.
 *
 * The score is a smoothed success rate, (successes + 1) / (samples + 2): an
 * agent with no history sits at 0.5, and two lucky runs do not make one
 * look perfect.
 */
import type { AgentTrackRecord, OrchestrationStep } from '@odysseus/protocol';

import type { IDatabase } from '../db/types';

const WINDOW_DAYS = 90;
const LIMIT_HIT =
  /usage limit|rate limit|limit reached|quota|resets? (at|in)|429|resource_exhausted/i;

interface Tally {
  sessions: { ok: number; bad: number };
  tests: { ok: number; bad: number };
  reviews: { ok: number; bad: number };
}

export class TrackRecords {
  constructor(
    private readonly db: IDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async forProject(userId: string, projectId: string): Promise<Map<string, AgentTrackRecord>> {
    const since = this.now() - WINDOW_DAYS * 86_400_000;
    const tallies = new Map<string, Tally>();
    const tally = (agentId: string): Tally => {
      let entry = tallies.get(agentId);
      if (!entry) {
        entry = {
          sessions: { ok: 0, bad: 0 },
          tests: { ok: 0, bad: 0 },
          reviews: { ok: 0, bad: 0 },
        };
        tallies.set(agentId, entry);
      }
      return entry;
    };

    for (const session of await this.db.sessions.listByUser(userId)) {
      if (session.projectId !== projectId || !session.agentId) continue;
      if (session.startedAt.getTime() < since) continue;
      if (session.state === 'completed') tally(session.agentId).sessions.ok++;
      else if (
        (session.state === 'failed' || session.state === 'crashed') &&
        !LIMIT_HIT.test(session.error ?? '')
      )
        tally(session.agentId).sessions.bad++;
    }

    const organizations = await this.db.organizations.listByUser(userId);
    const runs = (
      await Promise.all(
        organizations.map((organization) =>
          this.db.orchestration.listRuns(organization.id, projectId),
        ),
      )
    )
      .flat()
      .filter((run) => run.userId === userId && run.createdAt.getTime() >= since);
    for (const run of runs) {
      const byId = new Map(run.plan.steps.map((step) => [step.id, step]));
      for (const check of run.plan.steps) {
        const verdict = judgement(check);
        if (!verdict) continue;
        for (const builder of check.dependsOn
          .map((id) => byId.get(id))
          .filter((step): step is OrchestrationStep =>
            Boolean(step && step.taskKind === 'implementation' && step.agentId),
          )) {
          const counts = tally(builder.agentId!)[verdict.kind];
          if (verdict.good) counts.ok++;
          else counts.bad++;
        }
      }
    }

    const records = new Map<string, AgentTrackRecord>();
    for (const [agentId, entry] of tallies) {
      const successes = entry.sessions.ok + entry.tests.ok + entry.reviews.ok;
      const failures = entry.sessions.bad + entry.tests.bad + entry.reviews.bad;
      const samples = successes + failures;
      if (samples === 0) continue;
      records.set(agentId, {
        agentId,
        projectId,
        successes,
        failures,
        samples,
        score: Math.round(((successes + 1) / (samples + 2)) * 100) / 100,
        summary: describe(entry, successes, samples),
      });
    }
    return records;
  }
}

/** What a finished test or review step says about the work it checked. */
function judgement(step: OrchestrationStep): { kind: 'tests' | 'reviews'; good: boolean } | null {
  if (step.state !== 'completed' || !step.outcome) return null;
  if (step.taskKind === 'test' && typeof step.outcome.testsPassed === 'boolean')
    return { kind: 'tests', good: step.outcome.testsPassed };
  if (step.taskKind === 'security_review' && step.outcome.verdict)
    return { kind: 'reviews', good: step.outcome.verdict === 'approve' };
  return null;
}

function describe(entry: Tally, successes: number, samples: number): string {
  const parts = (
    [
      ['sessions', entry.sessions],
      ['tests', entry.tests],
      ['reviews', entry.reviews],
    ] as const
  )
    .filter(([, counts]) => counts.ok + counts.bad > 0)
    .map(([name, counts]) => `${name} ${counts.ok}/${counts.ok + counts.bad}`);
  return `${successes} of ${samples} went well (${parts.join(', ')})`;
}
