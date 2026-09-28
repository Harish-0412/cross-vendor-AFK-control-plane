import { randomUUID } from 'node:crypto';

import type {
  AgentInfo,
  AgentQuota,
  AgentRouteCandidate,
  AgentTrackRecord,
  RoutingDecision,
  RoutingRequest,
} from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import type { ConnectionRegistry } from '../tunnel/connection-registry';
import type { TunnelServer } from '../tunnel/tunnel-server';

/**
 * What the router knows beyond "online and capable": how much of each agent's
 * subscription is left, and how each has done on this project before.
 */
export interface RoutingInsight {
  quota(userId: string, deviceId: string, agentId: string): Promise<AgentQuota>;
  trackRecords(userId: string, projectId: string): Promise<Map<string, AgentTrackRecord>>;
}

/** Fewer samples than this and a track record is not trusted either way. */
const MIN_TRACK_SAMPLES = 3;
/** Where an agent with no trusted history ranks: between a mediocre record and a good one. */
const UNPROVEN = 0.5;

export class AgentRouter {
  constructor(
    private readonly db: IDatabase,
    private readonly registry: ConnectionRegistry,
    private readonly tunnel: TunnelServer,
    private readonly insight?: RoutingInsight,
  ) {}
  async route(userId: string, request: RoutingRequest): Promise<RoutingDecision> {
    const project = await this.db.projects.findById(request.projectId);
    if (!project || project.userId !== userId) throw new Error('Project not found');
    // isDeviceAcceptingSessions, not isDeviceOnline: a draining gateway is
    // still online and still streaming events for its in-flight sessions, but
    // routing new work to it only earns a 503. It drops out of selection
    // within one heartbeat of announcing the drain.
    const devices = (await this.db.devices.listByUser(userId)).filter(
      (device) => this.registry.isDeviceAcceptingSessions(device.id) && device.status === 'trusted',
    );
    const candidates = (
      await Promise.all(
        devices.map((device) => this.candidatesForDevice(device.id, device.gatewayId)),
      )
    ).flat();
    const eligible = candidates.filter((candidate) => this.eligible(candidate, request));
    if (this.insight) await this.annotate(userId, request.projectId, eligible);
    // An agent out of plan quota would only fail; it is left out, and said so.
    const skipped = eligible
      .filter((candidate) => candidate.quota?.state === 'exhausted')
      .map((candidate) => ({
        agentId: candidate.agentId,
        deviceId: candidate.deviceId,
        reason: `${candidate.agentId}: ${candidate.quota!.detail}`,
      }));
    const usable = eligible.filter((candidate) => candidate.quota?.state !== 'exhausted');
    const sorted = this.sort(usable, request.strategy ?? 'capability_first');
    const selected = sorted[0] ?? null;
    const decision: RoutingDecision = {
      id: `route_${randomUUID().replace(/-/g, '')}`,
      request,
      selected,
      alternatives: sorted.slice(1),
      reasons: selected
        ? [
            `Selected ${selected.agentId} on ${selected.deviceId}`,
            `strategy=${request.strategy ?? 'capability_first'}`,
            `activeSessions=${selected.activeSessions}`,
            ...(selected.trackRecord ? [`Track record here: ${selected.trackRecord.summary}`] : []),
            ...(selected.quota && selected.quota.state !== 'unknown'
              ? [`Plan: ${selected.quota.detail}`]
              : []),
            ...skipped.map((item) => `Skipped ${item.reason}`),
          ]
        : skipped.length > 0
          ? [
              'Every eligible agent is out of plan quota',
              ...skipped.map((item) => `Skipped ${item.reason}`),
            ]
          : ['No online gateway advertises an eligible agent'],
      ...(skipped.length > 0 ? { skipped } : {}),
      createdAt: new Date(),
    };
    await this.db.orchestration.appendRoutingDecision(decision);
    return decision;
  }
  private async candidatesForDevice(
    deviceId: string,
    gatewayId: string,
  ): Promise<AgentRouteCandidate[]> {
    const response = await this.tunnel.sendCommandToDevice(deviceId, 'system.inventory', {}, 5_000);
    const payload = unwrap(response.payload) as
      { agents?: AgentInfo[]; activeSessions?: number } | undefined;
    if (!response.delivered || !payload?.agents) return [];
    // Keep a durable last-known inventory for dashboards and offline diagnostics.
    await this.db.devices.update(deviceId, {
      availableAgents: payload.agents.map((agent) => ({
        id: agent.metadata.id,
        capabilities: agent.metadata.capabilities,
      })),
    });
    return payload.agents
      .filter((agent) => agent.installed && agent.health.status !== 'unhealthy')
      .map((agent) => ({
        deviceId,
        gatewayId,
        agentId: agent.metadata.id,
        online: true,
        activeSessions: payload.activeSessions ?? 0,
        capabilities: agent.metadata.capabilities,
      }));
  }
  private eligible(candidate: AgentRouteCandidate, request: RoutingRequest): boolean {
    if (request.requiredAgentId && candidate.agentId !== request.requiredAgentId) return false;
    if (
      request.maxEstimatedCostUsd !== undefined &&
      (candidate.estimatedCostUsd ?? 0) > request.maxEstimatedCostUsd
    )
      return false;
    // HIGH/CRITICAL tasks may still be routed only to adapters that advertise
    // at least a partial interception story; policy remains the final gate.
    if ((request.maxRiskScore ?? 0) >= 0.55 && this.executionRisk(candidate) >= 1) return false;
    return (request.requiredCapabilities ?? []).every(
      (name) => candidate.capabilities?.[name] === 'supported',
    );
  }
  /** Attach each candidate's plan quota and its track record on this project. */
  private async annotate(
    userId: string,
    projectId: string,
    candidates: AgentRouteCandidate[],
  ): Promise<void> {
    const insight = this.insight!;
    const records = await insight
      .trackRecords(userId, projectId)
      .catch(() => new Map<string, AgentTrackRecord>());
    await Promise.all(
      candidates.map(async (candidate) => {
        const record = records.get(candidate.agentId);
        if (record) candidate.trackRecord = record;
        const quota = await insight
          .quota(userId, candidate.deviceId, candidate.agentId)
          .catch(() => undefined);
        if (quota) candidate.quota = quota;
      }),
    );
  }

