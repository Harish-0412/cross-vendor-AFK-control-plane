import { randomUUID } from 'node:crypto';

import type {
  AgentInfo,
  AgentRouteCandidate,
  RoutingDecision,
  RoutingRequest,
} from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import type { ConnectionRegistry } from '../tunnel/connection-registry';
import type { TunnelServer } from '../tunnel/tunnel-server';

export class AgentRouter {
  constructor(
    private readonly db: IDatabase,
    private readonly registry: ConnectionRegistry,
    private readonly tunnel: TunnelServer,
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
    const sorted = this.sort(eligible, request.strategy ?? 'capability_first');
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
          ]
        : ['No online gateway advertises an eligible agent'],
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
  private sort(
    candidates: AgentRouteCandidate[],
    strategy: NonNullable<RoutingRequest['strategy']>,
  ): AgentRouteCandidate[] {
    return [...candidates].sort((a, b) => {
      if (strategy === 'lowest_cost')
        return (
          (a.estimatedCostUsd ?? 0) - (b.estimatedCostUsd ?? 0) ||
          a.activeSessions - b.activeSessions
        );
      if (strategy === 'lowest_risk')
        return this.executionRisk(a) - this.executionRisk(b) || a.activeSessions - b.activeSessions;
      return a.activeSessions - b.activeSessions || a.agentId.localeCompare(b.agentId);
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
