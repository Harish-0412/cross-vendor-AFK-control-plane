"use client";

import { useEffect, useState } from "react";
import { Github, CheckCircle2, Loader2, Plug, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api-client";
import { AiToolIntegrations } from "@/components/integrations/AiToolIntegrations";

interface Integration {
  id: string;
  provider: "github" | "gitlab" | "bitbucket";
  configured?: boolean;
  connected: boolean;
  username?: string;
  displayName?: string;
  scopes?: string[];
  connectedAt?: string;
}

const providerMeta = {
  github: {
    name: "GitHub",
    icon: Github,
    description:
      "Connect to GitHub to enable AI-driven pull request creation and review.",
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
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);

  const refreshIntegrations = () => {
    setLoading(true);
    return apiClient
      .get<{ integrations: Integration[] }>("/api/v1/integrations")
      .then((data) => setIntegrations(data.integrations ?? []))
      .catch(() => {
        setIntegrations([]);
        setConnectionError(
          "We could not retrieve your version-control connections. Check your connection and try again.",
        );
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void refreshIntegrations();
  }, []);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const provider = parameters.get("provider");
    const result = parameters.get("connection");
    if (result === "connected" && provider && provider in providerMeta) {
      setConnectionNotice(
        providerMeta[provider as keyof typeof providerMeta].name +
          " was verified and connected securely.",
      );
      void refreshIntegrations();
    }
    if (result === "failed") {
      setConnectionError(
        "The provider could not verify this connection. No access was saved; please try again.",
      );
    }
    if (result) window.history.replaceState({}, "", "/integrations");
  }, []);

  const getIntegration = (provider: string) =>
    integrations.find((i) => i.provider === provider);

  const handleConnect = async (provider: keyof typeof providerMeta) => {
    setConnectionError(null);
    setConnectionNotice(null);
    setConnecting(provider);
    try {
      const response = await apiClient.get<{ authorizationUrl: string }>(
        providerMeta[provider].oauthPath,
      );
      if (!response.authorizationUrl)
        throw new Error("Authorization link missing");
      window.location.assign(response.authorizationUrl);
    } catch {
      setConnectionError(
        "Could not start the " +
          providerMeta[provider].name +
          " connection. Check that its OAuth app is configured on the Control Plane.",
      );
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (provider: keyof typeof providerMeta) => {
    setConnectionError(null);
    try {
      await apiClient.delete("/api/v1/integrations/" + provider);
      setIntegrations((previous) =>
        previous.map((integration) =>
          integration.provider === provider
            ? {
                ...integration,
                connected: false,
                username: undefined,
                displayName: undefined,
                connectedAt: undefined,
              }
            : integration,
        ),
      );
      setConnectionNotice(
        providerMeta[provider].name +
          " access was disconnected and its encrypted credential was removed.",
      );
    } catch {
      setConnectionError(
        "Could not disconnect " +
          providerMeta[provider].name +
          ". Please try again.",
      );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Connect the AI coding tools on your computer, and your version control
          providers
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            AI coding tools
          </h2>
          <p className="text-sm text-muted-foreground">
            See past conversations and plan usage from tools that run on your
            workstation. Access is approved on that computer, and you can revoke
            it at any time.
          </p>
        </div>
        <AiToolIntegrations />
      </section>

      <h2 className="text-lg font-semibold text-foreground">Version control</h2>

      {connectionNotice && (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {connectionNotice}
        </div>
      )}
      {connectionError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {connectionError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(providerMeta) as Array<keyof typeof providerMeta>).map(
            (provider) => {
              const meta = providerMeta[provider];
              const integration = getIntegration(provider);
              const connected = integration?.connected ?? false;
              const configured = integration?.configured ?? false;
              const Icon = meta.icon;

              return (
                <Card
                  key={provider}
                  className={connected ? "border-emerald-500/30" : ""}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                          <Icon className="h-5 w-5 text-foreground" />
                        </div>
                        <CardTitle className="text-base">{meta.name}</CardTitle>
                      </div>
                      {connected ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                        >
                          <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                          Connected
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] text-muted-foreground"
                        >
                          Not connected
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-xs mt-2">
                      {meta.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    {connected && integration?.username && (
                      <div className="rounded-md bg-muted/50 px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          Authenticated as
                        </p>
                        <p className="text-sm font-medium">
                          {integration.displayName ??
                            "@" + integration.username}
                        </p>
                        {integration.displayName && (
                          <p className="text-xs text-muted-foreground">
                            @{integration.username}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-1">
                      {meta.scopes.map((scope) => (
                        <Badge
                          key={scope}
                          variant="secondary"
                          className="text-[10px] font-mono"
                        >
                          {scope}
                        </Badge>
                      ))}
                    </div>

                    {!connected ? (
                      <Button
                        size="sm"
                        className="w-full gap-2"
                        onClick={() => handleConnect(provider)}
                        disabled={!configured || connecting === provider}
                      >
                        {connecting === provider ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Icon className="h-4 w-4" />
                        )}
                        {configured ? "Connect " + meta.name : "Setup required"}
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
                    {!connected && !configured && (
                      <p className="text-xs text-muted-foreground">
                        This server has no {meta.name} OAuth app yet. Set{" "}
                        <code className="text-foreground">
                          {provider.toUpperCase()}_CLIENT_ID
                        </code>
                        ,{" "}
                        <code className="text-foreground">
                          {provider.toUpperCase()}_CLIENT_SECRET
                        </code>{" "}
                        and{" "}
                        <code className="text-foreground">
                          {provider.toUpperCase()}_CALLBACK_URL
                        </code>{" "}
                        on the Control Plane, then reload.
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}
