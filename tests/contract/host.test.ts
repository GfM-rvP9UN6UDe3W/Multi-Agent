import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { MAX_FRAME_BYTES, startUnixHost } from '../../packages/cli/src/host.ts';

const moduleUrl = new URL('../../packages/cli/src/host.ts', import.meta.url).href;
const fixture = `
import {startStdioHost,startUnixHost} from ${JSON.stringify(moduleUrl)};
let closeCount=0;
const engine={instanceId:'fixture',storeId:'fixture-store',
  async call(method,params,context){
    if(method==='initialize')return {protocolVersion:'1.0',engineVersion:'test',schemaVersion:1,instanceId:'fixture',storeId:'fixture-store',capabilities:{}};
    if(method==='echo')return {params,owner:context.owner,closeCount};
    if(method==='delay'){await new Promise(r=>setTimeout(r,params.ms));return true;}
    if(method==='host.shutdown'){if(!context.owner)throw Object.assign(new Error('Owner required'),{code:'FORBIDDEN'});return this.close();}
    throw Object.assign(new Error('Unknown method'),{code:'METHOD_NOT_FOUND'});
  },
  async close(){closeCount++;return {status:'closed',operationId:'close-1'};}
};
if(process.env.TEST_SOCKET){const host=await startUnixHost(engine,{socketPath:process.env.TEST_SOCKET});process.send?.('ready');process.on('SIGTERM',()=>host.close({mode:'interrupt'}));await host.closed;}
else {process.send?.('ready');await startStdioHost(engine).closed;}
`;

function child(socketPath?: string) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', fixture], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ...(socketPath ? { TEST_SOCKET: socketPath } : {}) },
  });
  let stderr = '';
  proc.stderr!.on('data', (b) => {
    stderr += b;
  });
  return { proc, stderr: () => stderr };
}

function frames(stream: NodeJS.ReadableStream) {
  let buffer = '';
  const received: any[] = [];
  const listeners = new Set<() => void>();
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      received.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      for (const listener of listeners) listener();
    }
  });
  return async (id: number | null, timeout = 3000): Promise<any> => {
    const existing = received.find((r) => r.id === id);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`No response for ${id}`));
      }, timeout);
      function check() {
        const value = received.find((r) => r.id === id);
        if (value) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(value);
        }
      }
      listeners.add(check);
      check();
    });
  };
}

function send(
  stream: NodeJS.WritableStream,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  stream.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill('SIGTERM');
  const fallback = setTimeout(() => proc.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(fallback);
}

test('AC11 stdio handshake, UTF-8 chunking and stdout contain only RPC frames', async (t) => {
  const { proc, stderr } = child();
  t.after(() => stop(proc));
  const read = frames(proc.stdout!);
  send(proc.stdin!, 1, 'echo');
  assert.equal((await read(1)).error.data.code, 'NOT_INITIALIZED');
  send(proc.stdin!, 2, 'initialize', { protocolVersion: '0.9', sdkVersion: 'test' });
  assert.equal((await read(2)).error.data.code, 'PROTOCOL_MISMATCH');
  send(proc.stdin!, 3, 'initialize', { protocolVersion: '1.0', sdkVersion: 'test' });
  assert.equal((await read(3)).result.protocolVersion, '1.0');
  const encoded = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'echo', params: { text: '任务' } }) + '\n',
  );
  for (const byte of encoded) proc.stdin!.write(Buffer.from([byte]));
  assert.deepEqual((await read(4)).result, {
    params: { text: '任务' },
    owner: true,
    closeCount: 0,
  });
  proc.stdin!.write('{broken}\n');
  assert.equal((await read(null)).error.data.code, 'PARSE_ERROR');
  send(proc.stdin!, 5, 'host.shutdown', { mode: 'drain', timeoutMs: 1000 });
  assert.equal((await read(5)).result.status, 'closed');
  await once(proc, 'exit');
  assert.equal(proc.exitCode, 0, stderr());
});

test('AC11 rejects frames larger than 1 MiB and closes the connection', async (t) => {
  const { proc } = child();
  t.after(() => stop(proc));
  const read = frames(proc.stdout!);
  proc.stdin!.on('error', () => {});
  proc.stdin!.write('x'.repeat(MAX_FRAME_BYTES + 1));
  assert.equal((await read(null)).error.data.code, 'FRAME_TOO_LARGE');
  await once(proc, 'exit');
});

test('AC11 64 pending requests stay bounded; request 65 is rejected', async (t) => {
  const { proc } = child();
  t.after(() => stop(proc));
  const read = frames(proc.stdout!);
  send(proc.stdin!, 0, 'initialize', { protocolVersion: '1.0', sdkVersion: 'test' });
  await read(0);
  for (let i = 1; i <= 65; i++) send(proc.stdin!, i, 'delay', { ms: 350 });
  assert.equal((await read(65)).error.data.code, 'REQUEST_LIMIT_EXCEEDED');
  assert.equal((await read(1)).result, true);
});

test(
  'AC07 Unix clients are not owners; disconnect keeps the shared host alive',
  { timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-host-test-'));
    const socketPath = join(dir, 'host.sock');
    const { proc, stderr } = child(socketPath);
    t.after(async () => {
      await stop(proc);
      await rm(dir, { recursive: true, force: true });
    });
    await Promise.race([
      once(proc, 'message'),
      once(proc, 'exit').then(() => {
        throw new Error(stderr());
      }),
    ]);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    async function connect() {
      const socket = createConnection(socketPath);
      await once(socket, 'connect');
      const read = frames(socket);
      send(socket, 1, 'initialize', { protocolVersion: '1.0', sdkVersion: 'test' });
      await read(1);
      return { socket, read };
    }
    const first = await connect();
    send(first.socket, 2, 'host.shutdown', { mode: 'interrupt', timeoutMs: 1000 });
    assert.equal((await first.read(2)).error.data.code, 'UNAUTHORIZED');
    first.socket.destroy();
    const second = await connect();
    send(second.socket, 2, 'echo');
    assert.equal((await second.read(2)).result.closeCount, 0);
    assert.equal((await second.read(2)).result.owner, false);
    second.socket.destroy();
  },
);

test('Unix host refuses a non-private parent directory without changing its permissions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-socket-perms-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  let host: Awaited<ReturnType<typeof startUnixHost>> | undefined;
  const engine = {
    async close() {
      return { status: 'closed', operationId: 'test' };
    },
  } as any;
  try {
    await assert.rejects(
      async () => {
        host = await startUnixHost(engine, { socketPath: join(dir, 'host.sock') });
      },
      { code: 'INVALID_CONFIG' },
    );
  } finally {
    await host?.close();
  }
  assert.equal((await stat(dir)).mode & 0o777, 0o755);
});

test('Unix host rejects paths exceeding the platform byte limit before listening', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-socket-length-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let host: Awaited<ReturnType<typeof startUnixHost>> | undefined;
  const engine = {
    async close() {
      return { status: 'closed', operationId: 'test' };
    },
  } as any;
  try {
    await assert.rejects(
      async () => {
        host = await startUnixHost(engine, { socketPath: join(dir, '长'.repeat(40) + '.sock') });
      },
      { code: 'INVALID_CONFIG' },
    );
  } finally {
    await host?.close();
  }
});
