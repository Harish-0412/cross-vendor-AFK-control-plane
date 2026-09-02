import type { DeviceCertificate, EventEnvelope } from '@freebuff/protocol';

export type TunnelState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'reconnecting'
  | 'reconciling'
  | 'degraded'
  | 'error';

export type TunnelMessageType =
  | 'event'
  | 'command'
  | 'heartbeat'
  | 'ack'
  | 'replay'
  | 'auth'
  | 'auth_challenge'
  | 'auth_success'
  | 'auth_failure'
  | 'reconciliation_request'
  | 'reconciliation_response'
  | 'replay_event'
  | 'disconnect'
  | 'error';

export interface TunnelMessage {
  id: string;
  type: TunnelMessageType;
  sequence: number;
  timestamp: Date;
  payload: unknown;
  correlationId?: string | undefined;
  signature?: string;
  certificateThumbprint?: string | undefined;
}

export interface AuthPayload {
  deviceId: string;
  gatewayId: string;
  nonce: string;
  timestamp: Date;
  publicKeyJwk: Record<string, unknown>;
  certificateThumbprint?: string | undefined;
  signature: string;
}

export interface AuthChallengePayload {
  challenge: string;
  issuedAt: Date;
  expiresAt: Date;
  serverNonce: string;
}

export interface AuthSuccessPayload {
  sessionId: string;
  assignedGlobalSequence: number;
  serverTimestamp: Date;
  capabilities: string[];
}

export interface AuthFailurePayload {
  reason: string;
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  deviceStatus?: string;
}

export interface TunnelConfig {
  controlPlaneUrl: string;
  deviceId: string;
  gatewayId: string;
  authToken?: string;
  tlsOptions?: {
    caCertPem?: string;
    clientCertPem?: string;
    clientKeyPem?: string;
    rejectUnauthorized?: boolean;
    serverName?: string;
  };
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxReconnectAttempts?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxQueueSize?: number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
  wsOptions?: {
    userAgent?: string;
    origin?: string;
    headers?: Record<string, string>;
  };
  signMessages?: boolean;
  autoReconnect?: boolean;
}

export const DEFAULT_TUNNEL_CONFIG: Required<
  Omit<TunnelConfig, 'authToken' | 'tlsOptions' | 'wsOptions' | 'controlPlaneUrl'> &
    Pick<TunnelConfig, 'controlPlaneUrl'>
> = {
  controlPlaneUrl: '',
  deviceId: '',
  gatewayId: '',
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  maxReconnectAttempts: 10,
  heartbeatIntervalMs: 15000,
  heartbeatTimeoutMs: 5000,
  maxQueueSize: 10000,
  connectTimeoutMs: 10000,
  authTimeoutMs: 5000,
  signMessages: true,
  autoReconnect: true,
};

export interface TunnelStats {
  state: TunnelState;
  messagesSent: number;
  messagesReceived: number;
  messagesQueued: number;
  reconnectAttempts: number;
  bytesSent: number;
  bytesReceived: number;
  connectedAt?: Date | undefined;
  lastDisconnectedAt?: Date | undefined;
  lastSentAt?: Date | undefined;
  lastReceivedAt?: Date | undefined;
  uptimeMs: number;
  disconnectedTimeMs: number;
  lastHeartbeatSentAt?: Date | undefined;
  lastHeartbeatReceivedAt?: Date | undefined;
  missedHeartbeats: number;
  authFailures: number;
  globalSequenceAcked: number;
  globalSequenceSent: number;
}

export interface TunnelEvent {
  type:
    | 'state_change'
    | 'message_sent'
    | 'message_received'
    | 'reconnect_attempt'
    | 'reconnect_success'
    | 'reconnect_failed'
    | 'auth_started'
    | 'auth_success'
    | 'auth_failure'
    | 'heartbeat_timeout'
    | 'reconciliation_started'
    | 'reconciliation_complete'
    | 'certificate_warning'
    | 'error';
  timestamp: Date;
  state?: TunnelState;
  previousState?: TunnelState;
  message?: string;
  error?: Error;
  payload?: unknown;
}

export type TunnelEventListener = (event: TunnelEvent) => void;

export interface CommandPayload {
  commandId: string;
  commandType: string;
  sessionId?: string;
  arguments: Record<string, unknown>;
  issuedAt: Date;
  signedBy: string;
  signature: string;
}

export interface EventForwardPayload {
  envelope: EventEnvelope;
}

export interface ReplayEventPayload {
  sequence: number;
  envelope: EventEnvelope;
}

export interface DisconnectPayload {
  reason: string;
  code: number;
  willReconnect: boolean;
  serverInitiated: boolean;
}

export interface HeartbeatPayload {
  timestamp: Date;
  sequence: number;
  load?: {
    activeSessions: number;
    pendingApprovals: number;
    cpuPercent: number;
    memoryMb: number;
  };
}

export { type DeviceCertificate };
