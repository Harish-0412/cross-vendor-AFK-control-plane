"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  Apple,
  Check,
  FolderOpen,
  Loader2,
  Monitor,
  Play,
  Plus,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { LiveDot } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { apiClient, ApiError } from "@/lib/api-client";
import { useUiStore } from "@/lib/ui-store";
import { useWorkspace, type DeviceSummary } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";

interface AgentOption {
  id: string;
  name?: string;
  capabilities?: Record<string, string>;
}

const AGENT_NAMES: Record<string, string> = {
  codex: "OpenAI Codex",
  "claude-code": "Claude Code",
  claude: "Claude Code",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  mock: "Mock agent",
};

const agentName = (agent: AgentOption) => agent.name ?? AGENT_NAMES[agent.id] ?? agent.id;

/**
 * The trigger kept for the screens that already place a "Launch session"
 * button. It opens the one shared launch sheet rather than its own copy.
 * `devices` is accepted for compatibility; the sheet reads the shared store.
 */
export function QuickLaunchModal({
  onSessionLaunched,
  className,
}: {
  devices?: unknown[];
  onSessionLaunched?: () => void;
  className?: string;
}) {
  const setLaunchOpen = useUiStore((state) => state.setLaunchOpen);
  return (
    <Button
      onClick={() => setLaunchOpen(true, onSessionLaunched)}
      className={cn("gap-2 shadow-sm", className)}
    >
      <Plus className="h-4 w-4" /> Launch session
    </Button>
  );
}

function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  if (platform === "darwin") return <Apple className={className} />;
  if (platform === "linux") return <Terminal className={className} />;
  return <Monitor className={className} />;
}

/**
 * Start an agent on a paired machine. Mounted once by the app shell and opened
 * from the phone's + button, the command palette or any Launch button.
 *
 * Machines and agents are picked from cards rather than native dropdowns:
 * on a phone a <select> opens a system wheel that hides whether a machine is
 * online, which is the one thing that decides whether this will work.
 */
export function LaunchSessionSheet() {
  const router = useRouter();
  const open = useUiStore((state) => state.launchOpen);
  const onLaunched = useUiStore((state) => state.onLaunched);
  const setOpen = useUiStore((state) => state.setLaunchOpen);
  const devices = useWorkspace((state) => state.devices.data);
  const refresh = useWorkspace((state) => state.refresh);

  const [deviceId, setDeviceId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [projectRoot, setProjectRoot] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => Number(b.online) - Number(a.online)),
    [devices],
  );
  const selected = devices.find((device) => device.id === deviceId);

  // Preselect the only online machine: the common case is one workstation.
  useEffect(() => {
    if (!open || deviceId) return;
    const online = devices.filter((device) => device.online);
    if (online.length === 1 && online[0]) setDeviceId(online[0].id);
  }, [open, devices, deviceId]);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  useEffect(() => {
    if (!deviceId) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    setLoadingAgents(true);
    apiClient
      .get<AgentOption[]>(`/api/v1/devices/${deviceId}/agents`)
      .catch(() => selected?.availableAgents ?? [])
      .then((available) => {
        if (cancelled) return;
        setAgents(available);
        setAgentId((current) =>
          available.some((agent) => agent.id === current) ? current : (available[0]?.id ?? ""),
        );
      })
      .finally(() => !cancelled && setLoadingAgents(false));
    return () => {
      cancelled = true;
    };
  }, [deviceId, selected?.availableAgents]);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!deviceId) return setError("Choose a machine to run on.");
    if (!agentId) return setError("Choose an agent installed on that machine.");
    if (!projectRoot.trim()) return setError("Enter the project folder on that machine.");

    setSubmitting(true);
    setError(null);
    try {
      const session = await apiClient.post<{ id: string }>("/api/v1/sessions", {
        deviceId,
        agentId,
        projectRoot: projectRoot.trim(),
        prompt: prompt.trim() || undefined,
      });
      toast.success("Session started", { description: `${agentName({ id: agentId })} is working.` });
      setOpen(false);
      onLaunched?.();
      void refresh();
      router.push(`/sessions/${session.id}`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The session could not be started.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const ready = Boolean(deviceId && agentId && projectRoot.trim()) && !submitting;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => setOpen(next)}
      icon={<Play className="h-5 w-5 fill-current" />}
      title="Launch an agent"
      description="Start a task on one of your machines"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!ready} className="gap-2">
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Starting…
              </>
            ) : (
              <>
                <Play className="h-4 w-4 fill-current" /> Launch
              </>
            )}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <section className="space-y-2">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Machine
          </Label>
          {devices.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              No machines are paired yet. Pair one from Machines, then come back.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {sortedDevices.map((device) => (
                <DeviceChoice
                  key={device.id}
                  device={device}
                  selected={device.id === deviceId}
                  onSelect={() => {
                    setDeviceId(device.id);
                    setAgentId("");
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <AnimatePresence initial={false}>
          {deviceId && (
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="space-y-2"
            >
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Agent
              </Label>
              {loadingAgents ? (
                <div className="flex gap-2">
                  <div className="skeleton h-11 flex-1" />
                  <div className="skeleton h-11 flex-1" />
                </div>
              ) : agents.length === 0 ? (
                <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                  That machine has not reported an installed agent yet. Is its gateway running?
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {agents.map((agent) => {
                    const active = agent.id === agentId;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => setAgentId(agent.id)}
                        className={cn(
                          "flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-medium transition-all active:scale-95",
                          active
                            ? "border-primary bg-primary/10 text-foreground shadow-sm"
                            : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                        )}
                      >
                        {active && <Check className="h-4 w-4 text-primary" />}
                        {agentName(agent)}
                      </button>
                    );
                  })}
                </div>
              )}
            </motion.section>
          )}
        </AnimatePresence>

        <section className="space-y-2">
          <Label
            htmlFor="launch-project-root"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Project folder
          </Label>
          <div className="relative">
            <FolderOpen className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="launch-project-root"
              value={projectRoot}
              onChange={(event) => setProjectRoot(event.target.value)}
              placeholder={
                selected?.platform === "windows" ? "C:\\projects\\my-app" : "/home/me/projects/my-app"
              }
              className="h-11 rounded-xl pl-9 font-mono text-sm"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          <p className="text-xs text-muted-foreground">A folder on that machine, inside a project root its gateway allows.</p>
        </section>

        <section className="space-y-2">
          <Label
            htmlFor="launch-prompt"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Task <span className="font-normal normal-case tracking-normal">(optional)</span>
          </Label>
          <textarea
            id="launch-prompt"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Add input validation to the signup form and cover it with tests"
            className="w-full resize-none rounded-xl border border-input bg-background p-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-ring/40"
          />
        </section>
        {/* Enter in the text field submits on desktop; the sheet has its own button. */}
        <button type="submit" hidden aria-hidden />
      </form>
    </ResponsiveDialog>
  );
}

function DeviceChoice({
  device,
  selected,
  onSelect,
}: {
  device: DeviceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!device.online}
      className={cn(
        "flex items-center gap-3 rounded-xl border p-3 text-left transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55",
        selected
          ? "border-primary bg-primary/10 shadow-sm ring-1 ring-primary/30"
          : "border-border bg-card hover:border-primary/40",
      )}
    >
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
          selected ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        <PlatformIcon platform={device.platform} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{device.friendlyName}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <LiveDot tone={device.online ? "success" : "muted"} live={device.online} />
          {device.online
            ? device.activeSessionCount > 0
              ? `Online · ${device.activeSessionCount} running`
              : "Online"
            : "Offline — start its gateway"}
        </span>
      </span>
      {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}
