"use client"

import { Bot, Check, X, ShieldAlert } from "lucide-react"

const logLines = [
  { text: "Reading src/auth/session.ts", tone: "muted" },
  { text: "Refactoring token validation", tone: "muted" },
  { text: "+ 42 lines  − 18 lines", tone: "success" },
  { text: "Running test suite (24 passed)", tone: "success" },
  { text: "Requesting: git push origin main", tone: "warn" },
]

export function AgentPhone() {
  return (
    <div className="relative w-[280px] select-none sm:w-[300px]">
      {/* glow */}
      <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-primary/20 blur-3xl" />

      <div className="rounded-[2.5rem] border border-foreground/15 bg-card/80 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <div className="overflow-hidden rounded-[2rem] border border-border bg-background">
          {/* status bar */}
          <div className="flex items-center justify-between px-5 py-3 font-mono text-[10px] text-foreground/60">
            <span>9:41</span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> Live
            </span>
          </div>

          {/* session header */}
          <div className="flex items-center gap-3 border-b border-border px-5 py-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Bot className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-sans text-sm font-medium text-foreground">OpenCode Agent</p>
              <p className="truncate font-mono text-[10px] text-foreground/50">workstation-01 · session #A3F</p>
            </div>
          </div>

          {/* log stream */}
          <div className="space-y-2 px-5 py-4">
            {logLines.map((line, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-foreground/30" />
                <p
                  className={`font-mono text-[11px] leading-relaxed ${
                    line.tone === "success"
                      ? "text-success"
                      : line.tone === "warn"
                        ? "text-accent"
                        : "text-foreground/60"
                  }`}
                >
                  {line.text}
                </p>
              </div>
            ))}
          </div>

          {/* approval gate */}
          <div className="mx-4 mb-4 rounded-xl border border-accent/40 bg-accent/10 p-3">
            <div className="mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-accent" />
              <p className="font-sans text-xs font-medium text-foreground">Approval required</p>
            </div>
            <p className="mb-3 font-mono text-[10px] leading-relaxed text-foreground/60">
              Agent wants to push to a protected branch.
            </p>
            <div className="flex gap-2">
              <button className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-success py-2 font-sans text-xs font-medium text-success-foreground">
                <Check className="h-3.5 w-3.5" /> Approve
              </button>
              <button className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-secondary py-2 font-sans text-xs font-medium text-foreground">
                <X className="h-3.5 w-3.5" /> Deny
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
