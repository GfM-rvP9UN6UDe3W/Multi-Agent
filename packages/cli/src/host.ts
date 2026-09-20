import { createServer } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { CloseOptions, Engine } from '../../engine/src/types.ts';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING_REQUESTS = 64;
export const MAX_HOST_CONNECTIONS = 32;
export const MAX_HOST_PENDING_REQUESTS = 256;
export const MAX_HOST_PENDING_BYTES = 8 * 1024 * 1024;
export const MAX_CONNECTION_OUTPUT_BYTES = 8 * 1024 * 1024;
interface HostBudget {
  pending: number;
  bytes: number;
}
export const OWNER_EOF_TIMEOUT_MS = 30_000;
type RequestId = string | number;
type RpcConnection = {
  closed: Promise<void>;
  close: () => void;
  shutdown: (options?: CloseOptions) => Promise<void>;
};

function errorData(error: unknown): {
  code: string;
  message: string;
  data: Record<string, unknown>;
} {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const details =
    value.details && typeof value.details === 'object'
      ? (value.details as Record<string, unknown>)
      : {};
  const data = {
    ...details,
    ...(value.data && typeof value.data === 'object'
      ? (value.data as Record<string, unknown>)
      : {}),
  };
  const code =
    typeof value.code === 'string'
      ? value.code
      : typeof data.code === 'string'
        ? data.code
        : 'INTERNAL_ERROR';
  return {
    code,
    message: typeof value.message === 'string' ? value.message : String(error),
    data: {
      ...data,
      code,
      ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    },
  };
}

function storageClosed(error: unknown): boolean {
  const normalized = errorData(error);
  return (
    normalized.code === 'STORAGE_DEGRADED_CLOSED' &&
    normalized.data.status === 'closed' &&
    normalized.data.durableReceipt === false
  );
}

