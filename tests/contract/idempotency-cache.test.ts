import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '../fixtures/engine.ts';
import {
  Orchestrator,
  OrchestratorError,
  createOrchestrator,
} from '../../packages/sdk-typescript/src/index.ts';
import type { Caller } from '../../packages/sdk-typescript/src/transport.ts';

// SPEC-0027 K: the SDK forgets an idempotency key that the engine rejected before committing.

const session = (model: string) => ({ runtime: { provider: 'fake', model } });

async function embedded(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-idempotency-cache-')));
  await mkdir(join(root, 'workspace'));
  const config = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    providers: { fake: { models: ['small', 'large'] } },
    storage: { emergencyBytes: 4096 },
  };
  const orch = await createOrchestrator(config);
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return orch;
}
/** A client over a scripted host: `answer` decides each call; `sent` records what reached it. */
function scripted(
  info: Orchestrator['info'],
  answer: (method: string, params: Record<string, unknown>) => unknown,
) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const caller: Caller = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
      return answer(method, params) as T;
    },
    disconnect() {},
  };
  return { client: new Orchestrator(caller, info, true), sent };
}
/** How a host reports an engine error: the code is also in the data (SPEC-0025 E01). */
const hostError = (code: string) => new OrchestratorError(code, `engine ${code}`, { code });
const localConflict = {
  code: 'IDEMPOTENCY_CONFLICT',
  message: 'Retry identity or payload changed',
};

test('0027-K01 a rejected request is corrected under the same key', async (t) => {
  const orch = await embedded(t);
  await assert.rejects(orch.sessions.open(session('unlisted'), { idempotencyKey: 'k1' }), {
    code: 'VALIDATION_ERROR',
  });
  const opened = await orch.sessions.open(session('small'), { idempotencyKey: 'k1' });
  assert.equal(opened.model, 'small');
  // Once committed, the key keeps its request: another one fails before it is sent.
  await assert.rejects(
    orch.sessions.open(session('large'), { idempotencyKey: 'k1' }),
    localConflict,
  );
  // Retrying the committed request returns what it committed.
  const retried = await orch.sessions.open(session('small'), { idempotencyKey: 'k1' });
  assert.equal(retried.id, opened.id);
});

test('0027-K02 0027-K04 identities are kept after local failures and after errors that may follow a commit', async (t) => {
  const orch = await embedded(t);
  for (const failure of [
    new OrchestratorError('TIMEOUT', 'Local request wait timed out'),
    new OrchestratorError('CONNECTION_CLOSED', 'Host connection closed'),
    new OrchestratorError('ABORTED', 'Local request aborted'),
    new OrchestratorError('RPC_ERROR', 'RPC error'),
    ...[
      'RESOURCE_CLEANUP_INCOMPLETE',
      'ROLLOVER_IN_PROGRESS',
      'ROLLOVER_BLOCKED',
      'STORE_SWITCH_IN_PROGRESS',
      'SHUTDOWN_INCOMPLETE',
      'OUTCOME_UNKNOWN',
      'OPERATION_HISTORY_EXPIRED',
      'IDEMPOTENCY_CONFLICT',
      'INTERNAL_ERROR',
      'STORAGE_DEGRADED',
    ].map(hostError),
  ]) {
    const { client, sent } = scripted(orch.info, () => {
      throw failure;
    });
    await assert.rejects(client.sessions.open(session('small'), { idempotencyKey: 'k' }), {
      code: failure.code,
    });
    await assert.rejects(
      client.sessions.open(session('large'), { idempotencyKey: 'k' }),
      localConflict,
      failure.code,
    );
    assert.equal(sent.length, 1, failure.code);
  }
  // An identity from before the call is kept even when the engine rejects the retry.
  let first = true;
  const { client, sent } = scripted(orch.info, () => {
    if (first) {
      first = false;
      return { id: 'session-1' };
    }
    throw hostError('VALIDATION_ERROR');
  });
  await client.sessions.open(session('small'), { idempotencyKey: 'k' });
  await assert.rejects(client.sessions.open(session('small'), { idempotencyKey: 'k' }), {
    code: 'VALIDATION_ERROR',
  });
  await assert.rejects(
    client.sessions.open(session('large'), { idempotencyKey: 'k' }),
    localConflict,
  );
  assert.equal(sent.length, 2);
});

test('0027-K01 engine rejections that commit nothing release the key', async (t) => {
  const orch = await embedded(t);
  for (const code of [
    'VALIDATION_ERROR',
    'NOT_FOUND',
    'UNAUTHORIZED',
    'STALE_TARGET',
    'HOST_STOPPING',
  ]) {
    let first = true;
    const { client, sent } = scripted(orch.info, () => {
      if (!first) return { id: 'session-2' };
      first = false;
      throw hostError(code);
    });
    await assert.rejects(client.sessions.open(session('small'), { idempotencyKey: 'k' }), { code });
    const opened = await client.sessions.open(session('large'), { idempotencyKey: 'k' });
    assert.equal(opened.id, 'session-2', code);
    assert.equal(sent.length, 2, code);
    assert.notEqual(sent[1].params.requestDigest, sent[0].params.requestDigest);
  }
});

test('0027-K03 forgetIdempotencyKey and the cache limit', async (t) => {
  const orch = await embedded(t);
  const { client, sent } = scripted(orch.info, () => ({ id: 'session' }));
  await client.sessions.open(session('small'), { idempotencyKey: 'kept' });
  await client.tasks.cancel('task-a', { idempotencyKey: 'kept' });
  await client.tasks.cancel('task-b', { idempotencyKey: 'other' });
  assert.equal(client.forgetIdempotencyKey('kept'), 2);
  assert.equal(client.forgetIdempotencyKey('kept'), 0);
  await client.sessions.open(session('large'), { idempotencyKey: 'kept' });
  assert.equal(sent.length, 4);
  // The engine still refuses another request under a key it committed.
  await orch.sessions.open(session('small'), { idempotencyKey: 'engine-key' });
  assert.equal(orch.forgetIdempotencyKey('engine-key'), 1);
  await assert.rejects(orch.sessions.open(session('large'), { idempotencyKey: 'engine-key' }), {
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Key was already used with different payload',
  });

  // At most 10,000 identities; the least recently used goes first.
  const many = scripted(orch.info, () => ({ id: 'session' }));
  await many.client.sessions.open(session('small'), { idempotencyKey: 'oldest' });
  await many.client.sessions.open(session('small'), { idempotencyKey: 'used' });
  for (let i = 0; i < 9998; i++)
    await many.client.sessions.open(session('small'), { idempotencyKey: `k${i}` });
  // Using `used` again makes `oldest` the least recently used.
  await many.client.sessions.open(session('small'), { idempotencyKey: 'used' });
  await many.client.sessions.open(session('small'), { idempotencyKey: 'newest' });
  await many.client.sessions.open(session('large'), { idempotencyKey: 'oldest' });
  await assert.rejects(
    many.client.sessions.open(session('large'), { idempotencyKey: 'used' }),
    localConflict,
  );
  await assert.rejects(
    many.client.sessions.open(session('large'), { idempotencyKey: 'newest' }),
    localConflict,
  );
});
