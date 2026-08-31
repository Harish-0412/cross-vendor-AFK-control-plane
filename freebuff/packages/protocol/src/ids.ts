import { randomBytes } from 'node:crypto';

import { SESSION_ID_PREFIX, SESSION_ID_LENGTH } from './types/session';
import { EVENT_ID_PREFIX, EVENT_ID_LENGTH } from './types/events';
import { COMMAND_ID_PREFIX, COMMAND_ID_LENGTH } from './types/commands';
import { PROJECT_ID_PREFIX, PROJECT_ID_LENGTH } from './types/project';
import { SANDBOX_ID_PREFIX, SANDBOX_ID_LENGTH } from './types/sandbox';

export function generateId(prefix: string, length: number): string {
  const bytes = randomBytes(Math.ceil(length / 2));
  return `${prefix}${bytes.toString('hex').slice(0, length)}`;
}

export function generateSessionId(): string {
  return generateId(SESSION_ID_PREFIX, SESSION_ID_LENGTH);
}

export function generateEventId(): string {
  return generateId(EVENT_ID_PREFIX, EVENT_ID_LENGTH);
}

export function generateCommandId(): string {
  return generateId(COMMAND_ID_PREFIX, COMMAND_ID_LENGTH);
}

export function generateProjectId(): string {
  return generateId(PROJECT_ID_PREFIX, PROJECT_ID_LENGTH);
}

export function generateSandboxId(): string {
  return generateId(SANDBOX_ID_PREFIX, SANDBOX_ID_LENGTH);
}

export function generateApprovalId(): string {
  return generateId('appr_', 20);
}

export function generateCheckpointId(): string {
  return generateId('chk_', 20);
}

export function generateDeviceId(): string {
  return generateId('dev_', 32);
}

export function generateGatewayId(): string {
  return generateId('gw_', 24);
}

export function generateCorrelationId(): string {
  return generateId('corr_', 24);
}

export function ulid(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = randomBytes(10).toString('hex');
  return `${timestamp}${random}`.toUpperCase();
}
