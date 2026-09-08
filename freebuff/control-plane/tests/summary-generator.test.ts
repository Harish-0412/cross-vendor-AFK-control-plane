import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@freebuff/protocol';

import { SummaryGenerator } from '../src/afk/summary-generator';
import { ControlPlane } from '../src/control-plane';
import { MemoryDatabase } from '../src/db/memory-store';

describe('Subphase 7.5 session summary generator', () => {
  it('creates the roadmap fixture summary from session events and audit records', async () => {
    const db = new MemoryDatabase();
    const sessionId = 'sess_summary';
    let sequence = 0;
    const append = async (eventType: EventEnvelope['eventType'], payload: unknown) => {
      const envelope: EventEnvelope = {
        eventId: `evt_${sequence}`, eventType, eventVersion: 1, sessionId, deviceId: 'dev_summary',
        sequence: ++sequence, occurredAt: new Date(), payload,
      };
      await db.events.append({ sessionId, deviceId: 'dev_summary', sequence, eventType, envelope });
    };
    for (let index = 0; index < 3; index += 1) {
      await append('session.tool_result', { toolName: 'vitest', success: true, output: 'passed' });
    }
    for (let index = 0; index < 6; index += 1) {
      await append('session.file_changed', { path: `src/file-${index}.ts`, action: 'modified' });
    }
    for (let index = 0; index < 8; index += 1) {
      await append('session.file_changed', { path: `tests/feature-${index}.test.ts`, action: 'created' });
    }
    await append('session.approval_required', { capability: 'package.install' });
    await append('session.tool_result', { toolName: 'git status', success: true, output: 'working tree clean' });

    const summary = await new SummaryGenerator(db).generate(sessionId);
    expect(summary.text).toBe([
      'While you were away',
      '✓ Fixed 3 tests',
      '✓ Modified 6 files',
      '✓ Added 8 tests',
      '⚠ Dependency install required approval',
      '✓ Working tree clean',
    ].join('\n'));
  });

  it('serves the summary through the authenticated session API', async () => {
    const cp = new ControlPlane({ port: 0 });
    const { url } = await cp.start();
    try {
      const registration = await fetch(`${url}/api/v1/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'summary@freebuff.dev', password: 'Password123!', name: 'Summary' }),
      });
      const { accessToken } = await registration.json() as { accessToken: string };
      const user = await cp.db.users.findByEmail('summary@freebuff.dev');
      await cp.db.sessions.create({
        id: 'sess_api_summary', userId: user!.id, deviceId: 'dev_api', gatewayId: 'gw_api',
        agentId: 'mock', projectRoot: '/workspace', state: 'completed',
        config: { projectRoot: '/workspace', adapter: 'mock' }, startedAt: new Date(), trustProfile: 'trusted-afk',
      });
      const response = await fetch(`${url}/api/v1/sessions/sess_api_summary/summary`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { sessionId: string }).sessionId).toBe('sess_api_summary');
    } finally {
      await cp.stop();
    }
  });
});
