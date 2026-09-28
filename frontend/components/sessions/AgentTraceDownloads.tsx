"use client";

import { useEffect, useState } from "react";
import { FileCode2 } from "lucide-react";
// Types only: the protocol package's runtime code includes Node-only modules.
import type { AgentTraceRecord } from "@odysseus/protocol";
import { apiClient } from "@/lib/api-client";

/** The spec's media type (AGENT_TRACE_MEDIA_TYPE in @odysseus/protocol). */
const AGENT_TRACE_MEDIA_TYPE = "application/vnd.agent-trace.record+json";

interface Traces {
  session: AgentTraceRecord | null;
  commits: AgentTraceRecord[];
}

function download(record: AgentTraceRecord, name: string) {
  const blob = new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: AGENT_TRACE_MEDIA_TYPE });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Agent Trace records (agent-trace.dev) for a session: which lines the agent
 * wrote, and who approved what. Commit records are also stored in the
 * repository as git notes under refs/notes/agent-trace.
 */
export function AgentTraceDownloads({ sessionId, refreshKey }: { sessionId: string; refreshKey?: string }) {
  const [traces, setTraces] = useState<Traces | null>(null);

  useEffect(() => {
    apiClient
      .get<Traces>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/agent-trace`)
      .then(setTraces)
      .catch(() => setTraces(null));
  }, [sessionId, refreshKey]);

  if (!traces || (!traces.session && traces.commits.length === 0)) return null;
  const lines = (record: AgentTraceRecord) =>
    record.files.reduce(
      (sum, file) =>
        sum +
        file.conversations.reduce(
          (inner, conversation) =>
            inner + conversation.ranges.reduce((count, range) => count + range.end_line - range.start_line + 1, 0),
          0,
        ),
      0,
    );

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
        Agent Trace
      </span>
      <span className="text-muted-foreground">Which lines the agent wrote, and who approved what.</span>
      <div className="flex flex-wrap gap-1.5">
        {traces.session && (
          <button
            type="button"
            onClick={() => download(traces.session!, `agent-trace-${sessionId}.json`)}
            className="rounded-md border border-border px-2 py-1 font-medium hover:bg-muted"
          >
            Working tree · {lines(traces.session)} lines
          </button>
        )}
        {traces.commits.map((record) => {
          const revision = record.vcs?.revision ?? record.id;
          return (
            <button
              key={record.id}
              type="button"
              onClick={() => download(record, `agent-trace-${revision.slice(0, 12)}.json`)}
              className="rounded-md border border-border px-2 py-1 font-mono hover:bg-muted"
              title="Also stored as a git note: git notes --ref=agent-trace show"
            >
              {revision.slice(0, 7)} · {lines(record)} lines
            </button>
          );
        })}
      </div>
    </div>
  );
}
