import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type {
  Decision,
  EventEnvelope,
  SessionState,
  Capability,
  PolicyVersion,
} from '@odysseus/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

import type { IDatabase } from '../db/types';
import type { ApprovalRecord, StoredEvent } from '../types';

import type { ConnectionRegistry, GatewayAdmissionPhase } from './connection-registry';

export interface TunnelServerOptions {
  heartbeatTimeoutMs?: number;
}

interface InboundTunnelMessage {
  id?: string;
  type?: string;
  sequence?: number;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

export class TunnelServer {
  private wss: WebSocketServer;
  private db: IDatabase;
  private registry: ConnectionRegistry;
  public readonly heartbeatTimeoutMs: number;
  private pendingCommands = new Map<
    string,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private onEventBroadcast?: (event: StoredEvent) => void;
  private onApprovalCreated?: (approval: ApprovalRecord) => void;
  private onAdmissionPhaseChange?: (
    deviceId: string,
    phase: GatewayAdmissionPhase,
    previous: GatewayAdmissionPhase,
  ) => void;
  private policyEvaluator:
    | ((
        capability: Capability,
        riskClass: 'low' | 'medium' | 'high' | 'critical',
        context: {
          resource?: string;
          projectId?: string;
          deviceId: string;
          sessionId?: string;
          userId: string;
        },
        policyVersion: PolicyVersion | null,
      ) => Promise<Decision>)
    | undefined;

  constructor(db: IDatabase, registry: ConnectionRegistry, options: TunnelServerOptions = {}) {
    this.db = db;
    this.registry = registry;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWss();
  }

  setOnAdmissionPhaseChange(
    callback: (
      deviceId: string,
      phase: GatewayAdmissionPhase,
      previous: GatewayAdmissionPhase,
    ) => void,
  ): void {
    this.onAdmissionPhaseChange = callback;
  }

  setOnEventBroadcast(callback: (event: StoredEvent) => void): void {
    this.onEventBroadcast = callback;
  }

  setOnApprovalCreated(callback: (approval: ApprovalRecord) => void): void {
    this.onApprovalCreated = callback;
  }

  setPolicyEvaluator(evaluator: typeof this.policyEvaluator): void {
    this.policyEvaluator = evaluator;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private setupWss(): void {
    this.wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
      let authenticatedDeviceId: string | undefined;

      socket.on('message', (data: Buffer | string) => {
        void this.handleSocketMessage(
          socket,
          req,
          data,
          (devId) => {
            authenticatedDeviceId = devId;
          },
          () => authenticatedDeviceId,
        );
      });

      // Remove only the connection that died. A device holding several
      // tunnels stays online on the rest — removing the whole device would
      // turn one dropped socket into a full outage for that machine.
      socket.on('close', () => {
        if (authenticatedDeviceId) {
          this.registry.removeGatewaySocket(authenticatedDeviceId, socket);
        }
      });

      socket.on('error', () => {
        if (authenticatedDeviceId) {
          this.registry.removeGatewaySocket(authenticatedDeviceId, socket);
        }
      });
    });
  }

