"use client";

import { use, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  GitBranch,
  HardDrive,
  Link2,
  Loader2,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";

type VcsProvider = "github" | "gitlab" | "bitbucket";

interface RepositoryBinding {
  provider: VcsProvider;
  fullName: string;
  defaultBranch?: string;
  webUrl?: string;
}

interface Project {
  id: string;
  name: string;
  root: string;
  preferences: {
    defaultBranch?: string;
    repository?: RepositoryBinding;
    githubRepository?: string;
    protectedBranches: string[];
  };
  updatedAt: string;
}

interface ProjectDashboard {
  project: Project;
  workspace: { root: string };
  repository: { binding: RepositoryBinding | null };
  defaultBranch: string;
  activeSessions: Array<{ id: string; agentId: string; state: string }>;
  pendingApprovals: Array<{ id: string }>;
}

interface Integration {
  provider: VcsProvider;
  configured: boolean;
  connected: boolean;
  username?: string;
}

interface RepositorySummary extends RepositoryBinding {
  name: string;
  private?: boolean;
}

const providerNames: Record<VcsProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [dashboard, setDashboard] = useState<ProjectDashboard | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const [provider, setProvider] = useState<VcsProvider | null>(null);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const connectedProviders = integrations.filter(
    (integration) => integration.connected,
  );
  const repository =
    dashboard?.repository.binding ??
    dashboard?.project.preferences.repository ??
    null;

  const load = () => {
    setLoading(true);
    return Promise.all([
      apiClient.get<ProjectDashboard>("/api/v1/projects/" + id + "/dashboard"),
      apiClient.get<{ integrations: Integration[] }>("/api/v1/integrations"),
    ])
      .then(([projectDashboard, integrationResult]) => {
        setDashboard(projectDashboard);
        setIntegrations(integrationResult.integrations ?? []);
      })
      .catch((cause: unknown) => {
        setMessage(
          cause instanceof Error
            ? cause.message
            : "Could not load this project",
        );
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void load();
  }, [id]);

  const loadRepositories = async (nextProvider: VcsProvider) => {
    setLoadingRepositories(true);
    setRepositories([]);
    try {
      const result = await apiClient.get<{ repositories: RepositorySummary[] }>(
        "/api/v1/integrations/" + nextProvider + "/repositories",
      );
      setRepositories(result.repositories ?? []);
    } catch (cause: unknown) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Could not retrieve repositories for this account",
      );
    } finally {
      setLoadingRepositories(false);
    }
  };

  const openLinkDialog = () => {
    setMessage(null);
    const selected =
      repository?.provider ?? connectedProviders[0]?.provider ?? null;
    setProvider(selected);
    setLinkOpen(true);
    if (selected) void loadRepositories(selected);
  };

  const selectProvider = (value: string) => {
    const selected = value as VcsProvider;
    setProvider(selected);
    void loadRepositories(selected);
  };

  const linkRepository = async (selected: RepositorySummary) => {
    if (!dashboard) return;
    setLinking(true);
    setMessage(null);
    try {
      const updatedProject = await apiClient.patch<Project>(
        "/api/v1/projects/" + id + "/preferences",
        {
          repository: {
            provider: selected.provider,
            fullName: selected.fullName,
            defaultBranch: selected.defaultBranch,
            webUrl: selected.webUrl,
          },
        },
      );
      const binding = updatedProject.preferences.repository ?? {
        provider: selected.provider,
        fullName: selected.fullName,
        defaultBranch: selected.defaultBranch,
        webUrl: selected.webUrl,
      };
      setDashboard((current) =>
        current
          ? {
              ...current,
              project: updatedProject,
              repository: { binding },
              defaultBranch: binding.defaultBranch ?? current.defaultBranch,
            }
          : current,
      );
      setLinkOpen(false);
      setMessage(
        providerNames[selected.provider] +
          " verified access to " +
          selected.fullName +
          " and linked it to this workspace.",
      );
    } catch (cause: unknown) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Could not link this repository",
      );
    } finally {
      setLinking(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="space-y-4">
        <Link href="/projects">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Projects
          </Button>
        </Link>
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {message ?? "Project not found."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/projects">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 mb-2 gap-2 text-muted-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Projects
            </Button>
          </Link>
          <h1 className="truncate text-2xl font-bold text-foreground">
            {dashboard.project.name}
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" />
            <span className="break-all font-mono">
              {dashboard.workspace.root}
            </span>
          </p>
        </div>
        <Button onClick={openLinkDialog} className="shrink-0 gap-2">
          <Link2 className="h-4 w-4" />
          {repository ? "Change repository" : "Link repository"}
        </Button>
      </div>

      {message && (
        <p
          role="status"
          className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground"
        >
          {message}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Source control</CardTitle>
            <CardDescription>
              Only a repository verified with your connected account can be
              linked here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {repository ? (
              <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    <p className="font-medium">{repository.fullName}</p>
                    <Badge variant="secondary" className="capitalize">
                      {repository.provider}
                    </Badge>
                  </div>
                  <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                    <GitBranch className="h-3.5 w-3.5" />
                    Default branch:{" "}
                    {repository.defaultBranch ?? dashboard.defaultBranch}
                  </p>
                </div>
                {repository.webUrl && (
                  <a
                    href={repository.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button variant="outline" size="sm">
                      Open repository
                    </Button>
                  </a>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                <Unplug className="mb-2 h-5 w-5" />
                No repository is linked. Connect a provider on the Integrations
                page, then choose a repository with this workspace’s project
                settings.
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pipeline status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Active agents</span>
              <Badge variant="secondary">
                {dashboard.activeSessions.length}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Approval requests</span>
              <Badge
                variant={
                  dashboard.pendingApprovals.length ? "default" : "secondary"
                }
              >
                {dashboard.pendingApprovals.length}
              </Badge>
            </div>
            <div className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Policies apply before pull-request creation.
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Link a source-control repository</DialogTitle>
            <DialogDescription>
              The Control Plane asks the selected provider to verify access
              before saving this connection.
            </DialogDescription>
          </DialogHeader>
          {connectedProviders.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No connected providers are available.{" "}
              <Link
                href="/integrations"
                className="font-medium text-primary hover:underline"
              >
                Connect GitHub, GitLab, or Bitbucket first.
              </Link>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  Connected provider
                </label>
                <Select
                  value={provider ?? undefined}
                  onValueChange={selectProvider}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {connectedProviders.map((integration) => (
                      <SelectItem
                        key={integration.provider}
                        value={integration.provider}
                      >
                        {providerNames[integration.provider]}
                        {integration.username
                          ? " · @" + integration.username
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {loadingRepositories ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : repositories.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No accessible repositories were returned. Check the provider
                  account’s repository permissions, then reconnect if needed.
                </p>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {repositories.map((item) => (
                    <button
                      key={item.fullName}
                      type="button"
                      disabled={linking}
                      onClick={() => void linkRepository(item)}
                      className="flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/50 disabled:opacity-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {item.fullName}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.defaultBranch ?? "default branch unavailable"}
                          {item.private ? " · private" : ""}
                        </span>
                      </span>
                      {linking ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Link2 className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
