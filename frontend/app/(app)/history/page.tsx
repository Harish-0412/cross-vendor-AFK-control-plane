"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Bot,
  FileX,
  History as HistoryIcon,
  Info,
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
  type HistorySearchInfo,
  type ImportedConversation,
  type IntegrationId,
} from "@/lib/ai-integrations";

const TOOL_META: Partial<Record<IntegrationId, { name: string; icon: typeof Bot }>> = {
  codex: { name: "Codex", icon: Bot },
  antigravity: { name: "Antigravity", icon: Sparkles },
  claude: { name: "Claude Code", icon: Bot },
  "chatgpt-export": { name: "ChatGPT", icon: Bot },
};

/** Long enough that a stray keystroke does not cost a request. */
const SEARCH_DEBOUNCE_MS = 300;

function HistoryList() {
  const params = useSearchParams();
  const initial = params?.get("integration");
  const [filter, setFilter] = useState<string>(
    initial === "codex" || initial === "antigravity" ? initial : "all",
  );
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [conversations, setConversations] = useState<ImportedConversation[] | null>(null);
  const [search, setSearch] = useState<HistorySearchInfo | undefined>();
  const [searching, setSearching] = useState(false);
  const [now] = useState(() => Date.now());
  // Guards against an earlier request landing after a later one and showing
  // results for a query the user has already moved on from.
  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const seq = (requestSeq.current += 1);
      if (debounced) setSearching(true);
      return aiIntegrations
        .history(debounced ? { query: debounced } : {})
        .then((page) => {
          if (cancelled || seq !== requestSeq.current) return;
          setConversations(page.conversations);
          setSearch(page.search);
          setSearching(false);
        })
        .catch(() => {
          if (cancelled || seq !== requestSeq.current) return;
          setConversations([]);
          setSearching(false);
        });
    };
    void load();
    // A fresh connection imports in the background; keep the list current.
    // Polling pauses during a search so results do not shuffle underfoot.
    if (debounced) return () => {
      cancelled = true;
    };
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [debounced]);

  const visible = useMemo(
    () =>
      (conversations ?? []).filter(
        (conversation) => filter === "all" || conversation.integration === filter,
      ),
    [conversations, filter],
  );

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: conversations?.length ?? 0 };
    for (const conversation of conversations ?? []) {
      result[conversation.integration] = (result[conversation.integration] ?? 0) + 1;
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
          Past conversations from the AI coding tools you connected, imported from your workstation.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList>
                <TabsTrigger value="all">All ({counts.all ?? 0})</TabsTrigger>
                <TabsTrigger value="codex">Codex ({counts.codex ?? 0})</TabsTrigger>
                <TabsTrigger value="antigravity">Antigravity ({counts.antigravity ?? 0})</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative min-w-[220px] flex-1">
              {searching ? (
                <Loader2 className="absolute left-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              )}
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search titles, folders and loaded messages"
                className="h-9 pl-8"
              />
            </div>
          </div>

          {search && <SearchCoverage search={search} results={visible.length} />}

          {conversations === null ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
            </div>
          ) : conversations.length === 0 && !debounced ? (
            <Card>
              <CardContent className="space-y-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">No imported conversations yet.</p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/integrations">Connect Codex or Antigravity</Link>
                </Button>
              </CardContent>
            </Card>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {debounced ? `Nothing matches “${debounced}”.` : "Nothing matches."}
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
                            <span className="text-muted-foreground">Untitled conversation</span>
                          )}
                        </span>
                        {!conversation.hasTranscript && (
                          <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
                            <FileX className="h-3 w-3" /> No transcript
                          </Badge>
                        )}
                        {conversation.contentSynced && (
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            Content synced
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span>{tool?.name ?? conversation.integration}</span>
                        <span>{formatRelative(conversation.updatedAt, now)}</span>
                        {conversation.hasTranscript && <span>{conversation.messageCount} messages</span>}
                        {conversation.toolCallCount > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Wrench className="h-3 w-3" /> {conversation.toolCallCount}
                          </span>
                        )}
                        {conversation.tokens && <span>{formatTokens(conversation.tokens.total)} tokens</span>}
                        {conversation.model && <span>{conversation.model}</span>}
                        {conversation.workspace && <span className="truncate">{conversation.workspace}</span>}
                      </div>
                      {conversation.match?.field === "messages" && (
                        <p className="mt-1.5 line-clamp-2 rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                          <Highlighted text={conversation.match.excerpt} needle={debounced} />
                          {conversation.match.hits > 1 && (
                            <span className="ml-1 opacity-70">
                              · {conversation.match.hits >= 99 ? "99+" : conversation.match.hits} matches
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Remaining usage</h2>
          <ProviderLimits compact />
        </aside>
      </div>
    </div>
  );
}

/**
 * What the search could actually look at.
 *
 * Without this, "no results" is ambiguous: a conversation whose content has
 * never been loaded has only a title on this side, so its messages genuinely
 * were not searched. Saying so is the difference between a useful empty result
 * and a misleading one.
 */
function SearchCoverage({
  search,
  results,
}: {
  search: HistorySearchInfo;
  results: number;
}) {
  const { searchableConversations, titleOnlyConversations } = search;
  return (
    <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {results} {results === 1 ? "result" : "results"}. Searched the messages of{" "}
        {searchableConversations}{" "}
        {searchableConversations === 1 ? "conversation" : "conversations"} you have loaded
        {titleOnlyConversations > 0 && (
          <>
            , and the titles of {titleOnlyConversations} more. Open a conversation and choose{" "}
            <span className="font-medium">Load conversation</span> to make its messages searchable
          </>
        )}
        .
      </span>
    </p>
  );
}

/** Marks the matched text inside an excerpt. Plain text only — never HTML. */
function Highlighted({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-primary/20 px-0.5 text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<div className="py-10 text-sm text-muted-foreground">Loading…</div>}>
      <HistoryList />
    </Suspense>
  );
}
