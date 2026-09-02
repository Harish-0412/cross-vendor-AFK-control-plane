import { randomBytes } from 'node:crypto';

import type {
  ReconciliationRequest,
  ReconciliationResponse,
  SessionReconciliationState,
  EventEnvelope,
} from '@freebuff/protocol';

import type {
  TunnelConfig,
  TunnelState,
  TunnelMessage,
  TunnelMessageType,
  TunnelStats,
  TunnelEvent,
  TunnelEventListener,
  AuthPayload,
  AuthChallengePayload,
  AuthSuccessPayload,
  AuthFailurePayload,
} from './types';
import { DEFAULT_TUNNEL_CONFIG } from './types';
// Reconciliation and event-envelope shapes are protocol-level contracts shared
// with the Control Plane, so they come from the protocol package rather than
// being redeclared per-transport.

type WebSocketClass = new (
  url: string,
  protocols?: string | string[],
  options?: Record<string, unknown>,
) => {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
};

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export interface TunnelAuthProvider {
  getPublicKeyJwk(): Record<string, unknown>;
  getCertificateThumbprint(): string | null;
  sign(data: string): string;
  verifySignature(data: string, signature: string, publicKeyJwk?: Record<string, unknown>): boolean;
}

export interface TunnelReconciliationProvider {
  getSessionStates(): SessionReconciliationState[];
  getLastAckedGlobalSequence(): number;
  applySessionUpdates(
    updates: ReconciliationResponse['sessionUpdates'],
  ): Promise<{ applied: number; warnings: string[] }>;
  replayEvent(sequence: number, event: unknown): Promise<boolean>;
  getEventsSince(
    fromSequence: number,
  ): Promise<Array<{ sequence: number; envelope: EventEnvelope }>>;
  recordUnrecoverableGap(sessionId: string | null, from: number, to: number, reason: string): void;
}

export interface TunnelCommandHandler {
  handleCommand(command: unknown): Promise<{ success: boolean; result?: unknown; error?: string }>;
}

