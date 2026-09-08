"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setAuthCookie } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from "@/components/ui/input-otp";

export default function MFAPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length < 6) return;
    
    setLoading(true);

    // Mock MFA verification
    setTimeout(() => {
      setLoading(false);
      setAuthCookie("mock-token-from-mfa");
      toast.success("Verification successful!");
      router.push("/dashboard");
    }, 1000);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center space-y-2 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 mb-2">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Two-Factor Authentication</h1>
          <p className="text-sm text-foreground/60 max-w-xs">
            Enter the 6-digit code from your authenticator app to continue.
          </p>
        </div>

        <form onSubmit={handleVerify} className="space-y-8 flex flex-col items-center">
          <InputOTP maxLength={6} value={code} onChange={setCode}>
            <InputOTPGroup>
              <InputOTPSlot index={0} className="h-12 w-10 sm:w-12 sm:h-14 text-lg" />
              <InputOTPSlot index={1} className="h-12 w-10 sm:w-12 sm:h-14 text-lg" />
              <InputOTPSlot index={2} className="h-12 w-10 sm:w-12 sm:h-14 text-lg" />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={3} className="h-12 w-10 sm:w-12 sm:h-14 text-lg" />
              <InputOTPSlot index={4} className="h-12 w-10 sm:w-12 sm:h-14 text-lg" />
              <InputOTPSlot index={5} className="h-12 w-10 sm:w-12 sm:h-14 text-lg" />
            </InputOTPGroup>
          </InputOTP>

          <Button type="submit" className="w-full" disabled={loading || code.length < 6}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Verify Code"}
          </Button>
        </form>
      </div>
    </div>
  );
}
