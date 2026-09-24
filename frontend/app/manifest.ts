import type { MetadataRoute } from "next";

/**
 * Web app manifest, served at /manifest.webmanifest and linked automatically.
 *
 * This is what lets the control centre be installed on a phone's home screen,
 * which matters for two reasons beyond convenience:
 *
 *  - Web Push on iOS only works for a site the user has added to the home
 *    screen. Without this file, an approval request can never reach an iPhone
 *    while the browser is closed — which is the situation the whole product
 *    exists for.
 *  - An installed app opens without browser chrome and keeps its own session,
 *    so checking on an agent is one tap rather than finding a tab.
 *
 * `start_url` is the dashboard rather than the marketing page: someone opening
 * the installed app wants the state of their agents, not the pitch.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Odysseus AFK Control Centre",
    short_name: "Odysseus",
    description:
      "Supervise and approve your AI coding agents from anywhere. Watch sessions, answer approvals and track plan usage while you are away from your desk.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#000000",
    theme_color: "#6366F1",
    categories: ["developer", "productivity", "utilities"],
    icons: [
      { src: "/ares.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/ares.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/ares.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Approvals",
        short_name: "Approvals",
        description: "Anything waiting on your decision",
        url: "/approvals",
      },
      {
        name: "Sessions",
        short_name: "Sessions",
        description: "Agents running right now",
        url: "/sessions",
      },
      {
        name: "History",
        short_name: "History",
        description: "Past conversations from your connected tools",
        url: "/history",
      },
    ],
  };
}
