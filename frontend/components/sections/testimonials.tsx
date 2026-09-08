"use client"

import { Star, GitFork, Users } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const quotes = [
  {
    quote: "Finally I can leave my agent working while I go to lunch. The approval gates give me peace of mind.",
    author: "@dev_sarah",
  },
  {
    quote: "The secret redaction is a game changer. I don't have to worry about API keys leaking.",
    author: "@eng_mike",
  },
]

const stats = [
  { icon: Star, value: "4.9/5", label: "on GitHub" },
  { icon: GitFork, value: "2.5k+", label: "Stars" },
  { icon: Users, value: "500+", label: "Users" },
]

export function Testimonials() {
  return (
    <section className="relative px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading eyebrow="Social Proof" title="What developers say" />

        <div className="mb-12 grid gap-6 md:grid-cols-2">
          {quotes.map((q, i) => (
            <Reveal
              key={q.author}
              delay={i * 120}
              from={i % 2 === 0 ? "left" : "right"}
              className="rounded-2xl border border-border bg-card/60 p-8 backdrop-blur-sm"
            >
              <div className="mb-4 flex gap-1 text-accent">
                {Array.from({ length: 5 }).map((_, s) => (
                  <Star key={s} className="h-4 w-4 fill-current" aria-hidden="true" />
                ))}
              </div>
              <p className="mb-6 text-pretty text-lg font-light leading-relaxed text-foreground/90">
                {`"${q.quote}"`}
              </p>
              <p className="font-mono text-sm text-primary">{q.author}</p>
            </Reveal>
          ))}
        </div>

        <Reveal className="flex flex-wrap items-center justify-center gap-8 rounded-2xl border border-border bg-card/40 px-8 py-6 backdrop-blur-sm sm:gap-14">
          {stats.map((s) => (
            <div key={s.label} className="flex items-center gap-3">
              <s.icon className="h-5 w-5 text-accent" aria-hidden="true" />
              <div>
                <p className="font-sans text-xl font-light text-foreground">{s.value}</p>
                <p className="font-mono text-xs text-foreground/55">{s.label}</p>
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  )
}
