"use client"

import { ShieldCheck, Smartphone, Zap, CircleCheck, KeyRound, RefreshCw, ScrollText, Boxes } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const features = [
  {
    icon: ShieldCheck,
    title: "Secure Sandboxing",
    copy: "Agents run in isolated containers with strict filesystem and network boundaries.",
  },
  {
    icon: Smartphone,
    title: "Mobile Supervision",
    copy: "Monitor and control agents from your phone or any browser — no app install needed.",
  },
  {
    icon: Zap,
    title: "Real-time Events",
    copy: "Watch every action as it happens with live streaming output.",
  },
  {
    icon: CircleCheck,
    title: "Approval Gates",
    copy: "Sensitive operations require your explicit approval before they execute.",
  },
  {
    icon: KeyRound,
    title: "Secret Redaction",
    copy: "API keys, passwords, and secrets are automatically stripped before leaving your machine.",
  },
  {
    icon: RefreshCw,
    title: "Auto-Recovery",
    copy: "Connection drops? The gateway auto-reconnects and resumes exactly where it left off.",
  },
  {
    icon: ScrollText,
    title: "Audit Trail",
    copy: "Every action is logged with a tamper-evident, hash-chained audit record.",
  },
  {
    icon: Boxes,
    title: "Multi-Agent Support",
    copy: "Works with OpenCode, Antigravity, Claude, and more — vendor neutral by design.",
  },
]

export function Features() {
  return (
    <section id="features" className="relative scroll-mt-24 px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Features"
          title="Everything you need to supervise from afar"
          description="Purpose-built controls that keep you in the loop while your agent does the heavy lifting."
        />

        <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => (
            <Reveal
              key={f.title}
              delay={(i % 4) * 80}
              className="group bg-card/70 p-7 backdrop-blur-sm transition-colors hover:bg-card"
            >
              <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/12 text-primary transition-transform duration-300 group-hover:-translate-y-1">
                <f.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mb-2 font-sans text-lg font-medium text-foreground">{f.title}</h3>
              <p className="text-sm leading-relaxed text-foreground/65">{f.copy}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
