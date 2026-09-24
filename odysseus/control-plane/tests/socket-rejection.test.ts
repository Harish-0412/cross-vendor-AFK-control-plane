import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/control-plane';
import { REJECT_GRACE_MS } from '../src/tunnel/reject-socket';

/**
 * A refused WebSocket must actually go away, even when the other side never
 * completes the close handshake.
 *
 * In production, behind the hosting proxy, a socket given an invalid token
 * stayed open indefinitely: the server's close frame was sent, but the reply
 * `ws` waits for never arrived, and `ws` waits thirty seconds before giving
 * up. These tests stand in for that proxy with a raw TCP peer that performs
 * the upgrade and then ignores the close frame entirely.
 */

/** A client-to-server text frame; clients must mask. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > 125) throw new Error('keep test frames short');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

/** Upgrade to a WebSocket over raw TCP, then do nothing unless told to. */
async function rawUpgrade(port: number, path: string, origin?: string): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      ...(origin ? [`Origin: ${origin}`] : []),
      '',
      '',
    ].join('\r\n'),
  );
  await new Promise<void>((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      if (!buffered.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      if (buffered.startsWith('HTTP/1.1 101')) resolve();
      else reject(new Error(`upgrade refused: ${buffered.split('\r\n')[0]}`));
    };
    socket.on('data', onData);
  });
  return socket;
}

/** Milliseconds until the server drops the TCP connection, or null. */
function timeUntilDropped(socket: Socket, limitMs: number): Promise<number | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), limitMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Date.now() - started);
    });
    // Swallow the server's close frame without answering it.
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
  });
}

describe('refused sockets are torn down even when the peer never answers', () => {
  let cp: ControlPlane;
  let port: number;
  const open: Socket[] = [];

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    port = (await cp.start()).port;
  });

  afterEach(async () => {
    for (const socket of open.splice(0)) socket.destroy();
    await cp.stop();
  });

  it('drops a browser socket that presents an invalid token', async () => {
    const socket = await rawUpgrade(port, '/ws/client', 'http://localhost:3000');
    open.push(socket);
    socket.write(textFrame(JSON.stringify({ type: 'auth', token: 'not-a-real-token' })));

    const dropped = await timeUntilDropped(socket, 5_000);
    expect(dropped).not.toBeNull();
    expect(dropped!).toBeLessThan(REJECT_GRACE_MS + 1_500);
  });

  it('drops a browser socket that never authenticates, shortly after its deadline', async () => {
    const socket = await rawUpgrade(port, '/ws/client', 'http://localhost:3000');
    open.push(socket);

    // Five-second authentication deadline, then the grace period.
    const dropped = await timeUntilDropped(socket, 9_000);
    expect(dropped).not.toBeNull();
    expect(dropped!).toBeLessThan(5_000 + REJECT_GRACE_MS + 1_500);
  }, 12_000);

  it('drops a gateway socket that sends traffic before authenticating', async () => {
    const socket = await rawUpgrade(port, '/ws/tunnel');
    open.push(socket);
    socket.write(
      textFrame(JSON.stringify({ id: 'x', type: 'heartbeat', sequence: 1, payload: {} })),
    );

    const dropped = await timeUntilDropped(socket, 5_000);
    expect(dropped).not.toBeNull();
    expect(dropped!).toBeLessThan(REJECT_GRACE_MS + 1_500);
  });
});
