import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import * as feedback from '../../packages/engine/src/verification-feedback.ts';
import type {
  Engine,
  EngineConfig,
  EventPage,
  RuntimeAdapter,
  RuntimeInput,
  RuntimeUsageEvent,
  TaskSnapshot,
  UsageRecord,
} from '../../packages/engine/src/types.ts';
import type { VerificationEvidence } from '../../packages/engine/src/verification.ts';

// SPEC-0028 E: usage records and events that carry their content, and check output in
// verification.completed.

const usage = (inputTokens: number): RuntimeUsageEvent => ({
  type: 'usage',
  usageId: 'u1',
  usage: {
    inputTokens,
    cachedInputTokens: 3,
    cacheWriteInputTokens: null,
    outputTokens: 5,
    raw: { big: 'x'.repeat(1000) },
  },
});
/** A fake runtime that reports usage once accepted, and keeps each input for late reports. */
function reporting() {
  const base = createFakeAdapter();
  const inputs = new Map<string, RuntimeInput>();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      inputs.set(input.taskId, input);
      for await (const event of base.execute(input)) {
        yield event;
        if (event.type === 'accepted') yield usage(11);
      }
    },
  };
  return { adapter, inputs };
}
async function setup(overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-contained-events-')));
  await mkdir(join(root, 'workspace'));
  const runtime = reporting();
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [runtime.adapter],
    ...overrides,
  });
  return {
    engine,
    inputs: runtime.inputs,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 1000; i++) {
    task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
async function create(engine: Engine, goal: string, extra: Record<string, unknown> = {}) {
  return (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model: 'fixture-model' },
      acceptance: { mode: 'human', criteria: ['Review'] },
      ...extra,
    },
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
}
const events = async (engine: Engine, taskId: string, type: string) =>
  ((await engine.call('events.read', { taskId, limit: 1000 })) as EventPage).events.filter(
    (event) => event.type === type,
  );

test('0028-E01 a usage record holds its session, model, root task and time', async () => {
  const f = await setup();
  try {
    const root = await create(f.engine, 'root');
    const done = await wait(f.engine, root.id, 'waiting_approval');
    const approval = (await f.engine.call('approvals.get', { approvalId: done.approvalId })) as {
      revision: number;
    };
    await f.engine.call('approvals.decide', {
      approvalId: done.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'approve',
    });
    await wait(f.engine, root.id, 'completed');
    const child = await create(f.engine, 'child', { parentTaskId: root.id });
    const waiting = await wait(f.engine, child.id, 'waiting_approval');
    const before = Date.now();
    const [record] = (
      (await f.engine.call('usage.get', { taskId: child.id })) as { records: UsageRecord[] }
    ).records as (UsageRecord & Record<string, unknown>)[];
    assert.equal(record.sessionId, waiting.sessionId);
    assert.equal(record.model, 'fixture-model');
    assert.equal(record.rootTaskId, root.id);
    assert.equal(typeof record.recordedAt, 'string');
    assert.ok(Date.parse(record.recordedAt as string) <= before);
    assert.equal(
      new Date(Date.parse(record.recordedAt as string)).toISOString(),
      record.recordedAt,
    );

    // A late repeat of the same observation is accepted; other counts under its identity are not.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const input = f.inputs.get(child.id)!;
    input.reportUsage!(usage(11));
    assert.throws(() => input.reportUsage!(usage(12)), { code: 'IDEMPOTENCY_CONFLICT' });
    const again = (
      (await f.engine.call('usage.get', { taskId: child.id })) as { records: UsageRecord[] }
    ).records;
    assert.deepEqual(again, [record], 'the stored record did not change');
  } finally {
    await f.close();
  }
});

test('0028-E02 usage.recorded carries the token counts, model and root task, without raw', async () => {
  const f = await setup();
  try {
    const task = await create(f.engine, 'task');
    const waiting = await wait(f.engine, task.id, 'waiting_approval');
    const [event] = await events(f.engine, task.id, 'usage.recorded');
    const [record] = (
      (await f.engine.call('usage.get', { taskId: task.id })) as { records: UsageRecord[] }
    ).records;
    assert.deepEqual(event.data, {
      usageRecordId: record.id,
      dispatchId: record.dispatchId,
      provider: 'fake',
      inputTokens: 11,
      cachedInputTokens: 3,
      cacheWriteInputTokens: null,
      outputTokens: 5,
      model: 'fixture-model',
      rootTaskId: task.id,
    });
    assert.equal(event.sessionId, waiting.sessionId);
    assert.equal(typeof event.occurredAt, 'string');
  } finally {
    await f.close();
  }
});

function rule(id: string, script: string) {
  return {
    id,
    version: '1',
    argv: [process.execPath, '-e', script],
    cwdRelative: '.',
    timeoutMs: 5000,
    permissionProfile: 'read-only',
    success: { exitCode: 0 },
  };
}

