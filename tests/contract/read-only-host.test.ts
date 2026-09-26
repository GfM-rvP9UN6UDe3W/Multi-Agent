import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0027 R09: the command-line host serves a store read-only over stdio, without a config file.

const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
const guard = fileURLToPath(new URL('../fixtures/reserve-guard.mjs', import.meta.url));

async function store(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-read-only-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work'));
  const stateDir = join(root, 'state');
  const engine = await createEngine({
    workspace: join(root, 'work'),
    stateDir,
    adapters: [createFakeAdapter()],
  });
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'Offline reading',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: 'offline',
  })) as TaskSnapshot;
  await engine.close({ mode: 'drain', timeoutMs: 5000 });
  return { root, stateDir, task };
}
function host(args: string[]) {
  const child = spawn(process.execPath, ['--import', guard, cli, 'host', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  return {
    child,
    stderr: () => stderr,
    async request(method: string, params: Record<string, unknown> = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
      const { value, done } = await lines.next();
      assert.ok(!done, `host closed its output: ${stderr}`);
      return JSON.parse(value as string) as {
        result?: Record<string, unknown>;
        error?: { message: string; data: Record<string, unknown> };
      };
    },
  };
}

test(
  '0027-R09 host --read-only serves reads over stdio and refuses writes',
  { timeout: 30_000 },
  async (t) => {
    const f = await store(t);
    const reader = host(['--read-only', '--state-dir', f.stateDir, '--stdio']);
    t.after(() => {
      if (reader.child.exitCode === null) reader.child.kill('SIGKILL');
    });
    const hello = await reader.request('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    });
    const capabilities = hello.result!.capabilities as Record<string, { version?: number }>;
    assert.deepEqual(capabilities.readOnly, { version: 1 });
    assert.equal(capabilities.storeNamespaces.version, 1);
    const read = await reader.request('tasks.get', { taskId: f.task.id });
    assert.equal((read.result as unknown as TaskSnapshot).id, f.task.id);
    const listed = await reader.request('tasks.list', {});
    assert.equal((listed.result!.tasks as unknown[]).length, 1);
    const refused = await reader.request('tasks.create', {
      spec: {},
      idempotencyKey: 'x',
      expectedStoreId: hello.result!.storeId,
    });
    assert.equal(refused.error?.data.code, 'READ_ONLY');
    const closed = await reader.request('host.shutdown', {
      expectedStoreId: hello.result!.storeId,
      mode: 'drain',
      timeoutMs: 1000,
    });
    assert.equal(closed.result?.status, 'closed');
    const [code] = await once(reader.child, 'exit');
    assert.equal(code, 0, reader.stderr());
  },
);

test('0027-R09 host --read-only needs an absolute state directory and stdio, and no config', async (t) => {
  const f = await store(t);
  for (const args of [
    ['--read-only', '--state-dir', 'relative', '--stdio'],
    ['--read-only', '--state-dir', f.stateDir],
    ['--read-only', '--state-dir', f.stateDir, '--socket', join(f.root, 'host.sock')],
    ['--read-only', '--state-dir', f.stateDir, '--stdio', '--config', join(f.root, 'config.json')],
    ['--state-dir', f.stateDir, '--stdio'],
  ]) {
    const child = spawn(process.execPath, ['--import', guard, cli, 'host', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, `${args.join(' ')}: ${stderr}`);
    assert.match(stderr, /INVALID_ARGUMENT/, args.join(' '));
  }
});
