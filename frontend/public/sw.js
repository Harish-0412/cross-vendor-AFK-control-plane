/* FreeBuff AFK — Web Push service worker (Phase 7.3).
 * Minimal, dependency-free: shows notifications, opens the right page on click.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "FreeBuff AFK", body: "Something happened." };
  }

  const title = data.title || "FreeBuff AFK";
  const options = {
    body: data.body || "",
    icon: "/icon-light-32x32.png",
    badge: "/icon-light-32x32.png",
    tag: data.tag || "freebuff-afk",
    data: {
      url: data.url || "/approvals",
      sessionId: data.sessionId,
      approvalId: data.approvalId,
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
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
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