test('0028-E03 verification.completed carries the output tail of each failed rule', async () => {
  const f = await setup({
    adapters: [createFakeAdapter()],
    verificationRules: [
      rule('lint', 'process.stdout.write("clean")'),
      rule('big', 'process.stdout.write("x".repeat(10000) + "END-OF-OUTPUT"); process.exit(1)'),
    ],
  } as Partial<EngineConfig>);
  try {
    const task = (await f.engine.call('tasks.create', {
      spec: {
        goal: 'Make the checks pass',
        runtime: { provider: 'fake', model: 'test' },
        acceptance: {
          mode: 'checks',
          ruleRefs: [
            { id: 'lint', version: '1' },
            { id: 'big', version: '1' },
          ],
          maxRepairs: 0,
        },
      },
      idempotencyKey: 'checks',
    })) as TaskSnapshot;
    await wait(f.engine, task.id, 'blocked');
    const [completed] = await events(f.engine, task.id, 'verification.completed');
    const [lint, big] = completed.data.rules as Record<string, unknown>[];
    assert.equal(lint.passed, true);
    assert.equal('outputTail' in lint, false, 'a passed rule carries no output');
    assert.equal('outputOmitted' in lint, false);
    assert.equal(big.passed, false);
    assert.equal(typeof big.outputTail, 'string', 'a failed rule carries its output tail');
    const tail = big.outputTail as string;
    assert.ok(Buffer.byteLength(JSON.stringify(tail)) - 2 <= 4096);
    assert.ok(tail.length > 4000, 'the tail uses its room');
    assert.ok(tail.endsWith('END-OF-OUTPUT'));
    assert.equal(big.outputBytes, 10000 + 'END-OF-OUTPUT'.length);
  } finally {
    await f.close();
  }
});

test('0028-E03 the event keeps the prompt budgets and shows the tails that the prompt shows', () => {
  const failed = (id: string, output: string): VerificationEvidence => ({
    ruleId: id,
    ruleVersion: '1',
    ruleDigest: 'd',
    argv: ['check', id],
    cwd: '/w',
    before: null,
    after: null,
    exitCode: 1,
    signal: null,
    timedOut: false,
    output,
    outputTruncated: false,
    passed: false,
    resourcesStopped: true,
  });
  const rules = [
    { ...failed('passed', 'fine'), passed: true, exitCode: 0 },
    failed('emoji', '\u{1F600}'.repeat(3000) + 'END-E'),
    ...[1, 2, 3, 4, 5, 6].map((i) => failed(`r${i}`, 'x'.repeat(10000) + `END-${i}`)),
    ...Array.from({ length: 200 }, (_, i) => failed(`many${i}`, 'y')),
  ];
  const completedRules = (feedback as Record<string, unknown>).completedRules as
    | ((rules: VerificationEvidence[]) => Record<string, unknown>[])
    | undefined;
  assert.equal(typeof completedRules, 'function', 'verification-feedback exports completedRules');
  const reported = completedRules!(rules);
  assert.equal(reported.length, rules.length, 'the event lists every rule');
  assert.deepEqual(
    Object.keys(reported[0]!).sort(),
    [
      'error',
      'exitCode',
      'outputBytes',
      'outputTruncated',
      'passed',
      'ruleId',
      'signal',
      'timedOut',
    ],
    'a passed rule has no output fields',
  );
  let tails = 0;
  const prompt = new Map<string, Record<string, unknown>>();
  for (const line of feedback
    .verificationFeedback('task', JSON.stringify({ taskId: 'task', passed: false, rules }), [])
    .split('\n')
    .filter((text) => text.startsWith('{"ruleId"')))
    prompt.set(JSON.parse(line).ruleId, JSON.parse(line));
  for (const entry of reported.slice(1)) {
    assert.equal(entry.passed, false);
    if (typeof entry.outputTail === 'string') {
      tails += Buffer.byteLength(JSON.stringify(entry.outputTail)) - 2;
      assert.ok(Buffer.byteLength(JSON.stringify(entry.outputTail)) - 2 <= 4096);
      assert.ok(!/\p{Surrogate}/u.test(entry.outputTail), `${entry.ruleId} splits a character`);
      assert.equal(entry.outputTail, prompt.get(entry.ruleId as string)?.outputTail);
    } else {
      assert.equal(entry.outputOmitted, 'limit', `${entry.ruleId}`);
      assert.equal(prompt.get(entry.ruleId as string)?.outputTail, undefined);
    }
  }
  assert.ok(tails <= 16384, `the tails take ${tails} bytes`);
  assert.ok(tails > 8000, 'the tails use their room');
  assert.ok((reported[1]!.outputTail as string).endsWith('END-E'));
  assert.ok(
    reported.some((entry) => entry.outputOmitted === 'limit'),
    'the budget left some tails out',
  );
});
