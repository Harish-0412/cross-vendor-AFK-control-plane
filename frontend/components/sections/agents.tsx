"use client"

import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const agents = [
  { name: "OpenCode", status: "Primary", note: "MIT · released · excellent CLI", live: true },
  { name: "Antigravity", status: "Excellent", note: "Apache 2.0 · built-in sandbox", live: true },
  { name: "Claude Code", status: "Coming Soon", note: "Phase 9+ · when GA", live: false },
  { name: "Custom Agents", status: "Adapter SDK", note: "Any CLI · vendor neutral", live: false },
]

const priority = [
  "OpenCode (MIT, released, excellent CLI)",
  "Antigravity (Apache 2.0, built-in sandbox, daemon mode)",
  "Claude Code (when GA)",
  "Custom agents via adapter SDK",
]

export function Agents() {
  return (
    <section className="relative px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Supported Agents"
          title="Works with your favorite coding agents"
          description="Vendor neutral by design — bring the agent you already use."
        />

        <div className="mb-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {agents.map((a, i) => (
            <Reveal
              key={a.name}
              delay={i * 90}
              className="rounded-2xl border border-border bg-card/60 p-6 text-center backdrop-blur-sm"
            >
              <div className="mb-3 flex items-center justify-center gap-2">
                <span className={`h-2 w-2 rounded-full ${a.live ? "bg-success" : "bg-foreground/25"}`} />
                <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-foreground/50">
                  {a.status}
                </span>
              </div>
              <h3 className="mb-1 font-sans text-lg font-medium text-foreground">{a.name}</h3>
              <p className="font-mono text-xs text-foreground/55">{a.note}</p>
            </Reveal>
          ))}
        </div>

        <Reveal className="mx-auto max-w-2xl rounded-2xl border border-border bg-card/40 p-8 backdrop-blur-sm">
          <p className="mb-5 font-mono text-xs uppercase tracking-[0.2em] text-primary">Adapter Priority</p>
          <ol className="space-y-3">
            {priority.map((p, i) => (
              <li key={p} className="flex items-center gap-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border font-mono text-xs text-foreground/70">
                  {i + 1}
                </span>
                <span className="text-sm text-foreground/80">{p}</span>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  )
}
