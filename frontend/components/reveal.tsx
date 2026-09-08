"use client"

import type { ReactNode } from "react"
import { useReveal } from "@/hooks/use-reveal"

interface RevealProps {
  children: ReactNode
  className?: string
  delay?: number
  /** direction the element travels in from */
  from?: "bottom" | "top" | "left" | "right"
  threshold?: number
  as?: "div" | "li" | "section"
}

export function Reveal({
  children,
  className = "",
  delay = 0,
  from = "bottom",
  threshold = 0.2,
  as = "div",
}: RevealProps) {
  const { ref, isVisible } = useReveal(threshold)

  const hidden = {
    bottom: "translate-y-10 opacity-0",
    top: "-translate-y-10 opacity-0",
    left: "-translate-x-12 opacity-0",
    right: "translate-x-12 opacity-0",
  }[from]

  const Tag = as as any

  return (
    <Tag
      ref={ref as any}
      className={`transition-all duration-700 ease-out will-change-transform ${
        isVisible ? "translate-x-0 translate-y-0 opacity-100" : hidden
      } ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  )
}