  /**
   * Agents running low on plan quota go after the rest, whatever the
   * strategy. Within that, the strategy's own key decides; a proven track
   * record on this project breaks ties, and for the default strategy it
   * comes before load, since a busy machine is cheaper than a failed run.
   */
  private sort(
    candidates: AgentRouteCandidate[],
    strategy: NonNullable<RoutingRequest['strategy']>,
  ): AgentRouteCandidate[] {
    const low = (candidate: AgentRouteCandidate) => (candidate.quota?.state === 'low' ? 1 : 0);
    const record = (candidate: AgentRouteCandidate) => trackBucket(candidate.trackRecord);
    return [...candidates].sort((a, b) => {
      const quota = low(a) - low(b);
      if (quota) return quota;
      if (strategy === 'lowest_cost')
        return (
          (a.estimatedCostUsd ?? 0) - (b.estimatedCostUsd ?? 0) ||
          a.activeSessions - b.activeSessions ||
          record(b) - record(a)
        );
      if (strategy === 'lowest_risk')
        return (
          this.executionRisk(a) - this.executionRisk(b) ||
          a.activeSessions - b.activeSessions ||
          record(b) - record(a)
        );
      if (strategy === 'least_loaded')
        return (
          a.activeSessions - b.activeSessions ||
          record(b) - record(a) ||
          a.agentId.localeCompare(b.agentId)
        );
      return (
        record(b) - record(a) ||
        a.activeSessions - b.activeSessions ||
        a.agentId.localeCompare(b.agentId)
      );
    });
  }
  /** A conservative adapter safety score used only to order otherwise eligible routes. */
  private executionRisk(candidate: AgentRouteCandidate): number {
    const approval = candidate.capabilities?.approvalInterception;
    return approval === 'supported' ? 0 : approval === 'partial' ? 0.5 : 1;
  }
}

function unwrap(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'result' in value
    ? (value as { result: unknown }).result
    : value;
}

/**
 * A track record in fifths of the score, so small differences do not reorder
 * agents; one without enough history sits in the middle.
 */
function trackBucket(record: AgentTrackRecord | undefined): number {
  if (!record || record.samples < MIN_TRACK_SAMPLES) return UNPROVEN;
  return Math.min(4, Math.floor(record.score * 5)) / 5;
}
