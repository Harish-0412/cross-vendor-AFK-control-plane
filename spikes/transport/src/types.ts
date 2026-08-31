export type MessageType = 'event' | 'command' | 'ack' | 'heartbeat' | 'auth' | 'auth_response' | 'reconnect' | 'replay';

export interface GatewayMessage {
  type: MessageType;
  id: string;
  sequence: number;
  correlationId?: string;
  payload: any;
  timestamp: number;
}

export interface ConnectionConfig {
  url: string;
  deviceId: string;
  authToken: string;
  reconnect?: ReconnectConfig;
  tls?: TLSConfig;
  heartbeat?: HeartbeatConfig;
}

export interface ReconnectConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  jitter: number;
  backoffMultiplier: number;
}

export interface TLSConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface HeartbeatConfig {
  interval: number;
  timeout: number;
  maxMissed: number;
}

export type ConnectionState = 
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'degraded'
  | 'reconciling'
  | 'connected';

export interface ClientState {
  connectionId: string;
  state: ConnectionState;
  lastSequenceSent: number;
  lastSequenceAcked: number;
  pendingAcks: Map<string, PendingAck>;
  reconnectAttempts: number;
  lastHeartbeat: number;
  serverSequence: number;
}

export interface PendingAck {
  messageId: string;
  sequence: number;
  timestamp: number;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  retries: number;
}

export interface ReconnectMessage {
  type: 'reconnect';
  deviceId: string;
  lastAckedSequence: number;
  clientId: string;
}

export interface ReplayMessage {
  type: 'replay';
  fromSequence: number;
  toSequence: number;
  messages: GatewayMessage[];
}

export interface AuthMessage {
  type: 'auth';
  deviceId: string;
  token: string;
  capabilities: string[];
}

export interface AuthResponseMessage {
  type: 'auth_response';
  success: boolean;
  sessionId?: string;
  error?: string;
  serverSequence: number;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
  sequence: number;
}

export interface EventMessage {
  type: 'event';
  eventType: string;
  sessionId: string;
  data: any;
}

export interface CommandMessage {
  type: 'command';
  command: string;
  params: any;
}

export interface AckMessage {
  type: 'ack';
  ackSequence: number;
  messageId: string;
}

export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
  jitter: 0.1,
  backoffMultiplier: 2
};

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  interval: 30000,
  timeout: 10000,
  maxMissed: 3
};

export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function createMessage(type: MessageType, payload: any, sequence: number, correlationId?: string): GatewayMessage {
  return {
    type,
    id: generateMessageId(),
    sequence,
    correlationId,
    payload,
    timestamp: Date.now()
  };
}