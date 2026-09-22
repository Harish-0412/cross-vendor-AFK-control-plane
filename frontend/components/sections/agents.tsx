"use client"

import { Terminal, Bot, Sparkles, Cpu, CheckCircle2 } from "lucide-react"
import { Reveal } from "@/components/reveal"
import { SectionHeading } from "@/components/section-heading"
import { StaggeredGrid, BentoItem } from "@/components/ui/staggered-grid"

const agentBentoItems: BentoItem[] = [
  {
    id: "opencode",
    title: "OpenCode",
    subtitle: "MIT · Primary CLI · Autonomous",
    description:
      "Autonomous terminal execution with structured JSON-RPC, hot-swappable models, and native git worktree isolation.",
    icon: <Terminal className="h-5 w-5 text-emerald-400" />,
    image: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=800&auto=format&fit=crop",
    status: "Primary",
  },
  {
    id: "antigravity",
    title: "Antigravity",
    subtitle: "Google · Local-First · Sandbox",
    description:
      "Built-in sandboxed runtime, stateful trajectory logging, subagent orchestration, and live sidecar daemon controls.",
    icon: <Bot className="h-5 w-5 text-cyan-400" />,
    image: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop",
    status: "Daemon Mode",
  },
  {
    id: "claude-code",
    title: "Claude Code",
    subtitle: "Anthropic · Stream JSON · Reasoning",
    description:
      "Deep agentic coding with multi-turn tool calling, headless subprocess sessions, and MCP server integrations.",
    icon: <Sparkles className="h-5 w-5 text-amber-400" />,
    image: "https://images.unsplash.com/photo-1620712943543-bcc4688e7485?q=80&w=800&auto=format&fit=crop",
    status: "Stream JSON",
  },
  {
    id: "custom-agents",
    title: "Custom Agents",
    subtitle: "Adapter SDK · Any CLI Agent",
    description:
      "Plug in Cursor CLI, Aider, Codex, or proprietary in-house agents via Odysseus bidirectional stdio adapter protocol.",
    icon: <Cpu className="h-5 w-5 text-violet-400" />,
    image: "https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=800&auto=format&fit=crop",
    status: "Adapter SDK",
  },
]

const priority = [
  {
    agent: "OpenCode",
    badge: "Primary (MIT)",
    description: "Released, production-ready CLI adapter with full lifecycle management and JSON-RPC bridge.",
  },
  {
    agent: "Google Antigravity",
    badge: "Daemon Mode",
    description: "Built-in sandboxed runtime, stateful trajectory logging, sidecar monitoring, and token tracking.",
  },
  {
    agent: "Claude Code",
    badge: "Stream JSON",
    description: "Streaming JSON adapter with subagent hooks and token consumption analytics.",
  },
  {
    agent: "Custom Agents",
    badge: "Adapter SDK",
    description: "Vendor-neutral SDK to plug any stdin/stdout CLI agent into the AFK control plane in under 50 lines.",
  },
]

export function Agents() {
  return (
    <section id="agents" className="relative scroll-mt-24 px-4 py-20 md:px-12 md:py-28 lg:px-16 overflow-hidden">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Supported Agents"
          title="Works with your favorite coding agents"
          description="Vendor neutral by design — bring the agent you already use, hover or click cards to inspect integration details."
        />

        {/* Staggered Grid Effect with Interactive Bento Cards */}
        <div className="w-full my-6">
          <StaggeredGrid
            bentoItems={agentBentoItems}
            centerText="AGENTS"
            showFooter={false}
          />
        </div>

        {/* Integration Priority & Architecture Details */}
        <Reveal className="mx-auto mt-12 max-w-4xl rounded-2xl border border-border bg-card/60 p-6 md:p-8 backdrop-blur-md shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/60 pb-5 mb-6">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary font-semibold">
                Adapter Architecture
              </p>
              <h4 className="text-base md:text-lg font-semibold text-foreground mt-1">
                Zero-Lock-in Execution Matrix
              </h4>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-mono text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              Unified Control Plane
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {priority.map((p, i) => (
              <div
                key={p.agent}
                className="flex items-start gap-3.5 rounded-xl border border-border/50 bg-background/50 p-4 transition-all hover:border-primary/40 hover:bg-card/80"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-card font-mono text-xs font-bold text-foreground">
                  {i + 1}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{p.agent}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {p.badge}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {p.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  )
}
