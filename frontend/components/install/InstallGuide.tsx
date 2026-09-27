"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  KeyRound,
  Laptop,
  Link2,
  ShieldCheck,
  Terminal,
  UserPlus,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const SITE = "https://cross-vendor-afk-control-plane.vercel.app";
const PACKAGE_URL =
  "https://github.com/Harish-0412/cross-vendor-AFK-control-plane/releases/latest/download/odysseus-gateway.tgz";
const GUIDE_URL =
  "https://github.com/Harish-0412/cross-vendor-AFK-control-plane/blob/main/GETTING_STARTED.md";

type Platform = "windows" | "unix";

const PLATFORMS: Record<
  Platform,
  { label: string; shell: string; prompt: string; command: string; open: string }
> = {
  windows: {
    label: "Windows",
    shell: "PowerShell",
    prompt: "PS>",
    command: `irm ${SITE}/install.ps1 | iex`,
    open: "Press Start, type PowerShell, open it, and paste:",
  },
  unix: {
    label: "macOS & Linux",
    shell: "Terminal",
    prompt: "$",
    command: `curl -fsSL ${SITE}/install.sh | sh`,
    open: "Open Terminal and paste:",
  },
};

const INSTALLER_DOES = [
  "Checks for Node.js 20+, and offers to install it if it is missing",
  "Installs the latest Odysseus gateway — the odysseus command",
  "Makes the command work in PowerShell without changing security settings",
  "Offers to pair this computer with your account straight away",
];

const TROUBLESHOOTING: Array<{ q: string; a: React.ReactNode }> = [
  {
    q: "npm login fails with “403 Forbidden” (GitHub Packages)",
    a: (
      <>
        You don&apos;t need GitHub Packages or a GitHub login. Use the one-line installer
        above — it downloads the public release directly.
      </>
    ),
  },
  {
    q: "“Running scripts is disabled on this system”",
    a: (
      <>
        Run the installer above again — it fixes the <Code>odysseus</Code> command for
        PowerShell. Or type <Code>odysseus.cmd</Code> instead of <Code>odysseus</Code>.
      </>
    ),
  },
  {
    q: "“odysseus is not recognised as a command”",
    a: <>Close the terminal and open a new one, so it picks up the new command.</>,
  },
  {
    q: "The gateway says the server did not answer in time",
    a: (
      <>
        The Odysseus server sleeps when idle and takes up to a minute to wake. Leave the
        gateway running — it retries on its own.
      </>
    ),
  },
  {
    q: "“Permission denied” or EACCES on macOS / Linux",
    a: (
      <>
        No need for <Code>sudo</Code>. The installer puts Odysseus in your own folder
        (<Code>~/.odysseus/npm</Code>) when npm&apos;s global folder is locked.
      </>
    ),
  },
];

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md border bg-muted/60 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
}

function CommandBlock({
  command,
  prompt = "$",
  large = false,
}: {
  command: string;
  prompt?: string;
  large?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Copied — paste it into your terminal");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy. Select the command and copy it manually.");
    }
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border border-white/10 bg-[#0b0d14] text-[#e8e6f0] shadow-inner",
        large ? "px-4 py-3.5" : "px-3.5 py-2.5",
      )}
    >
      <span className="select-none font-mono text-xs text-violet-300/70">{prompt}</span>
      <code
        className={cn(
          "min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono no-scrollbar",
          large ? "text-sm sm:text-[15px]" : "text-[13px]",
        )}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        aria-label={copied ? "Copied" : `Copy: ${command}`}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white shadow-md">
      {n}
    </span>
  );
}

