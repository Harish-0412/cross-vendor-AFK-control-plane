"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface DiffLine {
  type: "added" | "removed" | "context" | "hunk";
  content: string;
  lineOld?: number;
  lineNew?: number;
}

interface DiffViewerProps {
  patch: string;
  className?: string;
  maxHeight?: string;
}

function parsePatch(patch: string): DiffLine[] {
  const lines = patch.split("\n");
  const result: DiffLine[] = [];
  let lineOld = 0;
  let lineNew = 0;

  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const match = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        lineOld = parseInt(match[1], 10);
        lineNew = parseInt(match[2], 10);
      }
      result.push({ type: "hunk", content: raw });
    } else if (raw.startsWith("+")) {
      result.push({ type: "added", content: raw.slice(1), lineNew: lineNew++ });
    } else if (raw.startsWith("-")) {
      result.push({ type: "removed", content: raw.slice(1), lineOld: lineOld++ });
    } else if (raw.startsWith(" ") || raw === "") {
      result.push({ type: "context", content: raw.startsWith(" ") ? raw.slice(1) : "", lineOld: lineOld++, lineNew: lineNew++ });
    }
  }

  return result;
}

export function DiffViewer({ patch, className, maxHeight = "400px" }: DiffViewerProps) {
  const lines = useMemo(() => parsePatch(patch), [patch]);

  if (!patch || lines.length === 0) {
    return (
      <div className={cn("rounded-lg border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground", className)}>
        No diff available
      </div>
    );
  }

  return (
    <div
      className={cn("rounded-lg border border-border overflow-hidden font-mono text-xs", className)}
      style={{ maxHeight, overflowY: "auto" }}
    >
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, idx) => {
            if (line.type === "hunk") {
              return (
                <tr key={idx} className="bg-blue-500/10">
                  <td className="w-10 select-none px-2 py-0.5 text-right text-blue-400/60 border-r border-border" colSpan={2} />
                  <td className="px-3 py-0.5 text-blue-400/80">{line.content}</td>
                </tr>
              );
            }

            const bgClass =
              line.type === "added"
                ? "bg-emerald-500/10"
                : line.type === "removed"
                ? "bg-destructive/10"
                : "";

            const gutter =
              line.type === "added"
                ? "text-emerald-500/60"
                : line.type === "removed"
                ? "text-destructive/60"
                : "text-muted-foreground/40";

            const prefix =
              line.type === "added" ? "+" : line.type === "removed" ? "−" : " ";

            const prefixColor =
              line.type === "added"
                ? "text-emerald-500"
                : line.type === "removed"
                ? "text-destructive"
                : "text-muted-foreground/30";

            return (
              <tr key={idx} className={bgClass}>
                <td className={cn("w-10 select-none px-2 py-0.5 text-right border-r border-border", gutter)}>
                  {line.type !== "added" ? line.lineOld ?? "" : ""}
                </td>
                <td className={cn("w-10 select-none px-2 py-0.5 text-right border-r border-border", gutter)}>
                  {line.type !== "removed" ? line.lineNew ?? "" : ""}
                </td>
                <td className="px-3 py-0.5 whitespace-pre text-foreground/90">
                  <span className={cn("mr-2 select-none", prefixColor)}>{prefix}</span>
                  {line.content}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
