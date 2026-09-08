"use client"

import { Bot, Github, Twitter, MessageCircle, Youtube } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { MagneticButton } from "@/components/magnetic-button"

const columns = [
  { title: "Product", links: ["Features", "Pricing", "Changelog", "Roadmap"] },
  { title: "Resources", links: ["Documentation", "Blog", "API Reference", "Status"] },
  { title: "Company", links: ["About", "Blog", "Careers", "Contact"] },
  { title: "Legal", links: ["Privacy", "Terms", "Security", "DPA"] },
]

const socials = [
  { icon: Twitter, label: "Twitter" },
  { icon: MessageCircle, label: "Discord" },
  { icon: Youtube, label: "YouTube" },
  { icon: Github, label: "GitHub" },
]

export function CtaFooter() {
  return (
    <footer className="relative px-6 pt-24 md:px-12 md:pt-32 lg:px-16">
      <div className="mx-auto max-w-7xl">
        {/* CTA */}
        <Reveal className="relative overflow-hidden rounded-3xl border border-primary/30 bg-primary/10 px-8 py-16 text-center backdrop-blur-sm md:px-16 md:py-20">
          <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-primary/30 blur-3xl" />
          <div className="relative">
            <h2 className="mb-4 text-balance font-sans text-4xl font-light leading-[1.1] tracking-tight text-foreground md:text-5xl">
              Ready to go AFK?
            </h2>
            <p className="mx-auto mb-8 max-w-md text-pretty text-base text-foreground/75 md:text-lg">
              Start supervising your AI agents from anywhere. Free for individual developers.
            </p>
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              <MagneticButton size="lg" variant="primary">
                Get Started Free
              </MagneticButton>
              <MagneticButton size="lg" variant="secondary" className="inline-flex items-center gap-2">
                <Github className="h-4 w-4" aria-hidden="true" />
                View on GitHub
              </MagneticButton>
            </div>
          </div>
        </Reveal>

        {/* Footer links */}
        <div className="grid gap-10 py-16 md:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <a href="#top" className="mb-4 flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Bot className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="font-sans text-lg font-semibold tracking-tight text-foreground">SmartConnect</span>
            </a>
            <p className="max-w-xs text-sm leading-relaxed text-foreground/60">
              The vendor-neutral AFK control plane for AI coding agents.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <p className="mb-4 font-mono text-xs uppercase tracking-[0.15em] text-foreground/40">{col.title}</p>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link}>
                    <a href="#" className="text-sm text-foreground/65 transition-colors hover:text-foreground">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-between gap-6 border-t border-border py-8 md:flex-row">
          <div className="text-center md:text-left">
            <p className="text-sm text-foreground/60">© 2026 SmartConnect. Open source under MIT License.</p>
            <p className="font-mono text-xs text-foreground/40">Made for developers who go AFK.</p>
          </div>
          <div className="flex gap-2">
            {socials.map((s) => (
              <a
                key={s.label}
                href="#"
                aria-label={s.label}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-border text-foreground/60 transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <s.icon className="h-4 w-4" aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
