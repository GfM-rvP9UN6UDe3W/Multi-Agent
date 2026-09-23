import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

test(
  'AC12 TS submits, Python replays and approves, TS observes the same completed task',
  { timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'orch-mixed-')),
    );
    const workspace = join(root, 'workspace'),
      stateDir = join(root, 'state'),
      socketPath = join(root, 'host.sock');
    await mkdir(workspace);
    await mkdir(stateDir);
    const config = join(root, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        workspace,
        stateDir,
        providers: { fake: { model: 'fixture', result: 'known mixed-language evidence' } },
      }),
    );
    const host = spawn(
      process.execPath,
      ['packages/cli/src/main.ts', 'host', '--config', config, '--socket', socketPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let diagnostics = '';
    const captureDiagnostics = (chunk: Buffer) => (diagnostics += chunk.toString());
    host.stderr.on('data', captureDiagnostics);
    const hostExit = once(host, 'exit');
    let client: Awaited<ReturnType<typeof connectOrchestrator>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const readyMarker = `orchvia listening on ${socketPath}\n`;
        const timer = setTimeout(
          () => finish(new Error(`Host startup timed out after 10000 ms: ${diagnostics}`)),
          10000,
        );
        const checkReady = () => {
          if (diagnostics.includes(readyMarker)) finish();
        };
        const fail = (error: Error) =>
          finish(new Error(`Host failed to start: ${error.message}\n${diagnostics}`));
        const failOnExit = (code: number | null, signal: NodeJS.Signals | null) =>
          finish(
            new Error(
              `Host exited before startup (code ${code}, signal ${signal}): ${diagnostics}`,
            ),
          );
        function finish(error?: Error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          host.stderr.off('data', checkReady);
          host.off('error', fail);
          host.off('exit', failOnExit);
          if (error) reject(error);
          else resolve();
        }
        host.stderr.on('data', checkReady);
        host.once('error', fail);
        host.once('exit', failOnExit);
        if (host.exitCode !== null || host.signalCode !== null)
          failOnExit(host.exitCode, host.signalCode);
        else checkReady();
      });
      client = await connectOrchestrator({ socketPath });
      const task = await client.tasks.create(
        {
          goal: 'Known offline fixture',
          runtime: { provider: 'fake', model: 'fixture' },
          acceptance: { mode: 'human', criteria: ['Compare exact fixture evidence'] },
        },
        { idempotencyKey: 'mixed-language' },
      );
      const python = spawn(
        'python3',
        [
          '-c',
          `
import asyncio, json, sys
from orchvia import Orchestrator
async def main():
    async with Orchestrator.connect(socket_path=sys.argv[1]) as orch:
        async for event in orch.events(task_id=sys.argv[2]):
            if event.type != 'approval.requested':
                continue
            approval = await orch.approvals.get(event.data.approval_id)
            state = await orch.tasks.get(sys.argv[2])
            assert state.result == 'known mixed-language evidence'
            assert approval.status == 'pending'
            await orch.approvals.decide(approval.approval_id, {'choice': 'approve', 'expected_revision': approval.revision}, idempotency_key='python-decision')
            print(json.dumps({'task_id': state.id, 'store_id': orch.info.store_id}))
            break
asyncio.run(main())
`,
          socketPath,
          task.id,
        ],
        {
          env: { ...process.env, PYTHONPATH: join(process.cwd(), 'python/src') },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '',
        errors = '';
      python.stdout.on('data', (chunk) => (output += chunk.toString()));
      python.stderr.on('data', (chunk) => (errors += chunk.toString()));
      const timer = setTimeout(() => python.kill('SIGKILL'), 5000);
      try {
        const [exit] = await once(python, 'exit');
        assert.equal(exit, 0, errors);
      } finally {
        clearTimeout(timer);
      }
      const receipt = JSON.parse(output);
      assert.equal(receipt.task_id, task.id);
      assert.equal(receipt.store_id, client.info.storeId);
      const result = await task.wait({ timeoutMs: 1000 });
      assert.equal(result.status, 'completed');
      assert.equal(result.result, 'known mixed-language evidence');
      assert.equal(host.exitCode, null, 'Python disconnect must leave the shared host running');
    } finally {
      await client?.close();
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
      const timer = setTimeout(() => host.kill('SIGKILL'), 2000);
      try {
        await hostExit;
      } finally {
        clearTimeout(timer);
        host.stderr.off('data', captureDiagnostics);
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
