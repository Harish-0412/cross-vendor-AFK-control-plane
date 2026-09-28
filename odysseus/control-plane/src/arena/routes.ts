/**
 * HTTP endpoints for never-idle, contests and the leaderboard.
 *
 *   GET    /api/v1/never-idle                     settings, active limits, hand-offs, scheduled resumes
 *   PUT    /api/v1/never-idle/settings
 *   DELETE /api/v1/never-idle/limits/:deviceId/:agentId
 *   DELETE /api/v1/never-idle/scheduled/:id
 *
 *   GET    /api/v1/contests                       POST /api/v1/contests
 *   GET    /api/v1/contests/:id
 *   POST   /api/v1/contests/:id/apply | cancel | cleanup
 *
 *   GET    /api/v1/benchmarks?projectId=          POST /api/v1/benchmarks
 *   GET    /api/v1/benchmarks/preview?projectId=&deviceId=&changes=
 *   GET    /api/v1/benchmarks/:id                 POST /api/v1/benchmarks/:id/cancel
 *   GET    /api/v1/leaderboard?projectId=
 *   POST   /api/v1/leaderboard/prefer             { projectId, agentId }
 */
import type { IDatabase } from '../db/types';

import type { BenchmarkService } from './benchmark';
import { ArenaError, type ContestService } from './contest';
import type { NeverIdleService } from './never-idle';

export interface ArenaResponse {
  status: number;
  body: unknown;
}

export class ArenaRoutes {
  constructor(
    private readonly db: IDatabase,
    private readonly neverIdle: NeverIdleService,
    private readonly contests: ContestService,
    private readonly benchmarks: BenchmarkService,
  ) {}

  /** Null when the path is not one of these endpoints. */
  async handle(
    method: string,
    url: URL,
    body: Record<string, unknown>,
    userId: string | undefined,
  ): Promise<ArenaResponse | null> {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'api' || segments[1] !== 'v1') return null;
    const area = segments[2];
    if (!['never-idle', 'contests', 'benchmarks', 'leaderboard'].includes(area ?? '')) return null;
    if (!userId) return { status: 401, body: { error: 'Unauthorized' } };
    const rest = segments.slice(3);
    try {
      if (area === 'never-idle') return await this.neverIdleRoute(method, rest, body, userId);
      if (area === 'contests') return await this.contestRoute(method, rest, body, userId);
      if (area === 'benchmarks') return await this.benchmarkRoute(method, rest, url, body, userId);
      return await this.leaderboardRoute(method, rest, url, body, userId);
    } catch (error) {
      if (error instanceof ArenaError)
        return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }

  private async neverIdleRoute(
    method: string,
    rest: string[],
    body: Record<string, unknown>,
    userId: string,
  ): Promise<ArenaResponse | null> {
    if (method === 'GET' && rest.length === 0) {
      const [settings, limits, handoffs, scheduled] = await Promise.all([
        this.neverIdle.settings(userId),
        this.neverIdle.activeLimits(userId),
        this.neverIdle.handoffs(userId),
        this.neverIdle.scheduled(userId),
      ]);
      return { status: 200, body: { settings, limits, handoffs, scheduled } };
    }
    if (method === 'PUT' && rest[0] === 'settings') {
      return { status: 200, body: await this.neverIdle.saveSettings(userId, body) };
    }
    if (method === 'DELETE' && rest[0] === 'limits' && rest[1] && rest[2]) {
      await this.neverIdle.clearLimit(userId, rest[1], rest[2]);
      return { status: 200, body: { cleared: true } };
    }
    if (method === 'DELETE' && rest[0] === 'scheduled' && rest[1]) {
      await this.neverIdle.cancelScheduled(userId, rest[1]).catch((error: Error) => {
        throw new ArenaError(404, error.message);
      });
      return { status: 200, body: { cancelled: true } };
    }
    return null;
  }

  private async contestRoute(
    method: string,
    rest: string[],
    body: Record<string, unknown>,
    userId: string,
  ): Promise<ArenaResponse | null> {
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: await this.contests.list(userId) };
      if (method === 'POST') return { status: 201, body: await this.contests.create(userId, body) };
    }
    const id = rest[0];
    if (!id) return null;
    if (method === 'GET' && rest.length === 1)
      return { status: 200, body: await this.contests.get(userId, id) };
    if (method === 'POST' && rest[1] === 'apply')
      return { status: 200, body: await this.contests.apply(userId, id, body['agentId']) };
    if (method === 'POST' && rest[1] === 'cancel')
      return { status: 200, body: await this.contests.cancel(userId, id) };
    if (method === 'POST' && rest[1] === 'cleanup')
      return { status: 200, body: await this.contests.cleanup(userId, id) };
    return null;
  }

  private async benchmarkRoute(
    method: string,
    rest: string[],
    url: URL,
    body: Record<string, unknown>,
    userId: string,
  ): Promise<ArenaResponse | null> {
    if (rest.length === 0) {
      if (method === 'GET')
        return {
          status: 200,
          body: await this.benchmarks.list(userId, url.searchParams.get('projectId') ?? undefined),
        };
      if (method === 'POST')
        return { status: 201, body: await this.benchmarks.create(userId, body) };
    }
    if (method === 'GET' && rest[0] === 'preview') {
      return {
        status: 200,
        body: await this.benchmarks.preview(
          userId,
          url.searchParams.get('projectId'),
          url.searchParams.get('deviceId'),
          Number(url.searchParams.get('changes') ?? 5),
        ),
      };
    }
    const id = rest[0];
    if (!id) return null;
    if (method === 'GET' && rest.length === 1)
      return { status: 200, body: await this.benchmarks.get(userId, id) };
    if (method === 'POST' && rest[1] === 'cancel')
      return { status: 200, body: await this.benchmarks.cancel(userId, id) };
    return null;
  }

  private async leaderboardRoute(
    method: string,
    rest: string[],
    url: URL,
    body: Record<string, unknown>,
    userId: string,
  ): Promise<ArenaResponse | null> {
    if (method === 'GET' && rest.length === 0) {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) throw new ArenaError(400, 'projectId is required');
      const project = await this.db.projects.findById(projectId);
      if (!project || project.userId !== userId) throw new ArenaError(404, 'Project not found');
      return {
        status: 200,
        body: {
          ...(await this.benchmarks.leaderboard(userId, projectId)),
          preferredAgentId: project.preferences.preferredAdapter ?? null,
        },
      };
    }
    if (method === 'POST' && rest[0] === 'prefer') {
      const projectId = typeof body['projectId'] === 'string' ? body['projectId'] : '';
      const agentId = typeof body['agentId'] === 'string' ? body['agentId'] : '';
      const project = await this.db.projects.findById(projectId);
      if (!project || project.userId !== userId) throw new ArenaError(404, 'Project not found');
      const preferences = { ...project.preferences };
      if (agentId) preferences.preferredAdapter = agentId;
      else delete preferences.preferredAdapter;
      await this.db.projects.update(projectId, { preferences });
      return { status: 200, body: { preferredAgentId: agentId || null } };
    }
    return null;
  }
}
