import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  connectOrchestrator,
  Orchestrator,
  OrchestratorError,
  TaskHandle,
  type InitializeResult,
} from '../../packages/sdk-typescript/src/index.ts';
import { UnixRpcClient } from '../../packages/sdk-typescript/src/transport.ts';
import {
  createEngine,
  createFakeAdapter,
  type TaskSnapshot,
} from '../../packages/engine/src/index.ts';

const info: InitializeResult = {
  protocolVersion: '1.0',
  engineVersion: 'fixture',
  schemaVersion: 2,
  instanceId: 'timeout-fixture',
  storeId: 'timeout-store',
  capabilities: {},
};
interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
  socket: Socket;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function observe<T>(promise: Promise<T>) {
  let state = 'pending';
  const result = promise.then(
    (value) => {
      state = 'fulfilled';
      return { value, error: undefined };
    },
    (error: OrchestratorError) => {
      state = 'rejected';
      return { value: undefined, error };
    },
  );
  return { result, state: () => state };
}
function reply(request: Request, result: unknown) {
  request.socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
async function fixture(
  t: TestContext,
  options: { initialize?: boolean; handle?: (request: Request) => void } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'orch-rpc-'));
  const socketPath = join(root, 'host.sock');
  const requests: Request[] = [];
  const cleanup: (() => Promise<unknown>)[] = [];
  const listeners = new Set<() => void>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = { ...JSON.parse(buffer.slice(0, end)), socket } as Request;
        buffer = buffer.slice(end + 1);
        requests.push(request);
        if (request.method === 'initialize' && options.initialize !== false) reply(request, info);
        else options.handle?.(request);
        for (const listener of listeners) listener();
      }
    });
  });
  t.after(async () => {
    for (const close of cleanup) await close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const request = async (method: string, index = 0): Promise<Request> => {
    const read = () => requests.filter((item) => item.method === method)[index];
    if (read()) return read();
    return new Promise((resolve) => {
      const check = () => {
        if (!read()) return;
        listeners.delete(check);
        resolve(read());
      };
      listeners.add(check);
    });
  };
  return { root, socketPath, requests, request, cleanup };
}

test('0004 AC-R03 ordinary Unix reads expire at the default 30000 ms', async (t) => {
  const f = await fixture(t);
  const client = await connectOrchestrator({ socketPath: f.socketPath });
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = observe(client.tasks.get('stalled'));
  await f.request('tasks.get');
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(pending.state(), 'pending');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(pending.state(), 'rejected', 'an unanswered ordinary request must expire');
  assert.equal((await pending.result).error?.code, 'TIMEOUT');
  assert.deepEqual(
    f.requests.map((request) => request.method),
    ['initialize', 'tasks.get'],
  );
});

test('0004 AC-R03 configured and per-request deadlines free capacity and ignore late replies', async (t) => {
  const f = await fixture(t);
  const client = await connectOrchestrator({ socketPath: f.socketPath, requestTimeoutMs: 40 });
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ordinary = Array.from({ length: 63 }, (_, i) => observe(client.tasks.get(`task-${i}`)));
  const override = observe(client.tasks.get('override', { timeoutMs: 100 }));
  await f.request('tasks.get', 63);
  await assert.rejects(client.tasks.get('over-capacity'), { code: 'REQUEST_LIMIT_EXCEEDED' });
  t.mock.timers.tick(40);
  await flush();
  assert.equal(
    ordinary.every((request) => request.state() === 'rejected'),
    true,
  );
  assert.equal(override.state(), 'pending');
  for (const request of ordinary) assert.equal((await request.result).error?.code, 'TIMEOUT');
  const next = client.tasks.get('healthy');
  const healthy = await f.request('tasks.get', 64);
  reply(await f.request('tasks.get'), { id: 'late-wrong-response' });
  reply(healthy, { id: 'healthy', status: 'queued' });
  assert.equal((await next).id, 'healthy');
  t.mock.timers.tick(60);
  await flush();
  assert.equal(override.state(), 'rejected');
  assert.equal((await override.result).error?.code, 'TIMEOUT');
});

test('0004 AC-R03 timed-out mutations retain lookup identity and recover the persisted task', async (t) => {
  let engine: Awaited<ReturnType<typeof createEngine>>;
  let dropReceipt = true;
  const f = await fixture(t, {
    handle(request) {
      void engine.call(request.method, request.params).then((result) => {
        if (request.method === 'tasks.create' && dropReceipt) dropReceipt = false;
        else reply(request, result);
      });
    },
  });
  await mkdir(join(f.root, 'workspace'));
  engine = await createEngine({
    workspace: join(f.root, 'workspace'),
    stateDir: join(f.root, 'state'),
    adapters: [
      {
        ...createFakeAdapter(),
        // Client virtual time must not also hold an unrelated runtime timer open during cleanup.
        async *execute() {
          yield { type: 'error' as const, message: 'offline fixture', outcome: 'unknown' as const };
        },
      },
    ],
  });
  f.cleanup.push(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }));
  const client = await connectOrchestrator({ socketPath: f.socketPath, requestTimeoutMs: 40 });
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spec = {
    goal: 'offline receipt recovery',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human' as const, criteria: ['review fixture'] },
  };
  const mutation = observe(client.tasks.create(spec, { timeoutMs: 70 }));
  await f.request('tasks.create');
  t.mock.timers.tick(40);
  await flush();
  assert.equal(mutation.state(), 'pending');
  t.mock.timers.tick(30);
  await flush();
  assert.equal(mutation.state(), 'rejected');
  const failure = (await mutation.result).error;
  assert.ok(failure instanceof OrchestratorError);
  assert.equal(failure.code, 'TIMEOUT');
  assert.equal(failure.method, 'tasks.create');
  assert.equal(failure.scope, 'local');
  assert.equal(typeof failure.idempotencyKey, 'string');
  assert.ok(failure.method && failure.scope && failure.idempotencyKey);
  const operation = await client.ops.lookup({
    method: failure.method,
    scope: failure.scope,
    idempotencyKey: failure.idempotencyKey,
  });
  const retry = await client.tasks.create(spec, { idempotencyKey: failure.idempotencyKey });
  assert.equal(retry.id, operation.targetId);
  assert.equal((await client.tasks.get(retry.id)).id, retry.id);
});

