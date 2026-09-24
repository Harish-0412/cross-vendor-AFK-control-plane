import type { Metadata } from "next";
import { WifiOff } from "lucide-react";

export const metadata: Metadata = {
  title: "Offline — Odysseus",
};

/**
 * Shown by the service worker when a page load fails with no connection.
 *
 * It is deliberately honest about what it does not know: the workstation may
 * still be working away, and this page has no way to tell. Saying "your agents
 * are fine" would be a guess, and the one thing a control plane must not do is
 * guess about the state of something it cannot see.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <WifiOff className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold text-foreground">You are offline</h1>
        <p className="text-sm text-muted-foreground">
          Odysseus could not reach the control plane. Your workstation may still be running —
          this device simply cannot see it right now.
        </p>
        <p className="text-sm text-muted-foreground">
          Reconnect and reload. Anything that happened while you were away is kept and will
          appear when you do.
        </p>
      </div>
    </main>
  );
}
