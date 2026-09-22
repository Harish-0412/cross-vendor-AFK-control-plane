'use client'

import React, { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import imagesLoaded from 'imagesloaded'
import { cn } from '@/lib/utils'
import { FaGithub, FaSlack, FaDocker, FaTerminal, FaPython } from 'react-icons/fa'
import {
  Bot,
  Sparkles,
  Terminal,
  Cpu,
  ShieldCheck,
  Workflow,
  GitBranch,
  Code2,
  Boxes,
  Server
} from 'lucide-react'

if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger)
}

export interface BentoItem {
  id: number | string
  title: string
  subtitle?: string
  description?: string
  icon?: React.ReactNode
  content?: React.ReactNode
  image?: string
  status?: string
}

export interface StaggeredGridProps {
  images?: string[]
  bentoItems: BentoItem[]
  centerText?: string
  credits?: {
    madeBy: { text: string; href: string }
    moreDemos: { text: string; href: string }
  }
  className?: string
  showFooter?: boolean
  scroller?: string | Element | Window | null
}

const defaultImages: string[] = [
  'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1504639725590-34d0984388bd?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?q=80&w=800&auto=format&fit=crop',
]

const techTiles = [
  { label: 'OpenCode', sub: 'Primary Agent', icon: Terminal },
  { label: 'Antigravity', sub: 'Google Sandbox', icon: Bot },
  { label: 'Claude Code', sub: 'Anthropic Agent', icon: Sparkles },
  { label: 'ChatGPT', sub: 'OpenAI GPT-4o', icon: Cpu },
  { label: 'GitHub', sub: 'Git Worktree', icon: FaGithub },
  { label: 'Docker', sub: 'Sandboxed Host', icon: FaDocker },
  { label: 'Terminal', sub: 'PTY Daemon', icon: FaTerminal },
  { label: 'Python', sub: 'Agent SDK', icon: FaPython },
  { label: 'Adapter SDK', sub: 'Bidirectional RPC', icon: Boxes },
  { label: 'Slack', sub: 'Notification Bridge', icon: FaSlack },
  { label: 'Security', sub: 'mTLS & Sandbox', icon: ShieldCheck },
  { label: 'Workflows', sub: 'DAG Scheduler', icon: Workflow },
  { label: 'Daemon', sub: 'Host Daemon', icon: Server },
  { label: 'Git Sync', sub: 'Multi-Branch', icon: GitBranch },
  { label: 'TypeScript', sub: 'Typed Schema', icon: Code2 },
]