function connectRpc(
  engine: Engine,
  input: Readable,
  output: Writable,
  owner: boolean,
  log: (message: string) => void,
  budget: HostBudget = { pending: 0, bytes: 0 },
): RpcConnection {
  let buffer = Buffer.alloc(0);
  let initialized = false;
  let stopped = false;
  let closing = false;
  let backpressured = false;
  let shutdownSucceeded = false;
  const pending = new Map<RequestId, AbortController>();
  const pendingBytes = new Map<RequestId, number>();
  const release = (id: RequestId) => {
    if (!pending.delete(id)) return;
    budget.pending--;
    budget.bytes -= pendingBytes.get(id) ?? 0;
    pendingBytes.delete(id);
  };
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function finish() {
    if (stopped) return;
    stopped = true;
    buffer = Buffer.alloc(0);
    for (const controller of pending.values()) controller.abort();
    for (const id of [...pending.keys()]) release(id);
    input.pause();
    input.removeListener('data', onData);
    input.destroy();
    const cleanup =
      owner && !shutdownSucceeded
        ? engine.close({ mode: 'interrupt', timeoutMs: OWNER_EOF_TIMEOUT_MS })
        : Promise.resolve();
    cleanup
      .catch((error) => log(`Owner disconnect cleanup: ${errorData(error).code}`))
      .finally(resolveClosed);
  }

  function send(value: unknown, after?: () => void) {
    if (stopped) return;
    let frame = JSON.stringify(value);
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      const id = value && typeof value === 'object' && 'id' in value ? value.id : null;
      frame = JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: 'Response exceeds 1 MiB',
          data: { code: 'FRAME_TOO_LARGE' },
        },
      });
    }
    if (output.writableLength + Buffer.byteLength(frame) > MAX_CONNECTION_OUTPUT_BYTES) {
      finish();
      output.destroy();
      return;
    }
    const accepted = output.write(frame + '\n', (error) => {
      if (error) finish();
      else after?.();
    });
    if (!accepted && !backpressured) {
      backpressured = true;
      input.pause();
      output.once('drain', () => {
        backpressured = false;
        consume();
        if (!stopped && !closing && !backpressured) input.resume();
      });
    }
  }

  function reject(id: RequestId | null, code: string, message: string, fatal = false) {
    if (fatal) {
      closing = true;
      input.pause();
    }
    send(
      { jsonrpc: '2.0', id, error: { code: -32000, message, data: { code } } },
      fatal ? finish : undefined,
    );
  }

  function receive(frame: Buffer) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
    } catch (error) {
      reject(
        null,
        error instanceof SyntaxError ? 'PARSE_ERROR' : 'PROTOCOL_ERROR',
        'Expected one valid UTF-8 JSON object per line',
      );
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reject(null, 'PROTOCOL_ERROR', 'Expected a JSON-RPC request object');
      return;
    }
    const request = parsed as Record<string, unknown>;
    const id =
      typeof request.id === 'string' ||
      (typeof request.id === 'number' && Number.isFinite(request.id))
        ? request.id
        : null;
    if (
      id === null ||
      request.jsonrpc !== '2.0' ||
      typeof request.method !== 'string' ||
      !request.params ||
      typeof request.params !== 'object' ||
      Array.isArray(request.params) ||
      Object.keys(request).some((k) => !['jsonrpc', 'id', 'method', 'params'].includes(k))
    ) {
      reject(id, 'PROTOCOL_ERROR', 'Invalid JSON-RPC envelope or unknown field');
      return;
    }
    const method = request.method;
    const params = request.params as Record<string, unknown>;
    if (method === 'initialize') {
      if (params.protocolVersion !== '2.0') {
        reject(id, 'PROTOCOL_MISMATCH', 'Only protocol 2.0 is supported');
        return;
      }
      if (
        typeof params.sdkVersion !== 'string' ||
        Object.keys(params).some((k) => !['protocolVersion', 'sdkVersion'].includes(k))
      ) {
        reject(id, 'INVALID_PARAMS', 'initialize requires protocolVersion and sdkVersion');
        return;
      }
    } else if (!initialized) {
      reject(id, 'NOT_INITIALIZED', 'initialize must complete before business requests');
      return;
    }
    if (method.startsWith('host.shutdown') && !owner) {
      reject(id, 'UNAUTHORIZED', 'Only the host owner may shut down the engine');
      return;
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      reject(id, 'REQUEST_LIMIT_EXCEEDED', 'At most 64 requests may be pending');
      return;
    }
    if (pending.has(id)) {
      reject(id, 'PROTOCOL_ERROR', 'Request id is already pending');
      return;
    }
    if (
      budget.pending >= MAX_HOST_PENDING_REQUESTS ||
      budget.bytes + frame.length > MAX_HOST_PENDING_BYTES
    ) {
      reject(
        id,
        'HOST_REQUEST_LIMIT_EXCEEDED',
        'Host-wide pending request count or byte limit reached',
      );
      return;
    }
    const controller = new AbortController();
    pending.set(id, controller);
    pendingBytes.set(id, frame.length);
    budget.pending++;
    budget.bytes += frame.length;
    Promise.resolve()
      .then(() => engine.call(method, params, { owner, signal: controller.signal }))
      .then(
        (result) => {
          if (method === 'initialize') initialized = true;
          const shutdown =
            (method === 'host.shutdown' || method === 'host.shutdown.continue') &&
            result &&
            typeof result === 'object' &&
            'status' in result &&
            result.status === 'closed';
          if (shutdown) {
            shutdownSucceeded = true;
            closing = true;
            input.pause();
          }
          send({ jsonrpc: '2.0', id, result }, shutdown ? finish : undefined);
        },
        (error) => {
          const normalized = errorData(error);
          const shutdownClosed =
            owner && method.startsWith('host.shutdown') && storageClosed(error);
          if (shutdownClosed) {
            shutdownSucceeded = true;
            closing = true;
            input.pause();
          }
          send(
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: normalized.message, data: normalized.data },
            },
            shutdownClosed ? finish : undefined,
          );
        },
      )
      .finally(() => release(id));
  }

  function consume() {
    while (!stopped && !closing && !backpressured) {
      const newline = buffer.indexOf(10);
      if (newline < 0) {
        if (buffer.length > MAX_FRAME_BYTES)
          reject(null, 'FRAME_TOO_LARGE', 'Request exceeds 1 MiB', true);
        return;
      }
      if (newline > MAX_FRAME_BYTES) {
        reject(null, 'FRAME_TOO_LARGE', 'Request exceeds 1 MiB', true);
        return;
      }
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      receive(frame);
    }
  }
  function onData(chunk: Buffer | string) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    consume();
  }
  input.on('data', onData);
  input.once('end', finish);
  input.once('close', finish);
  input.once('error', finish);
  output.once('error', finish);
  return {
    closed,
    close: finish,
    async shutdown(options) {
      if (!owner)
        throw Object.assign(new Error('Only the host owner may shut down the engine'), {
          code: 'UNAUTHORIZED',
        });
      // Keep the owner pipe and controls available when shutdown is incomplete.
      let closedFailure: unknown;
      try {
        await engine.close(options);
      } catch (error) {
        if (!storageClosed(error)) throw error;
        closedFailure = error;
      }
      shutdownSucceeded = true;
      finish();
      await closed;
      if (closedFailure) throw closedFailure;
    },
  };
}

