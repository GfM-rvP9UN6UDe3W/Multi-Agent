import type { RetryIdentity } from '../../engine/src/types.ts';
import { createConnection, type Socket } from 'node:net';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING_REQUESTS = 64;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export class OrchestratorError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;
  retryIdentity?: RetryIdentity;
  operationId?: string;
  method?: string;
  scope?: string;
  idempotencyKey?: string;
  client?: unknown;
  constructor(code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.data = data;
    if (data.retryIdentity && typeof data.retryIdentity === 'object')
      this.retryIdentity = data.retryIdentity as RetryIdentity;
    if (typeof data.operationId === 'string') this.operationId = data.operationId;
    if (typeof data.method === 'string') this.method = data.method;
    if (typeof data.scope === 'string') this.scope = data.scope;
    if (typeof data.idempotencyKey === 'string') this.idempotencyKey = data.idempotencyKey;
  }
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface Caller {
  call<T>(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  disconnect(): void;
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};
function validateTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new OrchestratorError(
      'INVALID_PARAMS',
      `${name} must be an integer between 1 and 2147483647 milliseconds`,
    );
}

export class UnixRpcClient implements Caller {
  private socket: Socket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private requestTimeoutMs: number;
  private constructor(socket: Socket, requestTimeoutMs: number) {
    this.socket = socket;
    this.requestTimeoutMs = requestTimeoutMs;
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (error) =>
      this.fail(new OrchestratorError('CONNECTION_CLOSED', error.message)),
    );
    socket.on('close', () =>
      this.fail(new OrchestratorError('CONNECTION_CLOSED', 'Host connection closed')),
    );
  }
  static async connect(
    socketPath: string,
    timeoutMs = 5000,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    validateTimeout(timeoutMs, 'timeoutMs');
    validateTimeout(requestTimeoutMs, 'requestTimeoutMs');
    const socket = createConnection(socketPath);
    const client = new UnixRpcClient(socket, requestTimeoutMs);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new OrchestratorError('TIMEOUT', 'Timed out connecting to host'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new OrchestratorError('CONNECTION_CLOSED', error.message));
      });
    });
    return client;
  }
  call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs === undefined ? this.requestTimeoutMs : options.timeoutMs;
    try {
      validateTimeout(timeoutMs, 'timeoutMs');
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.ended)
      return Promise.reject(new OrchestratorError('CONNECTION_CLOSED', 'Client is closed'));
    if (options.signal?.aborted)
      return Promise.reject(new OrchestratorError('ABORTED', 'Local request aborted'));
    if (this.pending.size >= MAX_PENDING_REQUESTS)
      return Promise.reject(
        new OrchestratorError('REQUEST_LIMIT_EXCEEDED', 'At most 64 requests may be pending'),
      );
    const id = ++this.nextId;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
      return Promise.reject(new OrchestratorError('FRAME_TOO_LARGE', 'Request exceeds 1 MiB'));
    if (this.socket.writableLength > MAX_FRAME_BYTES * MAX_PENDING_REQUESTS)
      return Promise.reject(
        new OrchestratorError('REQUEST_LIMIT_EXCEEDED', 'Transport write buffer is full'),
      );
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = (error: OrchestratorError) => {
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      const abort = () =>
        cancel(
          new OrchestratorError('ABORTED', 'Local request aborted; remote work was not cancelled'),
        );
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(
        () =>
          cancel(
            new OrchestratorError(
              'TIMEOUT',
              'Request wait timed out; remote work was not cancelled',
            ),
          ),
        timeoutMs,
      );
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup });
      this.socket.write(frame + '\n', (error) => {
        if (error) this.fail(new OrchestratorError('CONNECTION_CLOSED', error.message));
      });
    });
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.ended) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > MAX_FRAME_BYTES)
          this.fail(new OrchestratorError('FRAME_TOO_LARGE', 'Response exceeds 1 MiB'));
        return;
      }
      if (newline > MAX_FRAME_BYTES) {
        this.fail(new OrchestratorError('FRAME_TOO_LARGE', 'Response exceeds 1 MiB'));
        return;
      }
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let response: any;
      try {
        response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
      } catch {
        this.fail(new OrchestratorError('PROTOCOL_ERROR', 'Malformed response frame'));
        return;
      }
      if (
        !response ||
        response.jsonrpc !== '2.0' ||
        typeof response.id !== 'number' ||
        'result' in response === 'error' in response
      ) {
        this.fail(new OrchestratorError('PROTOCOL_ERROR', 'Invalid JSON-RPC response'));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue; // A cancelled local wait may still receive its remote reply.
      this.pending.delete(response.id);
      pending.cleanup();
      if (response.error) {
        const data = response.error.data ?? {};
        pending.reject(
          new OrchestratorError(
            typeof data.code === 'string' ? data.code : 'RPC_ERROR',
            response.error.message ?? 'RPC error',
            data,
          ),
        );
      } else pending.resolve(response.result);
    }
  }
  private fail(error: OrchestratorError) {
    if (this.ended) return;
    this.ended = true;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }
  disconnect() {
    this.fail(new OrchestratorError('CONNECTION_CLOSED', 'Client disconnected'));
  }
}
