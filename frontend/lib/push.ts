"use client";

import { apiClient } from "@/lib/api-client";

/**
 * Phase 7.3 — client-side Web Push subscription.
 *
 * Registration is fully optional and feature-detected:
 *  - requires a VAPID public key (NEXT_PUBLIC_VAPID_PUBLIC_KEY)
 *  - requires PushManager + service worker support (secure context / localhost)
 *  - requires user permission (we ask lazily, never on first load)
 * The endpoint is subscribed exactly once per service worker registration and
 * posted to POST /api/v1/push/subscribe; the backend stores it for the
 * PushSender (§7.3) to deliver AFK notifications.
 */

const SW_PATH = "/sw.js";
const SUBSCRIBED_FLAG = "freebuff_push_subscribed";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
  );
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_PATH);
  } catch {
    return null;
  }
}

/**
 * Subscribe to web push and register the subscription with the control plane.
 * Returns true when a subscription was created and persisted server-side.
 */
export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  if (Notification.permission !== "granted") return false;

  const registration = await ensureServiceWorker();
  if (!registration || !registration.pushManager) return false;

  try {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
      ) as BufferSource,
    });

    // Only register with the backend once per subscription.
    if (localStorage.getItem(SUBSCRIBED_FLAG) === subscription.endpoint) {
      return true;
    }

    await apiClient.post("/api/v1/push/subscribe", {
      subscription: subscription.toJSON(),
    });
    localStorage.setItem(SUBSCRIBED_FLAG, subscription.endpoint);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tear down: unsubscribe from the push service and unregister with the plane.
 * Idempotent — safe to call on logout.
 */
export async function unsubscribeFromPush(): Promise<void> {
  try {
    const registration = await ensureServiceWorker();
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription) {
      const endpoint = subscription.endpoint;
      await apiClient.delete("/api/v1/push/subscribe", {
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
      localStorage.removeItem(SUBSCRIBED_FLAG);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Ask for notification permission (user gesture required) and subscribe.
 * Returns a human-readable status for UI feedback.
 */
export async function enablePushNotifications(): Promise<"granted" | "denied" | "unsupported" | "error"> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const ok = await subscribeToPush();
  return ok ? "granted" : "error";
}

/** Standard base64url → Uint8Array conversion required by PushManager. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64WithPadding = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64WithPadding);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}