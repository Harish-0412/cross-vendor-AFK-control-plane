"use client";

import { useSyncExternalStore } from "react";

/**
 * Desktop or phone — decided by layout width, with the same breakpoint the
 * shell uses (Tailwind's `lg`, 1024px).
 *
 * The app deliberately behaves differently on each, not just smaller: a phone
 * gets bottom tabs, bottom sheets and big thumb-sized actions; a desktop gets
 * the sidebar, dense multi-column layouts and a command palette. Components
 * that differ that much render different trees, and this is how they choose.
 *
 * Built on useSyncExternalStore so every subscriber flips in the same render
 * when the window crosses the breakpoint, instead of each settling on its own.
 * The server snapshot is "desktop": the authenticated shell renders on the
 * client after the session check, so this only matters for the first paint of
 * public pages.
 */
export const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/** A touch-first device, regardless of width — for hover-only affordances. */
export function useIsTouch(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(hover: none)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(hover: none)").matches,
    () => false,
  );
}
