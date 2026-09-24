// frontend/lib/realtime.ts
// Realtime WebSocket client for web frontend connecting to Control Plane /ws/client

import { create } from "zustand";
import type { EventEnvelope } from "@odysseus/protocol";
import { getAccessToken, requestRefreshToken } from "./api-client";

export type RealtimeStatus =
  "connecting" | "connected" | "reconnecting" | "offline";

export interface InboundEventMessage {
  type: string;
  sessionId?: string;
  deviceId?: string;
  sequence?: number;
  eventType?: string;
  envelope?: EventEnvelope;
  timestamp?: string;
  integration?: string;
  kind?: string;
  [key: string]: unknown;
}

interface RealtimeStore {
  status: RealtimeStatus;
  setStatus: (status: RealtimeStatus) => void;
}

export const useRealtimeStore = create<RealtimeStore>((set) => ({
  status: "offline",
  setStatus: (status) => set({ status }),
}));

class RealtimeClient {
  private ws: WebSocket | null = null;
  private wsBaseUrl: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelayMs = 10_000;
  private isIntentionallyClosed = false;
  /** The upgrade succeeded for the current socket. */
  private opened = false;
  /** The server accepted the token and sent its 'connected' welcome. */
  private welcomed = false;
  private lifecycleInstalled = false;
  private lastSessionSequence = new Map<string, number>();

  private sessionListeners = new Map<
    string,
    Set<(envelope: EventEnvelope) => void>
  >();
  private deviceListeners = new Map<string, Set<(data: unknown) => void>>();
  private globalListeners = new Set<(message: InboundEventMessage) => void>();

