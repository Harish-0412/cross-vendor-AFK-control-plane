import type { RiskAssessment, TaskKind } from '@odysseus/protocol';

/** Pure, explainable scoring. Policy remains the final authority. */
export class RiskEngine {
  assess(input: {
    taskKind: TaskKind;
    prompt: string;
    protectedProject?: boolean;
  }): RiskAssessment {
    const factors: RiskAssessment['factors'] = [];
    let score = 0.1;
    const add = (name: string, weight: number) => {
      score += weight;
      factors.push({ name, weight, contribution: weight });
    };
    if (input.taskKind === 'security_review') add('security-review', 0.1);
    if (input.taskKind === 'implementation') add('implementation-write', 0.2);
    if (input.taskKind === 'planning') add('planning-read-only', -0.05);
    if (input.taskKind === 'test') add('test-execution', 0.1);
    if (/\b(deploy|production|release)\b/i.test(input.prompt)) add('production-keyword', 0.55);
    if (/\b(push|commit|delete|rm\s+-rf)\b/i.test(input.prompt)) add('repository-mutation', 0.35);
    if (input.protectedProject) add('protected-project', 0.15);
    score = Math.max(0, Math.min(1, score));
    const level =
      score >= 0.8 ? 'critical' : score >= 0.55 ? 'high' : score >= 0.25 ? 'medium' : 'low';
    return { score, level, factors, requiresApproval: score >= 0.55 };
  }
}
