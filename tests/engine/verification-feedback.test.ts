import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { verificationFeedback } from '../../packages/engine/src/verification-feedback.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0022 V: a retry after a failed verification says why the check failed.

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

async function fixture(rules: ReturnType<typeof rule>[]) {
  const root = await mkdtemp(join(tmpdir(), 'orchvia-verification-feedback-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const inner = createFakeAdapter();
  const prompts: string[] = [];
  const adapter: RuntimeAdapter = {
    ...inner,
    execute(input) {
      prompts.push(input.prompt);
      return inner.execute(input);
    },
  };
  const engine = await createEngine({
    workspace,
    stateDir: join(root, 'state'),
    adapters: [adapter],
    verificationRules: rules,
  } as EngineConfig);
  return {
    engine,
    prompts,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function checked(engine: Engine, ruleIds: string[], maxRepairs: number) {
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'Make the checks pass',
      runtime: { provider: 'fake', model: 'test' },
      acceptance: {
        mode: 'checks',
        ruleRefs: ruleIds.map((id) => ({ id, version: '1' })),
        maxRepairs,
      },
    },
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
  for (let i = 0; i < 1000; i++) {
    const current = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
    if (current.status === 'blocked') return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The task did not become blocked');
}

/** The JSON lines of a prompt. */
const jsonLines = (prompt: string) =>
  prompt
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => ({ line, value: JSON.parse(line) as Record<string, unknown> }));

test('0022-V01 a retry prompt lists each failed check with its command, exit status and output', async () => {
  const unit = rule('unit', 'console.error("expected 3 but got 2"); process.exit(1)');
  const f = await fixture([unit, rule('lint', 'console.log("clean")')]);
  try {
    await checked(f.engine, ['unit', 'lint'], 1);
    assert.equal(f.prompts.length, 2);
    assert.equal(jsonLines(f.prompts[0]!).length, 0, 'the first dispatch has no feedback');
    const retry = f.prompts[1]!;
    assert.deepEqual(
      jsonLines(retry).map(({ value }) => value),
      [
        {
          ruleId: 'unit',
          argv: unit.argv,
          exitCode: 1,
          signal: null,
          timedOut: false,
          error: null,
          outputBytes: Buffer.byteLength('expected 3 but got 2\n'),
          outputTruncated: false,
          outputTail: 'expected 3 but got 2\n',
        },
      ],
    );
    assert.match(retry, /untrusted/);
    assert.match(retry, /sha256:[0-9a-f]{64}/, 'the evidence artifacts are still named');
  } finally {
    await f.close();
  }
});

test('0022-V02 a large output reaches the prompt as its end, within 4 KiB', async () => {
  const f = await fixture([
    rule('big', 'process.stdout.write("x".repeat(10000) + "END-OF-OUTPUT"); process.exit(1)'),
  ]);
  try {
    await checked(f.engine, ['big'], 1);
    const [only] = jsonLines(f.prompts[1]!).map(({ value }) => value);
    const tail = only!.outputTail as string;
    assert.ok(Buffer.byteLength(JSON.stringify(tail)) - 2 <= 4096);
    assert.ok(tail.length > 4000, 'the tail uses its room');
    assert.ok(tail.endsWith('END-OF-OUTPUT'));
    assert.equal(only!.outputBytes, 10000 + 'END-OF-OUTPUT'.length);
  } finally {
    await f.close();
  }
});

test('0022-V02 the list keeps its limits and never splits a character', () => {
  const failed = (id: string, output: string) => ({
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
    failed('emoji', '\u{1F600}'.repeat(3000) + 'END-E'),
    ...[1, 2, 3, 4, 5, 6].map((i) => failed(`r${i}`, 'x'.repeat(10000) + `END-${i}`)),
    ...Array.from({ length: 200 }, (_, i) => failed(`many${i}`, 'y')),
  ];
  const text = verificationFeedback(
    'task',
    JSON.stringify({ taskId: 'task', passed: false, rules }),
    ['sha256:' + 'c'.repeat(64)],
  );
  const lines = jsonLines(text);
  const total = lines.reduce((sum, { line }) => sum + Buffer.byteLength(line), 0);
  assert.ok(total <= 16384, `the lines take ${total} bytes`);
  let listed = 0,
    omitted = 0,
    withoutTail = 0;
  for (const { value } of lines) {
    if (typeof value.omittedRules === 'number') {
      omitted += value.omittedRules;
      continue;
    }
    listed++;
    if (typeof value.outputTail !== 'string') {
      assert.equal(value.outputOmitted, 'limit');
      withoutTail++;
      continue;
    }
    const tail = value.outputTail;
    assert.ok(Buffer.byteLength(JSON.stringify(tail)) - 2 <= 4096, `${value.ruleId} tail too long`);
    // With the u flag, only a lone surrogate matches.
    assert.ok(!/\p{Surrogate}/u.test(tail), `${value.ruleId} tail splits a character`);
  }
  assert.equal(listed + omitted, rules.length, 'every failed rule is listed or counted');
  assert.ok(withoutTail > 0 && omitted > 0, 'the limit dropped tails, then rules');
  assert.equal(lines[0]!.value.ruleId, 'emoji');
  assert.ok((lines[0]!.value.outputTail as string).endsWith('END-E'));
});

test('0022-V03 without readable failed evidence of the same task, the details are unavailable', () => {
  const refs = ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)];
  for (const evidence of [
    null,
    'not json',
    JSON.stringify({ taskId: 'other', passed: false, rules: [] }),
    JSON.stringify({ taskId: 'task', passed: true, rules: [] }),
    JSON.stringify({ taskId: 'task', passed: false }),
  ]) {
    const text = verificationFeedback('task', evidence, refs);
    assert.match(text, /details are unavailable/, String(evidence));
    assert.ok(text.includes(JSON.stringify(refs)));
    assert.equal(jsonLines(text).length, 0);
  }
});

test('0022-V04 verification.completed reports every rule that ran, without its output', async () => {
  const f = await fixture([
    rule('lint', 'process.stdout.write("clean")'),
    rule('unit', 'process.stdout.write("boom"); process.exit(1)'),
  ]);
  try {
    const task = await checked(f.engine, ['lint', 'unit'], 0);
    const { events } = (await f.engine.call('events.read', { taskId: task.id })) as {
      events: { type: string; data: Record<string, unknown> }[];
    };
    const completed = events.find((event) => event.type === 'verification.completed')!;
    assert.deepEqual(completed.data.rules, [
      {
        ruleId: 'lint',
        passed: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        error: null,
        outputBytes: 5,
        outputTruncated: false,
      },
      {
        ruleId: 'unit',
        passed: false,
        exitCode: 1,
        signal: null,
        timedOut: false,
        error: null,
        outputBytes: 4,
        outputTruncated: false,
      },
    ]);
    assert.equal(completed.data.passed, false);
  } finally {
    await f.close();
  }
});
