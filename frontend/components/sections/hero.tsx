"use client"

import FoldText from "@/components/FoldText"
import TiltedCard from "@/components/TiltedCard"
import { Play, Check } from "lucide-react"
import { MagneticButton } from "@/components/magnetic-button"
import { AgentPhone } from "@/components/agent-phone"

const badges = ["No credit card required", "Open source", "Runs locally"]

export function Hero({ isLoaded }: { isLoaded: boolean }) {
  return (
    <section
      id="top"
      className={`relative flex min-h-screen w-full items-center px-6 pb-20 pt-32 transition-opacity duration-700 md:px-12 md:pt-28 lg:px-16 ${
        isLoaded ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="mx-auto grid w-full max-w-7xl items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-8">
        <div className="max-w-2xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-foreground/15 bg-foreground/10 px-4 py-1.5 backdrop-blur-md animate-in fade-in slide-in-from-bottom-4 duration-700">
            <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
            <p className="font-mono text-xs text-foreground/90">Vendor-Neutral AFK Control Plane</p>
          </div>

          <h1 className="mb-6 animate-in fade-in slide-in-from-bottom-8 font-sans text-5xl font-light leading-[1.05] tracking-tight text-foreground duration-1000 md:text-6xl lg:text-7xl">
            <span className="text-balance">
              <FoldText
                text="Go AFK. Your AI Agent Keeps Working."
                splitBy="word"
                hinge="top"
                trigger="mount"
                duration={0.65}
                stagger={0.045}
                ease="power3.out"
                perspective={700}
                creaseShading={0.55}
                fontSize="inherit"
                fontWeight="inherit"
                color="currentColor"
              />
            </span>
          </h1>

          <p className="mb-8 max-w-xl animate-in fade-in slide-in-from-bottom-4 text-lg leading-relaxed text-foreground/80 duration-1000 delay-200 md:text-xl">
            <span className="text-pretty">
              Supervise, approve, and control your AI coding agents from anywhere — your phone, tablet, or any browser.
            </span>
          </p>

          <div className="mb-8 flex animate-in fade-in slide-in-from-bottom-4 flex-col gap-3 duration-1000 delay-300 sm:flex-row sm:items-center">
            <MagneticButton size="lg" variant="primary">
              Get Started Free
            </MagneticButton>
            <MagneticButton size="lg" variant="secondary" className="inline-flex items-center gap-2">
              <Play className="h-4 w-4" aria-hidden="true" />
              Watch Demo
            </MagneticButton>
          </div>

          <ul className="flex animate-in fade-in slide-in-from-bottom-4 flex-wrap gap-x-6 gap-y-2 duration-1000 delay-500">
            {badges.map((b) => (
              <li key={b} className="flex items-center gap-2 font-mono text-xs text-foreground/70">
                <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                {b}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex animate-in fade-in slide-in-from-bottom-8 justify-center duration-1000 delay-500 lg:justify-end">
          <TiltedCard 
            imageSrc={null}
            displayOverlayContent={true}
            overlayContent={<AgentPhone />}
            containerHeight="auto"
            containerWidth="auto"
            imageHeight="auto"
            imageWidth="auto"
            showTooltip={false}
            showMobileWarning={false}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
    </section>
  )
}