test('0004 AC-R03 connection and request durations reject invalid or overflowing timer values', async (t) => {
  const f = await fixture(t);
  const client = await connectOrchestrator({ socketPath: f.socketPath });
  t.after(() => client.close());
  for (const duration of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    await assert.rejects(
      connectOrchestrator({ socketPath: f.socketPath, requestTimeoutMs: duration }),
      { code: 'INVALID_PARAMS' },
    );
    await assert.rejects(connectOrchestrator({ socketPath: f.socketPath, timeoutMs: duration }), {
      code: 'INVALID_PARAMS',
    });
    await assert.rejects(client.tasks.get('invalid', { timeoutMs: duration }), {
      code: 'INVALID_PARAMS',
    });
  }
  assert.equal(f.requests.filter((request) => request.method !== 'initialize').length, 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const duration of [1, 2_147_483_647]) {
    const valid = client.tasks.get('valid', { timeoutMs: duration });
    reply(await f.request('tasks.get', duration === 1 ? 0 : 1), { id: 'valid', status: 'queued' });
    assert.equal((await valid).id, 'valid');
  }
});

test('0004 AC-R03 initialize keeps its 5000 ms bound independently of the request default', async (t) => {
  const f = await fixture(t, { initialize: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connecting = observe(
    connectOrchestrator({ socketPath: f.socketPath, timeoutMs: 10_000, requestTimeoutMs: 1 }),
  );
  await f.request('initialize');
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(connecting.state(), 'pending');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(connecting.state(), 'rejected');
  assert.equal((await connecting.result).error?.code, 'TIMEOUT');
});

test('0004 AC-R03 explicit wait totals override ordinary RPC timeouts and abort only the local read', async (t) => {
  const f = await fixture(t);
  const client = await connectOrchestrator({ socketPath: f.socketPath, requestTimeoutMs: 10 });
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const task = new TaskHandle(client, { id: 'waiting', status: 'queued' } as TaskSnapshot);
  const long = observe(task.wait({ timeoutMs: 50 }));
  await f.request('tasks.get');
  t.mock.timers.tick(10);
  await flush();
  assert.equal(long.state(), 'pending');
  t.mock.timers.tick(40);
  await flush();
  assert.equal(long.state(), 'rejected');
  assert.equal((await long.result).error?.code, 'TIMEOUT');
  const controller = new AbortController();
  const aborted = observe(task.get({ signal: controller.signal }));
  const second = await f.request('tasks.get', 1);
  controller.abort();
  assert.equal((await aborted.result).error?.code, 'ABORTED');
  reply(second, { id: 'late', status: 'completed' });
  const final = task.get();
  reply(await f.request('tasks.get', 2), { id: task.id, status: 'queued' });
  assert.equal((await final).status, 'queued');
  assert.equal(
    f.requests.some((request) => request.method === 'tasks.cancel'),
    false,
  );
});

test('0004 AC-R03 owner shutdown RPC covers the explicit close budget and preserves continuation', async (t) => {
  const f = await fixture(t);
  const caller = await UnixRpcClient.connect(f.socketPath, 5000, 10);
  const client = new Orchestrator(caller, info, true);
  t.after(() => caller.disconnect());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = observe(client.close({ mode: 'drain', timeoutMs: 80 }));
  const request = await f.request('host.shutdown');
  t.mock.timers.tick(80);
  await flush();
  assert.equal(closing.state(), 'pending');
  request.socket.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        message: 'fixture cleanup still active',
        data: { code: 'SHUTDOWN_INCOMPLETE', operationId: 'shutdown-fixture' },
      },
    }) + '\n',
  );
  const error = (await closing.result).error;
  assert.ok(error instanceof OrchestratorError);
  assert.equal(error.code, 'SHUTDOWN_INCOMPLETE');
  assert.equal(error.client, client);
  const continued = client.close({ mode: 'drain', timeoutMs: 80, operationId: error.operationId });
  reply(await f.request('host.shutdown.continue'), {
    status: 'closed',
    operationId: error.operationId,
  });
  assert.equal((await continued)?.status, 'closed');
});

test(
  '0004 AC-R03 CLI status exits nonzero when an initialized host stops replying',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const preload = `import {mock} from 'node:test';
mock.timers.enable({apis:['setTimeout']});
process.on('message', message => {
  if (message === 'expire-request') { mock.timers.tick(30000); process.disconnect(); }
});`;
    const child = spawn(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(preload)}`,
        fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url)),
        'status',
        '--socket',
        f.socketPath,
        '--task',
        'stalled-cli-task',
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const exited = once(child, 'exit');
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    await f.request('tasks.get');
    child.send('expire-request');
    let timeout: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('CLI kept waiting after the request deadline')),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout!);
    }
    assert.equal(child.exitCode, 1, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, /"code":"TIMEOUT"/);
  },
);
