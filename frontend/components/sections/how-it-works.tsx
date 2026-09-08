"use client"

import { MonitorDown, QrCode, Smartphone, ArrowRight } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const steps = [
  {
    icon: MonitorDown,
    step: "Step 1",
    title: "Install Gateway",
    copy: "Install the lightweight Gateway on your workstation.",
    time: "~2 minutes",
  },
  {
    icon: QrCode,
    step: "Step 2",
    title: "Pair Device",
    copy: "Connect your phone or tablet with a simple QR code scan.",
    time: "~30 seconds",
  },
  {
    icon: Smartphone,
    step: "Step 3",
    title: "Control AFK",
    copy: "Start a task, walk away, and supervise from anywhere.",
    time: "Forever",
  },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative scroll-mt-24 px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="How It Works"
          title="Up and running in under three minutes"
          description="No inbound ports, no complex setup. Install, pair, and go."
        />

        <div className="grid items-stretch gap-6 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {steps.map((s, i) => (
            <div key={s.title} className="contents">
              <Reveal
                delay={i * 150}
                className="group flex flex-col rounded-2xl border border-border bg-card/60 p-8 backdrop-blur-sm transition-colors hover:border-primary/40"
              >
                <div className="mb-5 flex items-center justify-between">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary transition-transform duration-300 group-hover:scale-110">
                    <s.icon className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <span className="font-mono text-xs uppercase tracking-[0.2em] text-foreground/40">{s.step}</span>
                </div>
                <h3 className="mb-2 font-sans text-xl font-medium text-foreground">{s.title}</h3>
                <p className="mb-6 flex-1 text-sm leading-relaxed text-foreground/65">{s.copy}</p>
                <span className="font-mono text-xs text-success">{s.time}</span>
              </Reveal>

              {i < steps.length - 1 && (
                <div className="hidden items-center justify-center text-foreground/25 md:flex">
                  <ArrowRight className="h-6 w-6" aria-hidden="true" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
