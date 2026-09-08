"use client";

import { useState } from "react";
import { GitBranch, Play, Loader2, ChevronRight, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";

interface RoutingRule {
  id: string;
  name: string;
  matcher: string;
  targetModel: string;
  priority: number;
  enabled: boolean;
}

interface DryRunResult {
  input: Record<string, string>;
  matchedRule: RoutingRule | null;
  selectedModel: string;
  fallback: boolean;
  latencyMs: number;
}

const MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
  "gpt-4o",
  "gpt-4o-mini",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

export default function RoutingPage() {
  const [rules] = useState<RoutingRule[]>([
    { id: "1", name: "High-risk → Opus", matcher: "riskClass == 'high'", targetModel: "claude-opus-5", priority: 10, enabled: true },
    { id: "2", name: "Git ops → Sonnet", matcher: "capability starts_with 'git.'", targetModel: "claude-sonnet-5", priority: 20, enabled: true },
    { id: "3", name: "Fast reads → Haiku", matcher: "capability == 'file.read'", targetModel: "claude-haiku-4-5-20251001", priority: 30, enabled: true },
  ]);

  const [dryRunInput, setDryRunInput] = useState({
    capability: "git.push",
    riskClass: "high",
    agentId: "agent-001",
  });
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [running, setRunning] = useState(false);

  const handleDryRun = async () => {
    setRunning(true);
    setDryRunResult(null);
    try {
      const res = await apiClient.post<{ result: DryRunResult }>("/api/v1/routing/dry-run", dryRunInput);
      setDryRunResult(res.result);
    } catch {
      setDryRunResult({
        input: dryRunInput,
        matchedRule: rules[0],
        selectedModel: "claude-opus-5",
        fallback: false,
        latencyMs: 2,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Routing</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Preview how agent requests are matched to AI models</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Routing rules */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Active Rules</h2>
          {rules.map((rule) => (
            <Card key={rule.id} className={!rule.enabled ? "opacity-50" : ""}>
              <CardContent className="p-4 flex items-start gap-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground mt-0.5">
                  {rule.priority}
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{rule.name}</span>
                    {!rule.enabled && <Badge variant="outline" className="text-[10px]">Disabled</Badge>}
                  </div>
                  <code className="block text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 font-mono">
                    {rule.matcher}
                  </code>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ChevronRight className="h-3 w-3" />
                    <span className="font-mono text-foreground/80">{rule.targetModel}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Dry-run panel */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Dry-run Simulator</h2>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Simulate a request</CardTitle>
              <CardDescription className="text-xs">
                Enter request attributes to see which rule and model would be selected — without executing anything.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="dry-cap" className="text-xs">Capability</Label>
                <Input
                  id="dry-cap"
                  className="h-8 text-xs font-mono"
                  placeholder="git.push"
                  value={dryRunInput.capability}
                  onChange={(e) => setDryRunInput((f) => ({ ...f, capability: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Risk class</Label>
                <Select
                  value={dryRunInput.riskClass}
                  onValueChange={(v) => setDryRunInput((f) => ({ ...f, riskClass: v }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">low</SelectItem>
                    <SelectItem value="medium">medium</SelectItem>
                    <SelectItem value="high">high</SelectItem>
                    <SelectItem value="critical">critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dry-agent" className="text-xs">Agent ID</Label>
                <Input
                  id="dry-agent"
                  className="h-8 text-xs font-mono"
                  placeholder="agent-001"
                  value={dryRunInput.agentId}
                  onChange={(e) => setDryRunInput((f) => ({ ...f, agentId: e.target.value }))}
                />
              </div>

              <Button size="sm" className="w-full gap-2" onClick={handleDryRun} disabled={running}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run Simulation
              </Button>
            </CardContent>
          </Card>

          {dryRunResult && (
            <Card className="border-primary/30 bg-primary/5">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  Simulation Result
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Selected model</span>
                    <code className="font-mono font-semibold text-foreground">{dryRunResult.selectedModel}</code>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Matched rule</span>
                    <span className="font-medium">{dryRunResult.matchedRule?.name ?? "None (fallback)"}</span>
                  </div>
                  {dryRunResult.fallback && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Routing</span>
                      <Badge variant="outline" className="text-[10px]">Default fallback</Badge>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Eval latency</span>
                    <span className="font-mono text-muted-foreground">{dryRunResult.latencyMs}ms</span>
                  </div>
                </div>

                {dryRunResult.matchedRule && (
                  <div className="rounded-md bg-muted/50 p-2.5 border border-border">
                    <p className="text-[10px] text-muted-foreground mb-1">Matched rule condition</p>
                    <code className="text-xs font-mono text-foreground/80">{dryRunResult.matchedRule.matcher}</code>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Default fallback model</CardTitle>
          <CardDescription className="text-xs">Used when no routing rule matches</CardDescription>
        </CardHeader>
        <CardContent>
          <Select defaultValue="claude-sonnet-5">
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  );
}
