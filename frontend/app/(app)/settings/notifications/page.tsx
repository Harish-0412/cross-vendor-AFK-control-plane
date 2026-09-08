"use client";

import { useEffect, useState } from "react";
import { Bell, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api-client";

interface NotificationPrefs {
  approvalRequired: boolean;
  approvalRequired_push: boolean;
  approvalRequired_email: boolean;
  killSwitchTriggered: boolean;
  killSwitchTriggered_push: boolean;
  killSwitchTriggered_email: boolean;
  budgetWarning: boolean;
  budgetWarning_push: boolean;
  budgetWarning_email: boolean;
  sessionEnded: boolean;
  sessionEnded_push: boolean;
  sessionEnded_email: boolean;
  policyViolation: boolean;
  policyViolation_push: boolean;
  policyViolation_email: boolean;
  weeklyDigest: boolean;
  weeklyDigest_email: boolean;
  emailAddress: string;
}

const defaultPrefs: NotificationPrefs = {
  approvalRequired: true,
  approvalRequired_push: true,
  approvalRequired_email: true,
  killSwitchTriggered: true,
  killSwitchTriggered_push: true,
  killSwitchTriggered_email: false,
  budgetWarning: true,
  budgetWarning_push: false,
  budgetWarning_email: true,
  sessionEnded: false,
  sessionEnded_push: false,
  sessionEnded_email: false,
  policyViolation: true,
  policyViolation_push: true,
  policyViolation_email: true,
  weeklyDigest: true,
  weeklyDigest_email: true,
  emailAddress: "",
};

const notificationGroups = [
  {
    key: "approvalRequired",
    label: "Approval required",
    description: "An agent action needs your review before proceeding",
    hasPush: true,
    hasEmail: true,
  },
  {
    key: "killSwitchTriggered",
    label: "Kill switch triggered",
    description: "An agent has been stopped via the kill switch",
    hasPush: true,
    hasEmail: true,
  },
  {
    key: "budgetWarning",
    label: "Budget warning",
    description: "Spend is approaching or has exceeded a configured limit",
    hasPush: true,
    hasEmail: true,
  },
  {
    key: "sessionEnded",
    label: "Session ended",
    description: "An agent session has completed or timed out",
    hasPush: true,
    hasEmail: true,
  },
  {
    key: "policyViolation",
    label: "Policy violation",
    description: "An agent was blocked by a policy rule",
    hasPush: true,
    hasEmail: true,
  },
  {
    key: "weeklyDigest",
    label: "Weekly digest",
    description: "Summary of all agent activity from the past week",
    hasPush: false,
    hasEmail: true,
  },
] as const;

export default function NotificationsPage() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(defaultPrefs);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiClient
      .get<{ preferences: NotificationPrefs }>("/api/v1/settings/notifications")
      .then((d) => setPrefs({ ...defaultPrefs, ...(d.preferences ?? {}) }))
      .catch(() => setPrefs(defaultPrefs))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiClient.patch("/api/v1/settings/notifications", prefs);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Notifications</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Choose how and when to be notified about agent activity</p>
        </div>
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saved ? "Saved!" : "Save"}
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Delivery channels
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            <Label htmlFor="email-addr" className="text-xs">Email address for notifications</Label>
            <Input
              id="email-addr"
              type="email"
              placeholder="you@example.com"
              className="max-w-sm"
              value={prefs.emailAddress}
              onChange={(e) => set("emailAddress", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {notificationGroups.map((group) => {
          const enabledKey = group.key as keyof NotificationPrefs;
          const enabled = prefs[enabledKey] as boolean;

          return (
            <Card key={group.key}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{group.label}</p>
                    </div>
                    <CardDescription className="text-xs">{group.description}</CardDescription>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(v) => set(enabledKey, v)}
                  />
                </div>

                {enabled && (
                  <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-4">
                    {group.hasPush && (
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`${group.key}-push`}
                          checked={prefs[`${group.key}_push` as keyof NotificationPrefs] as boolean}
                          onCheckedChange={(v) => set(`${group.key}_push` as keyof NotificationPrefs, v)}
                          className="scale-75"
                        />
                        <Label htmlFor={`${group.key}-push`} className="text-xs text-muted-foreground">Push</Label>
                      </div>
                    )}
                    {group.hasEmail && (
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`${group.key}-email`}
                          checked={prefs[`${group.key}_email` as keyof NotificationPrefs] as boolean}
                          onCheckedChange={(v) => set(`${group.key}_email` as keyof NotificationPrefs, v)}
                          className="scale-75"
                        />
                        <Label htmlFor={`${group.key}-email`} className="text-xs text-muted-foreground">Email</Label>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