export function StaggeredGrid({
  images = defaultImages,
  bentoItems,
  centerText = 'AGENTS',
  credits = {
    madeBy: { text: '@codrops', href: 'https://x.com/codrops' },
    moreDemos: { text: 'More demos', href: 'https://tympanus.net/codrops/demos' },
  },
  className,
  showFooter = false,
  scroller,
}: StaggeredGridProps) {
  const [isLoaded, setIsLoaded] = useState(false)
  const gridFullRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  // Bento Grid State
  const [activeBento, setActiveBento] = useState<number>(0)

  const splitText = (text: string) => {
    return text.split('').map((char, i) => (
      <span
        key={i}
        className="char inline-block"
        style={{ willChange: 'transform' }}
      >
        {char === ' ' ? '\u00A0' : char}
      </span>
    ))
  }

  useEffect(() => {
    let isCancelled = false
    const handleLoad = () => {
      if (isCancelled) return
      if (typeof document !== 'undefined') {
        document.body.classList.remove('loading')
      }
      setIsLoaded(true)
    }

    const elements = document.querySelectorAll('.grid__item-img')
    if (elements.length === 0) {
      handleLoad()
    } else {
      try {
        imagesLoaded(elements, { background: true }, handleLoad)
      } catch {
        handleLoad()
      }
    }

    const timer = setTimeout(handleLoad, 600)
    return () => {
      isCancelled = true
      clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!isLoaded || typeof window === 'undefined') return

    const ctx = gsap.context(() => {
      // Animate Text Element
      if (textRef.current) {
        const chars = textRef.current.querySelectorAll('.char')
        if (chars.length > 0) {
          gsap
            .timeline({
              scrollTrigger: {
                trigger: textRef.current,
                scroller: scroller || undefined,
                start: 'top bottom',
                end: 'center center-=20%',
                scrub: 1,
              },
            })
            .from(chars, {
              ease: 'sine.out',
              yPercent: 250,
              autoAlpha: 0,
              stagger: {
                each: 0.05,
                from: 'center',
              },
            })
        }
      }

      // Animate Full Grid
      if (gridFullRef.current) {
        const gridFullItems = gridFullRef.current.querySelectorAll('.grid__item')
        const computedStyle = getComputedStyle(gridFullRef.current)
        const colsValue = computedStyle.getPropertyValue('grid-template-columns')
        const numColumns = colsValue ? colsValue.trim().split(/\s+/).length : 7
        const middleColumnIndex = Math.floor(numColumns / 2)

        const columns: Element[][] = Array.from({ length: numColumns }, () => [])
        gridFullItems.forEach((item: Element) => {
          const colAttr = item.getAttribute('data-col')
          const columnIndex = colAttr !== null ? parseInt(colAttr, 10) : 0
          if (columns[columnIndex]) {
            columns[columnIndex].push(item)
          }
        })

        columns.forEach((columnItems, columnIndex) => {
          if (columnItems.length === 0) return
          const delayFactor = Math.abs(columnIndex - middleColumnIndex) * 0.15

          const colTl = gsap.timeline({
            scrollTrigger: {
              trigger: gridFullRef.current,
              scroller: scroller || undefined,
              start: 'top bottom',
              end: 'center center',
              scrub: 1.2,
            },
          })

          colTl.from(columnItems, {
            yPercent: 320,
            autoAlpha: 0,
            delay: delayFactor,
            ease: 'sine.out',
          })

          const imgEls = columnItems
            .map((item) => item.querySelector('.grid__item-img'))
            .filter((el): el is Element => el !== null)

          if (imgEls.length > 0) {
            colTl.from(
              imgEls,
              {
                transformOrigin: '50% 0%',
                ease: 'sine.out',
              },
              0
            )
          }
        })

        // Specific animation for Bento Container
        const bentoContainer = gridFullRef.current.querySelector('.bento-container')
        if (bentoContainer) {
          const tl = gsap.timeline({
            scrollTrigger: {
              trigger: gridFullRef.current,
              scroller: scroller || undefined,
              start: 'top top+=15%',
              end: 'bottom center',
              scrub: 1,
              invalidateOnRefresh: true,
            },
          })

          tl.to(
            bentoContainer,
            {
              y: () => (typeof window !== 'undefined' ? window.innerHeight * 0.06 : 30),
              scale: 1.15,
              zIndex: 100,
              ease: 'power2.out',
              duration: 1,
              force3D: true,
            },
            0
          )
        }
      }
    })

    return () => {
      ctx.revert()
    }
  }, [isLoaded, scroller])

  // Total 35 slots (7 columns x 5 rows)
  // Row 3 starts at slot 14. Bento group placed at slot 16 (spans cols 2, 3, 4).
  const TOTAL_SLOTS = 35
  const mixedGridItems: (string | 'BENTO_GROUP')[] = Array.from(
    { length: TOTAL_SLOTS },
    (_, i) => images[i % images.length]
  )
  mixedGridItems[16] = 'BENTO_GROUP'

  return (
    <div
      className={cn('relative overflow-hidden w-full', className)}
      style={
        {
          '--grid-item-translate': '0px',
        } as React.CSSProperties
      }
    >
      {/* Background Big Typography */}
      <section className="grid place-items-center w-full relative mt-4 md:mt-8 select-none pointer-events-none">
        <div
          ref={textRef}
          className="text font-mono font-black uppercase tracking-widest flex content-center text-[clamp(2.5rem,11vw,8.5rem)] leading-none text-foreground/10 dark:text-white/10"
        >
          {splitText(centerText)}
        </div>
      </section>

      {/* Grid Section */}
      <section className="grid place-items-center w-full relative -mt-6 md:-mt-12 overflow-x-auto md:overflow-x-visible pb-8">
        <div
          ref={gridFullRef}
          className="grid--full relative min-w-[760px] md:min-w-0 w-full my-6 md:my-10 h-auto aspect-[1.25] md:aspect-[1.1] max-w-none p-4 grid gap-3 md:gap-4 grid-cols-7 grid-rows-5"
        >
          <div className="grid-overlay absolute inset-0 z-[15] pointer-events-none opacity-0 bg-background/80 rounded-2xl transition-opacity duration-500" />

          {mixedGridItems.map((item, i) => {
            if (item === 'BENTO_GROUP') {
              if (!bentoItems || bentoItems.length === 0) return null

              return (
                <div
                  key="bento-group"
                  data-col={2}
                  className="grid__item bento-container col-span-3 row-span-1 relative z-30 flex items-center justify-center gap-2.5 h-full w-full will-change-transform"
                >
                  {bentoItems.map((bentoItem, index) => {
                    const isActive = activeBento === index
                    const activeWidth =
                      bentoItems.length === 4 ? (isActive ? '55%' : '15%') : 'auto'

                    return (
                      <div
                        key={bentoItem.id}
                        className={cn(
                          'relative cursor-pointer overflow-hidden rounded-2xl h-full transition-all duration-700 ease-[cubic-bezier(0.25,1,0.5,1)] group border shadow-md',
                          isActive
                            ? 'bg-card border-primary/50 shadow-2xl ring-1 ring-primary/40'
                            : 'bg-card/75 border-border/80 hover:border-primary/40 hover:bg-card/90'
                        )}
                        style={{ width: activeWidth }}
                        onMouseEnter={() => setActiveBento(index)}
                        onClick={() => setActiveBento(index)}
                      >
                        {/* Border Overlay */}
                        <div
                          className={cn(
                            'absolute inset-0 rounded-2xl border z-50 pointer-events-none transition-colors duration-700',
                            isActive
                              ? 'border-primary/40'
                              : 'border-border/60 group-hover:border-border'
                          )}
                        />

                        {/* Content Container */}
                        <div className="relative z-10 w-full h-full flex flex-col p-0">
                          {/* Active State Content */}
                          <div
                            className={cn(
                              'absolute inset-0 flex flex-col justify-end p-4 transition-all duration-500 ease-in-out z-20',
                              isActive
                                ? 'opacity-100 translate-y-0'
                                : 'opacity-0 translate-y-4 pointer-events-none'
                            )}
                          >
                            {/* Image Background */}
                            <div className="absolute inset-0 bg-zinc-950 overflow-hidden z-0">
                              {bentoItem.image && (
                                <>
                                  <img
                                    src={bentoItem.image}
                                    alt={bentoItem.title}
                                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 opacity-40 group-hover:opacity-55"
                                  />
                                  <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-transparent pointer-events-none" />
                                </>
                              )}
                            </div>

                            {/* Active Content Info */}
                            <div className="relative z-10 flex flex-col gap-1 text-left">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
                                  <h3 className="text-sm md:text-base font-bold text-white drop-shadow-md leading-none tracking-tight">
                                    {bentoItem.title}
                                  </h3>
                                </div>
                                <div className="text-white/90 shrink-0 drop-shadow">
                                  {bentoItem.icon}
                                </div>
                              </div>
                              {bentoItem.subtitle && (
                                <span className="text-[10px] md:text-[11px] font-mono uppercase tracking-wider text-emerald-300 drop-shadow">
                                  {bentoItem.subtitle}
                                </span>
                              )}
                              {bentoItem.description && (
                                <p className="text-[11px] md:text-xs text-zinc-200 line-clamp-2 md:line-clamp-3 leading-snug drop-shadow mt-0.5">
                                  {bentoItem.description}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Inactive State - Icon + Title Centered */}
                        <div
                          className={cn(
                            'absolute inset-0 flex flex-col items-center justify-center gap-2 transition-all duration-500 px-1',
                            isActive ? 'opacity-0 scale-90 pointer-events-none' : 'opacity-100 scale-100'
                          )}
                        >
                          <div className="text-foreground/60 group-hover:text-foreground transition-colors scale-110">
                            {bentoItem.icon}
                          </div>
                          <span className="text-[9px] md:text-[10px] font-semibold text-foreground/70 group-hover:text-foreground transition-colors uppercase tracking-wider font-mono text-center truncate w-full">
                            {bentoItem.title}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            }

            // Skip rendering for slots 17 and 18 because Bento Group spans col-span-3 (slots 16, 17, 18)
            if (i === 17 || i === 18) return null

            const tile = techTiles[i % techTiles.length]
            const TileIcon = tile.icon

            return (
              <figure
                key={`tile-${i}`}
                data-col={i % 7}
                className="grid__item m-0 relative z-10 [perspective:800px] will-change-[transform,opacity] group cursor-pointer"
              >
                <div
                  className="grid__item-img w-full h-full [backface-visibility:hidden] will-change-transform rounded-xl overflow-hidden shadow-sm border border-border bg-card/50 hover:bg-card/90 flex items-center justify-center transition-all duration-500 ease-out group-hover:scale-105 group-hover:shadow-xl group-hover:border-primary/40 relative"
                  style={
                    item && (item.startsWith('http') || item.startsWith('/'))
                      ? {
                          backgroundImage: `url(${item})`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        }
                      : undefined
                  }
                >
                  {/* Subtle dark tint over image */}
                  <div className="absolute inset-0 bg-background/85 dark:bg-background/90 group-hover:bg-background/70 transition-colors duration-500" />

                  {/* Hover gradient overlay */}
                  <div className="absolute inset-0 bg-gradient-to-b from-primary/10 via-primary/20 to-primary/40 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-0" />

                  {/* Content Container */}
                  <div className="relative z-10 flex flex-col items-center justify-center gap-1.5 p-2 text-center">
                    <TileIcon className="w-5 h-5 md:w-6 md:h-6 text-foreground/60 transition-all duration-300 group-hover:text-foreground group-hover:scale-110" />
                    <div className="opacity-0 group-hover:opacity-100 transform translate-y-1.5 group-hover:translate-y-0 transition-all duration-300">
                      <span className="block text-[8px] md:text-[9px] font-mono text-foreground/75 uppercase tracking-wider">
                        {tile.sub}
                      </span>
                      <span className="block text-[10px] md:text-xs font-bold text-foreground tracking-tight">
                        {tile.label}
                      </span>
                    </div>
                  </div>
                </div>
              </figure>
            )
          })}
        </div>
      </section>

      {showFooter && (
        <footer className="frame__footer w-full p-4 flex justify-between items-center relative z-50 text-foreground/70 uppercase font-mono text-xs tracking-wider">
          <a
            href={credits.madeBy.href}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            {credits.madeBy.text}
          </a>
          <a
            href={credits.moreDemos.href}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            {credits.moreDemos.text}
          </a>
        </footer>
      )}
    </div>
  )
}

export default StaggeredGrid
