"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Bot, Link2, Monitor, Moon, Play, RefreshCw, Sun } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { LiveDot } from "@/components/motion";
import { agentLabel, projectName } from "@/components/dashboard/shared";
import { rankCommand } from "@/lib/command-rank";
import { NAV_GROUPS } from "@/lib/navigation";
import { useUiStore } from "@/lib/ui-store";
import { useLiveSessions, useWorkspace } from "@/lib/workspace-store";

/**
 * ⌘K / Ctrl+K: jump anywhere, or do the common things, from the keyboard.
 *
 * Pages, the machines you have paired and the sessions running on them are
 * all one search away — on a desktop that is faster than any amount of
 * navigation chrome. It reads from the same stores as the rest of the shell,
 * so it opens instantly with nothing to load.
 */
export function CommandPalette() {
  const router = useRouter();
  const open = useUiStore((state) => state.commandOpen);
  const setOpen = useUiStore((state) => state.setCommandOpen);
  const setLaunchOpen = useUiStore((state) => state.setLaunchOpen);
  const devices = useWorkspace((state) => state.devices.data);
  const liveSessions = useLiveSessions();
  const refresh = useWorkspace((state) => state.refresh);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useUiStore.getState().commandOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const deviceName = (id: string) =>
    devices.find((device) => device.id === id)?.friendlyName ?? id.slice(0, 10);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search Odysseus"
      description="Jump to a page, a machine or a running session"
      filter={rankCommand}
      className="rounded-2xl border shadow-2xl sm:max-w-xl"
    >
      <CommandInput placeholder="Search pages, machines, sessions…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>Nothing matches.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(() => setLaunchOpen(true))}>
            <Play /> Launch an agent session
            <CommandShortcut>New</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/devices/pair")}>
            <Link2 /> Pair a machine
          </CommandItem>
          <CommandItem onSelect={() => run(() => void refresh())}>
            <RefreshCw /> Refresh everything
          </CommandItem>
          <CommandItem
            onSelect={() => run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
          </CommandItem>
        </CommandGroup>

        {liveSessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Running now">
              {liveSessions.slice(0, 8).map((session) => (
                <CommandItem
                  key={session.id}
                  // Names people type, never the raw session id.
                  value={`${agentLabel(session.agentId)} ${projectName(session.projectRoot)} ${deviceName(session.deviceId)} running session`}
                  onSelect={() => go(`/sessions/${session.id}`)}
                >
                  <Bot />
                  <span className="truncate">
                    {agentLabel(session.agentId)} · {projectName(session.projectRoot)}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                    <LiveDot
                      tone={session.state === "waiting_for_approval" ? "warning" : "success"}
                    />
                    {session.state.replaceAll("_", " ")}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {devices.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Machines">
              {devices.map((device) => (
                <CommandItem
                  key={device.id}
                  value={`machine ${device.friendlyName} ${device.platform}`}
                  onSelect={() => go(`/devices/${device.id}`)}
                >
                  <Monitor />
                  <span className="truncate">{device.friendlyName}</span>
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                    <LiveDot tone={device.online ? "success" : "muted"} live={device.online} />
                    {device.online ? "online" : "offline"}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <CommandSeparator />
            <CommandGroup heading={group.label}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`${item.name} ${item.hint} ${(item.keywords ?? []).join(" ")}`}
                  onSelect={() => go(item.href)}
                >
                  <item.icon />
                  <span>{item.name}</span>
                  <span className="ml-auto truncate pl-4 text-xs text-muted-foreground">
                    {item.hint}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
