import { GatewayMessage, MessageType, generateMessageId, createMessage } from './types';

export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES: Record<string, MessageType> = {
  EVENT: 'event',
  COMMAND: 'command',
  ACK: 'ack',
  HEARTBEAT: 'heartbeat',
  AUTH: 'auth',
  AUTH_RESPONSE: 'auth_response',
  RECONNECT: 'reconnect',
  REPLAY: 'replay'
};

export interface ProtocolCapabilities {
  version: number;
  features: string[];
  maxMessageSize: number;
  supportedCompression: string[];
}

export const CLIENT_CAPABILITIES: ProtocolCapabilities = {
  version: PROTOCOL_VERSION,
  features: ['reconnect', 'replay', 'ack', 'heartbeat', 'compression'],
  maxMessageSize: 1024 * 1024,
  supportedCompression: ['none', 'gzip']
};

export function createEventMessage(eventType: string, sessionId: string, data: any, sequence: number): GatewayMessage {
  return createMessage('event', { eventType, sessionId, data }, sequence);
}

export function createCommandMessage(command: string, params: any, sequence: number, correlationId?: string): GatewayMessage {
  return createMessage('command', { command, params }, sequence, correlationId);
}

export function createAckMessage(ackSequence: number, messageId: string, sequence: number): GatewayMessage {
  return createMessage('ack', { ackSequence, messageId }, sequence);
}

export function createHeartbeatMessage(sequence: number): GatewayMessage {
  return createMessage('heartbeat', { timestamp: Date.now() }, sequence);
}

export function createAuthMessage(deviceId: string, token: string, sequence: number): GatewayMessage {
  return createMessage('auth', { deviceId, token, capabilities: CLIENT_CAPABILITIES }, sequence);
}

export function createReconnectMessage(deviceId: string, lastAckedSequence: number, clientId: string, sequence: number): GatewayMessage {
  return createMessage('reconnect', { deviceId, lastAckedSequence, clientId }, sequence);
}

export function parseMessage(data: string | Buffer): GatewayMessage | null {
  try {
    const parsed = JSON.parse(data.toString());
    return validateMessage(parsed);
  } catch {
    return null;
  }
}

export function validateMessage(msg: any): GatewayMessage | null {
  if (!msg || typeof msg !== 'object') return null;
  if (!msg.type || !MESSAGE_TYPES[msg.type.toUpperCase()]) return null;
  if (!msg.id || typeof msg.id !== 'string') return null;
  if (typeof msg.sequence !== 'number') return null;
  if (typeof msg.timestamp !== 'number') return null;
  if (msg.payload === undefined) return null;
  return msg as GatewayMessage;
}

export function serializeMessage(msg: GatewayMessage): string {
  return JSON.stringify(msg);
}

export function deserializeMessage(data: string): GatewayMessage | null {
  return parseMessage(data);
}

export class MessageSerializer {
  static serialize(msg: GatewayMessage): Uint8Array {
    const json = serializeMessage(msg);
    return new TextEncoder().encode(json);
  }

  static deserialize(data: Uint8Array): GatewayMessage | null {
    const json = new TextDecoder().decode(data);
    return parseMessage(json);
  }
}

export const HEARTBEAT_INTERVAL = 30000;
export const ACK_TIMEOUT = 10000;
export const MAX_PENDING_ACKS = 1000;
export const MAX_MESSAGE_SIZE = 1024 * 1024;