  private async handleSocketMessage(
    socket: WebSocket,
    req: IncomingMessage,
    data: Buffer | string,
    setAuthDevId: (id: string) => void,
    getAuthDevId: () => string | undefined,
  ): Promise<void> {
    try {
      const raw = data.toString('utf8');
      const msg = JSON.parse(raw) as InboundTunnelMessage;
      const { id, type, sequence, correlationId, payload } = msg;

      // 1. Handle initial Authentication
      if (type === 'auth') {
        const deviceId =
          typeof payload?.['deviceId'] === 'string' ? payload['deviceId'] : undefined;
        const gatewayId =
          typeof payload?.['gatewayId'] === 'string' ? payload['gatewayId'] : undefined;

        if (!deviceId || !gatewayId) {
          this.send(socket, {
            id: randomUUID(),
            type: 'auth_failure',
            sequence: 1,
            correlationId: id,
            timestamp: new Date(),
            payload: {
              code: 'INVALID_CREDENTIALS',
              reason: 'Missing deviceId or gatewayId',
              retryable: false,
            },
          });
          socket.close(4001, 'Authentication failed');
          return;
        }

        let device = await this.db.devices.findById(deviceId);
        if (!device) {
          const pairing = await this.db.pairings.findByDeviceId(deviceId);
          if (pairing && pairing.status === 'confirmed') {
            device = await this.db.devices.create({
              id: deviceId,
              gatewayId,
              userId: pairing.userId || 'usr_anonymous',
              friendlyName: `Device ${deviceId.slice(-6)}`,
              platform: 'unknown',
              publicKeyPem: '',
              publicKeyJwk: {},
              fingerprintHex: pairing.fingerprintHex,
              fingerprintWords: pairing.fingerprintWords,
              status: 'trusted',
            });
          } else {
            this.send(socket, {
              id: randomUUID(),
              type: 'auth_failure',
              sequence: 1,
              correlationId: id,
              timestamp: new Date(),
              payload: {
                code: 'DEVICE_NOT_TRUSTED',
                reason: 'Device is not yet paired or trusted by a user',
                retryable: true,
                retryAfterMs: 5000,
              },
            });
            return;
          }
        }

        if (device.status === 'revoked' || device.status === 'suspended') {
          this.send(socket, {
            id: randomUUID(),
            type: 'auth_failure',
            sequence: 1,
            correlationId: id,
            timestamp: new Date(),
            payload: {
              code: 'DEVICE_REVOKED',
              reason: `Device status is ${device.status}`,
              retryable: false,
            },
          });
          socket.close(4003, 'Device revoked');
          return;
        }

        setAuthDevId(deviceId);
        await this.db.devices.updateLastSeen(deviceId, new Date());

        // A gateway running several tunnels labels each one, so they are kept
        // side by side rather than each replacing the last.
        const connectionId =
          typeof payload?.['connectionId'] === 'string' ? payload['connectionId'] : 'default';

        this.registry.registerGateway({
          deviceId,
          gatewayId,
          socket,
          connectionId,
          connectedAt: new Date(),
          lastHeartbeatAt: new Date(),
          remoteAddress: req.socket.remoteAddress ?? undefined,
          capabilities: ['sessions', 'approvals', 'commands'],
        });

        this.send(socket, {
          id: randomUUID(),
          type: 'auth_success',
          sequence: 1,
          correlationId: id,
          timestamp: new Date(),
          payload: {
            sessionId: `cpsess_${randomUUID().replace(/-/g, '')}`,
            assignedGlobalSequence: 1,
            serverTimestamp: new Date(),
            capabilities: ['sessions', 'approvals', 'commands'],
          },
        });
        return;
      }

      const authedId = getAuthDevId();
      if (!authedId) {
        socket.close(4001, 'Unauthenticated');
        return;
      }

      // 2. Handle Heartbeat
      if (type === 'heartbeat') {
        await this.db.devices.updateLastSeen(authedId, new Date());
        const conn = this.registry.getGateway(authedId);
        if (conn) conn.lastHeartbeatAt = new Date();

        if (payload && typeof payload === 'object') {
          const p = payload;

          // Admission phase drives routing: a draining gateway must stop being
          // selected for new work immediately, while staying online so its
          // in-flight sessions can finish and report.
          const phase = p['admissionPhase'];
          if (
            phase === 'running' ||
            phase === 'draining' ||
            phase === 'aborting' ||
            phase === 'stopped'
          ) {
            const previous = this.registry.getAdmissionPhase(authedId);
            this.registry.setAdmissionPhase(authedId, phase);
            if (previous !== phase) {
              this.onAdmissionPhaseChange?.(authedId, phase, previous);
            }
          }
          const resources = (p['resources'] ?? p['resourceUsage'] ?? p) as Record<string, unknown>;
          if (
            typeof resources['cpuPercent'] === 'number' ||
            typeof resources['memoryMb'] === 'number' ||
            typeof resources['activeProcesses'] === 'number' ||
            typeof resources['diskFreeMb'] === 'number'
          ) {
            await this.db.devices.updateResourceUsage(authedId, {
              cpuPercent:
                typeof resources['cpuPercent'] === 'number' ? resources['cpuPercent'] : undefined,
              memoryMb:
                typeof resources['memoryMb'] === 'number' ? resources['memoryMb'] : undefined,
              memoryPeakMb:
                typeof resources['memoryPeakMb'] === 'number'
                  ? resources['memoryPeakMb']
                  : undefined,
              activeProcesses:
                typeof resources['activeProcesses'] === 'number'
                  ? resources['activeProcesses']
                  : undefined,
              diskFreeMb:
                typeof resources['diskFreeMb'] === 'number' ? resources['diskFreeMb'] : undefined,
            });
          }
        }

        this.send(socket, {
          id: randomUUID(),
          type: 'heartbeat',
          sequence: sequence ?? 0,
          correlationId: id,
          timestamp: new Date(),
          payload: { ack: true },
        });
        return;
      }

      // 3. Handle Acknowledgment
      if (type === 'ack') {
        if (correlationId && this.pendingCommands.has(correlationId)) {
          const pending = this.pendingCommands.get(correlationId)!;
          clearTimeout(pending.timer);
          this.pendingCommands.delete(correlationId);
          pending.resolve({
            acknowledged: true,
            sequence: sequence ?? null,
            payload,
          } as unknown);
        }
        return;
      }

      // 4. Handle Gateway Events
      if (type === 'event') {
        const envelope = (payload?.['event'] ?? payload) as EventEnvelope | undefined;
        if (envelope && envelope.sessionId) {
          const stored = await this.db.events.append({
            sessionId: envelope.sessionId,
            deviceId: authedId,
            sequence: envelope.sequence ?? sequence ?? 0,
            eventType: envelope.eventType,
            envelope,
          });

          if (envelope.eventType === 'session.status_changed') {
            const state = (envelope.payload as { state?: SessionState })?.state;
            if (state) {
              await this.db.sessions.update(envelope.sessionId, { state });
            }
          }

          if (envelope.eventType === 'session.approval_required') {
            const p = (envelope.payload ?? {}) as {
              actionType?: string;
              action?: { type?: string; description?: string; riskLevel?: string };
              description?: string;
              capability?: string;
              riskClass?: string;
              resource?: string;
            };
            const session = await this.db.sessions.findById(envelope.sessionId);
            const device = await this.db.devices.findById(authedId);

            // Evaluate policy if evaluator is available
            let policyVersion = 'p_default';
            let matchedRules: string[] | undefined;
            let requiredRole: 'owner' | 'admin' | undefined;
            let expiresAt = new Date(Date.now() + 30 * 60 * 1000);

            if (this.policyEvaluator && session && device) {
              const capability = (p.capability || p.action?.type || 'process.exec') as Capability;
              const riskClass = (p.riskClass || p.action?.riskLevel || 'medium') as
                'low' | 'medium' | 'high' | 'critical';
              const result = await this.policyEvaluator(
                capability,
                riskClass,
                {
                  ...(p.resource ? { resource: p.resource } : {}),
                  deviceId: authedId,
                  sessionId: envelope.sessionId,
                  userId: session.userId,
                },
                null, // Will use default policy version
              );
              policyVersion = result.policyVersion;
              if ('matchedRules' in result) matchedRules = result.matchedRules;
              if ('requiredRole' in result) requiredRole = result.requiredRole;
              if ('expiresAt' in result) expiresAt = result.expiresAt;
            }

            const approval = await this.db.approvals.create({
              sessionId: envelope.sessionId,
              deviceId: authedId,
              userId: session?.userId || 'usr_unknown',
              actionType: p.actionType || p.action?.type || 'operation',
              description: p.description || p.action?.description || 'Agent requires user approval',
              details: p as Record<string, unknown>,
              status: 'pending',
              policyVersion,
              matchedRules,
              requiredRole,
              expiresAt,
            });
            this.onApprovalCreated?.(approval);
          }

          if (this.onEventBroadcast) {
            this.onEventBroadcast(stored);
          }

          this.send(socket, {
            id: randomUUID(),
            type: 'ack',
            sequence: sequence ?? 0,
            correlationId: id,
            timestamp: new Date(),
            payload: { received: true, serverReceivedSequence: stored.sequence },
          });
        }
        return;
      }

      // 5. Handle Command Result
      if (type === 'command_result') {
        if (correlationId && this.pendingCommands.has(correlationId)) {
          const pending = this.pendingCommands.get(correlationId)!;
          clearTimeout(pending.timer);
          this.pendingCommands.delete(correlationId);
          pending.resolve({
            acknowledged: true,
            sequence: sequence ?? null,
            payload: payload,
          } as unknown);
        }
        return;
      }

      // 6. Handle Disconnect
      if (type === 'disconnect') {
        this.registry.removeGatewaySocket(authedId, socket);
        socket.close(1000, 'Gateway requested disconnect');
      }
    } catch (err) {
      // Was a bare `catch { /* swallow malformed messages */ }`. That comment
      // was only accurate for the JSON.parse at the top of this method — it
      // also caught every exception thrown while processing a well-formed
      // message (e.g. a DB error while appending an event), so a real bug in
      // event/command handling failed silently with no trace, and the caller
      // waiting on a response (ack, event forward, command result) hung until
      // its own timeout instead of seeing the actual error.
      console.error('[tunnel-server] error handling gateway message:', err);
    }
  }

