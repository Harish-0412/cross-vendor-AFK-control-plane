"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Fingerprint,
  KeyRound,
  Laptop,
  Loader2,
  MonitorCog,
  RotateCcw,
  Server,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiClient } from "@/lib/api-client";

interface PairingSessionResponse {
  pairingId: string;
  deviceId: string;
  gatewayId: string;
  deviceName: string;
  platform: "windows" | "linux" | "darwin" | "unknown";
  fingerprintHex: string;
  fingerprintWords: string[];
  expiresAt: string;
  status: "code_verified";
}

type PairingSessionWire = Partial<
  Record<keyof PairingSessionResponse, unknown>
>;

interface ConfirmedDevice {
  id: string;
  friendlyName: string;
  platform: string;
  status: string;
  online: boolean;
}

interface DeviceListItem extends ConfirmedDevice {
  systemInfo?: { hostname?: string } | null;
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Pairing records created by older gateways can omit display-only fields.
 * Normalize the network response before it reaches React state so rendering
 * never calls string or array methods on an undefined legacy value.
 */
function normalizePairing(data: PairingSessionWire): PairingSessionResponse {
  const pairingId = stringField(data.pairingId);
  const deviceId = stringField(data.deviceId);
  if (!pairingId || !deviceId) {
    throw new Error(
      "The Control Plane returned an incomplete pairing response.",
    );
  }

  const platform = stringField(data.platform, "unknown");
  return {
    pairingId,
    deviceId,
    gatewayId: stringField(data.gatewayId, `gw_${deviceId}`),
    deviceName: stringField(
      data.deviceName,
      `Workstation ${deviceId.slice(-6)}`,
    ),
    platform:
      platform === "windows" || platform === "linux" || platform === "darwin"
        ? platform
        : "unknown",
    fingerprintHex: stringField(
      data.fingerprintHex,
      "Not provided by legacy gateway",
    ),
    fingerprintWords: Array.isArray(data.fingerprintWords)
      ? data.fingerprintWords.filter(
          (word): word is string => typeof word === "string" && word.length > 0,
        )
      : [],
    expiresAt: stringField(
      data.expiresAt,
      new Date(Date.now() + 5 * 60_000).toISOString(),
    ),
    status: "code_verified",
  };
}

function normalizeConfirmedDevice(
  value: Partial<ConfirmedDevice> | null | undefined,
  pairing: PairingSessionResponse,
  requestedName: string,
): ConfirmedDevice {
  return {
    id: stringField(value?.id, pairing.deviceId),
    friendlyName: stringField(
      value?.friendlyName,
      requestedName || pairing.deviceName || "Workstation",
    ),
    platform: stringField(value?.platform, pairing.platform),
    status: stringField(value?.status, "trusted"),
    online: value?.online === true,
  };
}

const STEPS = [
  { id: 1, label: "Enter code", detail: "Link the request" },
  { id: 2, label: "Verify device", detail: "Check its identity" },
  { id: 3, label: "Ready", detail: "Start controlling" },
] as const;

function formatCode(value: string): string {
  const clean = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function platformLabel(
  value: PairingSessionResponse["platform"] | string,
): string {
  if (value === "darwin") return "macOS";
  if (value === "windows") return "Windows";
  if (value === "linux") return "Linux";
  return "Unknown platform";
}

function PlatformIcon({ platform }: { platform: string }) {
  return platform === "linux" ? (
    <Server className="h-6 w-6" />
  ) : (
    <Laptop className="h-6 w-6" />
  );
}

export default function PairDevicePage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [code, setCode] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingSessionResponse | null>(null);
  const [connectedDevice, setConnectedDevice] =
    useState<ConfirmedDevice | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get("code");
    if (fromLink) setCode(formatCode(fromLink));
  }, []);

  useEffect(() => {
    if (!pairing || step !== 2) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pairing, step]);

  // The CLI starts the tunnel after pairing. Keep the success state honest
  // and switch it to online automatically as soon as that happens.
  useEffect(() => {
    if (step !== 3 || !connectedDevice || connectedDevice.online) return;
    const refresh = async () => {
      const devices = await apiClient
        .get<DeviceListItem[]>("/api/v1/devices")
        .catch(() => []);
      const current = devices.find(
        (device) => device.id === connectedDevice.id,
      );
      if (current) {
        setConnectedDevice((existing) =>
          existing ? { ...existing, ...current } : current,
        );
      }
    };
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [connectedDevice, step]);

  const secondsRemaining = useMemo(() => {
    if (!pairing) return null;
    return Math.max(
      0,
      Math.ceil((Date.parse(pairing.expiresAt) - now) / 1_000),
    );
  }, [now, pairing]);

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanCode = code.replace(/-/g, "");
    if (cleanCode.length !== 8) {
      setError("Enter the complete eight-character code shown by the gateway.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const wire = await apiClient.post<PairingSessionWire>(
        "/api/v1/devices/pair",
        {
          code: cleanCode,
        },
      );
      const data = normalizePairing(wire);
      setPairing(data);
      setFriendlyName(data.deviceName);
      setStep(2);
      toast.success(`Code verified — ${data.deviceName} responded`);
    } catch (problem) {
      const message =
        problem instanceof ApiError
          ? problem.message
          : "That code is invalid or expired.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const confirmPairing = async () => {
    if (!pairing) return;
    setBusy(true);
    setError(null);
    try {
      const requestedName =
        (friendlyName || "").trim() || pairing.deviceName || "Workstation";
      const response = await apiClient.post<{
        status: string;
        device?: Partial<ConfirmedDevice>;
      }>("/api/v1/devices/confirm", {
        pairingId: pairing.pairingId,
        confirmed: true,
        friendlyName: requestedName,
      });
      const device = normalizeConfirmedDevice(
        response?.device,
        pairing,
        requestedName,
      );
      setConnectedDevice(device);
      setStep(3);
      toast.success(`${device.friendlyName} is now trusted`);
    } catch (problem) {
      const message =
        problem instanceof ApiError
          ? problem.message
          : "The device could not be paired.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const rejectPairing = async () => {
    if (pairing) {
      await apiClient
        .post("/api/v1/devices/confirm", {
          pairingId: pairing.pairingId,
          confirmed: false,
        })
        .catch(() => undefined);
    }
    setPairing(null);
    setFriendlyName("");
    setStep(1);
    setError(null);
    toast.info("Pairing request rejected");
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-6xl items-center py-4 lg:py-8">
      <div className="grid w-full overflow-hidden rounded-[28px] border bg-card shadow-[0_24px_80px_-36px_rgba(15,23,42,0.45)] lg:grid-cols-[320px_1fr]">
        <aside className="relative overflow-hidden border-b bg-[linear-gradient(145deg,#0f172a_0%,#172554_56%,#1e3a8a_100%)] p-7 text-white lg:border-b-0 lg:border-r lg:p-9">
          <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-blue-400/20 blur-3xl" />
          <div className="absolute -bottom-24 -left-20 h-64 w-64 rounded-full bg-cyan-300/10 blur-3xl" />
          <div className="relative flex h-full flex-col">
            <Link
              href="/devices"
              className="mb-10 inline-flex items-center gap-2 text-sm text-white/70 transition hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" /> Connected machines
            </Link>

            <div className="mb-8">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/10 backdrop-blur">
                <MonitorCog className="h-6 w-6" />
              </div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-blue-200">
                Secure pairing
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">
                Connect a workstation
              </h1>
              <p className="mt-3 text-sm leading-6 text-blue-100/75">
                Link this control plane to one specific Odysseus Gateway. No
                agent credentials are transferred.
              </p>
            </div>

            <div className="space-y-1">
              {STEPS.map((item) => {
                const complete = step > item.id;
                const active = step === item.id;
                return (
                  <div
                    key={item.id}
                    className={`flex items-center gap-3 rounded-xl px-3 py-3 ${active ? "bg-white/10" : ""}`}
                  >
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${complete ? "border-emerald-300 bg-emerald-300 text-slate-950" : active ? "border-white bg-white text-blue-950" : "border-white/25 text-white/50"}`}
                    >
                      {complete ? <Check className="h-4 w-4" /> : item.id}
                    </div>
                    <div>
                      <p
                        className={
                          active || complete
                            ? "text-sm font-medium text-white"
                            : "text-sm text-white/50"
                        }
                      >
                        {item.label}
                      </p>
                      <p className="text-xs text-white/45">{item.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-auto hidden rounded-xl border border-white/10 bg-black/10 p-4 text-xs leading-5 text-white/60 lg:block">
              <div className="mb-1 flex items-center gap-2 font-medium text-white/85">
                <ShieldCheck className="h-4 w-4 text-emerald-300" /> Why compare
                fingerprints?
              </div>
              They prove the computer answering this PIN is the same computer in
              front of you—not another device that learned the code.
            </div>
          </div>
        </aside>

        <main className="relative min-h-[620px] p-6 sm:p-10 lg:p-14">
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">We couldn&apos;t continue</p>
                <p className="mt-0.5 text-xs opacity-80">{error}</p>
              </div>
            </motion.div>
          )}

          {step === 1 && (
            <motion.section
              key="code"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              className="mx-auto flex min-h-[500px] max-w-xl flex-col justify-center"
            >
              <div className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-300">
                <KeyRound className="h-7 w-7" />
              </div>
              <p className="text-sm font-medium text-blue-600 dark:text-blue-300">
                Step 1 of 3
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">
                Enter the connection PIN
              </h2>
              <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
                On the computer you want to connect, open the Odysseus project
                and run{" "}
                <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  pnpm pair
                </code>
                . Enter the one-time code it displays.
              </p>

              <form onSubmit={verifyCode} className="mt-9 space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="pairing-code">Eight-character PIN</Label>
                  <Input
                    id="pairing-code"
                    value={code}
                    onChange={(event) =>
                      setCode(formatCode(event.target.value))
                    }
                    placeholder="T55Q-Y3D2"
                    autoComplete="one-time-code"
                    inputMode="text"
                    autoFocus
                    className="h-16 rounded-xl border-2 bg-background text-center font-mono text-2xl font-semibold tracking-[0.22em] uppercase shadow-inner focus-visible:border-blue-500"
                  />
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock3 className="h-3.5 w-3.5" /> PINs expire after five
                    minutes and work once.
                  </p>
                </div>
                <Button
                  type="submit"
                  size="lg"
                  disabled={busy || code.replace(/-/g, "").length !== 8}
                  className="h-12 w-full rounded-xl bg-blue-600 text-white hover:bg-blue-700"
                >
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />{" "}
                      Validating securely…
                    </>
                  ) : (
                    <>
                      Find this workstation{" "}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>
            </motion.section>
          )}

          {step === 2 && pairing && (
            <motion.section
              key="verify"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              className="mx-auto max-w-2xl"
            >
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-blue-600 dark:text-blue-300">
                    Step 2 of 3 · PIN validated
                  </p>
                  <h2 className="mt-1 text-3xl font-semibold tracking-tight">
                    Confirm the right computer
                  </h2>
                </div>
                {secondsRemaining !== null && (
                  <div className="rounded-full border bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {secondsRemaining}s left
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.05] p-5">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
                    <PlatformIcon platform={pairing.platform} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-lg font-semibold">
                        {pairing.deviceName}
                      </h3>
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                        PIN verified
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {platformLabel(pairing.platform)} · Device{" "}
                      {pairing.deviceId.slice(-8)}
                    </p>
                  </div>
                  <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-500" />
                </div>
              </div>

              <div className="mt-6 rounded-2xl border bg-muted/25 p-5">
                <div className="mb-4 flex items-start gap-3">
                  <Fingerprint className="mt-0.5 h-5 w-5 text-blue-600" />
                  <div>
                    <h3 className="font-semibold">
                      Compare the security words
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      These must match the words in the terminal, in the same
                      order. Reject the request if even one differs.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {pairing.fingerprintWords.map((word, index) => (
                    <div
                      key={`${word}-${index}`}
                      className="rounded-lg border bg-background px-2 py-2.5 text-center font-mono text-xs"
                    >
                      <span className="mr-1 text-muted-foreground">
                        {index + 1}
                      </span>
                      {word}
                    </div>
                  ))}
                </div>
                <p
                  className="mt-4 truncate font-mono text-[10px] text-muted-foreground"
                  title={pairing.fingerprintHex}
                >
                  SHA-256 · {pairing.fingerprintHex}
                </p>
              </div>

              <div className="mt-6 space-y-2">
                <Label htmlFor="device-name">Name shown in Odysseus</Label>
                <Input
                  id="device-name"
                  value={friendlyName || ""}
                  onChange={(event) =>
                    setFriendlyName(event.target.value.slice(0, 120))
                  }
                  className="h-11 rounded-xl"
                />
                <p className="text-xs text-muted-foreground">
                  We received{" "}
                  <strong className="font-medium text-foreground">
                    {pairing.deviceName || "Workstation"}
                  </strong>{" "}
                  from the computer. You can keep it or choose a clearer label.
                </p>
              </div>

              <div className="mt-7 grid gap-3 sm:grid-cols-2">
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => void rejectPairing()}
                  disabled={busy}
                  className="h-12 rounded-xl"
                >
                  The words don&apos;t match
                </Button>
                <Button
                  size="lg"
                  onClick={() => void confirmPairing()}
                  disabled={
                    busy ||
                    secondsRemaining === 0 ||
                    !(friendlyName || "").trim()
                  }
                  className="h-12 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
                >
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />{" "}
                      Establishing trust…
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="mr-2 h-4 w-4" /> Trust this
                      computer
                    </>
                  )}
                </Button>
              </div>
            </motion.section>
          )}

          {step === 3 && connectedDevice && (
            <motion.section
              key="success"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="mx-auto flex min-h-[500px] max-w-xl flex-col items-center justify-center text-center"
            >
              <div className="relative mb-7">
                <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-emerald-500/12 text-emerald-600">
                  <CheckCircle2 className="h-10 w-10" />
                </div>
                <span className="absolute -right-1 -top-1 h-4 w-4 rounded-full border-4 border-card bg-emerald-500" />
              </div>
              <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-300">
                Connection approved
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">
                {connectedDevice.friendlyName || "Workstation"} is paired
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                The verified device identity is now saved to your account. Start
                the gateway on that computer to bring its agents and
                conversations online.
              </p>

              <div className="mt-7 w-full rounded-2xl border bg-muted/25 p-5 text-left">
                <div className="flex items-center gap-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-background shadow-sm">
                    <PlatformIcon platform={connectedDevice.platform} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">
                      {connectedDevice.friendlyName || "Workstation"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {platformLabel(connectedDevice.platform)} ·{" "}
                      {connectedDevice.id.slice(-10)}
                    </p>
                  </div>
                  <div
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${connectedDevice.online ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}
                  >
                    {connectedDevice.online ? (
                      <Wifi className="h-3.5 w-3.5" />
                    ) : (
                      <CircleDot className="h-3.5 w-3.5" />
                    )}
                    {connectedDevice.online ? "Online" : "Waiting for gateway"}
                  </div>
                </div>
              </div>

              {!connectedDevice.online && (
                <div className="mt-4 w-full rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4 text-left text-xs leading-5 text-muted-foreground">
                  Return to the computer terminal and run the gateway command
                  shown there. This page checks automatically and will change to{" "}
                  <strong className="text-foreground">Online</strong>.
                </div>
              )}

              <div className="mt-7 grid w-full gap-3 sm:grid-cols-2">
                <Button
                  variant="outline"
                  asChild
                  size="lg"
                  className="h-12 rounded-xl"
                >
                  <Link href="/devices">View connected machines</Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  className="h-12 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
                >
                  <Link href="/integrations">
                    Connect coding tools <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
              <button
                onClick={() => {
                  setStep(1);
                  setPairing(null);
                  setConnectedDevice(null);
                  setFriendlyName("");
                  setCode("");
                }}
                className="mt-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Pair another computer
              </button>
            </motion.section>
          )}
        </main>
      </div>
    </div>
  );
}
