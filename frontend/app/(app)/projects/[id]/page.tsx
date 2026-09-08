"use client";

import { useEffect, useState } from "react";
import { use } from "react";
import { ArrowLeft, GitBranch, GitPullRequest, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DiffViewer } from "@/components/diff-viewer";
import { apiClient } from "@/lib/api-client";

interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  status: "active" | "idle" | "locked";
}

interface PullRequest {
  id: string;
  number: number;
  title: string;
  branch: string;
  status: "open" | "merged" | "closed" | "pending_review";
  createdAt: string;
  patch?: string;
  aiSummary?: string;
}

interface Session {
  id: string;
  agentId: string;
  status: string;
  startedAt: string;
  capability: string;
}

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedPr, setSelectedPr] = useState<PullRequest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiClient.get<{ project: Project }>(`/api/v1/projects/${id}`),
      apiClient.get<{ pullRequests: PullRequest[] }>(`/api/v1/projects/${id}/pull-requests`),
      apiClient.get<{ sessions: Session[] }>(`/api/v1/projects/${id}/sessions`),
    ])
      .then(([projRes, prRes, sessRes]) => {
        setProject(projRes.project);
        const prList = prRes.pullRequests ?? [];
        setPrs(prList);
        setSessions(sessRes.sessions ?? []);
        const first = prList.find((p) => p.status === "open" || p.status === "pending_review");
        if (first) setSelectedPr(first);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  const handleApprove = async (prId: string) => {
    await apiClient.post(`/api/v1/projects/${id}/pull-requests/${prId}/approve`);
    setPrs((prev) => prev.map((p) => (p.id === prId ? { ...p, status: "merged" } : p)));
  };

  const handleReject = async (prId: string) => {
    await apiClient.post(`/api/v1/projects/${id}/pull-requests/${prId}/reject`);
    setPrs((prev) => prev.map((p) => (p.id === prId ? { ...p, status: "closed" } : p)));
  };

  const prStatusIcon = {
    open: <GitPullRequest className="h-4 w-4 text-emerald-500" />,
    pending_review: <Clock className="h-4 w-4 text-amber-500" />,
    merged: <CheckCircle2 className="h-4 w-4 text-violet-500" />,
    closed: <XCircle className="h-4 w-4 text-muted-foreground" />,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <Link href="/projects">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to Projects
          </Button>
        </Link>
        <p className="text-muted-foreground">Project not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/projects">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
            Projects
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{project.name}</h1>
          <div className="flex items-center gap-2 mt-0.5 text-sm text-muted-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            <span>{project.defaultBranch}</span>
          </div>
        </div>
      </div>

      <Tabs defaultValue="prs">
        <TabsList>
          <TabsTrigger value="prs">Pull Requests ({prs.filter(p => p.status !== "closed").length})</TabsTrigger>
          <TabsTrigger value="sessions">Active Sessions ({sessions.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="prs" className="space-y-4 mt-4">
          <div className="grid lg:grid-cols-[320px_1fr] gap-4">
            {/* PR list */}
            <div className="space-y-2">
              {prs.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    No pull requests yet
                  </CardContent>
                </Card>
              ) : (
                prs.map((pr) => (
                  <Card
                    key={pr.id}
                    className={`cursor-pointer transition-colors hover:border-primary/50 ${
                      selectedPr?.id === pr.id ? "border-primary bg-primary/5" : ""
                    }`}
                    onClick={() => setSelectedPr(pr)}
                  >
                    <CardContent className="p-3 space-y-1.5">
                      <div className="flex items-center gap-2">
                        {prStatusIcon[pr.status]}
                        <span className="text-xs font-mono text-muted-foreground">#{pr.number}</span>
                      </div>
                      <p className="text-sm font-medium leading-tight">{pr.title}</p>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <GitBranch className="h-3 w-3" />
                        {pr.branch}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>

            {/* PR detail */}
            <div className="space-y-4">
              {selectedPr ? (
                <>
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base">{selectedPr.title}</CardTitle>
                        <Badge variant="outline" className="text-[10px] uppercase shrink-0">
                          {selectedPr.status.replace("_", " ")}
                        </Badge>
                      </div>
                    </CardHeader>
                    {selectedPr.aiSummary && (
                      <CardContent className="pt-0">
                        <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 p-3">
                          <p className="text-xs font-semibold text-violet-500 mb-1">AI Summary</p>
                          <p className="text-sm text-foreground/80">{selectedPr.aiSummary}</p>
                        </div>
                      </CardContent>
                    )}
                    {(selectedPr.status === "open" || selectedPr.status === "pending_review") && (
                      <CardContent className="pt-0">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="gap-2 flex-1 sm:flex-none"
                            onClick={() => handleApprove(selectedPr.id)}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Approve & Merge
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-2 text-destructive hover:text-destructive flex-1 sm:flex-none"
                            onClick={() => handleReject(selectedPr.id)}
                          >
                            <XCircle className="h-4 w-4" />
                            Reject
                          </Button>
                        </div>
                      </CardContent>
                    )}
                  </Card>

                  {selectedPr.patch ? (
                    <DiffViewer patch={selectedPr.patch} maxHeight="500px" />
                  ) : (
                    <Card className="border-dashed">
                      <CardContent className="py-8 text-center text-sm text-muted-foreground">
                        No diff available for this PR
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <Card className="border-dashed">
                  <CardContent className="py-12 text-center text-sm text-muted-foreground">
                    Select a pull request to view details
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="sessions" className="mt-4">
          {sessions.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No active sessions for this project
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <Card key={session.id}>
                  <CardContent className="p-4 flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium font-mono">{session.agentId}</p>
                      <p className="text-xs text-muted-foreground">{session.capability}</p>
                    </div>
                    <div className="text-right space-y-0.5">
                      <Badge variant="outline" className="text-[10px]">{session.status}</Badge>
                      <p className="text-xs text-muted-foreground">
                        {new Date(session.startedAt).toLocaleTimeString()}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <div className="space-y-2">
            {prs.filter(p => p.status === "merged" || p.status === "closed").map((pr) => (
              <Card key={pr.id}>
                <CardContent className="p-4 flex items-center gap-3">
                  {prStatusIcon[pr.status]}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{pr.title}</p>
                    <p className="text-xs text-muted-foreground">#{pr.number} · {new Date(pr.createdAt).toLocaleDateString()}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {pr.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
            {prs.filter(p => p.status === "merged" || p.status === "closed").length === 0 && (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center text-sm text-muted-foreground">
                  No closed or merged PRs yet
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