  constructor() {
    if (process.env.NEXT_PUBLIC_WS_URL) {
      this.wsBaseUrl = process.env.NEXT_PUBLIC_WS_URL;
    } else if (typeof window !== "undefined") {
      const isLocal =
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1";
      if (!isLocal) {
        this.wsBaseUrl = "wss://odysseus-control-plane.onrender.com";
      } else {
        this.wsBaseUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:4000`;
      }
    } else {
      this.wsBaseUrl = "ws://localhost:4000";
    }
  }

  connect(): void {
    if (typeof window === "undefined") return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.isIntentionallyClosed = false;
    this.installLifecycleHandlers();
    const token = getAccessToken();

    // The Control Plane refuses a socket without a token (close 4001). The
    // access token lives in memory, so after a page reload it is gone until
    // the refresh cookie is exchanged. Connecting without one would just
    // earn a 4001 and a reconnect loop, so fetch a token first.
    if (!token) {
      void requestRefreshToken().then((fresh) => {
        if (fresh) this.connect();
        else useRealtimeStore.getState().setStatus("offline");
      });
      return;
    }

    const url = `${this.wsBaseUrl}/ws/client`;

    useRealtimeStore
      .getState()
      .setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    this.opened = false;
    this.welcomed = false;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // The upgrade succeeding does not mean the server accepted the token —
      // it authenticates right after, and says so with a 'connected' welcome.
      // Reporting 'connected' here showed a green status for sockets that
      // were about to be rejected.
      this.opened = true;
      // Send the bearer token inside the encrypted WebSocket rather than in
      // its URL, where hosting/proxy access logs commonly record it.
      this.send({ type: "auth", token });
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (msg.type === "connected") {
          this.welcomed = true;
          // Backoff resets only once the server has accepted us, so a socket
          // that is repeatedly rejected keeps backing off.
          this.reconnectAttempts = 0;
          useRealtimeStore.getState().setStatus("connected");
          for (const sessionId of this.sessionListeners.keys()) {
            const seen = this.lastSessionSequence.get(sessionId);
            this.send({
              action: "subscribe_session",
              sessionId,
              ...(seen !== undefined ? { fromSequence: seen + 1 } : {}),
            });
          }
          for (const deviceId of this.deviceListeners.keys()) {
            this.send({ action: "subscribe_device", deviceId });
          }
          return;
        }
        if (msg.type === "event") {
          const evtMsg = msg as unknown as InboundEventMessage;
          const envelope = evtMsg.envelope;

          // Notify global listeners
          for (const listener of this.globalListeners) {
            listener(evtMsg);
          }

          // Notify session listeners
          const targetSessionId = evtMsg.sessionId || envelope?.sessionId;
          if (targetSessionId && envelope) {
            const sequence = evtMsg.sequence ?? envelope.sequence;
            if (typeof sequence === "number") {
              this.lastSessionSequence.set(
                targetSessionId,
                Math.max(
                  sequence,
                  this.lastSessionSequence.get(targetSessionId) ?? 0,
                ),
              );
            }
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
          return;
        }

        // Integration changes are not EventEnvelopes, but pages such as
        // History still need an immediate refresh instead of waiting for a
        // polling interval.
        if (
          msg.type === "integration_update" ||
          msg.type === "integration_data" ||
          // A plan window has crossed its warning threshold. It is not tied to
          // a session, so it goes to the global listeners like the others.
          msg.type === "usage_alert"
        ) {
          for (const listener of this.globalListeners) {
            listener(msg as unknown as InboundEventMessage);
          }
          return;
        }

        if (msg.type === "disconnected" && msg.source === "workstation") {
          this.isIntentionallyClosed = true;
          useRealtimeStore.getState().setStatus("offline");
        }
      } catch {
        /* ignore malformed message */
      }
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      if (event.code === 4004) {
        this.isIntentionallyClosed = true;
        useRealtimeStore.getState().setStatus("offline");
        return;
      }
      if (!this.isIntentionallyClosed) {
        useRealtimeStore.getState().setStatus("reconnecting");
        // The server rejected the token — almost always because the access
        // token expired. Reconnecting with the same token would fail the same
        // way forever, so refresh first.
        //
        // The 4001 close code alone is not enough: on the deployed Control
        // Plane, the platform proxy delivered an immediate server close as
        // 1006 with no code. "Opened but never welcomed" survives that, and
        // cannot be confused with a network failure, which never opens —
        // so a flaky mobile connection does not trigger a refresh that could
        // sign the user out.
        const rejected = event.code === 4001 || (this.opened && !this.welcomed);
        if (rejected) {
          void requestRefreshToken().then((fresh) => {
            if (fresh) this.scheduleReconnect();
            else useRealtimeStore.getState().setStatus("offline");
          });
          return;
        }
        this.scheduleReconnect();
      } else {
        useRealtimeStore.getState().setStatus("offline");
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

  private installLifecycleHandlers(): void {
    if (this.lifecycleInstalled || typeof window === "undefined") return;
    this.lifecycleInstalled = true;
    window.addEventListener("pagehide", () => this.disconnect());
    window.addEventListener("pageshow", () => this.connect());
  }

  subscribeSession(
    sessionId: string,
    onEvent: (envelope: EventEnvelope) => void,
  ): () => void {
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
      const seen = this.lastSessionSequence.get(sessionId);
      this.send({
        action: "subscribe_session",
        sessionId,
        ...(seen !== undefined ? { fromSequence: seen + 1 } : {}),
      });
    }
    set.add(onEvent);

    return () => {
      const s = this.sessionListeners.get(sessionId);
      if (s) {
        s.delete(onEvent);
        if (s.size === 0) {
          this.sessionListeners.delete(sessionId);
          this.send({ action: "unsubscribe_session", sessionId });
          this.lastSessionSequence.delete(sessionId);
        }
      }
    };
  }

  subscribeDevice(
    deviceId: string,
    onUpdate: (data: unknown) => void,
  ): () => void {
    let set = this.deviceListeners.get(deviceId);
    if (!set) {
      set = new Set();
      this.deviceListeners.set(deviceId, set);
      this.send({ action: "subscribe_device", deviceId });
    }
    set.add(onUpdate);

    return () => {
      const s = this.deviceListeners.get(deviceId);
      if (s) {
        s.delete(onUpdate);
        if (s.size === 0) {
          this.deviceListeners.delete(deviceId);
          this.send({ action: "unsubscribe_device", deviceId });
        }
      }
    };
  }

  subscribeAllEvents(
    listener: (message: InboundEventMessage) => void,
  ): () => void {
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
      this.send({ type: "disconnect" });
      this.ws.close();
      this.ws = null;
    }
    useRealtimeStore.getState().setStatus("offline");
  }
}

export const realtimeClient = new RealtimeClient();
