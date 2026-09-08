"use client";

import { useEffect, useState } from "react";
import { Github, CheckCircle2, Loader2, Plug, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api-client";

interface Integration {
  id: string;
  provider: "github" | "gitlab" | "bitbucket";
  connected: boolean;
  username?: string;
  scopes?: string[];
  connectedAt?: string;
}

const providerMeta = {
  github: {
    name: "GitHub",
    icon: Github,
    description: "Connect to GitHub to enable AI-driven pull request creation and review.",
    scopes: ["repo", "read:org"],
    oauthPath: "/api/v1/integrations/github/oauth/start",
  },
  gitlab: {
    name: "GitLab",
    icon: Plug,
    description: "Connect to GitLab for merge request automation.",
    scopes: ["api"],
    oauthPath: "/api/v1/integrations/gitlab/oauth/start",
  },
  bitbucket: {
    name: "Bitbucket",
    icon: Plug,
    description: "Connect to Bitbucket Cloud for pull request workflows.",
    scopes: ["repository:write"],
    oauthPath: "/api/v1/integrations/bitbucket/oauth/start",
  },
};

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<{ integrations: Integration[] }>("/api/v1/integrations")
      .then((d) => setIntegrations(d.integrations ?? []))
      .catch(() => setIntegrations([]))
      .finally(() => setLoading(false));
  }, []);

  const getIntegration = (provider: string) =>
    integrations.find((i) => i.provider === provider);

  const handleConnect = async (provider: keyof typeof providerMeta) => {
    setConnecting(provider);
    try {
      const res = await apiClient.get<{ url: string }>(providerMeta[provider].oauthPath);
      if (res.url) {
        window.location.href = res.url;
      }
    } catch {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (provider: string) => {
    await apiClient.delete(`/api/v1/integrations/${provider}`);
    setIntegrations((prev) => prev.map((i) => (i.provider === provider ? { ...i, connected: false, username: undefined } : i)));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Connect version control providers to enable AI-driven git workflows</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(providerMeta) as Array<keyof typeof providerMeta>).map((provider) => {
            const meta = providerMeta[provider];
            const integration = getIntegration(provider);
            const connected = integration?.connected ?? false;
            const Icon = meta.icon;

            return (
              <Card key={provider} className={connected ? "border-emerald-500/30" : ""}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                        <Icon className="h-5 w-5 text-foreground" />
                      </div>
                      <CardTitle className="text-base">{meta.name}</CardTitle>
                    </div>
                    {connected ? (
                      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                        Connected
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        Not connected
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="text-xs mt-2">{meta.description}</CardDescription>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  {connected && integration?.username && (
                    <div className="rounded-md bg-muted/50 px-3 py-2">
                      <p className="text-xs text-muted-foreground">Authenticated as</p>
                      <p className="text-sm font-medium">@{integration.username}</p>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1">
                    {meta.scopes.map((scope) => (
                      <Badge key={scope} variant="secondary" className="text-[10px] font-mono">
                        {scope}
                      </Badge>
                    ))}
                  </div>

                  {!connected ? (
                    <Button
                      size="sm"
                      className="w-full gap-2"
                      onClick={() => handleConnect(provider)}
                      disabled={connecting === provider}
                    >
                      {connecting === provider ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Icon className="h-4 w-4" />
                      )}
                      Connect {meta.name}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full gap-2 text-destructive hover:text-destructive"
                      onClick={() => handleDisconnect(provider)}
                    >
                      <AlertCircle className="h-4 w-4" />
                      Disconnect
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