  /**
   * Send a command to a connected gateway device and wait for its ack.
   * Resolves with the ack payload or rejects if the device is offline or the
   * command times out (default 10 s). The caller is responsible for handling
   * the result — updating session state, surfacing errors, etc.
   */
  async sendCommandToDevice(
    deviceId: string,
    commandType: string,
    payload: unknown,
    timeoutMs = 10_000,
    expectAck = true,
  ): Promise<{
    acknowledged: boolean;
    sequence: number | null;
    delivered: boolean;
    payload?: unknown;
  }> {
    // Pick the least-loaded healthy connection rather than always the first.
    // With one connection this is the previous behaviour; with several it
    // keeps a slow command from blocking everything queued behind it, and
    // makes a dropped socket invisible as long as another is up.
    const conn = this.registry.pickConnection(deviceId);
    const delivered = !!conn && conn.socket.readyState === 1;

    if (!conn || !delivered) {
      return { acknowledged: false, sequence: null, delivered: false, payload: undefined };
    }

    conn.inFlight = (conn.inFlight ?? 0) + 1;
    const releaseSlot = (): void => {
      conn.inFlight = Math.max(0, (conn.inFlight ?? 1) - 1);
    };

    const commandId = `cmd_${randomUUID().replace(/-/g, '')}`;
    const message = {
      id: commandId,
      type: 'command',
      sequence: 1,
      timestamp: new Date(),
      payload: {
        commandId,
        commandType,
        commandVersion: 1,
        issuedAt: new Date(),
        payload,
      },
    };

    if (!expectAck) {
      this.send(conn.socket, message);
      releaseSlot();
      return { acknowledged: false, sequence: null, delivered: true, payload: undefined };
    }

    return new Promise<{
      acknowledged: boolean;
      sequence: number | null;
      delivered: boolean;
      payload?: unknown;
    }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        releaseSlot();
        resolve({ acknowledged: false, sequence: null, delivered: true, payload: undefined });
      }, timeoutMs);

      this.pendingCommands.set(commandId, {
        resolve: (val: unknown) => {
          clearTimeout(timer);
          this.pendingCommands.delete(commandId);
          releaseSlot();
          resolve({
            acknowledged: true,
            sequence: (val as { sequence?: number })?.sequence ?? null,
            delivered: true,
            payload: (val as { payload?: unknown })?.payload,
          });
        },
        reject: () => {
          clearTimeout(timer);
          this.pendingCommands.delete(commandId);
          releaseSlot();
          resolve({ acknowledged: false, sequence: null, delivered: true, payload: undefined });
        },
        timer,
      });

      try {
        this.send(conn.socket, message);
      } catch {
        clearTimeout(timer);
        this.pendingCommands.delete(commandId);
        releaseSlot();
        resolve({ acknowledged: false, sequence: null, delivered: true, payload: undefined });
      }
    });
  }

  /**
   * Forcefully disconnect a device's tunnel and clean up registry state.
   * Called when a device is revoked via the REST API.
   */
  forceDisconnectDevice(deviceId: string, reason: string): void {
    const conn = this.registry.getGateway(deviceId);
    if (!conn) return;

    // Send a disconnect notice so the gateway can clean up gracefully
    this.send(conn.socket, {
      id: randomUUID(),
      type: 'disconnect',
      sequence: 0,
      timestamp: new Date(),
      payload: { reason, code: 'DEVICE_REVOKED' },
    });

    // Close the WebSocket with a protocol-specific code
    try {
      conn.socket.close(4003, reason);
    } catch {
      /* already closed */
    }

    // Remove from registry
    this.registry.removeGateway(deviceId);
  }

  /**
   * Send a disconnect notice and close a gateway WebSocket on a best-effort
   * basis. Unlike `forceDisconnectDevice`, this does NOT remove the entry
   * from the registry — the caller does that after the close() is issued.
   */
  sendDisconnectNotice(deviceId: string, reason: string): boolean {
    const conn = this.registry.getGateway(deviceId);
    if (!conn) return false;

    this.send(conn.socket, {
      id: randomUUID(),
      type: 'disconnect',
      sequence: 0,
      timestamp: new Date(),
      payload: { reason, code: 'SESSION_REMOVED' },
    });

    try {
      conn.socket.close(1000, reason);
    } catch {
      /* already closed */
    }

    return true;
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    for (const [, p] of this.pendingCommands) {
      clearTimeout(p.timer);
      p.reject(new Error('Tunnel server shutting down'));
    }
    this.pendingCommands.clear();
    this.wss.close();
  }
}
