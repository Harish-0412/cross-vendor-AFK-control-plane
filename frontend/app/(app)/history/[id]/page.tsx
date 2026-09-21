"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Brain, Download, FileX, Loader2, Scissors, Terminal, Wrench } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api-client";
import {
  aiIntegrations,
  formatRelative,
  formatTokens,
  type HistoryItem,
  type ImportedConversation,
} from "@/lib/ai-integrations";

/**
 * One imported conversation. Only its title and metadata are synced by
 * default; the messages are fetched from the workstation when asked for here.
 *
 * All text is rendered as text (never as HTML) — it came from a tool's files,
 * and must not be able to inject anything into this page.
 */
export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [conversation, setConversation] = useState<ImportedConversation | null>(null);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const data = await aiIntegrations.conversation(decodeURIComponent(id));
      setConversation(data.conversation);
      setItems(data.items);
      return data.conversation;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "Conversation not found." : "Could not load it.");
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const requestContent = async () => {
    setLoadingContent(true);
    try {
      await aiIntegrations.requestContent(decodeURIComponent(id));
      const started = Date.now();
      const previous = conversation?.contentSyncedAt;
      pollRef.current = setInterval(async () => {
        const latest = await load();
        const done = latest?.contentSynced && latest.contentSyncedAt !== previous;
        if (done || Date.now() - started > 90_000) {
          if (pollRef.current) clearInterval(pollRef.current);
          setLoadingContent(false);
          if (!done) toast.error("The workstation did not send the conversation. Is the gateway running?");
        }
      }, 2000);
    } catch (err) {
      setLoadingContent(false);
      toast.error(err instanceof Error ? err.message : "Could not ask the workstation for it");
    }
  };

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading conversation…
      </div>
    );
  }

  const toolName = conversation.integration === "codex" ? "Codex" : conversation.integration === "antigravity" ? "Antigravity" : conversation.integration;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BackLink />

      <div className="space-y-2">
        <h1 className="text-xl font-bold text-foreground">{conversation.title || "Untitled conversation"}</h1>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{toolName}</span>
          <span>Started {new Date(conversation.startedAt).toLocaleString()}</span>
          <span>Last activity {formatRelative(conversation.updatedAt, now)}</span>
          {conversation.model && <span>{conversation.model}</span>}
          {conversation.workspace && <span>{conversation.workspace}</span>}
          <span>{conversation.messageCount} messages</span>
          <span>{conversation.toolCallCount} tool calls</span>
          {conversation.tokens && (
            <span title={`input ${conversation.tokens.input.toLocaleString()} · cached ${conversation.tokens.cachedInput.toLocaleString()} · output ${conversation.tokens.output.toLocaleString()} · reasoning ${conversation.tokens.reasoning.toLocaleString()}`}>
              {formatTokens(conversation.tokens.total)} tokens
            </span>
          )}
        </div>
      </div>

      {!conversation.hasTranscript ? (
        <Card>
          <CardContent className="flex items-start gap-3 py-5 text-sm text-muted-foreground">
            <FileX className="mt-0.5 h-4 w-4 shrink-0" />
            {toolName} kept no readable transcript for this conversation on your workstation, so there are no messages
            to show.
          </CardContent>
        </Card>
      ) : !conversation.contentSynced ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Messages are not synced</CardTitle>
            <CardDescription>
              Only the title and details are imported by default. Load this conversation to fetch its messages from
              your workstation — they are redacted there before they are sent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void requestContent()} disabled={loadingContent}>
              {loadingContent ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {loadingContent ? "Fetching from your workstation…" : "Load conversation"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Synced {conversation.contentSyncedAt ? formatRelative(conversation.contentSyncedAt, now) : ""} ·{" "}
              {items.length} items
            </span>
            <Button size="sm" variant="ghost" onClick={() => void requestContent()} disabled={loadingContent}>
              {loadingContent && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Refresh from workstation
            </Button>
          </div>
          {conversation.contentTruncated && (
            <p className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
              <Scissors className="h-3.5 w-3.5" /> This conversation is very long; only its first part was synced.
            </p>
          )}
          <div className="space-y-3">
            {items.map((item) => (
              <Item key={item.seq} item={item} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/history" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> History
    </Link>
  );
}

function Shortened({ item }: { item: HistoryItem }) {
  return item.truncated ? (
    <Badge variant="outline" className="ml-2 text-[10px]">
      shortened
    </Badge>
  ) : null;
}

function Item({ item }: { item: HistoryItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
            {item.text}
            <Shortened item={item} />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm">
          {item.text}
          <Shortened item={item} />
        </div>
      );
    case "thinking":
      return (
        <details className="text-xs text-muted-foreground">
          <summary className="flex cursor-pointer select-none items-center gap-1.5">
            <Brain className="h-3.5 w-3.5" /> Reasoning
          </summary>
          <div className="mt-1.5 whitespace-pre-wrap break-words border-l-2 pl-3">{item.text}</div>
        </details>
      );
    case "tool_call":
      return (
        <details className="rounded-md border bg-muted/30 text-xs">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 font-medium">
            <Wrench className="h-3.5 w-3.5" /> {item.toolName ?? "tool"}
            <Shortened item={item} />
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t px-3 py-2 font-mono">{item.text}</pre>
        </details>
      );
    case "tool_result":
      return (
        <details className="ml-6 rounded-md border text-xs">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-muted-foreground">
            <Terminal className="h-3.5 w-3.5" /> Result
            <Shortened item={item} />
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t px-3 py-2 font-mono">{item.text}</pre>
        </details>
      );
    case "error":
    case "tool_error":
      return (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{item.text}</span>
        </div>
      );
    default:
      return (
        <p className="whitespace-pre-wrap text-center text-[11px] text-muted-foreground">{item.text}</p>
      );
  }
}
