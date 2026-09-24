/* Odysseus AFK service worker.
 *
 * Two jobs, both small and dependency-free:
 *
 *  1. Web Push — show the notification and open the right page when it is
 *     tapped. This is what reaches you when nothing is open.
 *  2. An offline fallback for page loads, so losing signal shows the app's own
 *     "you are offline" page instead of the browser's error. It is also what
 *     makes the app installable on desktop Chrome, which requires a fetch
 *     handler that can answer a failed navigation.
 *
 * Deliberately NOT a cache of the app or its data. Session state, approvals
 * and conversations are private and change constantly; serving a stale copy of
 * them would be worse than showing that the connection is down. Only the
 * offline page and the icons are cached.
 */

const CACHE = "odysseus-shell-v1";
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One missing file must not fail the whole install, so they are added
      // individually and failures are ignored.
      await Promise.all(
        PRECACHE.map((url) => cache.add(url).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only page loads. API calls and WebSockets must always go to the network:
  // an answer from a cache would be stale state presented as current.
  if (request.mode !== "navigate" || request.method !== "GET") return;
  if (new URL(request.url).pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = await caches.match(OFFLINE_URL);
        return (
          cached ??
          new Response("You are offline.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Odysseus AFK", body: "Something happened." };
  }

  const title = data.title || "Odysseus AFK";
  // PushSender sends the navigation fields in the notification's `data`
  // object. Older payloads placed them at the top level, so accept both while
  // preferring the typed, nested shape. Without this, a usage warning renders
  // correctly but opens the generic Approvals page instead of Budgets.
  const notificationData =
    data.data && typeof data.data === "object" ? data.data : data;
  const options = {
    body: data.body || "",
    icon: "/ares.png",
    badge: "/ares.png",
    tag: data.tag || "odysseus-afk",
    data: {
      url: notificationData.url || "/approvals",
      eventId: notificationData.eventId,
      eventType: notificationData.eventType,
      sessionId: notificationData.sessionId,
      deviceId: notificationData.deviceId,
      approvalId: notificationData.approvalId,
    },
    renotify: Boolean(data.renotify),
    requireInteraction: Boolean(data.requireInteraction),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/approvals";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
