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

import { isUsablePublicKeyJwk } from '../auth/device-signature';
import type { IDatabase } from '../db/types';
import type { ApprovalRecord, DeviceRecord, StoredEvent } from '../types';

import type { ConnectionRegistry, GatewayAdmissionPhase } from './connection-registry';
import { DeviceAuthenticator, type AuthDenial, type PendingChallenge } from './device-auth';

export interface TunnelServerOptions {
  heartbeatTimeoutMs?: number;
  /** Overrides for the device authentication exchange; see device-auth.ts. */
  clockSkewToleranceMs?: number;
  challengeTtlMs?: number;
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
  /** Callers awaiting a session.started event, keyed by sessionId. */
  private pendingSessionStarts = new Map<
    string,
    {
      resolve: (result: { started: boolean; error?: string; timedOut?: boolean }) => void;
      timer: NodeJS.Timeout;
    }
  >();
  /** Results that arrived before anyone waited for them. */
  private settledSessionStarts = new Map<string, { started: boolean; error?: string }>();
  /** Per-socket authentication state: the challenge awaiting its response. */
  private readonly socketAuth = new WeakMap<WebSocket, { pending?: PendingChallenge }>();
  private readonly authenticator: DeviceAuthenticator;
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
    this.authenticator = new DeviceAuthenticator({
      ...(options.clockSkewToleranceMs !== undefined
        ? { clockSkewToleranceMs: options.clockSkewToleranceMs }
        : {}),
      ...(options.challengeTtlMs !== undefined ? { challengeTtlMs: options.challengeTtlMs } : {}),
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWss();
  }

  /**
   * Wait for the gateway to report that a session actually started.
   *
   * `sendCommandToDevice` resolving only means the gateway received and
   * accepted the start command. The adapter may still fail to launch. This
   * waits for the `session.started` event (or a failure event) so the HTTP
   * response reflects what really happened rather than what was requested.
   */
  waitForSessionStart(
    sessionId: string,
    timeoutMs = 15_000,
  ): Promise<{ started: boolean; error?: string; timedOut?: boolean }> {
    // The event can arrive before the caller starts waiting, so a result
    // recorded in the meantime is returned immediately.
    const settled = this.settledSessionStarts.get(sessionId);
    if (settled) {
      this.settledSessionStarts.delete(sessionId);
      return Promise.resolve(settled);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSessionStarts.delete(sessionId);
        resolve({
          started: false,
          timedOut: true,
          error:
            'Gateway accepted the start command but never reported session.started; ' +
            'the adapter may have failed to launch',
        });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pendingSessionStarts.set(sessionId, { resolve, timer });
    });
  }

  private resolveSessionStart(
    sessionId: string,
    result: { started: boolean; error?: string },
  ): void {
    const pending = this.pendingSessionStarts.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSessionStarts.delete(sessionId);
      pending.resolve(result);
      return;
    }
    // Arrived before anyone waited — hold it briefly so the waiter sees it.
    this.settledSessionStarts.set(sessionId, result);
    const expiry = setTimeout(() => this.settledSessionStarts.delete(sessionId), 30_000);
    if (typeof expiry.unref === 'function') expiry.unref();
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

