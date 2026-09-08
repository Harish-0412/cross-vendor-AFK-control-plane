"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"

const faqs = [
  {
    q: "Does my code leave my machine?",
    a: "No. SmartConnect runs entirely locally. Only control signals and redacted event summaries travel to the cloud.",
  },
  {
    q: "What AI agents are supported?",
    a: "OpenCode and Antigravity today, with Claude Code coming soon. We're vendor-neutral — any agent with a CLI can be integrated via our adapter SDK.",
  },
  {
    q: "Is it really free?",
    a: "Yes. The core is open source (MIT). You can self-host forever at $0. Paid plans add managed cloud features.",
  },
  {
    q: "How does AFK mode work?",
    a: 'Set a trust profile (e.g. "allow file edits, require approval for git push"). The agent follows the policy, and you get notified only for actions that need you.',
  },
  {
    q: "What about security?",
    a: "Sandboxed execution, outbound-only connections, secret redaction, device revocation, and hash-chained audit. See our Security Whitepaper for details.",
  },
]

export function Faq() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <section id="faq" className="relative scroll-mt-24 px-6 py-24 md:px-12 md:py-32 lg:px-16">
      <div className="mx-auto max-w-3xl">
        <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />

        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/50 backdrop-blur-sm">
          {faqs.map((item, i) => {
            const isOpen = open === i
            return (
              <Reveal key={item.q} as="div" delay={i * 60}>
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
                  aria-expanded={isOpen}
                >
                  <span className="font-sans text-base font-medium text-foreground md:text-lg">{item.q}</span>
                  <Plus
                    className={`h-5 w-5 shrink-0 text-primary transition-transform duration-300 ${
                      isOpen ? "rotate-45" : ""
                    }`}
                    aria-hidden="true"
                  />
                </button>
                <div
                  className={`grid transition-all duration-300 ease-out ${
                    isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="overflow-hidden">
                    <p className="px-6 pb-6 text-sm leading-relaxed text-foreground/70 md:text-base">{item.a}</p>
                  </div>
                </div>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}
