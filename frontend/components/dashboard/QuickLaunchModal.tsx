"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2, Plus, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

interface DeviceOption {
  id: string;
  friendlyName: string;
  online: boolean;
  platform: string;
}

interface QuickLaunchModalProps {
  devices: DeviceOption[];
  onSessionLaunched?: () => void;
}

export function QuickLaunchModal({ devices, onSessionLaunched }: QuickLaunchModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [agentId, setAgentId] = useState("claude-code");
  const [projectRoot, setProjectRoot] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onlineDevices = devices.filter((d) => d.online);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId) {
      setError("Please select a target device");
      return;
    }
    if (!projectRoot.trim()) {
      setError("Project root directory is required");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const session = await apiClient.post<{ id: string }>("/api/v1/sessions", {
        deviceId,
        agentId,
        projectRoot: projectRoot.trim(),
        prompt: prompt.trim() || undefined,
      });

      toast.success("Session launched successfully!");
      setOpen(false);
      if (onSessionLaunched) onSessionLaunched();
      router.push(`/sessions/${session.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to launch session";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} className="gap-2 shadow-sm">
        <Plus className="h-4 w-4" /> Launch Session
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-border pb-4">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Play className="h-4 w-4 fill-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Launch Agent Session</h3>
                  <p className="text-xs text-muted-foreground">Start an autonomous agent task on a connected device</p>
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground text-sm font-semibold rounded-lg p-1"
              >
                ✕
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="device-select" className="text-xs font-semibold">
                  Target Machine
                </Label>
                <select
                  id="device-select"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  required
                >
                  <option value="">-- Select a connected device --</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id} disabled={!d.online}>
                      {d.friendlyName} ({d.platform}) - {d.online ? "ONLINE" : "OFFLINE"}
                    </option>
                  ))}
                </select>
                {onlineDevices.length === 0 && (
                  <p className="text-[11px] text-amber-500">
                    No online devices available. Ensure your gateway is running and connected.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="agent-select" className="text-xs font-semibold">
                  Agent Engine
                </Label>
                <select
                  id="agent-select"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  <option value="claude-code">Claude Code (Anthropic CLI)</option>
                  <option value="gemini-cli">Gemini CLI (Google AI)</option>
                  <option value="codestral">Codestral (Mistral)</option>
                  <option value="mock">Mock Agent (Simulated / Testing)</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="project-root" className="text-xs font-semibold">
                  Workspace / Project Directory
                </Label>
                <Input
                  id="project-root"
                  type="text"
                  placeholder="e.g. C:\projects\my-app or /home/user/workspace"
                  value={projectRoot}
                  onChange={(e) => setProjectRoot(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="initial-prompt" className="text-xs font-semibold">
                  Initial Task Prompt (Optional)
                </Label>
                <textarea
                  id="initial-prompt"
                  rows={3}
                  className="w-full rounded-md border border-input bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  placeholder="e.g. Refactor the authentication module to support OAuth2..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={submitting || !deviceId}>
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting...
                    </>
                  ) : (
                    "Launch Agent"
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
