"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Clock,
  History,
  KeyRound,
  Loader2,
  Monitor,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api-client";
import {
  AVAILABLE_INTEGRATIONS,
  aiIntegrations,
  formatRelative,
  type DeviceIntegration,
  type DeviceOption,
  type IntegrationId,
  type IntegrationScope,
} from "@/lib/ai-integrations";

const SCOPE_LABEL: Record<IntegrationScope, string> = {
  "history.read": "Past conversations",
  "usage.read": "Usage & plan limits",
  "session.run": "Run sessions",
};

const ICON: Partial<Record<IntegrationId, typeof Bot>> = { codex: Bot, antigravity: Sparkles };

interface PendingConnect {
  integration: IntegrationId;
  name: string;
  code: string;
  expiresAt: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

/**
 * Connect AI coding tools that run on your own workstation.
 *
 * This page can only *ask* for access. Approval happens on the workstation,
 * where the owner types the code shown here — so a stolen web session cannot
 * grant itself access to anything.
 */
export function AiToolIntegrations() {
  const [devices, setDevices] = useState<DeviceOption[] | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [integrations, setIntegrations] = useState<DeviceIntegration[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedScopes, setSelectedScopes] = useState<Record<string, IntegrationScope[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConnect | null>(null);
  const [revoking, setRevoking] = useState<DeviceIntegration | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const device = devices?.find((candidate) => candidate.id === deviceId);

  useEffect(() => {
    aiIntegrations
      .devices()
      .then((list) => {
        setDevices(list);
        const preferred = list.find((candidate) => candidate.online) ?? list[0];
        if (preferred) setDeviceId(preferred.id);
      })
      .catch(() => setDevices([]));
  }, []);

  const load = useCallback(async () => {
    if (!deviceId) return;
    try {
      const list = await aiIntegrations.forDevice(deviceId);
      setIntegrations(list);
      setSelectedScopes((current) => {
        const next = { ...current };
        for (const item of list) next[item.id] ??= [...item.scopes];
        return next;
      });
    } catch {
      setIntegrations([]);
    }
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  // While a request is waiting, watch for the workstation's decision.
  useEffect(() => {
    if (!pending) return;
    const tick = async () => {
      setNow(Date.now());
      const list = await aiIntegrations.forDevice(deviceId).catch(() => null);
      if (!list) return;
      setIntegrations(list);
      const state = list.find((item) => item.id === pending.integration)?.state;
      if (state?.status === "active") {
        toast.success(`${pending.name} connected. Importing your conversations…`);
        setPending(null);
      } else if (state?.status === "denied" || state?.status === "expired") {
        toast.error(state.reason ?? `The request was ${state.status}`);
        setPending(null);
      }
    };
    pollRef.current = setInterval(() => void tick(), 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pending, deviceId]);

  const toggleScope = (integration: string, scope: IntegrationScope, on: boolean) => {
    setSelectedScopes((current) => {
      const existing = current[integration] ?? [];
      return {
        ...current,
        [integration]: on ? [...new Set([...existing, scope])] : existing.filter((item) => item !== scope),
      };
    });
  };

  const connect = async (item: DeviceIntegration) => {
    const scopes = selectedScopes[item.id] ?? [];
    if (scopes.length === 0) {
      toast.error("Choose at least one kind of access");
      return;
    }
    setBusy(item.id);
    try {
      const created = await aiIntegrations.requestAccess(deviceId, item.id, scopes);
      setPending({ integration: item.id, name: item.name, code: created.confirmationCode, expiresAt: created.expiresAt });
      await load();
    } catch (error) {
      toast.error(errorMessage(error, "Could not send the request"));
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async (item: DeviceIntegration) => {
    setBusy(`sync:${item.id}`);
    try {
      await aiIntegrations.syncNow(deviceId, item.id);
      toast.success(`Syncing ${item.name}. New conversations will appear in History shortly.`);
    } catch (error) {
      toast.error(errorMessage(error, "Could not start a sync"));
    } finally {
      setBusy(null);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    const item = revoking;
    setRevoking(null);
    setBusy(`revoke:${item.id}`);
    try {
      const result = await aiIntegrations.revoke(deviceId, item.id);
      toast.success(
        result.delivered
          ? `${item.name} disconnected and its synced history deleted`
          : `${item.name} disconnected here. The workstation is offline — it will stop reading as soon as it reconnects.`,
      );
      await load();
    } catch (error) {
      toast.error(errorMessage(error, "Could not revoke access"));
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------------ render

  if (devices === null) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your devices…
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No paired workstation</CardTitle>
          <CardDescription>
            AI coding tools run on your own computer. Pair it first (run <code>pnpm pair</code> on it), then come back
            here to connect Codex or Antigravity.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild variant="outline" size="sm">
            <Link href="/devices/pair">Pair a device</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <Select value={deviceId} onValueChange={setDeviceId}>
            <SelectTrigger className="h-9 w-[260px]">
              <SelectValue placeholder="Choose a workstation" />
            </SelectTrigger>
            <SelectContent>
              {devices.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.friendlyName} {option.online ? "· online" : "· offline"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {device && !device.online && (
          <p className="text-xs text-muted-foreground">
            This workstation is offline. Start the gateway on it to connect or sync.
          </p>
        )}
      </div>

      {loading && integrations.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {integrations.map((item) => {
            const Icon = ICON[item.id] ?? KeyRound;
            const available = AVAILABLE_INTEGRATIONS.includes(item.id);
            const status = item.state.status;
            const active = status === "active";
            const waiting = status === "pending";
            const chosen = selectedScopes[item.id] ?? [];

            return (
              <Card key={item.id} className={!available ? "opacity-70" : undefined}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{item.name}</CardTitle>
                        <CardDescription className="text-xs">{item.summary}</CardDescription>
                      </div>
                    </div>
                    {!available ? (
                      <Badge variant="outline">Coming later</Badge>
                    ) : active ? (
                      <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
                        <CheckCircle2 className="h-3 w-3" /> Connected
                      </Badge>
                    ) : waiting ? (
                      <Badge variant="secondary" className="gap-1">
                        <Clock className="h-3 w-3" /> Waiting for approval
                      </Badge>
                    ) : (
                      <Badge variant="outline">Not connected</Badge>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="space-y-3 text-sm">
                  {active ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {item.state.scopes.map((scope) => (
                          <Badge key={scope} variant="secondary">
                            {SCOPE_LABEL[scope]}
                          </Badge>
                        ))}
                      </div>
                      {item.state.roots && item.state.roots.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Reading only: <code className="text-foreground">{item.state.roots.join(", ")}</code>
                        </p>
                      )}
                      {item.state.expiresAt && (
                        <p className="text-xs text-muted-foreground">
                          Access expires {formatRelative(item.state.expiresAt, now)} — you will be asked again.
                        </p>
                      )}
                    </>
                  ) : available ? (
                    <>
                      <div className="space-y-2">
                        {item.scopes.map((scope) => (
                          <label key={scope} className="flex cursor-pointer items-start gap-2.5">
                            <Checkbox
                              checked={chosen.includes(scope)}
                              onCheckedChange={(checked) => toggleScope(item.id, scope, checked === true)}
                              disabled={waiting}
                              className="mt-0.5"
                            />
                            <span>
                              <span className="font-medium">{SCOPE_LABEL[scope]}</span>
                              <span className="block text-xs text-muted-foreground">{item.reads[scope]}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />
                        {item.leavesMachine}
                      </p>
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">Never read</summary>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                          {item.neverRead.map((entry) => (
                            <li key={entry}>{entry}</li>
                          ))}
                        </ul>
                      </details>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Planned for a later phase. Nothing is read for this integration today.
                    </p>
                  )}
                  {status === "denied" && item.state.reason && (
                    <p className="text-xs text-destructive">Last request: {item.state.reason}</p>
                  )}
                </CardContent>

                {available && (
                  <CardFooter className="flex flex-wrap gap-2">
                    {active ? (
                      <>
                        <Button asChild size="sm" variant="default">
                          <Link href={`/history?integration=${item.id}`}>
                            <History className="mr-1.5 h-3.5 w-3.5" /> View history
                          </Link>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!device?.online || busy === `sync:${item.id}`}
                          onClick={() => void syncNow(item)}
                        >
                          {busy === `sync:${item.id}` ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Sync now
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRevoking(item)}>
                          <ShieldOff className="mr-1.5 h-3.5 w-3.5" /> Revoke
                        </Button>
                      </>
                    ) : waiting ? (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(item)}>
                        Cancel request
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={!device?.online || busy === item.id || chosen.length === 0}
                        onClick={() => void connect(item)}
                      >
                        {busy === item.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Connect
                      </Button>
                    )}
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* The confirmation code: shown once, only in this browser. */}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve on your workstation</DialogTitle>
            <DialogDescription>
              Access to {pending?.name} is granted on {device?.friendlyName ?? "your workstation"}, not here. Type this
              code there to approve.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border bg-muted/40 py-5 text-center">
            <div className="font-mono text-4xl font-semibold tracking-[0.25em]">{pending?.code}</div>
            {pending && (
              <div className="mt-2 text-xs text-muted-foreground">
                Expires {formatRelative(pending.expiresAt, now)}
              </div>
            )}
          </div>
          <div className="space-y-2 text-sm">
            <p className="flex items-start gap-2">
              <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                The gateway terminal on that computer is showing this request. Check what it will read, then type the
                code.
              </span>
            </p>
            <p className="pl-6 text-xs text-muted-foreground">
              If the gateway runs in the background, open a terminal there and run{" "}
              <code className="text-foreground">pnpm grants approve</code>.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for approval…
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revoking?.state.status === "pending" ? "Cancel this request?" : `Disconnect ${revoking?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revoking?.state.status === "pending"
                ? "The pending request will be cancelled on your workstation."
                : "Your workstation stops reading immediately, and everything synced from it — conversation titles, any content you synced, and usage figures — is deleted from Odysseus. Nothing on your computer is touched."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRevoke()} className="bg-destructive text-white hover:bg-destructive/90">
              {revoking?.state.status === "pending" ? "Cancel request" : "Disconnect & delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
