// A scripted ACP agent for tests: JSON-RPC 2.0 over stdio, one message per line.
// What it does in a turn depends on words in the prompt.
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
let nextId = 1;
const waiting = new Map();
let cancelled = null;
let sessionId = null;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const call = (method, params) =>
  new Promise((done) => {
    const id = `agent-${nextId++}`;
    waiting.set(id, done);
    send({ id, method, params });
  });
const update = (update) => send({ method: 'session/update', params: { sessionId, update } });
const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

async function turn(text) {
  if (text.includes('hello')) {
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking it over.' } });
    say('Hel');
    say('lo');
    return 'end_turn';
  }
  if (text.includes('run tests')) {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Run pnpm test',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: ['bash', '-lc', 'pnpm test'] },
    });
    const answer = await call('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call_1', title: 'Run pnpm test', kind: 'execute' },
      options: [
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer.result?.outcome;
    if (outcome?.outcome === 'cancelled') return 'cancelled';
    if (outcome?.optionId?.startsWith('allow')) {
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      });
      say(`Tests passed (${outcome.optionId})`);
    } else say(`Skipped (${outcome?.optionId})`);
    return 'end_turn';
  }
  if (text.includes('write config')) {
    const answer = await call('fs/write_text_file', {
      sessionId,
      path: resolve(process.cwd(), '.cursor', 'mcp.json'),
      content: '{"mcpServers":{}}',
    });
    say(answer.error ? `Refused: ${answer.error.message}` : 'Wrote it');
    return 'end_turn';
  }
  if (text.includes('write file')) {
    const path = resolve(process.cwd(), 'src', 'new.ts');
    await call('fs/write_text_file', { sessionId, path, content: 'export const a = 1;\nexport const b = 2;\n' });
    const read = await call('fs/read_text_file', { sessionId, path, line: 2, limit: 1 });
    say(`Read back: ${read.result?.content}`);
    return 'end_turn';
  }
  if (text.includes('read outside')) {
    const answer = await call('fs/read_text_file', { sessionId, path: resolve(process.cwd(), '..', 'secret.txt') });
    say(answer.error ? `Refused: ${answer.error.message}` : 'Read it');
    return 'end_turn';
  }
  if (text.includes('refuse')) return 'refusal';
  if (text.includes('crash')) process.exit(3);
  if (text.includes('wait')) {
    return new Promise((done) => {
      cancelled = () => done('cancelled');
    });
  }
  say(`Loaded ${sessionId}`);
  return 'end_turn';
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id && !message.method) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  if (method === 'session/cancel') {
    cancelled?.();
    return;
  }
  if (method === 'initialize') {
    return send({
      id,
      result: {
        protocolVersion: Number(env.FAKE_ACP_VERSION ?? 1),
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'fake', version: '9.9.9' },
        authMethods: [],
      },
    });
  }
  if (method === 'session/new') {
    if (env.FAKE_ACP_AUTH === 'required')
      return send({ id, error: { code: -32000, message: 'Authentication required' } });
    sessionId = 'fake-session-1';
    return send({ id, result: { sessionId } });
  }
  if (method === 'session/load') {
    sessionId = params.sessionId;
    say('old history that must not be republished');
    return send({ id, result: null });
  }
  if (method === 'session/prompt') {
    const text = params.prompt.map((block) => block.text ?? '').join(' ');
    const stopReason = await turn(text);
    return send({ id, result: { stopReason } });
  }
  send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
