"use client"

import { Check, FileText, ClipboardList } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { MagneticButton } from "@/components/magnetic-button"

const guarantees = [
  { title: "Local-first execution", copy: "Agents run on YOUR machine, in YOUR sandbox." },
  { title: "Outbound-only connections", copy: "The gateway never opens inbound ports." },
  { title: "Secret redaction", copy: "API keys are stripped before any data leaves." },
  { title: "Hash-chained audit", copy: "Tamper-evident logs of every action." },
  { title: "Device revocation", copy: "Instantly revoke any paired device." },
  { title: "Open source", copy: "Audit the code yourself. MIT licensed." },
]

export function Security() {
  return (
    <section className="relative px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          <Reveal from="left" className="lg:sticky lg:top-28 lg:self-start">
            <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-primary">Security First</p>
            <h2 className="mb-4 text-balance font-sans text-4xl font-light leading-[1.1] tracking-tight text-foreground md:text-5xl">
              Your code never leaves your machine.
            </h2>
            <p className="mb-8 text-pretty text-base leading-relaxed text-foreground/70 md:text-lg">
              Only control signals and redacted event summaries ever travel to the cloud. Everything else stays local.
            </p>
            <div className="flex flex-wrap gap-3">
              <MagneticButton variant="secondary" size="default" className="inline-flex items-center gap-2">
                <FileText className="h-4 w-4" aria-hidden="true" />
                Security Whitepaper
              </MagneticButton>
              <MagneticButton variant="ghost" size="default" className="inline-flex items-center gap-2">
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
                Audit Reports
              </MagneticButton>
            </div>
          </Reveal>

          <div className="grid gap-4 sm:grid-cols-2">
            {guarantees.map((g, i) => (
              <Reveal
                key={g.title}
                delay={(i % 2) * 90}
                className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-sm"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/15 text-success">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <h3 className="font-sans text-base font-medium text-foreground">{g.title}</h3>
                </div>
                <p className="text-sm leading-relaxed text-foreground/65">{g.copy}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
