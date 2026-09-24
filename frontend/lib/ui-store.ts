"use client";

import { create } from "zustand";

/**
 * Per-viewer interface state: whether the sidebar is collapsed, whether the
 * command palette is open, and the launch sheet the phone's action button
 * opens.
 *
 * The sidebar preference is kept in localStorage because it is a convenience
 * for this browser only. Storage can be unavailable (private windows, blocked
 * site data), so every access is guarded and the app works without it.
 */
const SIDEBAR_KEY = "odysseus.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, value ? "1" : "0");
  } catch {
    /* storage unavailable — the preference just is not remembered */
  }
}

interface UiState {
  sidebarCollapsed: boolean;
  sidebarHydrated: boolean;
  hydrateSidebar: () => void;
  toggleSidebar: () => void;

  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;

  launchOpen: boolean;
  /** Called after a session starts, by whichever screen opened the sheet. */
  onLaunched: (() => void) | null;
  setLaunchOpen: (open: boolean, onLaunched?: () => void) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  sidebarHydrated: false,
  hydrateSidebar: () => {
    if (get().sidebarHydrated) return;
    set({ sidebarCollapsed: readCollapsed(), sidebarHydrated: true });
  },
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    writeCollapsed(next);
    set({ sidebarCollapsed: next });
  },

  commandOpen: false,
  setCommandOpen: (open) => set({ commandOpen: open }),

  launchOpen: false,
  onLaunched: null,
  setLaunchOpen: (open, onLaunched) =>
    set(open ? { launchOpen: true, onLaunched: onLaunched ?? null } : { launchOpen: false }),
}));
