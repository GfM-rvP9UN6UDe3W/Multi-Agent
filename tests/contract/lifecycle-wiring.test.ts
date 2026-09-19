import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Orchestrator, OperationHandle } from '../../packages/sdk-typescript/src/index.ts';
import { engineConfig, loadConfig } from '../../packages/cli/src/config.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
import type {
  Engine,
  OperationSnapshot,
  SessionControlTarget,
} from '../../packages/engine/src/types.ts';

const target: SessionControlTarget = {
  sessionId: 'session-1',
  expectedGeneration: 1,
  expectedRevision: 3,
  expectedDispatchId: 'dispatch-1',
  expectedState: 'outcome_unknown',
};
const evidence = {
  source: 'owner_attestation' as const,
  summary: 'Owner checked the original execution record',
  localResources: 'stopped' as const,
  remoteExecution: 'stopped' as const,
  sideEffects: 'resolved' as const,
  outcome: 'completed' as const,
  result: 'Verified result',
};
const lifecycleCapability = { version: 1, reconcile: 'owner-attestation', durableDeadlines: true };
const info = {
  protocolVersion: '1.0',
  engineVersion: 'test',
  schemaVersion: 1,
  instanceId: 'fixture',
  storeId: 'fixture-store',
  capabilities: {},
};

test('0003-A TS reconcile rejects missing or incompatible lifecycle capability before sending', async () => {
  for (const lifecycle of [
    undefined,
    {},
    { ...lifecycleCapability, version: 2 },
    { ...lifecycleCapability, durableDeadlines: false },
  ]) {
    const sent: string[] = [];
    const client = new Orchestrator(
      {
        async call<T>(method: string): Promise<T> {
          sent.push(method);
          throw new Error('must not send');
        },
        disconnect() {},
      },
      { ...info, capabilities: lifecycle === undefined ? {} : { lifecycle } },
      true,
    );
    await assert.rejects(async () => client.sessions.reconcile(target, evidence), {
      code: 'UNSUPPORTED_CAPABILITY',
    });
    assert.deepEqual(sent, []);
  }
});

test('0003-A TS reconcile forwards exact target/evidence/key and exposes lifecycle on the operation handle', async () => {
  const calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const operation = {
    id: 'operation-1',
    method: 'sessions.reconcile',
    scope: target.sessionId,
    idempotencyKey: 'owner-review-1',
    status: 'completed',
    targetId: target.sessionId,
    result: { taskId: 'task-1' },
    error: null,
    lifecycle: {
      enteredAt: '2026-09-19T00:00:00.000Z',
      deadlineAt: '2026-09-19T00:01:00.000Z',
      policyVersion: 1,
      kind: 'reconcile',
      expectedGeneration: 1,
      expectedDispatchId: 'dispatch-1',
      mayHaveBeenSent: false,
      lastEvidence: 'Owner attestation',
    },
  } as unknown as OperationSnapshot;
  const client = new Orchestrator(
    {
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push({ method, params });
        return operation as T;
      },
      disconnect() {},
    },
    { ...info, capabilities: { lifecycle: lifecycleCapability } },
    true,
  );
  const handle = await client.sessions.reconcile(target, evidence, {
    idempotencyKey: 'owner-review-1',
  });
  assert.ok(handle instanceof OperationHandle);
  assert.deepEqual(calls[0], {
    method: 'sessions.reconcile',
    params: { target, evidence, idempotencyKey: 'owner-review-1' },
  });
  assert.equal(handle.initial.lifecycle?.deadlineAt, '2026-09-19T00:01:00.000Z');
  assert.equal((await handle.wait({ timeoutMs: 100 })).id, operation.id);
});

test('0003-A CLI validates lifecycle timeout bounds and passes every configured value to the engine', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-lifecycle-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const base = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    providers: { fake: { model: 'fake-model' } },
  };
  const path = join(root, 'config.json');
  const timeouts = {
    acceptanceMs: 1,
    turnMs: 86400000,
    drainMs: 300000,
    interruptMs: 30000,
    reconcileMs: 60000,
  };
  await writeFile(path, JSON.stringify({ ...base, timeouts }));
  assert.deepEqual((await engineConfig(await loadConfig(path))).timeouts, timeouts);
  for (const invalid of [0, -1, 1.5, 86400001, '1000', true]) {
    await writeFile(path, JSON.stringify({ ...base, timeouts: { turnMs: invalid } }));
    await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
  }
  await writeFile(path, JSON.stringify({ ...base, timeouts: { unknownMs: 100 } }));
  await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
});

test('0003-A owner EOF uses the 30-second bounded emergency close and reports incomplete cleanup', async () => {
  const calls: unknown[] = [],
    logs: string[] = [];
  const engine = {
    async close(options: unknown) {
      calls.push(options);
      throw Object.assign(new Error('Owned runtime not yet confirmed stopped'), {
        code: 'SHUTDOWN_INCOMPLETE',
        operationId: 'shutdown-1',
      });
    },
  } as unknown as Engine;
  const input = new PassThrough(),
    output = new PassThrough();
  const connection = startStdioHost(engine, {
    input,
    output,
    log: (message) => logs.push(message),
  });
  input.end();
  await connection.closed;
  assert.deepEqual(calls, [{ mode: 'interrupt', timeoutMs: 30000 }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /SHUTDOWN_INCOMPLETE/);
  assert.doesNotMatch(logs[0], /status.*closed/);
});
