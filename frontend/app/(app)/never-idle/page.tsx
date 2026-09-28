"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarClock,
  CircleSlash,
  Clock,
  Eye,
  Loader2,
  Repeat,
  Shuffle,
} from "lucide-react";
import { toast } from "sonner";

import { HowItWorks, useDeviceAgents } from "@/components/arena/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api-client";
import {
  AGENT_VENDOR,
  agentLabel,
  arena,
  clockText,
  untilText,
  type Handoff,
  type NeverIdleOverview,
  type NeverIdleSettings,
  type ScheduledResume,
  type VendorLimit,
} from "@/lib/arena";
import { cn } from "@/lib/utils";
import { useWorkspace, type DeviceSummary } from "@/lib/workspace-store";

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

const DEFAULT_ORDER = ["claude-code", "codex", "opencode", "antigravity", "freebuff"];

export default function NeverIdlePage() {
  const devices = useWorkspace((state) => state.devices.data);
  const [data, setData] = useState<NeverIdleOverview | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setData(await arena.neverIdle());
    } catch (error) {
      toast.error(errorText(error, "Could not load never-idle status"));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const save = async (patch: Partial<NeverIdleSettings>) => {
    if (!data) return;
    setSaving(true);
    setData({ ...data, settings: { ...data.settings, ...patch } });
    try {
      const settings = await arena.saveNeverIdle(patch);
      setData((current) => (current ? { ...current, settings } : current));
    } catch (error) {
      toast.error(errorText(error, "Could not save"));
      void load();
    } finally {
      setSaving(false);
    }
  };

  const order = useMemo(() => {
    const chosen = data?.settings.fallbackOrder ?? [];
    const known = new Set<string>([...chosen, ...DEFAULT_ORDER]);
    for (const device of devices) for (const agent of device.availableAgents ?? []) known.add(agent.id);
    known.delete("mock");
    return [...chosen.filter((id) => known.has(id)), ...[...known].filter((id) => !chosen.includes(id))];
  }, [data?.settings.fallbackOrder, devices]);

  const move = (index: number, delta: number) => {
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    void save({ fallbackOrder: next });
  };

  if (!data) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const { settings, limits, handoffs, scheduled } = data;
  const limitFor = (deviceId: string, agentId: string) =>
    limits.find((limit) => limit.deviceId === deviceId && limit.agentId === agentId);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Never idle</h1>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
            When an agent hits its plan or rate limit in the middle of a task, the task keeps
            going. Another vendor&apos;s agent on the same machine picks it up where it stopped — or,
            if none is available, the same agent continues the moment its limit resets.
          </p>
        </div>
        <label className="surface flex shrink-0 cursor-pointer items-center gap-3 px-4 py-3">
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => void save({ enabled: checked })}
            disabled={saving}
          />
          <span className="text-sm font-semibold">{settings.enabled ? "On" : "Off"}</span>
        </label>
      </div>

      <HowItWorks
        steps={[
          {
            icon: Eye,
            title: "Watches every session",
            text: "When an agent stops with a usage-limit message, Odysseus records it and when the limit resets.",
          },
          {
            icon: Shuffle,
            title: "Hands off to another vendor",
            text: "The next agent in your order continues in the same folder, briefed on the task and the work already done.",
          },
          {
            icon: CalendarClock,
            title: "Or waits for the reset",
            text: "With no other agent available, the same agent is restarted automatically once its limit resets.",
          },
        ]}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Agents right now</CardTitle>
          <CardDescription>
            An agent at its limit is skipped: new launches of it start the next agent instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {devices.length === 0 && <p className="text-sm text-muted-foreground">No machines paired yet.</p>}
          {devices.map((device) => (
            <MachineAgents
              key={device.id}
              device={device}
              limitFor={limitFor}
              now={now}
              onCleared={() => void load()}
            />
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Hand-off order</CardTitle>
            <CardDescription>
              Who takes over first. Agents at their limit, or not installed on that machine, are skipped.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ol className="space-y-2">
              {order.map((agentId, index) => (
                <li key={agentId} className="flex items-center gap-3 rounded-xl border px-3 py-2">
                  <span className="w-5 text-center text-sm font-bold text-muted-foreground">{index + 1}</span>
                  <span className="flex-1 text-sm font-medium">
                    {agentLabel(agentId)}{" "}
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {AGENT_VENDOR[agentId] ?? ""}
                    </span>
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={index === 0 || saving}
                    onClick={() => move(index, -1)}
                    aria-label={`Move ${agentLabel(agentId)} up`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={index === order.length - 1 || saving}
                    onClick={() => move(index, 1)}
                    aria-label={`Move ${agentLabel(agentId)} down`}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ol>
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Continue after the reset</span>
                <span className="block text-xs text-muted-foreground">
                  When no other agent can take over, restart the same one once its limit resets.
                </span>
              </span>
              <Switch
                checked={settings.resumeAfterReset}
                onCheckedChange={(checked) => void save({ resumeAfterReset: checked })}
                disabled={saving}
              />
            </label>
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Hand-offs in a row</span>
                <span className="block text-xs text-muted-foreground">
                  Stops a task being passed around when every agent is limited.
                </span>
              </span>
              <select
                value={settings.maxHandoffs}
                onChange={(event) => void save({ maxHandoffs: Number(event.target.value) })}
                className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
              >
                {[1, 2, 3, 4, 5, 6].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
          </CardContent>
        </Card>

        <WaitingList scheduled={scheduled} onChanged={() => void load()} />
      </div>

      <HandoffHistory handoffs={handoffs} />
    </div>
  );
}

function MachineAgents({
  device,
  limitFor,
  now,
  onCleared,
}: {
  device: DeviceSummary;
  limitFor: (deviceId: string, agentId: string) => VendorLimit | undefined;
  now: number;
  onCleared: () => void;
}) {
  const live = useDeviceAgents(device.id, device.online);
  const agents = (live ?? (device.availableAgents ?? []).map((agent) => agent.id)).filter(
    (id) => id !== "mock",
  );
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {device.friendlyName} {device.online ? "" : "· offline"}
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {agents.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {live === null ? "Checking…" : device.online ? "No agents reported." : "Start its gateway to see its agents."}
          </p>
        )}
        {agents.map((agentId) => {
          const limit = limitFor(device.id, agentId);
          return (
            <div
              key={agentId}
              className={cn(
                "flex items-start justify-between gap-2 rounded-xl border p-3",
                limit ? "border-amber-500/30 bg-amber-500/5" : "border-border",
              )}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold">{agentLabel(agentId)}</p>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {AGENT_VENDOR[agentId] ?? "Agent"}
                </p>
                {limit ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    At its limit · {limit.resetKnown ? "resets" : "expected back"} {clockText(limit.resetsAt)} (
                    {untilText(limit.resetsAt, now)})
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">Ready</p>
                )}
              </div>
              {limit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() =>
                    void arena.clearLimit(device.id, agentId).then(() => {
                      toast.success(`${agentLabel(agentId)} marked as available`);
                      onCleared();
                    })
                  }
                >
                  It&apos;s back
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WaitingList({ scheduled, onChanged }: { scheduled: ScheduledResume[]; onChanged: () => void }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Waiting for a reset</CardTitle>
        <CardDescription>Tasks that restart automatically when their agent is available again.</CardDescription>
      </CardHeader>
      <CardContent>
        {scheduled.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" /> Nothing is waiting.
          </p>
        ) : (
          <ul className="space-y-2">
            {scheduled.map((resume) => (
              <li key={resume.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {agentLabel(resume.agentId)} continues {clockText(resume.runAt)}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{resume.projectRoot}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void arena.cancelScheduled(resume.id).then(() => {
                      toast.info("Cancelled");
                      onChanged();
                    })
                  }
                >
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function HandoffHistory({ handoffs }: { handoffs: Handoff[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Recent hand-offs</CardTitle>
      </CardHeader>
      <CardContent>
        {handoffs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. When an agent hits its limit, what happened next appears here.
          </p>
        ) : (
          <ul className="divide-y">
            {handoffs.map((handoff) => (
              <li key={handoff.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                    {handoff.kind === "handoff" ? (
                      <Repeat className="h-4 w-4 text-primary" />
                    ) : handoff.kind === "scheduled_resume" ? (
                      <CalendarClock className="h-4 w-4 text-amber-500" />
                    ) : (
                      <CircleSlash className="h-4 w-4 text-muted-foreground" />
                    )}
                    {agentLabel(handoff.fromAgentId)}
                    {handoff.toAgentId && (
                      <>
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        {agentLabel(handoff.toAgentId)}
                      </>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{handoff.reason}</p>
                  {handoff.error && <p className="text-xs text-destructive">{handoff.error}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3 text-xs">
                  <span className="text-muted-foreground">{new Date(handoff.createdAt).toLocaleString()}</span>
                  <Link href={`/sessions/${handoff.fromSessionId}`} className="font-medium text-primary hover:underline">
                    Stopped session
                  </Link>
                  {handoff.toSessionId && (
                    <Link href={`/sessions/${handoff.toSessionId}`} className="font-medium text-primary hover:underline">
                      Continued session
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
