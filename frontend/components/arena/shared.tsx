"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, type LucideIcon } from "lucide-react";

import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api-client";
import { AGENT_VENDOR, agentLabel } from "@/lib/arena";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace-store";

export interface ProjectOption {
  id: string;
  name: string;
  root: string;
}

/** Three numbered steps at the top of a page: what it does, before anything else. */
export function HowItWorks({
  steps,
}: {
  steps: Array<{ icon: LucideIcon; title: string; text: string }>;
}) {
  return (
    <ol className="grid gap-3 sm:grid-cols-3">
      {steps.map((step, index) => (
        <li key={step.title} className="surface flex gap-3 p-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <step.icon className="h-3.5 w-3.5 text-primary" />
              {step.title}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The agents installed on a machine, asked live. The stored list is only
 * refreshed as a side effect of routing, so it can be empty or stale.
 */
export function useDeviceAgents(deviceId: string | undefined, online: boolean | undefined) {
  const [agents, setAgents] = useState<string[] | null>(null);
  useEffect(() => {
    if (!deviceId) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    setAgents(null);
    void apiClient
      .get<Array<{ id: string }>>(`/api/v1/devices/${encodeURIComponent(deviceId)}/agents`)
      .then((list) => !cancelled && setAgents((Array.isArray(list) ? list : []).map((agent) => agent.id)))
      .catch(() => !cancelled && setAgents([]));
    return () => {
      cancelled = true;
    };
  }, [deviceId, online]);
  return agents;
}

/** Projects and machines, with the first online machine preselected. */
export function useProjectAndMachine() {
  const devices = useWorkspace((state) => state.devices.data);
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [deviceId, setDeviceId] = useState("");

  useEffect(() => {
    void apiClient
      .get<ProjectOption[]>("/api/v1/projects")
      .then((list) => {
        const safe = Array.isArray(list) ? list : [];
        setProjects(safe);
        if (safe[0]) setProjectId((current) => current || safe[0]!.id);
      })
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (deviceId) return;
    const online = devices.find((device) => device.online);
    if (online) setDeviceId(online.id);
  }, [devices, deviceId]);

  const device = devices.find((item) => item.id === deviceId);
  const project = projects?.find((item) => item.id === projectId);
  const agents = useDeviceAgents(deviceId || undefined, device?.online);
  return { projects, project, projectId, setProjectId, devices, device, deviceId, setDeviceId, agents };
}

export function ProjectMachineFields({
  state,
}: {
  state: ReturnType<typeof useProjectAndMachine>;
}) {
  const { projects, projectId, setProjectId, devices, deviceId, setDeviceId } = state;
  if (projects && projects.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
        Register a project first on the{" "}
        <Link href="/projects" className="font-medium text-primary underline-offset-4 hover:underline">
          Projects
        </Link>{" "}
        page. Agents work inside a git repository on one of your machines.
      </p>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="arena-project">Project</Label>
        <select
          id="arena-project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
        >
          {(projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} — {project.root}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="arena-machine">Machine</Label>
        <select
          id="arena-machine"
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
          className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
        >
          {devices.length === 0 && <option value="">No paired machines</option>}
          {devices.map((device) => (
            <option key={device.id} value={device.id} disabled={!device.online}>
              {device.friendlyName} {device.online ? "· online" : "· offline — start its gateway"}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Agents installed on the chosen machine, as toggle chips labelled with their vendor. */
export function AgentPicker({
  available,
  selected,
  onChange,
  max,
  hint,
}: {
  available: string[] | null;
  selected: string[];
  onChange: (next: string[]) => void;
  max: number;
  hint?: string;
}) {
  const options = useMemo(
    () => (available ?? []).filter((id) => id !== "mock" || (available ?? []).length === 1),
    [available],
  );
  if (available === null) {
    return <p className="text-sm text-muted-foreground">Asking the machine which agents it has…</p>;
  }
  if (options.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
        This machine has not reported any installed agents. Is its gateway running?
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {options.map((id) => {
          const active = selected.includes(id);
          const full = !active && selected.length >= max;
          return (
            <button
              key={id}
              type="button"
              disabled={full}
              onClick={() => onChange(active ? selected.filter((item) => item !== id) : [...selected, id])}
              className={cn(
                "flex h-11 items-center gap-2 rounded-xl border px-3.5 text-left text-sm transition-all active:scale-95 disabled:opacity-40",
                active
                  ? "border-primary bg-primary/10 text-foreground shadow-sm"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {active && <Check className="h-4 w-4 text-primary" />}
              <span>
                <span className="block font-medium leading-4">{agentLabel(id)}</span>
                <span className="block text-[10px] uppercase tracking-wider opacity-70">
                  {AGENT_VENDOR[id] ?? "Agent"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function StateBadge({ state }: { state: string }) {
  const tone =
    state === "done" || state === "decided" || state === "completed"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25"
      : state === "failed"
        ? "bg-destructive/10 text-destructive border-destructive/25"
        : state === "cancelled" || state === "queued"
          ? "bg-muted text-muted-foreground border-border"
          : "bg-primary/10 text-primary border-primary/25";
  const label: Record<string, string> = {
    preparing: "Preparing workspace",
    running: "Working",
    evaluating: "Running tests",
    reviewing: "Being reviewed",
    judging: "Reviewing",
    decided: "Decided",
    done: "Finished",
    failed: "Failed",
    cancelled: "Cancelled",
    queued: "Queued",
    completed: "Completed",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold", tone)}>
      {label[state] ?? state}
    </span>
  );
}
