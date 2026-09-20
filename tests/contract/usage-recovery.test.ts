import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('../fixtures/usage-owner.ts', import.meta.url));
function start(args: string[]) {
  const child = spawn(process.execPath, [fixture, ...args], { stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise<{
    taskId?: string;
    storeId: string;
    submissions: number;
    afterCursor: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Usage owner timeout: ${stderr}`)), 5000);
    createInterface({ input: child.stdout }).once('line', (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Usage owner exited: ${stderr}`));
    });
  });
  return { child, ready };
}

test(
  'AC-P08 usage and cursor survive an owned host crash and exact TS/Python replay',
  { timeout: 15000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'u7-')));
    const workspace = join(root, 'ws'),
      stateDir = join(root, 'state'),
      socketPath = join(root, 'host.sock');
    await mkdir(workspace);
    const children: ReturnType<typeof start>[] = [];
    try {
      const original = start(['seed', workspace, stateDir, socketPath]);
      children.push(original);
      const saved = await original.ready;
      assert.equal(saved.submissions, 1);
      const dead = once(original.child, 'exit');
      original.child.kill('SIGKILL');
      await dead;
      // This is our fixture's stale socket, and its owning process has actually exited.
      await rm(socketPath);
      const restarted = start(['serve', workspace, stateDir, socketPath]);
      children.push(restarted);
      const next = await restarted.ready;
      assert.equal(next.storeId, saved.storeId);
      assert.equal(next.submissions, 0);
      const client = await connectOrchestrator({ socketPath });
      try {
        const page = await client.events.read({
          storeId: saved.storeId,
          afterCursor: saved.afterCursor,
        });
        const notifications = page.events.filter((event) => event.type === 'usage.recorded');
        assert.equal(notifications.length, 1);
        const record = await client.usage.getRecord(notifications[0].data.usageRecordId as string);
        assert.equal(record.taskId, saved.taskId);
        assert.equal(record.inputTokens, 7);
        assert.equal((await client.usage.get(saved.taskId!)).records.length, 1);
        await assert.rejects(
          client.events.read({ afterCursor: saved.afterCursor, storeId: 'wrong-store' }),
          { code: 'CURSOR_EXPIRED' },
        );
        const { stdout } = await execute(
          'python3',
          [
            '-c',
            `
import asyncio, json, sys
from agent_orch import Orchestrator, OrchestrationError
async def main():
    async with Orchestrator.connect(socket_path=sys.argv[1]) as client:
        async for event in client.events(after_cursor=sys.argv[2], store_id=sys.argv[3]):
            if event.type != 'usage.recorded':
                continue
            record = await client.usage.get_record(event.data.usage_record_id)
            assert record.dispatch_id == event.data.dispatch_id
            assert record.raw['vendor'] == {'taskId': 'raw-unchanged'}
            assert record.cached_input_tokens is None
            for invalid, code in [('', 'VALIDATION_ERROR'), ('missing', 'NOT_FOUND')]:
                try:
                    await client.usage.get_record(invalid)
                except OrchestrationError as error:
                    assert error.code == code
                else:
                    raise AssertionError('Expected stable record error')
            print(json.dumps({'id': record.id, 'input': record.input_tokens, 'output': record.output_tokens}))
            return
asyncio.run(main())
`,
            socketPath,
            saved.afterCursor,
            saved.storeId,
          ],
          {
            timeout: 5000,
            env: {
              ...process.env,
              PYTHONPATH: fileURLToPath(new URL('../../python/src', import.meta.url)),
            },
          },
        );
        assert.deepEqual(JSON.parse(stdout), { id: record.id, input: 7, output: 2 });
        assert.deepEqual(
          (await client.events.read({ storeId: saved.storeId, afterCursor: page.cursor })).events,
          [],
        );
      } finally {
        await client.close();
      }
      const exited = once(restarted.child, 'exit');
      restarted.child.stdin.write('close\n');
      assert.equal((await exited)[0], 0);
    } finally {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('AC-P08 runnable forwarding example survives lost acknowledgment and replay without double accounting', async () => {
  const example = fileURLToPath(
    new URL('../../examples/typescript/usage-forwarding.ts', import.meta.url),
  );
  const { stdout } = await execute(process.execPath, [example], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), {
    runtime: 'fake',
    replayed: true,
    deliveryAttempts: 2,
    ledgerRows: 1,
    inputTokens: 7,
  });
});
