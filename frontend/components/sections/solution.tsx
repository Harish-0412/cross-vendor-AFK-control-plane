"use client"

import { Lock, Smartphone, Bot } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const pillars = [
  {
    icon: Lock,
    title: "Safe",
    copy: "Sandboxed execution with strict filesystem and network boundaries.",
  },
  {
    icon: Smartphone,
    title: "Remote",
    copy: "Full supervision and control from any device — no app install needed.",
  },
  {
    icon: Bot,
    title: "AFK",
    copy: "Set a trust policy, walk away, and let the agent work on its own.",
  },
]

export function Solution() {
  return (
    <section className="relative px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="The SmartConnect Solution"
          title="A control plane between you and your agent"
          description="A secure layer that gives you full supervision of your AI agent — without being tied to your desk."
        />

        <div className="grid gap-6 md:grid-cols-3">
          {pillars.map((p, i) => (
            <Reveal
              key={p.title}
              delay={i * 120}
              from="bottom"
              className="group rounded-2xl border border-border bg-card/60 p-8 backdrop-blur-sm transition-colors hover:border-primary/40"
            >
              <span className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary transition-transform duration-300 group-hover:scale-110">
                <p.icon className="h-6 w-6" aria-hidden="true" />
              </span>
              <h3 className="mb-2 font-sans text-2xl font-light text-foreground">{p.title}</h3>
              <p className="text-sm leading-relaxed text-foreground/70 md:text-base">{p.copy}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
