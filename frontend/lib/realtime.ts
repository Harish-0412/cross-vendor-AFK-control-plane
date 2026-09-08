// frontend/lib/realtime.ts
// Realtime WebSocket client for web frontend connecting to Control Plane /ws/client

import { create } from 'zustand';
import type { EventEnvelope } from '@freebuff/protocol';
import { getAccessToken } from './api-client';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface InboundEventMessage {
  type: 'event';
  sessionId?: string;
  deviceId?: string;
  sequence?: number;
  eventType?: string;
  envelope?: EventEnvelope;
  timestamp?: string;
}

interface RealtimeStore {
  status: RealtimeStatus;
  setStatus: (status: RealtimeStatus) => void;
}

export const useRealtimeStore = create<RealtimeStore>((set) => ({
  status: 'offline',
  setStatus: (status) => set({ status }),
}));

class RealtimeClient {
  private ws: WebSocket | null = null;
  private wsBaseUrl: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelayMs = 10_000;
  private isIntentionallyClosed = false;

  private sessionListeners = new Map<string, Set<(envelope: EventEnvelope) => void>>();
  private deviceListeners = new Map<string, Set<(data: unknown) => void>>();
  private globalListeners = new Set<(message: InboundEventMessage) => void>();

  constructor() {
    this.wsBaseUrl =
      process.env.NEXT_PUBLIC_WS_URL ||
      (typeof window !== 'undefined'
        ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:4000`
        : 'ws://localhost:4000');
  }

  connect(): void {
    if (typeof window === 'undefined') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isIntentionallyClosed = false;
    const token = getAccessToken();
    const url = token
      ? `${this.wsBaseUrl}/ws/client?token=${encodeURIComponent(token)}`
      : `${this.wsBaseUrl}/ws/client`;

    useRealtimeStore.getState().setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      useRealtimeStore.getState().setStatus('connected');

      // Resubscribe active session listeners
      for (const sessionId of this.sessionListeners.keys()) {
        this.send({ action: 'subscribe_session', sessionId });
      }

      // Resubscribe active device listeners
      for (const deviceId of this.deviceListeners.keys()) {
        this.send({ action: 'subscribe_device', deviceId });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (msg.type === 'event') {
          const evtMsg = msg as unknown as InboundEventMessage;
          const envelope = evtMsg.envelope;

          // Notify global listeners
          for (const listener of this.globalListeners) {
            listener(evtMsg);
          }

          // Notify session listeners
          const targetSessionId = evtMsg.sessionId || envelope?.sessionId;
          if (targetSessionId && envelope) {
            const listeners = this.sessionListeners.get(targetSessionId);
            if (listeners) {
              for (const l of listeners) {
                l(envelope);
              }
            }
          }

          // Notify device listeners
          const targetDeviceId = evtMsg.deviceId || envelope?.deviceId;
          if (targetDeviceId) {
            const listeners = this.deviceListeners.get(String(targetDeviceId));
            if (listeners) {
              for (const l of listeners) {
                l(evtMsg);
              }
            }
          }
        }
      } catch {
        /* ignore malformed message */
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.isIntentionallyClosed) {
        useRealtimeStore.getState().setStatus('reconnecting');
        this.scheduleReconnect();
      } else {
        useRealtimeStore.getState().setStatus('offline');
      }
    };

    this.ws.onerror = () => {
      // ws.onclose will fire after onerror
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(1.5, this.reconnectAttempts - 1),
      this.maxReconnectDelayMs,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  subscribeSession(sessionId: string, onEvent: (envelope: EventEnvelope) => void): () => void {
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
      this.send({ action: 'subscribe_session', sessionId });
    }
    set.add(onEvent);

    return () => {
      const s = this.sessionListeners.get(sessionId);
      if (s) {
        s.delete(onEvent);
        if (s.size === 0) {
          this.sessionListeners.delete(sessionId);
          this.send({ action: 'unsubscribe_session', sessionId });
        }
      }
    };
  }

  subscribeDevice(deviceId: string, onUpdate: (data: unknown) => void): () => void {
    let set = this.deviceListeners.get(deviceId);
    if (!set) {
      set = new Set();
      this.deviceListeners.set(deviceId, set);
      this.send({ action: 'subscribe_device', deviceId });
    }
    set.add(onUpdate);

    return () => {
      const s = this.deviceListeners.get(deviceId);
      if (s) {
        s.delete(onUpdate);
        if (s.size === 0) {
          this.deviceListeners.delete(deviceId);
        }
      }
    };
  }

  subscribeAllEvents(listener: (message: InboundEventMessage) => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    useRealtimeStore.getState().setStatus('offline');
  }
}

export const realtimeClient = new RealtimeClient();
