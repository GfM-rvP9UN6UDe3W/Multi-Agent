import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'packages/cli/src/main.ts');

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end)
      throw new Error(`Timed out waiting for wire state: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function stop(proc: ChildProcessWithoutNullStreams) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 1500);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

test(
  'A2 real Unix host gives TS and Python identical scheduler and persisted budget snapshots',
  { timeout: 10000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'a2w-')));
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'state'));
    const configPath = join(root, 'config.json');
    const socketPath = join(root, 'host.sock');
    await writeFile(
      configPath,
      JSON.stringify({
        workspace: join(root, 'workspace'),
        stateDir: join(root, 'state'),
        providers: { fake: { model: 'fake-model', delayMs: 200, result: 'late fixture result' } },
        limits: { maxActiveSessions: 1, maxQuarantinedDispatches: 1 },
        timeouts: { acceptanceMs: 1000, turnMs: 40 },
      }),
    );
    const host = spawn(
      process.execPath,
      [cli, 'host', '--config', configPath, '--socket', socketPath],
      { stdio: 'pipe' },
    );
    let stderr = '';
    host.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      await stop(host);
      await rm(root, { recursive: true, force: true });
    });
    await eventually(
      async () => {
        if (host.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
        return stderr;
      },
      (value) => value.includes('listening on'),
    );
    const client = await connectOrchestrator({ socketPath });
    t.after(() => client.close());
    assert.equal(client.info.schemaVersion, 3);
    const task = await client.tasks.create(
      {
        goal: 'offline execution-isolation wire fixture',
        runtime: { provider: 'fake', model: 'fake-model' },
        acceptance: { mode: 'human', criteria: ['inspect known fixture output'] },
      },
      { idempotencyKey: 'a2-wire' },
    );
    const scheduler = await eventually(
      () => client.scheduler.get(),
      (value) => value.executionOccupied === 0 && value.quarantined === 1,
    );
    assert.equal(scheduler.quarantineReserved, 0);
    assert.equal(scheduler.canDispatch, false);
    assert.deepEqual(scheduler.reasons, ['QUARANTINE_CAPACITY_EXCEEDED']);
    const session = await client.sessions.get(task.initial.sessionId!);
    assert.equal(session.status, 'outcome_unknown');
    assert.equal(session.execution?.lease.status, 'released');
    assert.equal(session.execution?.quarantined, true);
    assert.equal(session.execution?.budget?.policyVersion, 2);
    assert.equal(session.execution?.budget?.effectiveTurnMs, 40);
    assert.equal((await client.tasks.get(task.id)).status, 'blocked');
    await assert.rejects(
      client.scheduler.resolveConflict(
        {
          conflictId: 'no-such-conflict',
          expectedRevision: 1,
          evidence: {
            source: 'owner_attestation',
            summary: 'ordinary client cannot attest resource release',
            localResources: 'stopped',
            remoteExecution: 'stopped',
            sideEffects: 'unknown',
            outcome: 'unknown',
          },
        },
        { idempotencyKey: 'not-owner' },
      ),
      (error: any) => error.code === 'UNAUTHORIZED' && error.scope === 'no-such-conflict',
    );

    const script = `import asyncio, json, sys
from orchvia import Orchestrator
from orchvia.types import to_wire
async def main():
    async with Orchestrator.connect(socket_path=sys.argv[1]) as client:
        print(json.dumps({"scheduler": to_wire(await client.scheduler.get()), "session": to_wire(await client.sessions.get(sys.argv[2]))}))
asyncio.run(main())
`;
    const python = spawn('python3', ['-c', script, socketPath, session.id], {
      stdio: 'pipe',
      env: { ...process.env, PYTHONPATH: join(repo, 'python/src') },
    });
    t.after(() => stop(python));
    let output = '',
      pythonError = '';
    python.stdout.on('data', (chunk) => {
      output += chunk;
    });
    python.stderr.on('data', (chunk) => {
      pythonError += chunk;
    });
    await once(python, 'exit');
    assert.equal(python.exitCode, 0, pythonError);
    assert.deepEqual(JSON.parse(output), { scheduler, session });
    const events = await client.events.read({ taskId: task.id, limit: 256 });
    assert.equal(events.events.filter((event) => event.type === 'dispatch.started').length, 1);
    assert.equal(events.events.filter((event) => event.type === 'approval.requested').length, 0);
  },
);
