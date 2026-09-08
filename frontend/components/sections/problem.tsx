"use client"

import { X, AlertTriangle } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const cannot = [
  "Leave your desk for a meeting",
  "Go home for the day",
  "Sleep while it works overnight",
  "Trust it won't do something dangerous",
]

const risks = [
  "Delete critical files",
  "Push code you didn't review",
  "Access secrets it shouldn't",
  "Get stuck and waste compute",
]

export function Problem() {
  return (
    <section className="relative px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="The Problem"
          title="Powerful agents. No way to watch them."
          description="You're running an AI coding agent on your workstation. But the moment you step away, you lose all visibility and control."
        />

        <div className="grid gap-6 md:grid-cols-2">
          <Reveal from="left" className="rounded-2xl border border-border bg-card/60 p-8 backdrop-blur-sm">
            <p className="mb-6 font-mono text-xs uppercase tracking-[0.2em] text-foreground/50">You need to</p>
            <ul className="space-y-4">
              {cannot.map((item) => (
                <li key={item} className="flex items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground/60">
                    <X className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-sm text-foreground/80 md:text-base">{item}</span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal
            from="right"
            delay={100}
            className="rounded-2xl border border-accent/30 bg-accent/5 p-8 backdrop-blur-sm"
          >
            <p className="mb-6 font-mono text-xs uppercase tracking-[0.2em] text-accent">Meanwhile the agent might</p>
            <ul className="space-y-4">
              {risks.map((item) => (
                <li key={item} className="flex items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-sm text-foreground/80 md:text-base">{item}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