export class TunnelClient {
  private readonly config: Required<Omit<TunnelConfig, 'authToken' | 'tlsOptions' | 'wsOptions'>> &
    Pick<TunnelConfig, 'authToken' | 'tlsOptions' | 'wsOptions'>;
  private _state: TunnelState = 'idle';
  private messageQueue: TunnelMessage[] = [];
  private sequenceCounter = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout | undefined;
  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private heartbeatTimeoutTimer?: NodeJS.Timeout | undefined;
  private authTimeoutTimer?: NodeJS.Timeout | undefined;
  private stats: {
    messagesSent: number;
    messagesReceived: number;
    bytesSent: number;
    bytesReceived: number;
    connectedAt?: Date;
    lastDisconnectedAt?: Date;
    lastSentAt?: Date;
    lastReceivedAt?: Date;
    lastHeartbeatSentAt?: Date;
    lastHeartbeatReceivedAt?: Date;
    disconnectedTimeMs: number;
    missedHeartbeats: number;
    authFailures: number;
    globalSequenceAcked: number;
    globalSequenceSent: number;
  } = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    disconnectedTimeMs: 0,
    missedHeartbeats: 0,
    authFailures: 0,
    globalSequenceAcked: 0,
    globalSequenceSent: 0,
  };
  private listeners: Set<TunnelEventListener> = new Set();
  private shuttingDown = false;
  private ws: InstanceType<WebSocketClass> | null = null;
  private WebSocketImpl: WebSocketClass | null = null;
  private authProvider: TunnelAuthProvider | null = null;
  private reconciliationProvider: TunnelReconciliationProvider | null = null;
  private commandHandler: TunnelCommandHandler | null = null;
  private wsSessionId: string | null = null;
  private disconnectInitiatedByServer = false;
  private disconnectCode = 0;
  private disconnectReason = '';
  private disconnectWasClean = true;

  constructor(config: TunnelConfig) {
    this.config = {
      ...DEFAULT_TUNNEL_CONFIG,
      ...config,
    };
  }

  setWebSocketImplementation(impl: WebSocketClass | null): void {
    this.WebSocketImpl = impl;
  }

  setAuthProvider(provider: TunnelAuthProvider | null): void {
    this.authProvider = provider;
  }

  setReconciliationProvider(provider: TunnelReconciliationProvider | null): void {
    this.reconciliationProvider = provider;
  }

  setCommandHandler(handler: TunnelCommandHandler | null): void {
    this.commandHandler = handler;
  }

  getState(): TunnelState {
    return this._state;
  }

  getWsSessionId(): string | null {
    return this.wsSessionId;
  }

  /**
   * Why the tunnel last dropped. The reconnect path moves through
   * Reconnecting → Degraded → reconciliation without surfacing a reason on its
   * own, so this is what tells an operator whether the Control Plane closed the
   * socket deliberately (code >= 4000) or the connection died mid-flight.
   */
  getLastDisconnect(): {
    initiatedByServer: boolean;
    code: number;
    reason: string;
    wasClean: boolean;
    at: Date | undefined;
  } {
    return {
      initiatedByServer: this.disconnectInitiatedByServer,
      code: this.disconnectCode,
      reason: this.disconnectReason,
      wasClean: this.disconnectWasClean,
      at: this.stats.lastDisconnectedAt,
    };
  }

  getStats(): TunnelStats {
    const now = Date.now();
    let uptimeMs = 0;
    if (this.stats.connectedAt && this._state === 'connected') {
      uptimeMs = now - this.stats.connectedAt.getTime();
    }

    return {
      state: this._state,
      messagesSent: this.stats.messagesSent,
      messagesReceived: this.stats.messagesReceived,
      messagesQueued: this.messageQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      bytesSent: this.stats.bytesSent,
      bytesReceived: this.stats.bytesReceived,
      connectedAt: this.stats.connectedAt,
      lastDisconnectedAt: this.stats.lastDisconnectedAt,
      lastSentAt: this.stats.lastSentAt,
      lastReceivedAt: this.stats.lastReceivedAt,
      uptimeMs,
      disconnectedTimeMs: this.stats.disconnectedTimeMs,
      lastHeartbeatSentAt: this.stats.lastHeartbeatSentAt,
      lastHeartbeatReceivedAt: this.stats.lastHeartbeatReceivedAt,
      missedHeartbeats: this.stats.missedHeartbeats,
      authFailures: this.stats.authFailures,
      globalSequenceAcked: this.stats.globalSequenceAcked,
      globalSequenceSent: this.stats.globalSequenceSent,
    };
  }

  async connect(): Promise<void> {
    if (this.shuttingDown) return;
    if (
      this._state === 'connected' ||
      this._state === 'connecting' ||
      this._state === 'authenticating'
    ) {
      return;
    }

    if (!this.config.controlPlaneUrl) {
      this.setState('error');
      this.emitEvent({
        type: 'error',
        timestamp: new Date(),
        message: 'controlPlaneUrl is required',
      });
      throw new Error('controlPlaneUrl is required for tunnel connection');
    }

    this.setState('connecting');

    try {
      await this.openWebSocket();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'error',
        timestamp: new Date(),
        message: `Failed to open WebSocket: ${message}`,
      });
      this.handleConnectionFailure();
    }
  }

  private async openWebSocket(): Promise<void> {
    const WS = this.WebSocketImpl;
    if (!WS) {
      this.emitEvent({
        type: 'state_change',
        timestamp: new Date(),
        state: 'connected',
        previousState: 'connecting',
        message:
          'Phase 2 stub: No WebSocket implementation provided, simulating connection (use setWebSocketImplementation for real WS)',
      });
      this.simulateConnection();
      return;
    }

    const url = this.config.controlPlaneUrl;
    const protocols = 'freebuff-tunnel.v1';
    const options: Record<string, unknown> = {};

    if (this.config.tlsOptions) {
      if (this.config.tlsOptions.caCertPem) options.ca = this.config.tlsOptions.caCertPem;
      if (this.config.tlsOptions.clientCertPem) options.cert = this.config.tlsOptions.clientCertPem;
      if (this.config.tlsOptions.clientKeyPem) options.key = this.config.tlsOptions.clientKeyPem;
      if (this.config.tlsOptions.rejectUnauthorized !== undefined) {
        options.rejectUnauthorized = this.config.tlsOptions.rejectUnauthorized;
      }
      if (this.config.tlsOptions.serverName) {
        options.servername = this.config.tlsOptions.serverName;
      }
    }

    if (this.config.wsOptions?.headers) {
      options.headers = { ...this.config.wsOptions.headers };
    }
    if (this.config.wsOptions?.origin) {
      if (!options.headers) options.headers = {};
      (options.headers as Record<string, string>).Origin = this.config.wsOptions.origin;
    }
    if (this.config.authToken) {
      if (!options.headers) options.headers = {};
      (options.headers as Record<string, string>).Authorization = `Bearer ${this.config.authToken}`;
    }

    let connectTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    await new Promise<void>((resolve, reject) => {
      try {
        const ws = new WS(url, protocols, Object.keys(options).length > 0 ? options : undefined);
        this.ws = ws;

        connectTimer = setTimeout(() => {
          timedOut = true;
          try {
            ws.close(4000, 'Connection timeout');
          } catch {
            /* ignore */
          }
          reject(new Error(`Connection timed out after ${this.config.connectTimeoutMs}ms`));
        }, this.config.connectTimeoutMs);

        ws.onopen = () => {
          if (timedOut) return;
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          this.handleWebSocketOpen();
          resolve();
        };

        ws.onmessage = (event: { data: unknown }) => {
          this.handleWebSocketMessage(event.data);
        };

        ws.onclose = (event: { code: number; reason: string; wasClean: boolean }) => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          this.handleWebSocketClose(event.code, event.reason, event.wasClean);
        };

        ws.onerror = () => {
          // The close handler will fire next; avoid double-rejection
        };
      } catch (err) {
        if (connectTimer) {
          clearTimeout(connectTimer);
        }
        reject(err);
      }
    });
  }

  private simulateConnection(): void {
    this.setState('connected');
    this.stats.connectedAt = new Date();
    this.reconnectAttempts = 0;
    this.wsSessionId = `sim-${randomBytes(8).toString('hex')}`;
    this.stats.globalSequenceAcked = 0;
    this.emitEvent({
      type: 'auth_success',
      timestamp: new Date(),
      payload: { simulated: true },
    });
    this.startHeartbeat();
    void this.flushQueue();
  }

  private handleWebSocketOpen(): void {
    this.setState('authenticating');
    this.emitEvent({
      type: 'auth_started',
      timestamp: new Date(),
      message: 'Performing device auth handshake',
    });
    this.startAuthTimeout();
    this.sendAuthMessage();
  }

  private sendAuthMessage(): void {
    if (!this.authProvider) {
      this.setState('connected');
      this.stats.connectedAt = new Date();
      this.reconnectAttempts = 0;
      this.stopAuthTimeout();
      this.startHeartbeat();
      void this.flushQueue();
      return;
    }

    const nonce = randomBytes(32).toString('hex');
    const timestamp = new Date();
    const thumbprint = this.authProvider.getCertificateThumbprint();
    const payload: AuthPayload = {
      deviceId: this.config.deviceId,
      gatewayId: this.config.gatewayId,
      nonce,
      timestamp,
      publicKeyJwk: this.authProvider.getPublicKeyJwk(),
      certificateThumbprint: thumbprint ?? undefined,
      signature: '',
    };
    const signatureBase = JSON.stringify({
      deviceId: payload.deviceId,
      gatewayId: payload.gatewayId,
      nonce: payload.nonce,
      timestamp: payload.timestamp.toISOString(),
      certificateThumbprint: payload.certificateThumbprint ?? '',
    });
    payload.signature = this.authProvider.sign(signatureBase);

    this.sendRaw('auth', payload);
  }

  private startAuthTimeout(): void {
    this.stopAuthTimeout();
    this.authTimeoutTimer = setTimeout(() => {
      this.stats.authFailures++;
      this.emitEvent({
        type: 'auth_failure',
        timestamp: new Date(),
        message: 'Authentication timed out',
      });
      this.handleAuthFailure('AUTH_TIMEOUT', 'Authentication timed out', true, 2000);
    }, this.config.authTimeoutMs);
    if (typeof this.authTimeoutTimer.unref === 'function') {
      this.authTimeoutTimer.unref();
    }
  }

  private stopAuthTimeout(): void {
    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer);
      this.authTimeoutTimer = undefined;
    }
  }

  private handleWebSocketMessage(data: unknown): void {
    try {
      const str =
        typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8');
      const parsed = JSON.parse(str) as TunnelMessage;
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid message');

      this.stats.messagesReceived++;
      this.stats.bytesReceived += str.length;
      this.stats.lastReceivedAt = new Date();

      this.emitEvent({
        type: 'message_received',
        timestamp: new Date(),
        payload: { type: parsed.type, id: parsed.id },
      });

      switch (parsed.type) {
        case 'auth_challenge':
          this.handleAuthChallenge(parsed.payload as AuthChallengePayload);
          break;
        case 'auth_success':
          this.handleAuthSuccess(parsed.payload as AuthSuccessPayload);
          break;
        case 'auth_failure':
          this.handleAuthFailurePayload(parsed.payload as AuthFailurePayload);
          break;
        case 'heartbeat':
          this.handleIncomingHeartbeat(parsed.payload as { timestamp: Date; sequence: number });
          break;
        case 'command':
          void this.handleIncomingCommand(parsed);
          break;
        case 'ack':
          this.handleAck(parsed.payload as { sequence: number });
          break;
        case 'disconnect':
          this.handleServerDisconnect(
            parsed.payload as { reason: string; code: number; willReconnect: boolean },
          );
          break;
        case 'reconciliation_response':
          void this.handleReconciliationResponse(parsed.payload as ReconciliationResponse);
          break;
        case 'replay_event':
        case 'replay':
        case 'event':
          // Forward to message handler
          break;
        case 'error':
          this.emitEvent({
            type: 'error',
            timestamp: new Date(),
            payload: parsed.payload,
          });
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'error',
        timestamp: new Date(),
        message: `Failed to parse incoming message: ${message}`,
      });
    }
  }

  private handleAuthChallenge(payload: AuthChallengePayload): void {
    if (!this.authProvider) return;

    const signatureBase = JSON.stringify({
      challenge: payload.challenge,
      serverNonce: payload.serverNonce,
      issuedAt: payload.issuedAt.toISOString(),
    });
    const signature = this.authProvider.sign(signatureBase);

    this.sendRaw('auth', {
      challenge: payload.challenge,
      serverNonce: payload.serverNonce,
      signature,
      deviceId: this.config.deviceId,
    });
  }

  private handleAuthSuccess(payload: AuthSuccessPayload): void {
    this.stopAuthTimeout();
    this.wsSessionId = payload.sessionId;
    this.stats.globalSequenceAcked = payload.assignedGlobalSequence ?? 0;
    this.setState('connected');
    this.stats.connectedAt = new Date();
    this.reconnectAttempts = 0;
    this.emitEvent({
      type: 'auth_success',
      timestamp: new Date(),
      payload: {
        sessionId: payload.sessionId,
        assignedGlobalSequence: payload.assignedGlobalSequence,
      },
    });
    this.startHeartbeat();
    void this.flushQueue();
  }

  private handleAuthFailurePayload(payload: AuthFailurePayload): void {
    this.stopAuthTimeout();
    this.stats.authFailures++;
    this.emitEvent({
      type: 'auth_failure',
      timestamp: new Date(),
      payload,
    });
    this.handleAuthFailure(payload.code, payload.reason, payload.retryable, payload.retryAfterMs);
  }

  private handleAuthFailure(
    code: string,
    reason: string,
    retryable: boolean,
    retryAfterMs?: number,
  ): void {
    try {
      this.ws?.close(4001, `Auth failed: ${code}`);
    } catch {
      /* ignore */
    }
    this.ws = null;

    if (!retryable) {
      this.setState('error');
      this.emitEvent({
        type: 'error',
        timestamp: new Date(),
        message: `Authentication failed (non-retryable): ${code} - ${reason}`,
      });
      return;
    }

    const deviceStatus =
      reason.toLowerCase().includes('revoke') || code.includes('REVOKED') ? 'revoked' : undefined;

    if (deviceStatus === 'revoked') {
      this.emitEvent({
        type: 'certificate_warning',
        timestamp: new Date(),
        message: 'Device certificate is revoked; aborting reconnect',
      });
      this.setState('error');
      return;
    }

    this.handleConnectionFailure(retryAfterMs);
  }

  private handleIncomingHeartbeat(payload: { timestamp: Date; sequence: number }): void {
    this.stats.lastHeartbeatReceivedAt = new Date();
    this.stats.missedHeartbeats = 0;
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = undefined;
    }
    if (payload.sequence !== undefined) {
      this.stats.globalSequenceAcked = Math.max(this.stats.globalSequenceAcked, payload.sequence);
    }
  }

  private async handleIncomingCommand(msg: TunnelMessage): Promise<void> {
    if (!this.commandHandler) return;
    try {
      const result = await this.commandHandler.handleCommand(msg.payload);
      const correlation = msg.correlationId ?? msg.id;
      if (correlation) {
        this.sendRaw('ack', {
          correlationId: correlation,
          success: result.success,
          result: result.result,
          error: result.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (msg.correlationId ?? msg.id) {
        this.sendRaw('ack', {
          correlationId: msg.correlationId ?? msg.id,
          success: false,
          error: message,
        });
      }
    }
  }

  private handleAck(payload: { sequence: number }): void {
    if (payload && typeof payload.sequence === 'number') {
      this.stats.globalSequenceAcked = Math.max(this.stats.globalSequenceAcked, payload.sequence);
    }
  }

  private handleServerDisconnect(payload: {
    reason: string;
    code: number;
    willReconnect: boolean;
  }): void {
    this.disconnectInitiatedByServer = true;
    this.disconnectCode = payload.code;
    this.disconnectReason = payload.reason;
    this.emitEvent({
      type: 'state_change',
      timestamp: new Date(),
      message: `Server initiated disconnect: ${payload.reason} (${payload.code}). Will reconnect: ${payload.willReconnect}`,
    });
    if (!payload.willReconnect) {
      this.config.autoReconnect = false;
    }
  }

  private handleWebSocketClose(code: number, reason: string, wasClean: boolean): void {
    const now = Date.now();
    this.stopHeartbeat();
    this.stopAuthTimeout();
    this.wsSessionId = null;

    const prevConnectedAt = this.stats.connectedAt;
    if (prevConnectedAt) {
      this.stats.disconnectedTimeMs += now - prevConnectedAt.getTime();
    }
    this.stats.lastDisconnectedAt = new Date();
    // Close codes at or above 4000 are application-defined, so the Control
    // Plane closing the socket deliberately lands in that range.
    this.disconnectInitiatedByServer = code >= 4000;
    this.disconnectCode = code;
    this.disconnectReason = reason;
    this.disconnectWasClean = wasClean;

    const state = this._state;
    if (state === 'disconnecting') {
      this.setState('disconnected');
      return;
    }

    if (this.shuttingDown) {
      this.setState('idle');
      return;
    }

    if (this.config.autoReconnect) {
      void this.reconnect();
    } else {
      this.setState('disconnected');
    }
  }

  private handleConnectionFailure(retryAfterMs?: number): void {
    if (this.shuttingDown) return;
    this.stopHeartbeat();
    this.stopAuthTimeout();
    this.wsSessionId = null;

    if (this.config.autoReconnect) {
      void this.reconnect(retryAfterMs);
    } else {
      this.setState('disconnected');
    }
  }

  async disconnect(): Promise<void> {
    if (
      this._state === 'idle' ||
      this._state === 'disconnected' ||
      this._state === 'disconnecting'
    ) {
      return;
    }

    this.setState('disconnecting');
    this.stopHeartbeat();
    this.stopReconnect();
    this.stopAuthTimeout();

    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.sendRaw('disconnect', {
          reason: 'Client initiated disconnect',
          code: 1000,
          willReconnect: false,
          serverInitiated: false,
        });
      } catch {
        /* ignore */
      }
      try {
        this.ws.close(1000, 'Client shutdown');
      } catch {
        /* ignore */
      }
    }
    this.ws = null;

    const prevConnectedAt = this.stats.connectedAt;
    if (prevConnectedAt) {
      this.stats.disconnectedTimeMs += Date.now() - prevConnectedAt.getTime();
    }
    this.stats.lastDisconnectedAt = new Date();
    this.wsSessionId = null;
    this.setState('disconnected');
  }

  send(type: TunnelMessageType, payload: unknown, correlationId?: string): TunnelMessage {
    const message: TunnelMessage = {
      id: this.generateMessageId(),
      type,
      sequence: this.nextSequence(),
      timestamp: new Date(),
      payload,
      correlationId,
      certificateThumbprint: this.authProvider?.getCertificateThumbprint() ?? undefined,
    };

    if (this.config.signMessages && this.authProvider) {
      const sigBase = JSON.stringify({
        id: message.id,
        type: message.type,
        sequence: message.sequence,
        timestamp: message.timestamp.toISOString(),
      });
      message.signature = this.authProvider.sign(sigBase);
    }

    // Try the wire first; anything that cannot go out right now waits in the
    // queue for the next flush. sendMessageOverWire reports whether it went.
    if (!this.sendMessageOverWire(message)) {
      this.enqueueMessage(message);
    }

    this.emitEvent({
      type: 'message_sent',
      timestamp: new Date(),
      message: `Queued/sent ${type} message`,
      payload: { id: message.id, type },
    });

    return message;
  }

  private sendRaw(type: TunnelMessageType, payload: unknown): TunnelMessage {
    const message: TunnelMessage = {
      id: this.generateMessageId(),
      type,
      sequence: this.nextSequence(),
      timestamp: new Date(),
      payload,
      certificateThumbprint: this.authProvider?.getCertificateThumbprint() ?? undefined,
    };
    this.sendMessageOverWire(message);
    return message;
  }

  /**
   * True when the client is "connected" without a real socket — the stub path
   * taken when no WebSocket implementation has been supplied. Sends are
   * accounted for but not transmitted.
   */
  private isSimulatedConnection(): boolean {
    return this.WebSocketImpl === null && this._state === 'connected';
  }

  /** Attempts one send. Returns false when the message should stay queued. */
  private sendMessageOverWire(message: TunnelMessage): boolean {
    if (this.isSimulatedConnection()) {
      const serialized = JSON.stringify(message);
      this.stats.messagesSent++;
      this.stats.bytesSent += serialized.length;
      this.stats.lastSentAt = new Date();
      this.stats.globalSequenceSent = Math.max(this.stats.globalSequenceSent, message.sequence);
      return true;
    }

    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return false;
    }

    try {
      const serialized = JSON.stringify(message);
      this.ws.send(serialized);
      this.stats.messagesSent++;
      this.stats.bytesSent += serialized.length;
      this.stats.lastSentAt = new Date();
      this.stats.globalSequenceSent = Math.max(this.stats.globalSequenceSent, message.sequence);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'error',
        timestamp: new Date(),
        message: `Failed to send message: ${msg}`,
      });
      return false;
    }
  }

  /** Queues a message, dropping the oldest once maxQueueSize is reached. */
  private enqueueMessage(message: TunnelMessage, toFront = false): void {
    if (toFront) {
      this.messageQueue.unshift(message);
    } else {
      this.messageQueue.push(message);
    }
    while (this.messageQueue.length > this.config.maxQueueSize) {
      this.messageQueue.shift();
    }
  }

  /**
   * Sends everything currently queued, keeping anything that could not go out.
   *
   * Drains a snapshot rather than looping on the live queue. The previous
   * version shifted a message off, and `sendMessageOverWire` pushed it straight
   * back whenever the socket was not open — so with the state marked
   * `connected` but no usable socket (exactly the degraded window this client
   * exists to survive) the loop span forever at 100% CPU and never yielded.
   */
  async flushQueue(): Promise<number> {
    if (this._state !== 'connected') return 0;

    const pending = this.messageQueue;
    this.messageQueue = [];

    let flushed = 0;
    for (let i = 0; i < pending.length; i++) {
      const msg = pending[i] as TunnelMessage;
      if (this._state !== 'connected' || !this.sendMessageOverWire(msg)) {
        // Preserve ordering: this message and everything after it stay queued.
        this.messageQueue = pending.slice(i).concat(this.messageQueue);
        while (this.messageQueue.length > this.config.maxQueueSize) {
          this.messageQueue.shift();
        }
        break;
      }
      flushed++;
    }

    return flushed;
  }

  getQueuedMessages(): TunnelMessage[] {
    return [...this.messageQueue];
  }

  clearQueue(): number {
    const count = this.messageQueue.length;
    this.messageQueue = [];
    return count;
  }

  handleIncoming(message: TunnelMessage): void {
    this.stats.messagesReceived++;
    this.stats.bytesReceived += JSON.stringify(message).length;
    this.stats.lastReceivedAt = new Date();

    this.emitEvent({
      type: 'message_received',
      timestamp: new Date(),
      message: `Received ${message.type} message`,
      payload: { type: message.type, id: message.id },
    });
  }

  onEvent(listener: TunnelEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isConnected(): boolean {
    return this._state === 'connected';
  }

  isAuthenticated(): boolean {
    return (
      this._state === 'connected' && (this.wsSessionId !== null || this.WebSocketImpl === null)
    );
  }

  getDeviceId(): string {
    return this.config.deviceId;
  }

  getGatewayId(): string {
    return this.config.gatewayId;
  }

  setAuthToken(token: string): void {
    (this.config as unknown as { authToken: string }).authToken = token;
  }

  async initiateReconciliation(): Promise<ReconciliationResponse | null> {
    if (this._state !== 'connected') return null;
    if (!this.reconciliationProvider) return null;

    this.setState('reconciling');
    this.emitEvent({
      type: 'reconciliation_started',
      timestamp: new Date(),
    });

    const sessionStates = this.reconciliationProvider.getSessionStates();
    const lastAcked = this.reconciliationProvider.getLastAckedGlobalSequence();
    const thumbprint = this.authProvider?.getCertificateThumbprint() ?? '';
    const signedAt = new Date();

    const basePayload = {
      deviceId: this.config.deviceId,
      gatewayId: this.config.gatewayId,
      lastAckedGlobalSequence: lastAcked,
      sessionStates,
      certificateThumbprint: thumbprint,
      signedAt: signedAt.toISOString(),
    };

    const signature = this.authProvider ? this.authProvider.sign(JSON.stringify(basePayload)) : '';

    const request: ReconciliationRequest = {
      ...basePayload,
      signedAt,
      signature,
    };

    const correlationId = `rec_${randomBytes(8).toString('hex')}`;
    this.send('reconciliation_request', request, correlationId);
    return null;
  }

  private async handleReconciliationResponse(response: ReconciliationResponse): Promise<void> {
    if (!this.reconciliationProvider) return;

    try {
      const { sessionUpdates, replayEvents, globalGapInfo } = response;

      if (globalGapInfo) {
        this.reconciliationProvider.recordUnrecoverableGap(
          null,
          globalGapInfo.from,
          globalGapInfo.to,
          globalGapInfo.reason,
        );
      }

      if (replayEvents && replayEvents.length > 0) {
        for (const { sequence, event } of replayEvents) {
          try {
            await this.reconciliationProvider.replayEvent(sequence, event);
          } catch {
            // continue with next event
          }
        }
      }

      if (sessionUpdates && sessionUpdates.length > 0) {
        await this.reconciliationProvider.applySessionUpdates(sessionUpdates);
      }

      if (typeof response.newAckBaseline === 'number') {
        this.stats.globalSequenceAcked = Math.max(
          this.stats.globalSequenceAcked,
          response.newAckBaseline,
        );
      }

      this.emitEvent({
        type: 'reconciliation_complete',
        timestamp: new Date(),
        payload: {
          replayedCount: replayEvents?.length ?? 0,
          updatesCount: sessionUpdates?.length ?? 0,
          newAckBaseline: response.newAckBaseline,
          hasGlobalGap: !!globalGapInfo,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'error',
        timestamp: new Date(),
        message: `Reconciliation failed: ${message}`,
      });
    } finally {
      this.setState('connected');
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.stopHeartbeat();
    this.stopReconnect();
    this.stopAuthTimeout();

    if (this.ws && this.ws.readyState !== WS_CLOSED && this.ws.readyState !== WS_CLOSING) {
      try {
        this.ws.close(1000, 'Shutdown');
      } catch {
        /* ignore */
      }
    }
    this.ws = null;

    this.messageQueue = [];
    this.listeners.clear();
    this._state = 'idle';
  }

  private async reconnect(explicitDelayMs?: number): Promise<void> {
    if (this.shuttingDown) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emitEvent({
        type: 'reconnect_failed',
        timestamp: new Date(),
        message: `Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`,
      });
      this.setState('error');
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    this.emitEvent({
      type: 'reconnect_attempt',
      timestamp: new Date(),
      message: `Reconnect attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts}`,
    });

    const baseDelay =
      explicitDelayMs ??
      this.config.reconnectBaseMs * Math.pow(2, Math.max(0, this.reconnectAttempts - 1));
    const delay = Math.min(baseDelay, this.config.reconnectMaxMs) + Math.random() * 500;

    // setTimeout discards the promise an async callback returns, so a throw
    // from the catch block below (emitEvent calls into user listeners) would
    // surface as an unhandled rejection during a reconnect storm — exactly
    // when the client is least able to afford crashing.
    this.reconnectTimer = setTimeout(() => {
      void this.runReconnectAttempt();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  private async runReconnectAttempt(): Promise<void> {
    {
      try {
        await this.connect();
        if (this._state === 'connected') {
          this.emitEvent({
            type: 'reconnect_success',
            timestamp: new Date(),
            message: `Reconnected after ${this.reconnectAttempts} attempts`,
          });
          await this.initiateReconciliation();
          await this.flushQueue();
        } else {
          throw new Error('Connection did not reach connected state');
        }
      } catch {
        this.emitEvent({
          type: 'error',
          timestamp: new Date(),
          message: `Reconnect attempt ${this.reconnectAttempts} failed`,
        });
        void this.reconnect();
      }
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.stats.missedHeartbeats = 0;

    if (this.config.heartbeatIntervalMs <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (this._state === 'connected') {
        this.sendHeartbeat();
      }
    }, this.config.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  private sendHeartbeat(): void {
    const payload = {
      timestamp: new Date(),
      sequence: this.stats.globalSequenceSent,
    };
    this.send('heartbeat', payload);
    this.stats.lastHeartbeatSentAt = new Date();
    this.stats.missedHeartbeats++;

    if (this.config.heartbeatTimeoutMs > 0) {
      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
      }
      this.heartbeatTimeoutTimer = setTimeout(() => {
        if (this.stats.missedHeartbeats >= 3) {
          this.emitEvent({
            type: 'heartbeat_timeout',
            timestamp: new Date(),
            message: `Missed ${this.stats.missedHeartbeats} consecutive heartbeats`,
          });
          try {
            this.ws?.close(4002, 'Heartbeat timeout');
          } catch {
            /* ignore */
          }
        }
      }, this.config.heartbeatTimeoutMs);
      if (typeof this.heartbeatTimeoutTimer.unref === 'function') {
        this.heartbeatTimeoutTimer.unref();
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = undefined;
    }
  }

  private setState(state: TunnelState): void {
    const previous = this._state;
    if (previous === state) return;
    this._state = state;
    this.emitEvent({
      type: 'state_change',
      timestamp: new Date(),
      state,
      previousState: previous,
      message: `Tunnel state: ${previous} → ${state}`,
    });
  }

  private emitEvent(event: TunnelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  private nextSequence(): number {
    return ++this.sequenceCounter;
  }

  private generateMessageId(): string {
    const bytes = randomBytes(12);
    return `msg_${bytes.toString('hex')}`;
  }
}

export function createTunnelClient(config: TunnelConfig): TunnelClient {
  return new TunnelClient(config);
}
