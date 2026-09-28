import { assessAction, RISK_THRESHOLDS, riskLevel } from '@odysseus/policy-engine';
import type { RiskAssessment, TaskKind } from '@odysseus/protocol';

/**
 * Pure, explainable scoring of a task before any agent has acted on it.
 * Policy remains the final authority.
 *
 * A task is only a prompt, so this reads what the prompt asks for — "push to
 * main", "deploy to production", "drop the users table" — not single words.
 * Matching bare words made "add push notifications" or "fix the commit
 * parser" look like repository mutations, and a gate that fires on ordinary
 * work teaches people to approve without reading. Commands quoted in the
 * prompt (`like this`) are scored as the actions they are.
 *
 * Concrete actions an agent takes are scored by `assessAction`, which sees
 * the actual command and file rather than a description of the task.
 */

interface Intent {
  name: string;
  weight: number;
  detail: string;
  pattern: RegExp;
  /** A stronger intent that makes this one redundant. */
  unless?: string;
}

const INTENTS: Intent[] = [
  {
    name: 'production-deploy',
    weight: 0.55,
    detail: 'asks to deploy or publish to production',
    pattern:
      /\b(deploy|release|ship|roll\s*out|publish|promote)\w*\b[^.\n]{0,60}\b(prod|production|live|customers|npm|pypi|registry|app\s*store)\b|\bto\s+prod(uction)?\b|\bproduction\s+(deploy|release)/i,
  },
  {
    name: 'deployment',
    weight: 0.3,
    detail: 'asks to deploy or release',
    // The verb, not the noun: "deploy the API", not "the deployment docs".
    pattern:
      /\b(re)?deploy\b(?!\s+(docs|documentation|notes|guide|page|script))|\b(cut|make|do|create|tag|publish)\s+(a\s+|the\s+)?(new\s+)?release\b/i,
    unless: 'production-deploy',
  },
  {
    name: 'force-push',
    weight: 0.5,
    detail: 'asks to force-push, which rewrites shared history',
    pattern: /\bforce[- ]?push|push\s+(--force|-f)\b|--force-with-lease/i,
  },
  {
    name: 'push',
    weight: 0.35,
    detail: 'asks to push to a remote',
    pattern:
      /\bgit\s+push\b|\bpush\s+(the\s+|your\s+|these\s+|my\s+)?(changes|commits?|branch|code|fix|work|it|them|this|upstream|to\s+(origin|remote|github|gitlab|the\s+remote|main|master))\b/i,
    unless: 'force-push',
  },
  {
    name: 'destructive',
    weight: 0.4,
    detail: 'asks to delete or wipe data',
    pattern:
      /\brm\s+-rf\b|\b(drop|truncate)\s+(the\s+)?\w*\s*(table|database|schema|collection)s?\b|\b(wipe|purge|nuke)\b|\bdelete\s+(the\s+|all\s+(the\s+)?|every\s+)?(\w+\s+){0,3}(database|tables?|buckets?|branch(es)?|repo(sitory)?|directory|folder|data|users|accounts|records|history|backups?)\b/i,
  },
  {
    name: 'secrets',
    weight: 0.2,
    detail: 'involves keys, tokens or credentials',
    pattern:
      /\b(api[_ -]?keys?|secrets?|credentials?|passwords?|private[_ -]keys?|access[_ -]tokens?|\.env)\b/i,
  },
  {
    name: 'infrastructure',
    weight: 0.25,
    detail: 'changes infrastructure',
    pattern:
      /\b(terraform|kubectl|helm|cloudformation|dns\s+records?|firewall|iam\s+(role|polic)|security\s+groups?)\b/i,
  },
  {
    name: 'migration',
    weight: 0.15,
    detail: 'changes a database schema',
    pattern: /\b(migration|migrate|schema\s+change|alter\s+table)\b/i,
  },
  {
    name: 'dependencies',
    weight: 0.1,
    detail: 'adds or upgrades dependencies',
    pattern:
      /\b(upgrade|update|bump|add|install)\b[^.\n]{0,30}\b(dependenc(y|ies)|packages?|librar(y|ies)|sdk)\b/i,
  },
];

const ROLE: Record<TaskKind, { weight: number; detail: string }> = {
  planning: { weight: -0.05, detail: 'plans without changing anything' },
  security_review: { weight: 0, detail: 'reviews without changing anything' },
  test: { weight: 0.1, detail: 'runs tests' },
  implementation: { weight: 0.2, detail: 'changes code' },
  general: { weight: 0, detail: 'unscoped task' },
};

const BASE = 0.1;

export class RiskEngine {
  assess(input: {
    taskKind: TaskKind;
    prompt: string;
    /** Branches the project protects; `main` and `master` always count. */
    protectedBranches?: string[];
  }): RiskAssessment {
    const factors: RiskAssessment['factors'] = [];
    let score = BASE;
    const add = (name: string, weight: number, detail: string) => {
      score += weight;
      factors.push({ name, weight, contribution: weight, detail });
    };

    const role = ROLE[input.taskKind];
    add(`role:${input.taskKind}`, role.weight, role.detail);

    const matched = new Set<string>();
    for (const intent of INTENTS) if (intent.pattern.test(input.prompt)) matched.add(intent.name);
    for (const intent of INTENTS) {
      if (!matched.has(intent.name)) continue;
      if (intent.unless && matched.has(intent.unless)) continue;
      add(intent.name, intent.weight, intent.detail);
    }

    const protectedBranches = new Set(['main', 'master', ...(input.protectedBranches ?? [])]);
    if (matched.has('push') || matched.has('force-push')) {
      const branch = [...protectedBranches].find((name) =>
        new RegExp(
          `\\bpush\\b[^.\\n]{0,40}\\b${escape(name)}\\b|\\b${escape(name)}\\b[^.\\n]{0,20}\\bpush`,
          'i',
        ).test(input.prompt),
      );
      if (branch) add('protected-branch', 0.2, `targets protected branch ${branch}`);
    }

    // `commands like this` in the prompt are scored as the actions they are.
    const commands = [...input.prompt.matchAll(/`([^`\n]{2,200})`/g)].map((match) => match[1]!);
    const worst = commands
      .map((command) => ({
        command,
        risk: assessAction({
          capability: 'process.exec',
          command,
          protectedBranches: [...protectedBranches],
        }),
      }))
      .filter((item) => item.risk.score >= RISK_THRESHOLDS.high)
      .sort((a, b) => b.risk.score - a.risk.score)[0];
    if (worst && worst.risk.score > score)
      add(
        'quoted-command',
        worst.risk.score - score,
        `quotes \`${worst.command}\`: ${worst.risk.summary}`,
      );

    score = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
    return {
      score,
      level: riskLevel(score),
      factors,
      requiresApproval: score >= RISK_THRESHOLDS.high,
    };
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
