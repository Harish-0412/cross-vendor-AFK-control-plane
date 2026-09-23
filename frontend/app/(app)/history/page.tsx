"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Bot,
  BrainCircuit,
  FileX,
  History as HistoryIcon,
  Loader2,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProviderLimits } from "@/components/integrations/ProviderLimits";
import {
  aiIntegrations,
  formatRelative,
  formatTokens,
  type ImportedConversation,
  type IntegrationId,
} from "@/lib/ai-integrations";
import { realtimeClient } from "@/lib/realtime";

const TOOL_META: Partial<
  Record<IntegrationId, { name: string; icon: typeof Bot }>
> = {
  codex: { name: "Codex", icon: Bot },
  antigravity: { name: "Antigravity", icon: Sparkles },
  claude: { name: "Claude Code", icon: BrainCircuit },
};

function HistoryList() {
  const params = useSearchParams();
  const initial = params?.get("integration");
  const [filter, setFilter] = useState<string>(
    initial === "codex" || initial === "antigravity" || initial === "claude"
      ? initial
      : "all",
  );
  const [query, setQuery] = useState("");
  const [conversations, setConversations] = useState<
    ImportedConversation[] | null
  >(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      aiIntegrations
        .history()
        .then((list) => !cancelled && setConversations(list))
        .catch(() => !cancelled && setConversations([]));
    void load();
    // A fresh connection imports in the background; keep the list current.
    const timer = setInterval(() => void load(), 15_000);
    const unsubscribe = realtimeClient.subscribeAllEvents((message) => {
      if (
        message.type === "integration_data" ||
        message.type === "integration_update"
      )
        void load();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (conversations ?? []).filter(
      (conversation) =>
        (filter === "all" || conversation.integration === filter) &&
        (!needle ||
          conversation.title.toLowerCase().includes(needle) ||
          (conversation.workspace ?? "").toLowerCase().includes(needle)),
    );
  }, [conversations, filter, query]);

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: conversations?.length ?? 0 };
    for (const conversation of conversations ?? []) {
      result[conversation.integration] =
        (result[conversation.integration] ?? 0) + 1;
    }
    return result;
  }, [conversations]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <HistoryIcon className="h-6 w-6" /> History
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Past conversations from the AI coding tools you connected, imported
          from your workstation.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList>
                <TabsTrigger value="all">All ({counts.all ?? 0})</TabsTrigger>
                <TabsTrigger value="codex">
                  Codex ({counts.codex ?? 0})
                </TabsTrigger>
                <TabsTrigger value="antigravity">
                  Antigravity ({counts.antigravity ?? 0})
                </TabsTrigger>
                <TabsTrigger value="claude">
                  Claude ({counts.claude ?? 0})
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search titles and folders"
                className="h-9 pl-8"
              />
            </div>
          </div>

          {conversations === null ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
            </div>
          ) : conversations.length === 0 ? (
            <Card>
              <CardContent className="space-y-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No imported conversations yet.
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/integrations">
                    Connect Codex, Antigravity, or Claude Code
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing matches.
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {visible.map((conversation) => {
                const tool = TOOL_META[conversation.integration];
                const Icon = tool?.icon ?? Bot;
                return (
                  <Link
                    key={conversation.id}
                    href={`/history/${encodeURIComponent(conversation.id)}`}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {conversation.title || (
                            <span className="text-muted-foreground">
                              Untitled conversation
                            </span>
                          )}
                        </span>
                        {!conversation.hasTranscript && (
                          <Badge
                            variant="outline"
                            className="shrink-0 gap-1 text-[10px]"
                          >
                            <FileX className="h-3 w-3" /> No transcript
                          </Badge>
                        )}
                        {conversation.contentSynced && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 text-[10px]"
                          >
                            Content synced
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span>{tool?.name ?? conversation.integration}</span>
                        <span>
                          {formatRelative(conversation.updatedAt, now)}
                        </span>
                        {conversation.hasTranscript && (
                          <span>{conversation.messageCount} messages</span>
                        )}
                        {conversation.toolCallCount > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Wrench className="h-3 w-3" />{" "}
                            {conversation.toolCallCount}
                          </span>
                        )}
                        {conversation.tokens && (
                          <span title="Exact total recorded by the provider; no dollar estimate">
                            {formatTokens(conversation.tokens.total)} tokens
                          </span>
                        )}
                        {conversation.model && (
                          <span>{conversation.model}</span>
                        )}
                        {conversation.workspace && (
                          <span className="truncate">
                            {conversation.workspace}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">
            Remaining usage
          </h2>
          <ProviderLimits compact />
        </aside>
      </div>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense
      fallback={
        <div className="py-10 text-sm text-muted-foreground">Loading…</div>
      }
    >
      <HistoryList />
    </Suspense>
  );
}