  /**
   * Handle both steps of the gateway authentication exchange.
   *
   * Step 1 carries the device's claimed identity and a signature the server
   * verifies against the key recorded at pairing time. Step 2 answers a
   * server-chosen challenge, which is what makes a captured step 1 useless to
   * replay. See `device-auth.ts` for the protocol.
   */
  private async handleAuthMessage(
    socket: WebSocket,
    req: IncomingMessage,
    correlationId: string | undefined,
    payload: Record<string, unknown>,
    setAuthDevId: (id: string) => void,
  ): Promise<void> {
    const state = this.socketAuth.get(socket);

    // A socket that already holds a challenge is answering it. Anything else
    // on that socket is a fresh attempt, which restarts the exchange.
    if (state?.pending && typeof payload['challenge'] === 'string') {
      const pending = state.pending;
      this.socketAuth.set(socket, {});

      const device = await this.db.devices.findById(pending.deviceId);
      if (!device) {
        this.denyAuth(socket, correlationId, {
          ok: false,
          code: 'DEVICE_NOT_TRUSTED',
          reason: 'Device disappeared between challenge and response',
          retryable: true,
          fatal: true,
        });
        return;
      }

      const outcome = this.authenticator.completeAuth(pending, payload, device.publicKeyJwk);
      if (!outcome.ok) {
        this.denyAuth(socket, correlationId, outcome);
        return;
      }

      setAuthDevId(pending.deviceId);
      await this.db.devices.updateLastSeen(pending.deviceId, new Date());

      this.registry.registerGateway({
        deviceId: pending.deviceId,
        gatewayId: pending.gatewayId,
        socket,
        connectionId: pending.connectionId,
        connectedAt: new Date(),
        lastHeartbeatAt: new Date(),
        remoteAddress: req.socket.remoteAddress ?? undefined,
        capabilities: ['sessions', 'approvals', 'commands'],
      });

      this.send(socket, {
        id: randomUUID(),
        type: 'auth_success',
        sequence: 1,
        correlationId,
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

    // ---------------------------------------------------------------- step 1
    const deviceId = typeof payload['deviceId'] === 'string' ? payload['deviceId'] : '';
    const gatewayId = typeof payload['gatewayId'] === 'string' ? payload['gatewayId'] : '';
    const connectionId =
      typeof payload['connectionId'] === 'string' ? payload['connectionId'] : 'default';

    const resolution = await this.resolveAuthDevice(deviceId, gatewayId);
    if ('denial' in resolution) {
      this.denyAuth(socket, correlationId, resolution.denial);
      return;
    }
    const device = resolution.device;

    const begun = this.authenticator.beginAuth(
      {
        deviceId,
        gatewayId,
        connectionId,
        nonce: typeof payload['nonce'] === 'string' ? payload['nonce'] : '',
        timestamp: typeof payload['timestamp'] === 'string' ? payload['timestamp'] : '',
        certificateThumbprint:
          typeof payload['certificateThumbprint'] === 'string'
            ? payload['certificateThumbprint']
            : undefined,
        signature: typeof payload['signature'] === 'string' ? payload['signature'] : '',
      },
      device.publicKeyJwk,
    );

    if (!begun.ok) {
      this.denyAuth(socket, correlationId, begun);
      return;
    }

    this.socketAuth.set(socket, { pending: begun.challenge });
    this.send(socket, {
      id: randomUUID(),
      type: 'auth_challenge',
      sequence: 1,
      correlationId,
      timestamp: new Date(),
      payload: {
        challenge: begun.challenge.challenge,
        serverNonce: begun.challenge.serverNonce,
        issuedAt: begun.challenge.issuedAtIso,
        expiresAt: new Date(begun.challenge.expiresAt).toISOString(),
      },
    });
  }

  /**
   * Find the device this gateway claims to be, creating it from a confirmed
   * pairing the first time it connects.
   *
   * The device is only created when the pairing carries a real public key. A
   * device row with an empty key can never authenticate, so creating one would
   * only replace a clear "not paired" error with a confusing permanent failure.
   */
  private async resolveAuthDevice(
    deviceId: string,
    gatewayId: string,
  ): Promise<{ device: DeviceRecord } | { denial: AuthDenial }> {
    if (!deviceId || !gatewayId) {
      return {
        denial: {
          ok: false,
          code: 'INVALID_CREDENTIALS',
          reason: 'Missing deviceId or gatewayId',
          retryable: false,
          fatal: true,
        },
      };
    }

    let device = await this.db.devices.findById(deviceId);

    if (!device) {
      const pairing = await this.db.pairings.findByDeviceId(deviceId);
      if (!pairing || pairing.status !== 'confirmed') {
        return {
          denial: {
            ok: false,
            code: 'DEVICE_NOT_TRUSTED',
            reason: 'Device is not yet paired or trusted by a user',
            retryable: true,
            fatal: false,
          },
        };
      }

      if (!isUsablePublicKeyJwk(pairing.publicKeyJwk)) {
        return {
          denial: {
            ok: false,
            code: 'DEVICE_KEY_MISSING',
            reason:
              'This pairing recorded no device public key, so the gateway cannot prove its ' +
              'identity. Re-run pairing with an up-to-date gateway.',
            retryable: false,
            fatal: true,
          },
        };
      }

      device = await this.db.devices.create({
        id: deviceId,
        gatewayId,
        userId: pairing.userId || 'usr_anonymous',
        friendlyName: `Device ${deviceId.slice(-6)}`,
        platform: 'unknown',
        publicKeyPem: pairing.publicKeyPem ?? '',
        publicKeyJwk: pairing.publicKeyJwk,
        fingerprintHex: pairing.fingerprintHex,
        fingerprintWords: pairing.fingerprintWords,
        status: 'trusted',
      });
    }

    if (device.status === 'revoked' || device.status === 'suspended') {
      return {
        denial: {
          ok: false,
          code: 'DEVICE_REVOKED',
          reason: `Device status is ${device.status}`,
          retryable: false,
          fatal: true,
        },
      };
    }

    return { device };
  }

  /**
   * Report a refusal in the shape TunnelClient's failure taxonomy expects, so
   * a permanent rejection exits rather than reconnecting forever.
   */
  private denyAuth(socket: WebSocket, correlationId: string | undefined, denial: AuthDenial): void {
    this.socketAuth.set(socket, {});
    this.send(socket, {
      id: randomUUID(),
      type: 'auth_failure',
      sequence: 1,
      correlationId,
      timestamp: new Date(),
      payload: {
        code: denial.code,
        reason: denial.reason,
        retryable: denial.retryable,
        ...(denial.retryable ? { retryAfterMs: 5000 } : {}),
      },
    });
    if (denial.fatal) {
      socket.close(denial.code === 'DEVICE_REVOKED' ? 4003 : 4001, 'Authentication failed');
    }
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

      // 1. Authentication. Both steps of the challenge-response arrive as
      // `auth`; which one this is depends on the state held for this socket.
      if (type === 'auth') {
        await this.handleAuthMessage(socket, req, id, payload ?? {}, setAuthDevId);
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

          // A session becomes `running` only when the gateway reports that it
          // actually started. An ack means the command was received, not that
          // the adapter launched anything — treating the two as the same is
          // how a session ends up live-looking and silent.
          if (envelope.eventType === 'session.started') {
            await this.db.sessions.update(envelope.sessionId, { state: 'running' });
            this.resolveSessionStart(envelope.sessionId, { started: true });
          }

          if (envelope.eventType === 'session.failed' || envelope.eventType === 'session.crashed') {
            const reason =
              (envelope.payload as { error?: string; reason?: string })?.error ??
              (envelope.payload as { reason?: string })?.reason ??
              `Session ${envelope.eventType.split('.')[1]}`;
            this.resolveSessionStart(envelope.sessionId, { started: false, error: reason });
          }

          if (envelope.eventType === 'session.status_changed') {
            const state = (envelope.payload as { state?: SessionState })?.state;
            if (state) {
              await this.db.sessions.update(envelope.sessionId, { state });
              if (state === 'running') {
                this.resolveSessionStart(envelope.sessionId, { started: true });
              }
              if (state === 'failed') {
                this.resolveSessionStart(envelope.sessionId, {
                  started: false,
                  error: 'Gateway reported the session as failed',
                });
              }
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
