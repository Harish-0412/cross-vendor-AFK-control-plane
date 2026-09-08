import type { ReactNode } from "react"
import { Reveal } from "@/components/reveal"

interface SectionHeadingProps {
  eyebrow: string
  title: ReactNode
  description?: ReactNode
  align?: "left" | "center"
}

export function SectionHeading({ eyebrow, title, description, align = "center" }: SectionHeadingProps) {
  return (
    <Reveal className={`mb-14 max-w-2xl ${align === "center" ? "mx-auto text-center" : ""}`}>
      <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-primary">{eyebrow}</p>
      <h2 className="mb-4 text-balance font-sans text-4xl font-light leading-[1.1] tracking-tight text-foreground md:text-5xl">
        {title}
      </h2>
      {description && <p className="text-pretty text-base leading-relaxed text-foreground/70 md:text-lg">{description}</p>}
    </Reveal>
  )
}
