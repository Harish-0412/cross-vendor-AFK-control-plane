/**
 * The words and judgements the overview is built on — no React, no DOM.
 *
 * Kept apart from the components so the rules are tested directly: how a
 * session's state is worded, and what one-line summary the dashboard leads
 * with. The summary in particular must never claim more than it knows.
 */

export type Tone = "success" | "warning" | "danger" | "muted" | "primary";

export interface SummaryInput {
  devicesError: string | null;
  devices: Array<{ online: boolean }>;
  approvals: unknown[];
  live: unknown[];
}

/** One sentence that says how things are, before any numbers. */
export function summary(d: SummaryInput): { text: string; tone: Exclude<Tone, "primary"> } {
  if (d.devicesError && d.devices.length === 0)
    return { text: "The machine list could not be loaded", tone: "danger" };
  if (d.devices.length === 0) return { text: "Pair a machine to get started", tone: "muted" };
  if (d.approvals.length > 0)
    return {
      text: `${d.approvals.length} ${d.approvals.length === 1 ? "decision is" : "decisions are"} waiting for you`,
      tone: "warning",
    };
  if (!d.devices.some((device) => device.online))
    return { text: "Your machines are offline", tone: "danger" };
  if (d.live.length > 0)
    return {
      text: `${d.live.length} ${d.live.length === 1 ? "agent is" : "agents are"} working — nothing needs you`,
      tone: "success",
    };
  return { text: "All clear. Nothing is running and nothing needs you", tone: "success" };
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const AGENT_NAMES: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  claude: "Claude Code",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  mock: "Mock agent",
};

export const agentLabel = (id: string): string => AGENT_NAMES[id] ?? id;

export function sessionState(state: string): { label: string; tone: Tone; live: boolean } {
  switch (state) {
    case "running":
      return { label: "Running", tone: "success", live: true };
    case "initializing":
      return { label: "Starting", tone: "primary", live: true };
    case "waiting_for_approval":
      return { label: "Needs you", tone: "warning", live: true };
    case "paused":
      return { label: "Paused", tone: "muted", live: false };
    case "completed":
      return { label: "Completed", tone: "success", live: false };
    case "failed":
    case "crashed":
      return { label: "Failed", tone: "danger", live: false };
    case "cancelled":
      return { label: "Stopped", tone: "muted", live: false };
    default:
      return { label: state.replaceAll("_", " "), tone: "muted", live: false };
  }
}

/** "C:\\Users\\me\\projects\\app" → "app"; the last folder is the recognisable part. */
export function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}
