import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { Orchestrator } from '../../packages/sdk-typescript/src/index.ts';
import type { Engine } from '../../packages/engine/src/types.ts';

const closedError = () =>
  Object.assign(new Error('No durable receipt'), {
    code: 'STORAGE_DEGRADED_CLOSED',
    details: { status: 'closed', durableReceipt: false },
  });
test('B06 TypeScript closes its owner handle after a confirmed degraded shutdown error', async () => {
  let calls = 0,
    disconnects = 0;
  const client = new Orchestrator(
    {
      async call() {
        calls++;
        throw closedError();
      },
      disconnect() {
        disconnects++;
      },
    },
    {
      protocolVersion: '2.0',
      engineVersion: 'fixture',
      schemaVersion: 3,
      instanceId: 'i',
      storeId: 's',
      capabilities: {},
    },
    true,
  );
  await assert.rejects(client.close(), { code: 'STORAGE_DEGRADED_CLOSED' });
  assert.equal(disconnects, 1);
  await client.close();
  assert.equal(calls, 1, 'A closed owner must not attempt a second database write');
});
test('B06 Unix host removes its endpoint after resources close without a durable receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-degraded-host-'));
  const socketPath = join(root, 'host.sock');
  const engine = {
    async close() {
      throw closedError();
    },
  } as unknown as Engine;
  const host = await startUnixHost(engine, { socketPath });
  try {
    await assert.rejects(host.close(), { code: 'STORAGE_DEGRADED_CLOSED' });
    await assert.rejects(stat(socketPath), { code: 'ENOENT' });
    await Promise.race([
      host.closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Host endpoint remained live')), 500),
      ),
    ]);
  } finally {
    engine.close = async () => ({ status: 'closed', operationId: 'cleanup' });
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
