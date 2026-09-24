import type { WebSocket } from 'ws';

/** How long a refused peer gets to complete the close handshake. */
export const REJECT_GRACE_MS = 1_000;

/**
 * Refuse a WebSocket, and make sure it actually goes away.
 *
 * `close(code)` sends a close frame and then waits — up to thirty seconds in
 * `ws` — for the peer to answer before dropping the connection. Behind the
 * hosting provider's proxy that answer was being lost: in production a socket
 * given an invalid token stayed open indefinitely from the client's side, and
 * one that never authenticated outlived its five-second deadline. Nothing was
 * delivered on those sockets, but each held server resources for as long as a
 * client cared to keep it, which is a cheap way to exhaust a small instance.
 *
 * So the close frame is sent first, for any peer that is listening, and the
 * TCP connection is torn down shortly after regardless. A dropped connection
 * is something every proxy propagates, and the web client already treats a
 * socket that opened but was never welcomed as a rejection.
 */
export function rejectSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    /* already closing */
  }
  const timer = setTimeout(() => {
    if (socket.readyState !== socket.CLOSED) socket.terminate();
  }, REJECT_GRACE_MS);
  timer.unref?.();
}
