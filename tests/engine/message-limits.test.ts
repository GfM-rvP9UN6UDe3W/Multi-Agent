import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { MessageSnapshot, TaskSnapshot } from '../../packages/engine/src/types.ts';
test('AC-F09 message expiry and rate limits survive restart and never deliver expired content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-message-limits-'));
  await mkdir(join(dir, 'workspace'));
  const config = {
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    messages: { maxPerMinute: 1, maxHops: 1 },
  };
  let engine = await createEngine(config);
  try {
    const task = (await engine.call('tasks.create', {
      spec: {
        goal: 'task',
        runtime: { provider: 'fake', model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['review'] },
      },
      idempotencyKey: 'task',
    })) as TaskSnapshot;
    while (
      ((await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot).status !==
      'waiting_approval'
    )
      await new Promise((done) => setTimeout(done, 2));
    const spec = {
      taskId: task.id,
      toSessionId: task.sessionId,
      expectedGeneration: 1,
      kind: 'finding',
      summary: 'must expire',
      ttlMs: 15,
    };
    const message = (await engine.call('messages.send', {
      spec,
      idempotencyKey: 'message',
    })) as MessageSnapshot;
    assert.equal(
      ((await engine.call('messages.send', { spec, idempotencyKey: 'message' })) as MessageSnapshot)
        .id,
      message.id,
    );
    await assert.rejects(engine.call('messages.send', { spec, idempotencyKey: 'message-2' }), {
      code: 'MESSAGE_RATE_LIMIT',
    });
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await new Promise((done) => setTimeout(done, 20));
    engine = await createEngine(config);
    assert.equal(
      ((await engine.call('messages.get', { messageId: message.id })) as MessageSnapshot).status,
      'expired',
    );
    await assert.rejects(engine.call('messages.send', { spec, idempotencyKey: 'message-3' }), {
      code: 'MESSAGE_RATE_LIMIT',
    });
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC-F09 a message reply chain cannot reset its hop budget after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-hop-'));
  await mkdir(join(dir, 'work'));
  const config = {
    workspace: join(dir, 'work'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    messages: { maxHops: 2 },
  };
  let engine = await createEngine(config);
  try {
    const task = (await engine.call('tasks.create', {
      spec: {
        goal: 'hops',
        runtime: { provider: 'fake', model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['review'] },
      },
      idempotencyKey: 'task',
    })) as TaskSnapshot;
    while (
      ((await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot).status !==
      'waiting_approval'
    )
      await new Promise((r) => setTimeout(r, 5));
    const spec = {
      taskId: task.id,
      toSessionId: task.sessionId,
      expectedGeneration: 1,
      kind: 'finding',
      summary: 'reply',
    };
    const first = (await engine.call('messages.send', {
      spec,
      idempotencyKey: 'one',
    })) as MessageSnapshot;
    const second = (await engine.call('messages.send', {
      spec: { ...spec, replyToMessageId: first.id },
      idempotencyKey: 'two',
    })) as MessageSnapshot;
    assert.equal(second.hopCount, 2);
    await engine.close();
    engine = await createEngine(config);
    await assert.rejects(
      engine.call('messages.send', {
        spec: { ...spec, replyToMessageId: second.id },
        idempotencyKey: 'three',
      }),
      { code: 'MESSAGE_HOP_LIMIT' },
    );
    assert.equal(
      ((await engine.call('messages.get', { messageId: second.id })) as MessageSnapshot).hopCount,
      2,
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