export function startStdioHost(
  engine: Engine,
  options: { input?: Readable; output?: Writable; log?: (message: string) => void } = {},
): RpcConnection {
  return connectRpc(
    engine,
    options.input ?? process.stdin,
    options.output ?? process.stdout,
    true,
    options.log ?? ((message) => process.stderr.write(message + '\n')),
  );
}

export async function startUnixHost(
  engine: Engine,
  options: { socketPath: string; log?: (message: string) => void },
) {
  if (!isAbsolute(options.socketPath))
    throw Object.assign(new Error('socketPath must be absolute'), { code: 'INVALID_CONFIG' });
  const maxSocketPathBytes = process.platform === 'darwin' ? 103 : 107;
  if (
    options.socketPath.includes('\0') ||
    Buffer.byteLength(options.socketPath) > maxSocketPathBytes
  )
    throw Object.assign(
      new Error(`socketPath exceeds the platform limit of ${maxSocketPathBytes} UTF-8 bytes`),
      { code: 'INVALID_CONFIG' },
    );
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(options.socketPath));
  if (
    !parent.isDirectory() ||
    process.getuid === undefined ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o077) !== 0
  )
    throw Object.assign(
      new Error(
        'Socket parent must be a real directory owned by the current user with no group or other permissions',
      ),
      { code: 'INVALID_CONFIG' },
    );
  try {
    await lstat(options.socketPath);
    throw Object.assign(new Error('Socket path already exists; refusing to replace it'), {
      code: 'SOCKET_IN_USE',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const connections = new Set<RpcConnection>();
  const budget: HostBudget = { pending: 0, bytes: 0 };
  const server = createServer((socket) => {
    if (connections.size >= MAX_HOST_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const connection = connectRpc(
      engine,
      socket,
      socket,
      false,
      options.log ?? ((message) => process.stderr.write(message + '\n')),
      budget,
    );
    connections.add(connection);
    void connection.closed.then(() => connections.delete(connection));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    server.close();
    await unlink(options.socketPath).catch(() => {});
    throw error;
  }
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let ended = false;
  server.on('error', (error) => options.log?.(`Socket server error: ${error.message}`));
  return {
    closed,
    async close(closeOptions?: CloseOptions) {
      if (ended) return;
      let closedFailure: unknown;
      try {
        await engine.close(closeOptions);
      } catch (error) {
        if (!storageClosed(error)) throw error;
        closedFailure = error;
      }
      ended = true;
      for (const connection of connections) connection.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.socketPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      resolveClosed();
      if (closedFailure) throw closedFailure;
    },
  };
}
