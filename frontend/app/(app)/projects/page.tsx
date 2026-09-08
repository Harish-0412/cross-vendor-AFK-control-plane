"use client";

import { useEffect, useState } from "react";
import { Plus, FolderGit2, ExternalLink, GitBranch, Clock, Loader2 } from "lucide-react";
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
import Link from "next/link";

interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  lastActivity: string;
  openPRs: number;
  status: "active" | "idle" | "locked";
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState({ name: "", repoUrl: "", defaultBranch: "main" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiClient
      .get<{ projects: Project[] }>("/api/v1/projects")
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, []);

  const handleRegister = async () => {
    if (!form.name.trim() || !form.repoUrl.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiClient.post<{ project: Project }>("/api/v1/projects", form);
      setProjects((prev) => [res.project, ...prev]);
      setRegisterOpen(false);
      setForm({ name: "", repoUrl: "", defaultBranch: "main" });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to register project");
    } finally {
      setSubmitting(false);
    }
  };

  const statusColor: Record<Project["status"], string> = {
    active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    idle: "bg-muted text-muted-foreground border-border",
    locked: "bg-destructive/10 text-destructive border-destructive/20",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage git repositories and review AI-generated changes</p>
        </div>
        <Button onClick={() => setRegisterOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Register Project
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : projects.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <FolderGit2 className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="font-medium text-foreground">No projects registered</p>
              <p className="text-sm text-muted-foreground mt-1">Register a git repository to start reviewing AI changes</p>
            </div>
            <Button onClick={() => setRegisterOpen(true)} variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              Register your first project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold truncate">{project.name}</CardTitle>
                    <Badge
                      variant="outline"
                      className={`text-[10px] uppercase tracking-wide shrink-0 ${statusColor[project.status]}`}
                    >
                      {project.status}
                    </Badge>
                  </div>
                  <a
                    href={project.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground truncate mt-1"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{project.repoUrl.replace(/^https?:\/\//, "")}</span>
                  </a>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      {project.defaultBranch}
                    </span>
                    {project.openPRs > 0 && (
                      <span className="flex items-center gap-1 text-amber-500">
                        <FolderGit2 className="h-3 w-3" />
                        {project.openPRs} open PR{project.openPRs !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Last activity: {new Date(project.lastActivity).toLocaleDateString()}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="proj-name">Project name</Label>
              <Input
                id="proj-name"
                placeholder="my-agent-project"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-repo">Repository URL</Label>
              <Input
                id="proj-repo"
                placeholder="https://github.com/org/repo"
                value={form.repoUrl}
                onChange={(e) => setForm((f) => ({ ...f, repoUrl: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-branch">Default branch</Label>
              <Input
                id="proj-branch"
                placeholder="main"
                value={form.defaultBranch}
                onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegisterOpen(false)}>Cancel</Button>
            <Button onClick={handleRegister} disabled={submitting} className="gap-2">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Register
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
