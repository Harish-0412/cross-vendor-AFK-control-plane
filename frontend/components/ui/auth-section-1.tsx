"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "@/lib/auth";
import { toast } from "sonner";
import { Loader2, AlertCircle } from "lucide-react";

const GrainGradient = dynamic(
  () => import("@paper-design/shaders-react").then((mod) => mod.GrainGradient),
  {
    ssr: false,
    loading: () => <div className="absolute inset-0 bg-[#0a0a0a]" />,
  },
);

const termsText = (
  <>
    By creating an account, you agree to our{" "}
    <a
      href="#"
      className="font-medium text-foreground/70 underline underline-offset-2 hover:text-foreground"
    >
      Terms of Service
    </a>{" "}
    and{" "}
    <a
      href="#"
      className="font-medium text-foreground/70 underline underline-offset-2 hover:text-foreground"
    >
      Privacy Policy
    </a>
  </>
);

interface AuthSectionOneProps {
  mode?: "signup" | "signin";
}

export default function AuthSectionOne({ mode = "signup" }: AuthSectionOneProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectParam = searchParams?.get('redirect') || null;
  const redirectTarget = redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('/login') && !redirectParam.startsWith('/register')
    ? redirectParam
    : '/dashboard';

  const { login, loginWithGoogle, register, clearError } = useAuthStore();

  const isSignup = mode === "signup";

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleGoogleAuth = async () => {
    clearError();
    setFormError(null);
    setSubmitting(true);
    try {
      await loginWithGoogle();
      toast.success("Successfully authenticated with Google");
      router.push(redirectTarget);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Google authentication failed";
      setFormError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setFormError(null);

    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();

    if (!trimmedEmail || !trimmedPassword) {
      setFormError("Please enter your email and password");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      setFormError("Please enter a valid email address");
      return;
    }

    if (isSignup && trimmedPassword.length < 6) {
      setFormError("Password must be at least 6 characters long");
      return;
    }

    setSubmitting(true);

    try {
      if (isSignup) {
        const fullName = `${firstName.trim()} ${lastName.trim()}`.trim() || undefined;
        await register(trimmedEmail, trimmedPassword, fullName);
        toast.success("Account created successfully!");
        router.push(redirectTarget);
      } else {
        await login(trimmedEmail, trimmedPassword);
        toast.success("Successfully logged in");
        router.push(redirectTarget);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      setFormError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="min-h-screen bg-background p-3 text-foreground antialiased [font-synthesis:none]">
      <div className="grid min-h-[calc(100vh-1.5rem)] gap-6 lg:grid-cols-[0.94fr_1.06fr]">
        {/* Left Side: Auth Form */}
        <div className="flex min-h-[640px] items-center justify-center rounded-xl border border-border bg-card px-6 py-10 sm:px-10 lg:min-h-0 lg:px-12 xl:px-16">
          <div className="mx-auto w-full max-w-[420px]">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                {isSignup ? "Create an account" : "Welcome back"}
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {isSignup
                  ? "Create your control plane account to supervise agents from anywhere"
                  : "Control your remote agents anywhere"}
              </p>
            </div>

            <div className="mt-6 grid gap-3">
              <SocialButton
                icon={<GoogleIcon />}
                label={isSignup ? "Sign up with Google" : "Sign in with Google"}
                onClick={handleGoogleAuth}
                disabled={submitting}
              />
            </div>

            <div className="relative my-6 text-center text-xs uppercase tracking-widest text-muted-foreground">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <span className="relative bg-card px-3 text-muted-foreground">or</span>
            </div>

            {formError && (
              <div className="mb-4 flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3.5">
              {isSignup && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldBox
                    label="First Name"
                    value={firstName}
                    onChange={setFirstName}
                    placeholder="First name"
                  />
                  <FieldBox
                    label="Last Name"
                    value={lastName}
                    onChange={setLastName}
                    placeholder="Last name"
                  />
                </div>
              )}

              <FieldBox
                label="Email"
                value={email}
                onChange={setEmail}
                type="email"
                placeholder="name@example.com"
              />
              <FieldBox
                label="Password"
                value={password}
                onChange={setPassword}
                type="password"
                placeholder="••••••••"
              />

              {isSignup && (
                <div className="space-y-2.5 pt-1 text-xs text-muted-foreground">
                  <CheckboxLine>
                    I don&apos;t want to receive product update emails
                  </CheckboxLine>
                  <CheckboxLine>{termsText}</CheckboxLine>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold transition-all hover:bg-primary/90 disabled:opacity-50 cursor-pointer shadow-sm"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {isSignup ? "Creating account..." : "Signing in..."}
                  </>
                ) : (
                  isSignup ? "Create account" : "Sign in"
                )}
              </button>
            </form>

            <div className="mt-6 text-center text-xs sm:text-sm text-muted-foreground">
              {isSignup ? (
                <>
                  Already have an account?{" "}
                  <Link
                    href={redirectParam ? `/login?redirect=${encodeURIComponent(redirectParam)}` : "/login"}
                    className="font-medium text-foreground underline underline-offset-2 hover:text-primary transition-colors"
                  >
                    Sign in
                  </Link>
                </>
              ) : (
                <>
                  Don&apos;t have an account?{" "}
                  <Link
                    href={redirectParam ? `/register?redirect=${encodeURIComponent(redirectParam)}` : "/register"}
                    className="font-medium text-foreground underline underline-offset-2 hover:text-primary transition-colors"
                  >
                    Create an account
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Side: Animated Canvas & Tagline */}
        <div className="relative flex min-h-[500px] lg:min-h-0 overflow-hidden rounded-xl bg-black p-8 sm:p-12 text-white shadow-sm">
          <GrainGradient
            speed={1}
            scale={1}
            rotation={0}
            offsetX={0}
            offsetY={0}
            softness={0.5}
            intensity={0.5}
            noise={0.25}
            shape="corners"
            frame={2854.5}
            colors={["#FFFFFF", "#FC7819", "#FC7819", "#FFFFFF"]}
            colorBack="#00000000"
            className="absolute inset-0 bg-black"
          />

          <div className="relative z-10 flex h-full w-full flex-col justify-between">
            <div className="pt-4 sm:pt-8">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur-md">
                Vendor-Neutral AFK Control Plane
              </span>
              <h2 className="mt-6 max-w-[500px] text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-[-0.04em] text-white leading-[1.05]">
                Go AFK.
                <br />
                Your agents keep building
              </h2>
              <p className="mt-4 max-w-[420px] text-sm sm:text-base text-white/70 leading-relaxed">
                Supervise, review, and steer your autonomous AI coding agents across all your machines from anywhere.
              </p>
            </div>

            <div className="text-xs text-white/50 pb-2">
              FreeBuff AFK Control Plane v0.1.0
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SocialButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function FieldBox({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange?: (val: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5 text-left">
      <label className="text-xs font-medium text-foreground/80 cursor-pointer">
        {label}
      </label>
      <div className="flex h-11 items-center rounded-lg border border-input bg-background px-3.5 shadow-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder || `Enter ${label.toLowerCase()}`}
          className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </div>
    </div>
  );
}

function CheckboxLine({ children }: { children: ReactNode }) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer select-none">
      <span className="relative mt-0.5 size-4 shrink-0">
        <input
          type="checkbox"
          className="peer size-full appearance-none rounded-[4px] border border-input bg-background checked:border-primary checked:bg-primary"
        />
        <svg
          viewBox="0 0 12 12"
          className="pointer-events-none absolute inset-0 hidden size-full p-0.5 text-primary-foreground peer-checked:block"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 6.2 5 8.1 9 3.9"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="leading-snug">{children}</span>
    </label>
  );
}

function GoogleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
        fill="#EB4335"
      />
    </svg>
  );
}


