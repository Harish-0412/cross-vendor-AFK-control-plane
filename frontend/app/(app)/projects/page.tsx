"use client";

import { useEffect, useState } from "react";
import {
  Plus,
  FolderGit2,
  ExternalLink,
  GitBranch,
  Clock,
  Loader2,
  HardDrive,
} from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api-client";

interface RepositoryBinding {
  provider: "github" | "gitlab" | "bitbucket";
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
  createdAt: string;
  updatedAt: string;
}

function projectRepository(project: Project): RepositoryBinding | null {
  return (
    project.preferences.repository ??
    (project.preferences.githubRepository
      ? { provider: "github", fullName: project.preferences.githubRepository }
      : null)
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState({ name: "", root: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = () => {
    setLoading(true);
    return apiClient
      .get<Project[]>("/api/v1/projects")
      .then((data) => setProjects(Array.isArray(data) ? data : []))
      .catch(() => {
        setProjects([]);
        setError(
          "We could not load your projects. Check your connection and try again.",
        );
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  const handleRegister = async () => {
    if (!form.name.trim() || !form.root.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await apiClient.post<Project>("/api/v1/projects", {
        name: form.name.trim(),
        root: form.root.trim(),
      });
      setProjects((previous) => [
        project,
        ...previous.filter((item) => item.id !== project.id),
      ]);
      setRegisterOpen(false);
      setForm({ name: "", root: "" });
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not register the workspace",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Register a workspace on a trusted device, then securely link its
            source-control repository.
          </p>
        </div>
        <Button
          onClick={() => {
            setError(null);
            setRegisterOpen(true);
          }}
          className="gap-2"
        >
          <Plus className="h-4 w-4" />
          Register workspace
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : projects.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <FolderGit2 className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="font-medium text-foreground">
                No workspaces registered
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Register the local folder your connected gateway is allowed to
                use.
              </p>
            </div>
            <Button
              onClick={() => setRegisterOpen(true)}
              variant="outline"
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              Register your first workspace
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => {
            const repository = projectRepository(project);
            return (
              <Card
                key={project.id}
                className="flex h-full flex-col transition-colors hover:border-primary/50"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="truncate text-base font-semibold">
                      {project.name}
                    </CardTitle>
                    <Badge
                      variant="outline"
                      className={
                        repository
                          ? "border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                          : "text-[10px] text-muted-foreground"
                      }
                    >
                      {repository ? "Repository linked" : "Not linked"}
                    </Badge>
                  </div>
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <HardDrive className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="break-all font-mono">{project.root}</span>
                  </div>
                </CardHeader>
                <CardContent className="mt-auto space-y-3 pt-0">
                  {repository ? (
                    <div className="rounded-md bg-muted/50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">
                          {repository.fullName}
                        </p>
                        {repository.webUrl && (
                          <a
                            href={repository.webUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={"Open " + repository.fullName}
                          >
                            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-foreground" />
                          </a>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                        {repository.provider} ·{" "}
                        {repository.defaultBranch ??
                          project.preferences.defaultBranch ??
                          "main"}
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                      Link GitHub, GitLab, or Bitbucket in project settings to
                      create reviewed pull requests.
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      {project.preferences.defaultBranch ?? "main"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Updated {new Date(project.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <Link href={"/projects/" + project.id} className="block">
                    <Button size="sm" variant="outline" className="w-full">
                      Project settings
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register a workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              The path must be a real local folder on a trusted gateway.
              Odysseus never creates a remote workspace from a repository URL.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="proj-name">Workspace name</Label>
              <Input
                id="proj-name"
                placeholder="my-agent-project"
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-root">Local workspace path</Label>
              <Input
                id="proj-root"
                placeholder={"C:\\Projects\\my-agent-project"}
                value={form.root}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    root: event.target.value,
                  }))
                }
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegisterOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRegister}
              disabled={submitting || !form.name.trim() || !form.root.trim()}
              className="gap-2"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Register workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
