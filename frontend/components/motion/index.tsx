"use client";

/**
 * Motion primitives.
 *
 * One small vocabulary used everywhere, so the app moves consistently: things
 * arrive by rising and un-blurring, lists arrive one item after another, and
 * numbers count rather than jump. Every primitive honours reduced motion —
 * the state still changes, only the movement is dropped.
 */
import {
  animate,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type HTMLMotionProps,
  type Variants,
} from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const SPRING = { type: "spring", stiffness: 380, damping: 32, mass: 0.8 } as const;
export const SOFT_SPRING = { type: "spring", stiffness: 220, damping: 26 } as const;

/** Rise into place. The default entrance for a block of content. */
export function FadeIn({
  children,
  delay = 0,
  y = 12,
  className,
  ...rest
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
} & Omit<HTMLMotionProps<"div">, "children">) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, y, filter: "blur(6px)" }}
      animate={
        reduce
          ? { opacity: 1 }
          : { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }
      }
      transition={{ duration: 0.5, delay, ease: EASE_OUT }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

const staggerParent: Variants = {
  hidden: {},
  show: (stagger: number = 0.06) => ({
    transition: { staggerChildren: stagger, delayChildren: 0.04 },
  }),
};

const staggerChild: Variants = {
  hidden: { opacity: 0, y: 14, filter: "blur(4px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.45, ease: EASE_OUT },
    transitionEnd: { filter: "none" },
  },
};

const staggerChildReduced: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2 } },
};

/** A container whose StaggerItems arrive one after another. */
export function Stagger({
  children,
  className,
  stagger = 0.06,
  as = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
  as?: "div" | "ul" | "section";
} & Omit<HTMLMotionProps<"div">, "children">) {
  const Component = as === "ul" ? motion.ul : as === "section" ? motion.section : motion.div;
  return (
    <Component
      variants={staggerParent}
      custom={stagger}
      initial="hidden"
      animate="show"
      className={className}
      {...(rest as object)}
    >
      {children}
    </Component>
  );
}

export function StaggerItem({
  children,
  className,
  as = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li";
} & Omit<HTMLMotionProps<"div">, "children">) {
  const reduce = useReducedMotion();
  const Component = as === "li" ? motion.li : motion.div;
  return (
    <Component
      variants={reduce ? staggerChildReduced : staggerChild}
      className={className}
      {...(rest as object)}
    >
      {children}
    </Component>
  );
}

/**
 * A number that counts to its value — from 0 the first time, then from the
 * previous value on every change, so an update reads as a change rather than
 * a flicker. Starts when scrolled into view.
 *
 * The true value is held in React state and rendered as plain text once the
 * count is done. Motion paints the in-between numbers on animation frames,
 * and browsers throttle or stop those in background tabs — where even the
 * in-view check waits for a frame. Without the state, a number could sit at
 * zero, looking current, until the tab was focused.
 */
export function AnimatedNumber({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  duration = 0.9,
  className,
}: {
  value: number;
  format?: (value: number) => string;
  duration?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-20px" });
  const count = useMotionValue(0);
  const text = useTransform(count, (latest) => format(latest));
  const [settled, setSettled] = useState<number | null>(null);

  useEffect(() => {
    if (reduce) {
      count.set(value);
      setSettled(value);
      return;
    }
    setSettled(null);
    const controls = inView ? animate(count, value, { duration, ease: EASE_OUT }) : null;
    // A timer, not a frame: it fires in a throttled tab too.
    const land = setTimeout(
      () => {
        controls?.stop();
        count.set(value);
        setSettled(value);
      },
      (inView ? duration * 1000 : 0) + 400,
    );
    return () => {
      clearTimeout(land);
      controls?.stop();
    };
  }, [count, value, duration, inView, reduce]);

  return (
    <span ref={ref} className={className}>
      {settled !== null ? format(settled) : <motion.span>{text}</motion.span>}
    </span>
  );
}

/** Tap feedback for anything pressable — a small, springy press. */
export function Pressable({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & Omit<HTMLMotionProps<"div">, "children">) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      whileTap={reduce ? undefined : { scale: 0.97 }}
      transition={SPRING}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** A status dot that breathes while something is live. */
export function LiveDot({
  tone = "success",
  live = true,
  className = "",
}: {
  tone?: "success" | "warning" | "danger" | "muted" | "primary";
  live?: boolean;
  className?: string;
}) {
  const color = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    muted: "bg-muted-foreground/50",
    primary: "bg-primary",
  }[tone];
  return (
    <span className={`relative inline-flex h-2 w-2 shrink-0 ${className}`}>
      {live && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${color}`}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}
