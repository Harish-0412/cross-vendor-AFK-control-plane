import type { AgentInfo } from '@odysseus/protocol';
import { describe, test, expect, beforeEach } from 'vitest';

import { MemoryDatabase } from '../src/db/memory-store';
import { AgentRouter } from '../src/orchestration/agent-router';
import { ConnectionRegistry, type GatewayAdmissionPhase } from '../src/tunnel/connection-registry';
import type { TunnelServer } from '../src/tunnel/tunnel-server';

/**
 * PR 2 acceptance: with two gateways online, draining one must divert all new
 * work to the other. The drain arrives as an admission phase on a heartbeat,
 * so routing reacts within a single beat rather than after a command timeout.
 */
describe('drain-aware routing', () => {
  let db: MemoryDatabase;
  let registry: ConnectionRegistry;
  let router: AgentRouter;
  let userId: string;
  let projectId: string;

  const DEVICE_A = 'dev_aaaa1111';
  const DEVICE_B = 'dev_bbbb2222';

  /** A socket stub that only needs to look open to the registry. */
  function fakeSocket() {
    return { readyState: 1, close: () => undefined } as unknown as Parameters<
      ConnectionRegistry['registerGateway']
    >[0]['socket'];
  }

  function agentInventory(): AgentInfo[] {
    return [
      {
        metadata: {
          id: 'mock',
          name: 'Mock',
          version: '1.0.0',
          platform: ['linux', 'darwin', 'win32'],
          capabilities: {
            sessionCreation: 'supported',
            promptDelivery: 'supported',
            streaming: 'supported',
            cancellation: 'supported',
            diffCollection: 'supported',
            approvalInterception: 'supported',
            checkpointRecovery: 'supported',
            multiTurn: 'supported',
            fileOperations: 'supported',
            toolExecution: 'supported',
          },
        },
        installed: true,
        health: { status: 'healthy', lastCheckAt: new Date(), issues: [], checks: {} },
        lastDetectedAt: new Date(),
      } as AgentInfo,
    ];
  }

  /** A tunnel that answers system.inventory for any device. */
  function fakeTunnel(): TunnelServer {
    return {
      sendCommandToDevice: async () => ({
        acknowledged: true,
        delivered: true,
        sequence: 1,
        payload: { success: true, result: { agents: agentInventory(), activeSessions: 0 } },
      }),
    } as unknown as TunnelServer;
  }

  function connect(deviceId: string, phase: GatewayAdmissionPhase = 'running'): void {
    registry.registerGateway({
      deviceId,
      gatewayId: `gw_${deviceId.slice(-4)}`,
      socket: fakeSocket(),
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
      capabilities: ['sessions'],
    });
    registry.setAdmissionPhase(deviceId, phase);
  }

  beforeEach(async () => {
    db = new MemoryDatabase();
    registry = new ConnectionRegistry();
    router = new AgentRouter(db, registry, fakeTunnel());

    const user = await db.users.create({
      email: 'drain@test.local',
      passwordHash: 'x',
      name: 'Drain Tester',
    });
    userId = user.id;

    for (const id of [DEVICE_A, DEVICE_B]) {
      await db.devices.create({
        id,
        gatewayId: `gw_${id.slice(-4)}`,
        userId,
        friendlyName: id,
        platform: 'linux',
        publicKeyPem: '',
        publicKeyJwk: {},
        fingerprintHex: 'ff',
        fingerprintWords: ['a'],
        status: 'trusted',
      });
    }

    const project = await db.projects.create({
      id: 'proj_drain',
      userId,
      name: 'drain',
      root: '/tmp/drain',
      preferences: { protectedBranches: ['main'] },
    });
    projectId = project.id;
  });

  test('a newly connected gateway defaults to accepting sessions', () => {
    connect(DEVICE_A);
    expect(registry.getAdmissionPhase(DEVICE_A)).toBe('running');
    expect(registry.isDeviceAcceptingSessions(DEVICE_A)).toBe(true);
  });

  test('routing picks either device while both are running', async () => {
    connect(DEVICE_A);
    connect(DEVICE_B);

    const decision = await router.route(userId, { projectId, taskKind: 'general' });
    expect(decision.selected).not.toBeNull();
    expect([DEVICE_A, DEVICE_B]).toContain(decision.selected?.deviceId);
  });

  test('draining one of two devices sends all new work to the other', async () => {
    connect(DEVICE_A);
    connect(DEVICE_B);

    // Device A announces the drain on its heartbeat.
    registry.setAdmissionPhase(DEVICE_A, 'draining');

    // Every subsequent routing decision must avoid A entirely.
    for (let i = 0; i < 8; i++) {
      const decision = await router.route(userId, { projectId, taskKind: 'general' });
      expect(decision.selected?.deviceId).toBe(DEVICE_B);
      expect(decision.alternatives.every((alt) => alt.deviceId !== DEVICE_A)).toBe(true);
    }
  });

  test('a draining device stays online so its in-flight sessions still report', () => {
    connect(DEVICE_A, 'draining');

    // Online (events still flow) but not accepting new work.
    expect(registry.isDeviceOnline(DEVICE_A)).toBe(true);
    expect(registry.isDeviceAcceptingSessions(DEVICE_A)).toBe(false);
  });

  test('when every device is draining there is no eligible gateway', async () => {
    connect(DEVICE_A, 'draining');
    connect(DEVICE_B, 'aborting');

    const decision = await router.route(userId, { projectId, taskKind: 'general' });
    expect(decision.selected).toBeNull();
    expect(decision.reasons.join(' ')).toMatch(/No online gateway/i);
  });

  test('a device that finishes draining becomes eligible again', async () => {
    connect(DEVICE_A);
    connect(DEVICE_B, 'draining');

    let decision = await router.route(userId, { projectId, taskKind: 'general' });
    expect(decision.selected?.deviceId).toBe(DEVICE_A);

    // B restarts and reports running again on its next heartbeat.
    registry.setAdmissionPhase(DEVICE_B, 'running');
    registry.setAdmissionPhase(DEVICE_A, 'draining');

    decision = await router.route(userId, { projectId, taskKind: 'general' });
    expect(decision.selected?.deviceId).toBe(DEVICE_B);
  });
});
