"use client"

import { Home, Moon, Building2, Lock } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const cases = [
  {
    icon: Home,
    title: "Remote Work",
    copy: "Start a refactoring task at home, monitor from your phone while commuting, review the diff on arrival.",
  },
  {
    icon: Moon,
    title: "Overnight Runs",
    copy: "Let the agent work on tests while you sleep. Get notified only if it needs your approval.",
  },
  {
    icon: Building2,
    title: "Team Lead Supervision",
    copy: "Monitor multiple developer workstations from one dashboard. See what agents are doing across the team.",
  },
  {
    icon: Lock,
    title: "Security-Critical Projects",
    copy: "Mandatory approval gates for any code touching authentication, payments, or infrastructure.",
  },
]

export function UseCases() {
  return (
    <section className="relative px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Use Cases"
          title="Built for the way developers actually work"
        />

        <div className="grid gap-6 md:grid-cols-2">
          {cases.map((c, i) => (
            <Reveal
              key={c.title}
              delay={(i % 2) * 120}
              from={i % 2 === 0 ? "left" : "right"}
              className="group flex gap-5 rounded-2xl border border-border bg-card/60 p-8 backdrop-blur-sm transition-colors hover:border-primary/40"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary transition-transform duration-300 group-hover:scale-110">
                <c.icon className="h-6 w-6" aria-hidden="true" />
              </span>
              <div>
                <h3 className="mb-2 font-sans text-xl font-medium text-foreground">{c.title}</h3>
                <p className="text-sm leading-relaxed text-foreground/65 md:text-base">{c.copy}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
