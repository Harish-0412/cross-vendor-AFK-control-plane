"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, ArrowRight, ShieldCheck, KeySquare, Loader2, AlertCircle } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { apiClient, ApiError } from "@/lib/api-client";

interface PairingSessionResponse {
  pairingId: string;
  deviceId: string;
  gatewayId: string;
  fingerprintHex: string;
  fingerprintWords: string[];
  status: string;
}

export default function PairDevicePage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [code, setCode] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingData, setPairingData] = useState<PairingSessionResponse | null>(null);

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) return;

    setIsVerifying(true);
    setError(null);

    try {
      const data = await apiClient.post<PairingSessionResponse>("/api/v1/devices/pair", {
        code: cleanCode,
      });
      setPairingData(data);
      setStep(2);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Invalid or expired pairing code";
      setError(msg);
      toast.error(msg);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleConfirmPair = async () => {
    if (!pairingData) return;
    setIsVerifying(true);
    setError(null);

    try {
      await apiClient.post("/api/v1/devices/confirm", {
        pairingId: pairingData.pairingId,
        confirmed: true,
        friendlyName: friendlyName.trim() || undefined,
      });

      toast.success("Device paired successfully!");
      router.push("/devices");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to confirm pairing";
      setError(msg);
      toast.error(msg);
      setIsVerifying(false);
    }
  };

  const handleRejectPair = async () => {
    if (!pairingData) return;
    try {
      await apiClient.post("/api/v1/devices/confirm", {
        pairingId: pairingData.pairingId,
        confirmed: false,
      });
    } catch {
      /* ignore */
    }
    setStep(1);
    setPairingData(null);
    toast.info("Pairing was rejected");
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto min-h-[70vh] justify-center">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex items-center gap-4"
      >
        <Link href="/devices">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Pair Gateway Machine</h1>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden relative"
      >
        {/* Progress indicator */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-accent">
          <div
            className="h-full bg-primary transition-all duration-500 ease-in-out"
            style={{ width: step === 1 ? "50%" : "100%" }}
          />
        </div>

        <div className="p-6 md:p-10">
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive mb-6">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === 1 ? (
            <div className="flex flex-col items-center text-center space-y-6 animate-in fade-in duration-300">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <KeySquare className="h-8 w-8" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold">Enter Pairing Code</h2>
                <p className="text-sm text-muted-foreground max-w-md">
                  Run <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">freebuff pair</code> in your gateway terminal and enter the pairing code shown.
                </p>
              </div>

              <form onSubmit={handleVerifyCode} className="w-full max-w-sm flex flex-col items-center gap-4">
                <div className="w-full space-y-2 text-left">
                  <Label htmlFor="code-input" className="text-xs font-semibold">
                    Pairing Code
                  </Label>
                  <Input
                    id="code-input"
                    type="text"
                    placeholder="e.g. T55Q-Y3D2"
                    className="text-center font-mono tracking-widest text-lg uppercase"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    required
                    autoFocus
                  />
                </div>

                <Button
                  type="submit"
                  size="lg"
                  className="w-full gap-2 mt-2"
                  disabled={!code.trim() || isVerifying}
                >
                  {isVerifying ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Verifying Code...
                    </>
                  ) : (
                    <>
                      Verify Code <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>
            </div>
          ) : (
            <div className="flex flex-col items-center text-center space-y-6 animate-in fade-in duration-300">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500">
                <ShieldCheck className="h-8 w-8" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold">Verify Security Fingerprint</h2>
                <p className="text-sm text-muted-foreground max-w-md">
                  Confirm the safety fingerprint words below match those displayed in your gateway terminal.
                </p>
              </div>

              {pairingData && (
                <div className="w-full max-w-md rounded-xl border border-border bg-muted/40 p-5 space-y-3">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                    Security Words
                  </span>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 text-xs font-mono font-medium text-foreground">
                    {pairingData.fingerprintWords.map((word, i) => (
                      <div key={i} className="rounded bg-card py-1.5 px-2 border border-border/50 text-center">
                        {word}
                      </div>
                    ))}
                  </div>
                  <div className="pt-2 text-left">
                    <span className="text-[10px] text-muted-foreground font-mono break-all">
                      SHA256: {pairingData.fingerprintHex}
                    </span>
                  </div>
                </div>
              )}

              <div className="w-full max-w-md space-y-2 text-left">
                <Label htmlFor="friendly-name" className="text-xs font-semibold">
                  Device Name (Optional)
                </Label>
                <Input
                  id="friendly-name"
                  type="text"
                  placeholder="e.g. Workstation Laptop, Home Server"
                  value={friendlyName}
                  onChange={(e) => setFriendlyName(e.target.value)}
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
                <Button
                  variant="outline"
                  size="lg"
                  className="flex-1"
                  onClick={handleRejectPair}
                  disabled={isVerifying}
                >
                  They don&apos;t match
                </Button>
                <Button
                  size="lg"
                  className="flex-1 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={handleConfirmPair}
                  disabled={isVerifying}
                >
                  {isVerifying ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Pairing...
                    </>
                  ) : (
                    "Confirm & Pair"
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
