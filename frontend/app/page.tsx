"use client"

import { useEffect, useRef, useState } from "react"
import { Shader, ChromaFlow, Swirl } from "shaders/react"
import { CustomCursor } from "@/components/custom-cursor"
import { GrainOverlay } from "@/components/grain-overlay"
import CardNav from "@/components/CardNav"
import { Hero } from "@/components/sections/hero"
import { Problem } from "@/components/sections/problem"
import { Solution } from "@/components/sections/solution"
import { Features } from "@/components/sections/features"
import { HowItWorks } from "@/components/sections/how-it-works"
import { Agents } from "@/components/sections/agents"
import { UseCases } from "@/components/sections/use-cases"
import { Security } from "@/components/sections/security"
import { Pricing } from "@/components/sections/pricing"
import { Testimonials } from "@/components/sections/testimonials"
import { Faq } from "@/components/sections/faq"
import { CtaFooter } from "@/components/sections/cta-footer"

import PixelSnow from "@/components/PixelSnow"

export default function Home() {
  const [isLoaded, setIsLoaded] = useState(false)
  const shaderContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const checkShaderReady = () => {
      if (shaderContainerRef.current) {
        const canvas = shaderContainerRef.current.querySelector("canvas")
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          setIsLoaded(true)
          return true
        }
      }
      return false
    }

    if (checkShaderReady()) return

    const intervalId = setInterval(() => {
      if (checkShaderReady()) clearInterval(intervalId)
    }, 100)

    const fallbackTimer = setTimeout(() => setIsLoaded(true), 1500)

    return () => {
      clearInterval(intervalId)
      clearTimeout(fallbackTimer)
    }
  }, [])

  return (
    <main className="relative w-full bg-background">
      <CustomCursor />
      <GrainOverlay />

      {/* Fixed shader backdrop — visible behind the hero */}
      <div
        ref={shaderContainerRef}
        className={`fixed inset-0 z-0 transition-opacity duration-700 ${isLoaded ? "opacity-100" : "opacity-0"}`}
        style={{ contain: "strict" }}
      >
        <Shader className="h-full w-full">
          <Swirl
            colorA="#6366F1"
            colorB="#F59E0B"
            speed={0.7}
            detail={0.8}
            blend={50}
            coarseX={40}
            coarseY={40}
            mediumX={40}
            mediumY={40}
            fineX={40}
            fineY={40}
          />
          <ChromaFlow
            baseColor="#6366F1"
            upColor="#6366F1"
            downColor="#10B981"
            leftColor="#F59E0B"
            rightColor="#6366F1"
            intensity={0.9}
            radius={1.8}
            momentum={25}
            maskType="alpha"
            opacity={0.95}
          />
        </Shader>
        <div className="absolute inset-0 bg-background/40" />
      </div>

      <div
        className={`fixed inset-x-0 top-0 z-50 transition-opacity duration-700 ${
          isLoaded ? "opacity-100" : "opacity-0"
        }`}
      >
        <CardNav
          logo=""
          logoAlt="FreeBuff AFK"
          items={[
            {
              label: "About",
              bgColor: "#1B1722",
              textColor: "#fff",
              links: [
                { label: "Features", href: "#features", ariaLabel: "Features" },
                { label: "How It Works", href: "#how-it-works", ariaLabel: "How It Works" }
              ]
            },
            {
              label: "Projects",
              bgColor: "#2F293A",
              textColor: "#fff",
              links: [
                { label: "Pricing", href: "#pricing", ariaLabel: "Pricing" },
                { label: "Security", href: "#security", ariaLabel: "Security" }
              ]
            },
            {
              label: "Contact",
              bgColor: "#2F293A",
              textColor: "#fff",
              links: [
                { label: "FAQ", href: "#faq", ariaLabel: "FAQ" },
                { label: "Docs", href: "#", ariaLabel: "Docs" },
                { label: "GitHub", href: "#", ariaLabel: "GitHub" }
              ]
            }
          ]}
          baseColor="transparent"
          menuColor="var(--foreground)"
          buttonBgColor="var(--primary)"
          buttonTextColor="var(--primary-foreground)"
          ease="power3.out"
        />
      </div>

      {/* Hero sits over the shader */}
      <div className="relative z-10">
        <Hero isLoaded={isLoaded} />
      </div>

      {/* Content scrolls over a solid background */}
      <div className="relative z-10">
        <div className="bg-background relative">
          <div className="absolute inset-0 z-0 pointer-events-none opacity-50">
            <PixelSnow 
              color="#ffffff"
              flakeSize={0.01}
              minFlakeSize={1.25}
              pixelResolution={200}
              speed={1.25}
              density={0.3}
              direction={125}
              brightness={1}
            />
          </div>
          <div className="relative z-10">
            <Problem />
            <Solution />
            <Features />
            <HowItWorks />
            <Agents />
            <UseCases />
            <Security />
            <Pricing />
            <Testimonials />
            <Faq />
          </div>
        </div>
        <div className="h-40 w-full bg-gradient-to-b from-background to-transparent pointer-events-none relative z-10 -mb-40" />
        {/* Let the footer reveal the fixed shader background */}
        <div className="bg-transparent pb-10 pt-20">
          <CtaFooter />
        </div>
      </div>
    </main>
  )
}
