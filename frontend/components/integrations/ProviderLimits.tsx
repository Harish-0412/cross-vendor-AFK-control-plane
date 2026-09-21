"use client";

import { useEffect, useState } from "react";
import { Gauge, Info, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  aiIntegrations,
  formatRelative,
  windowViews,
  type ProviderUsageEntry,
} from "@/lib/ai-integrations";

/**
 * Remaining-usage limits for connected tools, shown exactly as the tool
 * recorded them. Two rules:
 *
 * - Every figure says when it was recorded. Codex only writes its limits while
 *   it runs, so a reading can be days old.
 * - A window that has reset since that reading does not show the old
 *   percentage — that number no longer describes it. It says so instead.
 */
export function ProviderLimits({ compact = false }: { compact?: boolean }) {
  const [entries, setEntries] = useState<ProviderUsageEntry[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    aiIntegrations.usage().then(setEntries).catch(() => setEntries([]));
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (entries === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading plan limits…
        </CardContent>
      </Card>
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4" /> Plan limits
          </CardTitle>
          <CardDescription>
            Connect Codex with <span className="font-medium">usage</span> access on the Integrations page to
            see your ChatGPT plan limits here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className={compact ? "space-y-3" : "grid gap-4 md:grid-cols-2"}>
      {entries.map((entry) => {
        const windows = windowViews(entry.snapshot, now);
        const allReset = windows.length > 0 && windows.every((window) => window.resetSinceReading);
        return (
          <Card key={`${entry.deviceId}:${entry.integration}`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Gauge className="h-4 w-4" />
                  {entry.integration === "codex" ? "Codex · ChatGPT plan" : entry.integration}
                </CardTitle>
                {entry.snapshot.planType && (
                  <Badge variant="secondary" className="capitalize">
                    {entry.snapshot.planType}
                  </Badge>
                )}
              </div>
              <CardDescription>
                As recorded by Codex {formatRelative(entry.snapshot.observedAt, now)} (
                {new Date(entry.snapshot.observedAt).toLocaleString()})
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {windows.length === 0 && (
                <p className="text-sm text-muted-foreground">Codex did not record any usage windows.</p>
              )}
              {windows.map((window) => (
                <div key={window.name} className="space-y-1.5">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{window.label}</span>
                    {window.resetSinceReading ? (
                      <span className="text-xs text-muted-foreground">reset since this reading</span>
                    ) : (
                      <span className="tabular-nums">
                        {window.usedPercent}% used · {Math.max(0, 100 - window.usedPercent)}% left
                      </span>
                    )}
                  </div>
                  {window.resetSinceReading ? (
                    <div className="h-2 rounded-full border border-dashed border-border" />
                  ) : (
                    <Progress value={window.usedPercent} className="h-2" />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {window.resetSinceReading
                      ? `Reset ${formatRelative(window.resetsAt, now)} — current usage appears when Codex next runs`
                      : `Resets ${formatRelative(window.resetsAt, now)} (${window.resetsAt.toLocaleString()})`}
                  </p>
                </div>
              ))}

              {entry.snapshot.credits && !entry.snapshot.credits.unlimited && (
                <div className="flex items-center justify-between border-t pt-3 text-sm">
                  <span className="text-muted-foreground">Credits balance</span>
                  <span className="tabular-nums">{entry.snapshot.credits.balance ?? "—"}</span>
                </div>
              )}
              {entry.snapshot.credits?.unlimited && (
                <div className="border-t pt-3 text-sm text-muted-foreground">Unlimited credits</div>
              )}

              {allReset && (
                <p className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Every window has reset since Codex last ran, so the figures above are not shown as current.
                  Use Codex once and they will update here automatically.
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