export function InstallGuide() {
  const [platform, setPlatform] = useState<Platform>("windows");

  useEffect(() => {
    const agent = navigator.userAgent;
    if (!/Windows/i.test(agent) && /(Mac|Linux|X11)/i.test(agent)) setPlatform("unix");
  }, []);

  return (
    <div className="app-canvas min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header className="glass sticky top-0 z-30 border-b border-border/60">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Odysseus home">
            <span className="relative flex h-9 w-9 overflow-hidden rounded-xl shadow-md ring-1 ring-white/10">
              <Image src="/ares.png" alt="" width={36} height={36} priority />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">Odysseus</span>
            <span className="rounded-md bg-brand-gradient px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-white">
              AFK
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm" className="bg-brand-gradient text-white hover:opacity-90">
              <Link href="/register">Create account</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-20">
        {/* Hero */}
        <section className="relative overflow-clip pb-10 pt-14 text-center sm:pt-20">
          <div className="aurora opacity-60" aria-hidden />
          <div className="relative">
            <span className="inline-flex items-center gap-2 rounded-full border bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              <Terminal className="h-3.5 w-3.5 text-primary" /> Odysseus Gateway · one-line install
            </span>
            <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
              Connect your computer to <span className="text-gradient">Odysseus</span>
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
              One command installs the gateway that links your computer to your dashboard.
              No GitHub account, no access tokens, no admin rights.
            </p>
          </div>
        </section>

        {/* Steps */}
        <ol className="relative space-y-6">
          {/* 1 — account */}
          <li className="surface p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <StepNumber n={1} />
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <UserPlus className="h-4 w-4 text-primary" /> Create your account
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sign up with Google or an email address. This is the dashboard you&apos;ll
                  use from your phone.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button asChild size="sm" className="bg-brand-gradient text-white hover:opacity-90">
                    <Link href="/register">
                      Create account <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/login">I already have one</Link>
                  </Button>
                </div>
              </div>
            </div>
          </li>

          {/* 2 — install */}
          <li className="surface gradient-border p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <StepNumber n={2} />
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <Laptop className="h-4 w-4 text-primary" /> Install the gateway
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  On the computer where your AI coding agents run.
                </p>

                <Tabs
                  value={platform}
                  onValueChange={(value) => setPlatform(value as Platform)}
                  className="mt-4"
                >
                  <TabsList>
                    {(Object.keys(PLATFORMS) as Platform[]).map((key) => (
                      <TabsTrigger key={key} value={key}>
                        {PLATFORMS[key].label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {(Object.keys(PLATFORMS) as Platform[]).map((key) => (
                    <TabsContent key={key} value={key} className="mt-4 space-y-3">
                      <p className="text-sm text-muted-foreground">{PLATFORMS[key].open}</p>
                      <CommandBlock command={PLATFORMS[key].command} prompt={PLATFORMS[key].prompt} large />
                      {key === "windows" && (
                        <p className="text-xs text-muted-foreground">
                          Use <strong className="text-foreground">PowerShell</strong>, not Command
                          Prompt. No administrator window needed.
                        </p>
                      )}
                    </TabsContent>
                  ))}
                </Tabs>

                <ul className="mt-5 grid gap-2 sm:grid-cols-2">
                  {INSTALLER_DOES.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <details className="group mt-5 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
                  <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                    Prefer to install with npm yourself?
                    <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="mt-3 space-y-2">
                    <p className="text-muted-foreground">
                      Needs Node.js 20 or newer. On Windows, run it in Command Prompt, or use{" "}
                      <Code>npm.cmd</Code> in PowerShell.
                    </p>
                    <CommandBlock command={`npm install --global ${PACKAGE_URL}`} />
                  </div>
                </details>
              </div>
            </div>
          </li>

          {/* 3 — pair */}
          <li className="surface p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <StepNumber n={3} />
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <Link2 className="h-4 w-4 text-primary" /> Pair this computer
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  The installer offers to do this for you. To do it later, run:
                </p>
                <div className="mt-3">
                  <CommandBlock command="odysseus pair" />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  Open the link it shows, then check that the{" "}
                  <strong className="text-foreground">ten security words</strong> match on
                  both screens before approving. That proves the dashboard is talking to
                  your computer.
                </p>
              </div>
            </div>
          </li>

          {/* 4 — online */}
          <li className="surface p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <StepNumber n={4} />
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <Wifi className="h-4 w-4 text-primary" /> Go online
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  In the folder of the project your agents should work on:
                </p>
                <div className="mt-3">
                  <CommandBlock command="odysseus gateway" />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  When it shows <span className="font-medium text-emerald-500">● Online</span>,
                  your computer appears in the dashboard. Leave the window open — closing it
                  takes the computer offline. Run it again after a restart; no need to pair
                  again.
                </p>
              </div>
            </div>
          </li>
        </ol>

        {/* Requirements & trust */}
        <section className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: Cpu,
              title: "What you need",
              body: "Windows 10/11, macOS or Linux, and Node.js 20+. The installer can set up Node.js for you.",
            },
            {
              icon: Terminal,
              title: "An AI coding agent",
              body: "Codex, Claude Code or OpenCode, installed and signed in. Odysseus finds them automatically.",
            },
            {
              icon: ShieldCheck,
              title: "Your code stays home",
              body: "The gateway only dials out. No open ports, and your keys and agent logins never leave your computer.",
            },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="surface p-5">
              <Icon className="h-5 w-5 text-primary" />
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>

        {/* Troubleshooting */}
        <section className="mt-12">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound className="h-5 w-5 text-primary" /> If something goes wrong
          </h2>
          <div className="mt-4 divide-y rounded-2xl border bg-card">
            {TROUBLESHOOTING.map(({ q, a }) => (
              <details key={q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium">
                  {q}
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{a}</p>
              </details>
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Full walkthrough, every command and how to uninstall:{" "}
            <a
              href={GUIDE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Getting started guide
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}
