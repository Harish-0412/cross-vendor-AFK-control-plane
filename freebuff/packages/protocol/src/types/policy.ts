export type RiskClass = 'low' | 'medium' | 'high' | 'critical';

export type Decision =
  | { decision: 'allow'; policyVersion: string }
  | { decision: 'deny'; policyVersion: string; reason: string; matchedRules?: string[] }
  | {
      decision: 'require_approval'
      policyVersion: string
      requiredRole?: 'owner' | 'admin'
      expiresAt: Date
      matchedRules: string[]
      reason: string
    };

export type TrustProfile = 'supervised' | 'trusted-afk' | 'read-only' | 'locked' | 'default';

export interface PolicyRule {
  id: string;
  description: string;
  match: {
    capability?: Capability;
    riskClass?: RiskClass;
    resourcePattern?: string;
    projectId?: string;
    trustProfile?: TrustProfile;
  };
  effect: 'allow' | 'deny' | 'require_approval';
  requiredRole?: 'owner' | 'admin';
  priority: number;
}

export interface PolicyVersion {
  id: string;
  version: string;
  description: string;
  rules: PolicyRule[];
  createdAt: Date;
  createdBy: string;
  isActive: boolean;
}

export interface PolicyEvaluationContext {
  capability: Capability;
  riskClass: RiskClass;
  resource?: string;
  projectId?: string;
  trustProfile: TrustProfile;
  deviceStatus: 'trusted' | 'revoked' | 'suspended';
  userId: string;
}

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  deviceId: string;
  userId: string;
  capability: Capability;
  riskClass: RiskClass;
  resource?: string;
  projectId?: string;
  trustProfile: TrustProfile;
  policyVersion: string;
  matchedRules: string[];
  requiredRole?: 'owner' | 'admin';
  expiresAt: Date;
  requestedAt: Date;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  timestamp: Date;
  actor: { type: 'user' | 'device' | 'system'; id: string };
  sessionId?: string;
  deviceId?: string;
  action: string;
  decision: 'allow' | 'deny' | 'require_approval' | 'granted' | 'denied' | 'timeout';
  policyVersion?: string;
  matchedRules?: string[];
  previousHash: string;
  hash: string;
}

export type Capability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'process.exec'
  | 'network.access'
  | 'package.install'
  | 'git.commit'
  | 'git.push'
  | 'deployment.execute'
  | 'secret.read';
