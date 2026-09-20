import { MUTATIONS } from '../../packages/engine/src/identity.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type {
  CloseOptions,
  EventEnvelope,
  OperationSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
const resultText = 'Fake turn completed before configured shutdown';

async function until<T>(read: () => T | Promise<T>, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Fixture condition did not become true before its deadline');
}

function rpc(input: Readable, output: Writable, diagnostics: () => string) {
  let nextId = 0;
  let storeId: string;
  let buffer = '';
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  input.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const frame = JSON.parse(buffer.slice(0, end)) as {
        id: number;
        result?: unknown;
        error?: { message: string; data: Record<string, unknown> };
      };
      buffer = buffer.slice(end + 1);
      const request = pending.get(frame.id);
      if (!request) continue;
      if (frame.error)
        request.reject(Object.assign(new Error(frame.error.message), frame.error.data));
      else {
        const info = frame.result as any;
        if (info?.storeId && info?.protocolVersion) storeId = info.storeId;
        request.resolve(frame.result);
      }
    }
  });
  input.on('end', () => {
    for (const request of pending.values())
      request.reject(new Error(`Fixture host ended before its RPC response: ${diagnostics()}`));
  });
  output.on('error', () => {});
  return async <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (MUTATIONS.has(method)) params = { expectedStoreId: storeId!, ...params };
    const id = ++nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        timer = setTimeout(
          () => reject(new Error(`Fixture RPC timed out: ${method}; ${diagnostics()}`)),
          method === 'initialize' || method.startsWith('host.shutdown') ? 10000 : 2000,
        );
        output.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
}

