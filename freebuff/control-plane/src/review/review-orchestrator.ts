import type { GitReviewBundle, GitTestResult } from '@freebuff/protocol';

import { SummaryGenerator } from '../afk/summary-generator';
import type { IDatabase } from '../db/types';
import type { PolicyEngineService } from '../policy/policy-engine-service';
import type { TunnelServer } from '../tunnel/tunnel-server';

export class ReviewOrchestrator {
  constructor(
    private readonly db: IDatabase,
    private readonly tunnel: TunnelServer,
    private readonly policy: PolicyEngineService,
    private readonly summaries = new SummaryGenerator(db),
  ) {}

  async build(sessionId: string): Promise<GitReviewBundle> {
    const session = await this.db.sessions.findById(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const generatedAt = new Date();
    try {
      const diffAck = await this.tunnel.sendCommandToDevice(
        session.deviceId,
        'session.diff_collection',
        { sessionId, projectRoot: session.projectRoot },
      );
      if (!diffAck.delivered)
        throw new Error('Gateway is offline; diff collection was not delivered');
      const diffResult = unwrapResult(diffAck.payload) as { diff?: unknown } | undefined;
      const diff = typeof diffResult?.diff === 'string' ? diffResult.diff : '';
      const summary = await this.summaries.generate(sessionId);
      const testDecision = await this.policy.evaluate('process.exec', 'medium', {
        resource: 'project:test',
        ...(session.projectId ? { projectId: session.projectId } : {}),
        deviceId: session.deviceId,
        sessionId,
        userId: session.userId,
      });
      if (testDecision.decision !== 'allow') {
        const bundle: GitReviewBundle = {
          sessionId,
          ...(session.projectId ? { projectId: session.projectId } : {}),
          generatedAt,
          diff,
          summary,
          tests: null,
          status: 'blocked_by_policy',
          policyDenial:
            testDecision.decision === 'deny'
              ? testDecision.reason
              : 'Test execution requires approval',
        };
        await this.db.sessions.update(sessionId, { reviewBundle: bundle });
        return bundle;
      }
      const testAck = await this.tunnel.sendCommandToDevice(
        session.deviceId,
        'session.run_tests',
        { sessionId, projectRoot: session.projectRoot },
        10 * 60_000,
      );
      const tests = (unwrapResult(testAck.payload) ?? null) as GitTestResult | null;
      const reviewSummary = {
        ...summary,
        testResults: tests,
        lines: [
          ...summary.lines,
          ...(tests
            ? [
                tests.passed
                  ? '✓ Review tests passed'
                  : `⚠ Review tests failed${tests.exitCode === null ? '' : ` (exit ${tests.exitCode})`}`,
              ]
            : []),
        ],
      };
      const bundle: GitReviewBundle = {
        sessionId,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        generatedAt,
        diff,
        summary: reviewSummary,
        tests,
        status: tests?.passed === false ? 'tests_failed' : 'ready',
      };
      await this.db.sessions.update(sessionId, { reviewBundle: bundle });
      return bundle;
    } catch (error) {
      const bundle: GitReviewBundle = {
        sessionId,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        generatedAt,
        diff: '',
        summary: await this.summaries.generate(sessionId),
        tests: null,
        status: 'collection_failed',
        error: error instanceof Error ? error.message : String(error),
      };
      await this.db.sessions.update(sessionId, { reviewBundle: bundle });
      return bundle;
    }
  }

  async get(sessionId: string, refresh = false): Promise<GitReviewBundle> {
    const session = await this.db.sessions.findById(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return !refresh && session.reviewBundle ? session.reviewBundle : this.build(sessionId);
  }
}

function unwrapResult(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const ack = payload as { result?: unknown; payload?: unknown };
  if ('result' in ack) return ack.result;
  return 'payload' in ack ? ack.payload : payload;
}
