import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  RuntimeAdapter,
  RuntimeInput,
  Engine,
  EngineConfig,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const spec = {
  goal: 'parent',
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Owner review'] },
};
async function run(
  action: (input: RuntimeInput, engine: Engine) => Promise<void>,
  options: Partial<EngineConfig> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-tools-'));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter();
  let engine: Engine;
  let complete!: () => void;
  let failure: unknown;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const adapter: RuntimeAdapter = {
    ...fake,
    async *execute(input) {
      if (input.prompt === 'parent') {
        try {
          await action(input, engine);
        } catch (error) {
          failure = error;
        }
        complete();
      }
      yield* fake.execute(input);
    },
  };
  engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    tools: { enabled: true },
    ...options,
  } as EngineConfig);
  try {
    await engine.call('tasks.create', { spec, idempotencyKey: 'parent' });
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('Tool fixture timed out')), 1500);
        t.unref();
      }),
    ]);
    if (failure) throw failure;
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
}

test('AC-F05 four bound tools delegate, replay, send, read and control only the granted subtree', async () => {
  await run(async (input, engine) => {
    const tools = (
      input as RuntimeInput & {
        orchestrationTools?: {
          definitions: { name: string }[];
          call(name: string, args: unknown): Promise<unknown>;
        };
      }
    ).orchestrationTools;
    assert.ok(tools);
    assert.deepEqual(
      tools.definitions.map((d) => d.name),
      ['work_delegate', 'work_send', 'work_read', 'work_control'],
    );
    const request = {
      goal: 'child',
      contextPlan: { requestedMode: 'fresh', independent: true },
      idempotencyKey: 'child-key',
    };
    const child = (await tools.call('work_delegate', request)) as unknown as TaskSnapshot;
    const repeated = (await tools.call('work_delegate', request)) as unknown as TaskSnapshot;
    assert.equal(child.id, repeated.id);
    assert.equal(child.spec.parentTaskId, input.taskId);
    const session = (await tools.call('work_read', { kind: 'session', id: child.sessionId })) as {
      generation: number;
    };
    await tools.call('work_send', {
      taskId: child.id,
      toSessionId: child.sessionId,
      expectedGeneration: session.generation,
      kind: 'finding',
      summary: 'bounded context',
      idempotencyKey: 'message',
    });
    const outsider = (await engine.call('tasks.create', {
      spec: { ...spec, goal: 'outside' },
      idempotencyKey: 'outside',
    })) as TaskSnapshot;
    await assert.rejects(tools.call('work_read', { kind: 'task', id: outsider.id }), {
      code: 'UNAUTHORIZED',
    });
    await assert.rejects(tools.call('approvals.decide', {}), { code: 'UNAUTHORIZED' });
    await assert.rejects(tools.call('work_delegate', { ...request, actor: 'host_owner' }), {
      code: 'VALIDATION_ERROR',
    });
    await assert.rejects(
      tools.call('work_control', {
        target: { sessionId: outsider.sessionId },
        command: { action: 'stop' },
        idempotencyKey: 'control',
      }),
      { code: 'UNAUTHORIZED' },
    );
  });
});

test('AC-F05 stale grants reject calls after a dispatch has finished', async () => {
  let retained: { call(name: string, args: unknown): Promise<unknown> } | undefined;
  await run(async (input) => {
    retained = (input as unknown as { orchestrationTools: typeof retained }).orchestrationTools;
    assert.ok(retained);
  });
  await assert.rejects(retained!.call('work_read', { kind: 'task', id: 'anything' }), {
    code: 'STALE_GRANT',
  });
});

test('AC-F09 delegation and identical-read loops stop at finite durable limits', async () => {
  await run(
    async (input) => {
      const tools = (
        input as unknown as {
          orchestrationTools: { call(name: string, args: unknown): Promise<unknown> };
        }
      ).orchestrationTools;
      assert.ok(tools);
      await tools.call('work_read', { kind: 'task', id: input.taskId });
      await tools.call('work_read', { kind: 'task', id: input.taskId });
      await assert.rejects(tools.call('work_read', { kind: 'task', id: input.taskId }), {
        code: 'TOOL_LOOP_LIMIT',
      });
    },
    { tools: { enabled: true, maxRepeatedCalls: 2 } } as Partial<EngineConfig>,
  );
});
