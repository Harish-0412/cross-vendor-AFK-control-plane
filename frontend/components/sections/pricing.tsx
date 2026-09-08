"use client"

import { Check } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"
import { MagneticButton } from "@/components/magnetic-button"

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    highlight: false,
    cta: "Start Free",
    features: ["1 machine", "1 agent", "Basic supervision", "Community support"],
  },
  {
    name: "Pro",
    price: "$19",
    period: "/month per seat",
    highlight: true,
    cta: "Start Pro Trial",
    features: ["5 machines", "3 agents", "AFK mode", "Priority support", "Audit export"],
  },
  {
    name: "Team",
    price: "$49",
    period: "/month per seat",
    highlight: false,
    cta: "Contact Sales",
    features: ["Unlimited machines", "10 agents", "Team management", "SSO / SCIM", "Dedicated support", "Custom policies"],
  },
]

export function Pricing() {
  return (
    <section id="pricing" className="relative scroll-mt-24 px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Pricing"
          title="Simple pricing that scales with you"
          description="Open source — self-host for free, forever. Paid plans add managed cloud features."
        />

        <div className="grid gap-6 md:grid-cols-3">
          {plans.map((plan, i) => (
            <Reveal
              key={plan.name}
              delay={i * 120}
              className={`relative flex flex-col rounded-2xl border p-8 backdrop-blur-sm ${
                plan.highlight
                  ? "border-primary bg-primary/10 shadow-xl shadow-primary/10"
                  : "border-border bg-card/60"
              }`}
            >
              {plan.highlight && (
                <span className="absolute -top-3 left-8 rounded-full bg-primary px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-primary-foreground">
                  Most Popular
                </span>
              )}
              <h3 className="mb-4 font-sans text-lg font-medium text-foreground">{plan.name}</h3>
              <div className="mb-6 flex items-baseline gap-1">
                <span className="font-sans text-5xl font-light tracking-tight text-foreground">{plan.price}</span>
                <span className="font-mono text-xs text-foreground/50">{plan.period}</span>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-3 text-sm text-foreground/80">
                    <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                    {f}
                  </li>
                ))}
              </ul>
              <MagneticButton variant={plan.highlight ? "primary" : "secondary"} size="lg" className="w-full">
                {plan.cta}
              </MagneticButton>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-10 text-center">
          <p className="font-mono text-sm text-foreground/60">Open source — self-host for free forever.</p>
        </Reveal>
      </div>
    </section>
  )
}
