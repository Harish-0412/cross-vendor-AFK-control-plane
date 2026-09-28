/**
 * JSON-RPC 2.0 over an agent's stdin/stdout, one message per line — the
 * transport the Agent Client Protocol uses.
 *
 * Both sides make requests: the client asks the agent to start sessions and
 * run prompts; the agent asks the client for permission, and to read and
 * write files. So this matches responses to its own requests by id, and
 * answers the agent's requests through a handler.
 */
import type { Readable, Writable } from 'node:stream';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** JSON-RPC's standard codes. */
export const RpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout | undefined;
}

/** A single line longer than this is refused rather than buffered without end. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export class AcpConnection {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number | string, Pending>();
  private requestHandler: RequestHandler = async (method) => {
    throw new RpcError(RpcCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  };
  private notificationHandler: NotificationHandler = () => undefined;
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly onProtocolNoise: (line: string) => void = () => undefined,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.receive(chunk));
    input.on('end', () => this.close('The agent closed its output'));
    // An agent that exits leaves a broken pipe; writing to it must end the
    // connection, not throw an unhandled EPIPE through the whole gateway.
    output.on('error', (error: Error) => this.close(`Cannot write to the agent: ${error.message}`));
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`Connection closed; cannot call ${method}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.send({ jsonrpc: '2.0', method, params });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private send(message: Record<string, unknown>): void {
    if (this.output.destroyed || !this.output.writable) {
      this.close('The agent is no longer accepting input');
      return;
    }
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
      this.buffer = '';
      this.onProtocolNoise('(dropped an oversized message)');
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Agents sometimes print banners or logs to stdout; they are not protocol.
      this.onProtocolNoise(line);
      return;
    }
    const id = message['id'] as number | string | undefined;
    const method = message['method'];

    if (typeof method === 'string' && id !== undefined && id !== null) {
      void this.answer(id, method, message['params']);
      return;
    }
    if (typeof method === 'string') {
      try {
        this.notificationHandler(method, message['params']);
      } catch (error) {
        this.onProtocolNoise(`notification handler failed: ${(error as Error).message}`);
      }
      return;
    }
    if (id !== undefined && id !== null) {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      const error = message['error'] as
        { code?: number; message?: string; data?: unknown } | undefined;
      if (error)
        entry.reject(
          new RpcError(
            error.code ?? RpcCode.INTERNAL_ERROR,
            error.message ?? 'Agent error',
            error.data,
          ),
        );
      else entry.resolve(message['result']);
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.requestHandler(method, params);
      if (!this.closed) this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      if (this.closed) return;
      const rpc =
        error instanceof RpcError
          ? error
          : new RpcError(
              RpcCode.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            );
      this.send({
        jsonrpc: '2.0',
        id,
        error: {
          code: rpc.code,
          message: rpc.message,
          ...(rpc.data !== undefined ? { data: rpc.data } : {}),
        },
      });
    }
  }
}
