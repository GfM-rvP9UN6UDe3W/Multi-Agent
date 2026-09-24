import { createServer, createConnection, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORCHESTRATION_TOOLS, TOOL_NAMES, type RuntimeTools } from './tools.ts';
import type { Json } from './types.ts';
import { VERSION } from './version.ts';

const MAX_FRAME = 1_048_576;
type BridgeEnv = { AGENT_ORCH_BRIDGE_TOKEN: string; AGENT_ORCH_BRIDGE_SOCKET: string };
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** One credential, one dispatch, one bounded request per connection. No public listener. */
export async function createToolBridge(tools: RuntimeTools, signal: AbortSignal) {
  if (signal.aborted) throw failure('STALE_GRANT');
  // A short socket path is necessary on macOS; this directory is always mode 0700.
  const directory = await mkdtemp('/tmp/ao-');
  await chmod(directory, 0o700);
  const path = join(directory, 's');
  const token = randomBytes(32).toString('hex');
  let revoked = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (revoked || sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      if (received) {
        socket.destroy();
        return;
      }
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      received = true;
      void (async () => {
        try {
          const value: unknown = JSON.parse(buffer.slice(0, end));
          if (
            !object(value) ||
            typeof value.token !== 'string' ||
            value.token.length !== token.length ||
            !timingSafeEqual(Buffer.from(value.token), Buffer.from(token))
          )
            throw failure('UNAUTHORIZED');
          if (revoked || signal.aborted) throw failure('STALE_GRANT');
          if (
            typeof value.name !== 'string' ||
            !TOOL_NAMES.includes(value.name as (typeof TOOL_NAMES)[number])
          )
            throw failure('UNKNOWN_TOOL');
          const result = await tools.call(value.name, value.request);
          const frame = JSON.stringify({ result });
          if (Buffer.byteLength(frame) > MAX_FRAME) throw failure('RESULT_LIMIT');
          socket.end(frame + '\n');
        } catch (error) {
          // Never echo private connection data or a callback exception into model-visible text.
          const code =
            object(error) && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)
              ? error.code
              : 'TOOL_FAILED';
          socket.end(JSON.stringify({ error: code }) + '\n');
        }
      })();
    });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    revoked = true;
    signal.removeEventListener('abort', abort);
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolve) => server.close(() => resolve())).then(() =>
      rm(directory, { recursive: true, force: true }),
    );
    return closing;
  };
  const abort = () => {
    void close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      await close();
      throw failure('STALE_GRANT');
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    env: { AGENT_ORCH_BRIDGE_TOKEN: token, AGENT_ORCH_BRIDGE_SOCKET: path } satisfies BridgeEnv,
    close,
  };
}

export async function callToolBridge(
  env: BridgeEnv,
  name: string,
  request: unknown,
): Promise<Json> {
  const frame = JSON.stringify({ token: env.AGENT_ORCH_BRIDGE_TOKEN, name, request }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME) throw failure('REQUEST_LIMIT');
  if (!env.AGENT_ORCH_BRIDGE_TOKEN || !env.AGENT_ORCH_BRIDGE_SOCKET) throw failure('UNAUTHORIZED');
  return new Promise((resolve, reject) => {
    const socket = createConnection(env.AGENT_ORCH_BRIDGE_SOCKET);
    let done = false,
      buffer = '';
    const finish = (error?: Error, value?: Json) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? null);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => finish(failure('BRIDGE_TIMEOUT')));
    socket.on('connect', () => socket.write(frame));
    socket.on('error', () => finish(failure('BRIDGE_UNAVAILABLE')));
    socket.on('close', () => finish(failure('BRIDGE_UNAVAILABLE')));
    socket.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        finish(failure('RESULT_LIMIT'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, end));
        if (value.error) finish(failure(value.error));
        else finish(undefined, value.result);
      } catch {
        finish(failure('INVALID_BRIDGE_RESPONSE'));
      }
    });
  });
}

export async function runToolBridge(): Promise<void> {
  const env = {
    AGENT_ORCH_BRIDGE_TOKEN: process.env.AGENT_ORCH_BRIDGE_TOKEN ?? '',
    AGENT_ORCH_BRIDGE_SOCKET: process.env.AGENT_ORCH_BRIDGE_SOCKET ?? '',
  };
  // Keep credentials only in this closure, not inherited by any later child.
  delete process.env.AGENT_ORCH_BRIDGE_TOKEN;
  delete process.env.AGENT_ORCH_BRIDGE_SOCKET;
  let buffer = '';
  for await (const data of process.stdin) {
    buffer += data.toString('utf8');
    if (Buffer.byteLength(buffer) > MAX_FRAME) throw failure('REQUEST_LIMIT');
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let value: Record<string, unknown>;
      try {
        const decoded: unknown = JSON.parse(line);
        if (!object(decoded)) throw failure('INVALID_REQUEST');
        value = decoded;
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Invalid JSON' },
          }) + '\n',
        );
        continue;
      }
      if (value.id === undefined) continue;
      const response: Record<string, unknown> = { jsonrpc: '2.0', id: value.id };
      const params = object(value.params) ? value.params : {};
      if (value.method === 'initialize')
        response.result = {
          protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(
            String(params.protocolVersion),
          )
            ? params.protocolVersion
            : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent_orch', version: VERSION },
        };
      else if (value.method === 'ping') response.result = {};
      else if (value.method === 'tools/list') response.result = { tools: ORCHESTRATION_TOOLS };
      else if (value.method === 'tools/call') {
        try {
          if (
            typeof params.name !== 'string' ||
            !TOOL_NAMES.includes(params.name as (typeof TOOL_NAMES)[number])
          )
            throw failure('UNKNOWN_TOOL');
          if (
            !object(params.arguments) ||
            Object.keys(params.arguments).some((key) => key !== 'request') ||
            !object(params.arguments.request)
          )
            throw failure('INVALID_REQUEST');
          const result = await callToolBridge(env, params.name, params.arguments.request);
          response.result = { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (error) {
          response.result = {
            isError: true,
            content: [
              { type: 'text', text: error instanceof Error ? error.message : 'TOOL_FAILED' },
            ],
          };
        }
      } else response.error = { code: -32601, message: 'Unknown method' };
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runToolBridge().catch(() => {
    process.stderr.write('Tool bridge stopped\n');
    process.exitCode = 1;
  });
}
