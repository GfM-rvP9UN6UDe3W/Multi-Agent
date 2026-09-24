import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  connectOrchestrator,
  createOrchestrator,
  OrchestratorError,
  type Orchestrator,
} from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';

// SPEC-0025 E: the embedded orchestrator rejects errors as a socket client does.

const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));

async function dirs(t: TestContext, prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'state'), { mode: 0o700 });
  await mkdir(join(root, 'run'), { mode: 0o700 });
  return {
    root,
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    socketPath: join(root, 'run', 'host.sock'),
  };
}

/** A socket host and a client connected to it. */
async function socketClient(t: TestContext): Promise<Orchestrator> {
  const d = await dirs(t, 'orchvia-sdk-errors-socket-');
  const config = join(d.root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      workspace: d.workspace,
      stateDir: d.stateDir,
      providers: { fake: { model: 'fake-model' } },
      storage: { emergencyBytes: 4096 },
    }),
  );
  const proc = spawn(
    process.execPath,
    [cli, 'host', '--config', config, '--socket', d.socketPath],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    await exited;
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  const deadline = performance.now() + 10_000;
  while (!stderr.includes('orchvia listening on')) {
    if (proc.exitCode !== null) throw new Error(`The host exited: ${stderr}`);
    if (performance.now() >= deadline) throw new Error(`The host did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const client = await connectOrchestrator({ socketPath: d.socketPath });
  t.after(() => client.close());
  return client;
}

async function embedded(t: TestContext): Promise<Orchestrator> {
  const d = await dirs(t, 'orchvia-sdk-errors-embedded-');
  const orch = await createOrchestrator({
    workspace: d.workspace,
    stateDir: d.stateDir,
    adapters: [createFakeAdapter()],
    providers: { fake: { model: 'fake-model' } },
    storage: { emergencyBytes: 4096 },
  });
  t.after(() => orch.close());
  return orch;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail('The call succeeded'),
    (error: unknown) => error,
  );
const shape = (error: unknown) => ({
  isOrchestratorError: error instanceof OrchestratorError,
  name: (error as Error).name,
  code: (error as OrchestratorError).code,
  message: (error as Error).message,
  data: (error as OrchestratorError).data,
});

test('0025-E01 a failed read rejects with the same error in-process and over a socket', async (t) => {
  const [socket, local] = await Promise.all([socketClient(t), embedded(t)]);
  const remote = shape(await failure(socket.tasks.get('missing-task')));
  const inProcess = await failure(local.tasks.get('missing-task'));
  assert.deepEqual(shape(inProcess), remote);
  assert.equal(remote.code, 'NOT_FOUND');
  assert.ok((inProcess as Error).cause instanceof Error, 'the engine error is the cause');
});

test("0025-E02 an in-process read with an aborted signal keeps the SDK's own error", async (t) => {
  const local = await embedded(t);
  const aborted = await failure(
    local.events.read({}, { signal: AbortSignal.abort() }) as Promise<unknown>,
  );
  assert.ok(aborted instanceof OrchestratorError);
  assert.equal(aborted.code, 'ABORTED');
  assert.equal(aborted.cause, undefined);
});