async function runningHost(
  t: TestContext,
  transport: 'unix' | 'stdio',
  shutdown?: CloseOptions,
  delayMs = 150,
  startupDelayMs = 0,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-signal-')));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  const configPath = join(root, 'config.json');
  const socketPath = join(root, 'host.sock');
  await writeFile(
    configPath,
    JSON.stringify({
      workspace,
      stateDir,
      providers: { fake: { model: 'fake-model', delayMs, result: resultText } },
      storage: { emergencyBytes: 4096 },
      ...(shutdown ? { shutdown } : {}),
    }),
  );
  const args = [
    cli,
    'host',
    '--config',
    configPath,
    ...(transport === 'stdio' ? ['--stdio'] : ['--socket', socketPath]),
  ];
  const proc = spawn(
    process.execPath,
    startupDelayMs
      ? [
          '--input-type=module',
          '-e',
          'const [delay, cli, ...args] = process.argv.slice(1); await new Promise(r => setTimeout(r, Number(delay))); process.argv = [process.execPath, cli, ...args]; await import((await import("node:url")).pathToFileURL(cli).href);',
          String(startupDelayMs),
          ...args,
        ]
      : args,
  );
  const exited = once(proc, 'exit');
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  let socket: Socket | undefined;
  t.after(async () => {
    socket?.destroy();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  let call: ReturnType<typeof rpc>;
  if (transport === 'unix') {
    proc.stdout.resume();
    await until(() => {
      if (proc.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
      return stderr.includes('listening on');
    }, 10000);
    socket = createConnection(socketPath);
    await once(socket, 'connect');
    call = rpc(socket, socket, () => stderr);
  } else call = rpc(proc.stdout, proc.stdin, () => stderr);
  await call('initialize', { protocolVersion: '2.0', sdkVersion: 'test' });
  const task = await call<TaskSnapshot>('tasks.create', {
    spec: {
      goal: 'Exercise configured host shutdown',
      runtime: { provider: 'fake', model: 'fake-model' },
      acceptance: { mode: 'human', criteria: ['inspect fake result'] },
    },
    idempotencyKey: 'signal-task',
  });
  await until(
    async () => (await call<TaskSnapshot>('tasks.get', { taskId: task.id })).status === 'running',
  );
  return {
    proc,
    call,
    taskId: task.id,
    diagnostics: () => stderr,
    async waitForExit() {
      await until(() => proc.exitCode !== null || proc.signalCode !== null);
      const [code, signal] = await exited;
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
    },
    async incomplete() {
      return until(() => {
        const line = stderr
          .split('\n')
          .find((value) => value.startsWith('{') && value.includes('SHUTDOWN_INCOMPLETE'));
        if (line) return JSON.parse(line) as { code: string; operationId?: string };
        if (proc.exitCode !== null || proc.signalCode !== null)
          throw new Error(`Host exited instead of retaining incomplete shutdown: ${stderr}`);
      });
    },
    persisted() {
      const db = new DatabaseSync(join(stateDir, 'store.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id) as {
          data: string;
        };
        const events = db.prepare('SELECT data FROM events ORDER BY cursor').all() as {
          data: string;
        }[];
        return {
          task: JSON.parse(row.data) as TaskSnapshot,
          waits: events
            .map((event) => JSON.parse(event.data) as EventEnvelope)
            .filter((event) => event.type === 'shutdown.wait_started'),
        };
      } finally {
        db.close();
      }
    },
  };
}

test('0011-R03 delayed stdio startup does not consume the configured shutdown deadline', async (t) => {
  const f = await runningHost(t, 'stdio', { mode: 'interrupt', timeoutMs: 500 }, 5000, 2200);
  f.proc.kill('SIGTERM');
  await f.waitForExit();
  const persisted = f.persisted();
  assert.equal(persisted.task.status, 'paused');
  assert.equal(persisted.waits[0].data.timeoutMs, 500);
});

for (const transport of ['unix', 'stdio'] as const) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const mode of ['drain', 'interrupt'] as const) {
      test(
        `AC-R02 ${transport} ${signal} honors configured ${mode} mode and budget`,
        { timeout: 6000 },
        async (t) => {
          const host = await runningHost(
            t,
            transport,
            { mode, timeoutMs: 1234 },
            mode === 'drain' ? 150 : 10_000,
          );
          host.proc.kill(signal);
          await host.waitForExit();
          const { task, waits } = host.persisted();
          assert.equal(waits.length, 1);
          assert.equal(waits[0].data.mode, mode);
          assert.equal(waits[0].data.timeoutMs, 1234);
          if (mode === 'drain') {
            assert.equal(task.result, resultText);
            assert.equal(task.status, 'waiting_approval');
          } else {
            assert.equal(task.result, null);
            assert.equal(task.reason, 'runtime_interrupted');
          }
          assert.doesNotMatch(host.diagnostics(), /SHUTDOWN_INCOMPLETE/);
        },
      );
    }
  }

  test(
    `AC-R02 ${transport} preserves its omitted shutdown defaults`,
    { timeout: 6000 },
    async (t) => {
      const host = await runningHost(t, transport, undefined, 10_000);
      host.proc.kill('SIGTERM');
      await host.waitForExit();
      const { waits, task } = host.persisted();
      assert.equal(waits.length, 1);
      assert.equal(waits[0].data.mode, 'interrupt');
      assert.equal(waits[0].data.timeoutMs, transport === 'unix' ? 1000 : 30_000);
      assert.equal(task.reason, 'runtime_interrupted');
    },
  );

  test(
    `AC-R02 ${transport} incomplete drain keeps the host and operation for another signal`,
    { timeout: 6000 },
    async (t) => {
      const host = await runningHost(t, transport, { mode: 'drain', timeoutMs: 0 }, 250);
      host.proc.kill('SIGTERM');
      const failure = await host.incomplete();
      assert.equal(failure.code, 'SHUTDOWN_INCOMPLETE');
      assert.equal(
        typeof failure.operationId,
        'string',
        'stderr must expose the recoverable shutdown operation',
      );
      assert.equal(host.proc.exitCode, null);
      assert.equal(host.proc.signalCode, null);
      const operation = await host.call<OperationSnapshot>('operations.get', {
        operationId: failure.operationId,
      });
      assert.equal(operation.status, 'persisted');
      assert.equal(operation.lifecycle?.mayHaveBeenSent, false);
      await until(
        async () =>
          (await host.call<TaskSnapshot>('tasks.get', { taskId: host.taskId })).status ===
          'waiting_approval',
      );
      assert.equal(host.proc.exitCode, null, 'an incomplete close must not silently finish itself');
      host.proc.kill('SIGINT');
      await host.waitForExit();
      const { waits, task } = host.persisted();
      assert.equal(task.result, resultText);
      assert.equal(waits.length, 2);
      assert.deepEqual(
        waits.map((event) => event.operationId),
        [failure.operationId, failure.operationId],
      );
      assert.deepEqual(
        waits.map((event) => event.data.mode),
        ['drain', 'drain'],
      );
      assert.deepEqual(
        waits.map((event) => event.data.timeoutMs),
        [0, 0],
      );
    },
  );
}

test(
  'AC-R02 stdio owner can continue a signal-started drain through the retained wire',
  { timeout: 6000 },
  async (t) => {
    const host = await runningHost(t, 'stdio', { mode: 'drain', timeoutMs: 0 }, 150);
    host.proc.kill('SIGINT');
    const failure = await host.incomplete();
    assert.equal(typeof failure.operationId, 'string');
    const result = await host.call<{ status: 'closed'; operationId: string }>(
      'host.shutdown.continue',
      { operationId: failure.operationId, mode: 'drain', timeoutMs: 1234 },
    );
    assert.equal(result.status, 'closed');
    assert.equal(result.operationId, failure.operationId);
    await host.waitForExit();
    assert.equal(host.persisted().task.result, resultText);
  },
);

test(
  'AC-R02 owner EOF still uses bounded interrupt despite configured drain and zero timeout',
  { timeout: 6000 },
  async (t) => {
    const host = await runningHost(t, 'stdio', { mode: 'drain', timeoutMs: 0 }, 10_000);
    host.proc.stdin.end();
    await host.waitForExit();
    const { waits, task } = host.persisted();
    assert.equal(waits.length, 1);
    assert.equal(waits[0].data.mode, 'interrupt');
    assert.equal(waits[0].data.timeoutMs, 30_000);
    assert.equal(task.result, null);
    assert.equal(task.reason, 'runtime_interrupted');
  },
);
