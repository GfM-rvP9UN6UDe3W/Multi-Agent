import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
} from '../../packages/adapter-claude/src/index.ts';
import { createEngine } from '../fixtures/engine.ts';
import type {
  EventPage,
  RuntimeEvent,
  RuntimeInput,
  SchedulerSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';
import { refuseGroupSignals, withClaudeProcess } from '../fixtures/claude-process.ts';

const makeAdapter = (config: Record<string, unknown>) =>
  createClaudeAdapter(config as ClaudeAdapterConfig);
async function directories(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-policy-')));
  const workspace = join(root, 'workspace'),
    stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, stateDir };
}
function input(
  paths: { workspace: string; stateDir: string },
  profile: RuntimeInput['permissionProfile'] = 'read-only',
): RuntimeInput {
  return {
    ...paths,
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    generation: 1,
    providerSessionId: null,
    model: 'offline',
    prompt: 'fixture',
    permissionProfile: profile,
    signal: new AbortController().signal,
  };
}
const terminal = (sessionId = 'native-session') => ({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  result: 'fixture',
});
async function collect(adapter: ReturnType<typeof createClaudeAdapter>, value: RuntimeInput) {
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute(value)) events.push(event);
  } finally {
    await adapter.close();
  }
  return events;
}
type NativeHook = (
  input: Record<string, unknown>,
  id: string,
  context: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;
type NativeOptions = Record<string, unknown> & { hooks: { PreToolUse: { hooks: NativeHook[] }[] } };

test('AC-P01 host options preserve native callbacks, tools, MCP/settings and approval defaults', async (t) => {
  const paths = await directories(t);
  let captured!: NativeOptions;
  const canUseTool = async () => ({ behavior: 'allow', updatedInput: {} });
  const hostHook: NativeHook = async () => ({ continue: true });
  const options = {
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [hostHook] }] },
    mcpServers: { host: { type: 'sdk', name: 'fixture', instance: {} } },
    systemPrompt: 'host policy',
    maxTurns: 3,
    env: { HOST_FIXTURE: 'yes' },
    settingSources: ['project'],
    tools: ['Read', 'Glob', 'Grep', 'mcp__host__lookup'],
    disallowedTools: ['Write'],
    managedSettings: { permissions: { deny: ['Read(//private/fixture/**)'] } },
  };
  const adapter = makeAdapter({
    options,
    query: withClaudeProcess((request) => {
      captured = request.options as unknown as NativeOptions;
      return (async function* () {
        yield terminal();
      })();
    }),
  });
  await collect(adapter, input(paths));
  assert.equal(captured.canUseTool, canUseTool);
  assert.equal(captured.systemPrompt, 'host policy');
  assert.equal(captured.maxTurns, 3);
  assert.deepEqual(captured.env, options.env);
  assert.deepEqual(captured.mcpServers, options.mcpServers);
  assert.deepEqual(captured.managedSettings, options.managedSettings);
  assert.deepEqual(captured.settingSources, ['project']);
  assert.deepEqual(captured.allowedTools, []);
  assert.equal(captured.permissionMode, 'default');
  assert.ok(captured.hooks.PreToolUse.some((matcher) => matcher.hooks.includes(hostHook)));
  assert.ok(captured.hooks.PreToolUse.length > 1, 'adapter guard must coexist with host hooks');
});

test('AC-P01 ownership overrides and malformed native policy fail without a query', () => {
  for (const options of [
    { cwd: '/private/forbidden' },
    { model: 'wrong' },
    { resume: 'wrong' },
    { prompt: 'wrong' },
    { abortController: new AbortController() },
    { spawnClaudeCodeProcess: () => {} },
    { sessionId: 'wrong' },
    { additionalDirectories: ['/private'] },
    { tools: 'Write' },
    { allowedTools: [1] },
    { settingSources: ['unknown'] },
    { permissionMode: 'unknown' },
    { maxTurns: 0 },
    { maxTurns: 1.2 },
    {
      get env() {
        throw new Error('PRIVATE_ACCESSOR_ERROR');
      },
    },
  ]) {
    assert.throws(
      () =>
        makeAdapter({
          options,
          query: () => {
            throw new Error('query must not run');
          },
        }),
      { code: 'INVALID_ADAPTER_CONFIG' },
    );
  }
});

test('AC-P02 async option extension consumes the original budget before submission', async (t) => {
  const paths = await directories(t);
  let called = false;
  let context: { input: RuntimeInput } | undefined;
  const value = input(paths);
  const started = performance.now();
  value.executionBudget = {
    policyVersion: 2,
    effectiveAcceptanceMs: 20,
    effectiveTurnMs: 30,
    enteredAt: new Date().toISOString(),
    acceptanceDeadlineAt: new Date().toISOString(),
    deadlineAt: new Date().toISOString(),
    acceptanceSource: 'host',
    turnSource: 'host',
    remainingAcceptanceMs: () => Math.max(0, 20 - (performance.now() - started)),
    remainingTurnMs: () => Math.max(0, 30 - (performance.now() - started)),
  };
  const adapter = makeAdapter({
    extendOptions: async (ctx: { input: RuntimeInput }) => {
      context = ctx;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { systemPrompt: 'too late' };
    },
    query: () => {
      called = true;
      throw new Error('must not submit');
    },
  });
  const events = await collect(adapter, value);
  assert.equal(called, false);
  assert.ok(context);
  assert.equal(context.input.dispatchId, value.dispatchId);
  assert.equal(
    context.input.executionBudget?.remainingTurnMs,
    value.executionBudget!.remainingTurnMs,
  );
  assert.equal(Object.isFrozen(context.input), true);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
});

test('AC-P02 extension ownership overrides fail before process/query creation', async (t) => {
  const paths = await directories(t);
  let called = false;
  const adapter = makeAdapter({
    extendOptions: () => ({ cwd: '/wrong' }),
    query: () => {
      called = true;
      throw new Error('must not submit');
    },
  });
  const events = await collect(adapter, input(paths));
  assert.equal(called, false);
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
  assert.ok(
    !JSON.stringify(events).includes('/wrong'),
    'error must not copy private option values',
  );
});

test('AC-P03 workspace-write passes sandbox policy and blocks unsafe native tool targets', async (t) => {
  const paths = await directories(t);
  const outside = join(paths.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(paths.workspace, 'outside-link'));
  await symlink(paths.stateDir, join(paths.workspace, 'state-link'));
  let captured!: NativeOptions;
  const adapter = makeAdapter({
    permissionProfile: 'workspace-write',
    query: withClaudeProcess((request) => {
      captured = request.options as unknown as NativeOptions;
      return (async function* () {
        yield terminal();
      })();
    }),
  });
  assert.deepEqual(adapter.capabilities().permissionProfiles, ['workspace-write']);
  await collect(adapter, input(paths, 'workspace-write'));
  assert.ok((captured.tools as string[]).includes('Bash'));
  const sandbox = captured.sandbox as {
    enabled: boolean;
    failIfUnavailable: boolean;
    allowUnsandboxedCommands: boolean;
    filesystem: { allowWrite: string[]; denyRead: string[] };
  };
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(sandbox.filesystem.allowWrite, [paths.workspace]);
  assert.ok(sandbox.filesystem.denyRead.includes(paths.stateDir));
  const check = async (tool_name: string, tool_input: Record<string, unknown>) => {
    const results = await Promise.all(
      captured.hooks.PreToolUse.flatMap((matcher) => matcher.hooks).map((hook) =>
        hook({ tool_name, tool_input }, 'call', { signal: new AbortController().signal }),
      ),
    );
    return results.some(
      (result) =>
        (result.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision ===
        'deny',
    );
  };
  assert.equal(
    await check('Write', { file_path: join(paths.workspace, 'new', 'file.txt') }),
    false,
  );
  assert.equal(await check('Write', { file_path: join(outside, 'file.txt') }), true);
  assert.equal(
    await check('Edit', { file_path: join(paths.workspace, 'outside-link', 'file.txt') }),
    true,
  );
  assert.equal(
    await check('Read', { file_path: join(paths.workspace, 'state-link', 'store.sqlite') }),
    true,
  );
  assert.equal(await check('Grep', { path: paths.stateDir, pattern: '.' }), true);
  assert.equal(await check('Write', { file_path: 123 }), true);
  assert.equal(
    await check('Bash', { command: 'echo fixture', dangerouslyDisableSandbox: true }),
    true,
  );
  assert.equal(await check('Bash', { command: 'echo fixture', run_in_background: true }), true);
  assert.equal(await check('Bash', { command: 'echo fixture' }), false);
});

test('AC-P03 weakening the write sandbox is rejected before a query', async (t) => {
  const paths = await directories(t);
  for (const sandbox of [
    { enabled: false },
    { failIfUnavailable: false },
    { allowUnsandboxedCommands: true },
    { excludedCommands: ['*'] },
    { filesystem: { allowWrite: [paths.root] } },
  ]) {
    let called = false;
    const adapter = makeAdapter({
      permissionProfile: 'workspace-write',
      options: { sandbox },
      query: () => {
        called = true;
        throw new Error('must not submit');
      },
    });
    const events = await collect(adapter, input(paths, 'workspace-write'));
    assert.equal(called, false);
    assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
  }
});

async function until<T>(read: () => Promise<T>, condition: (value: T) => boolean): Promise<T> {
  // Generous for slow CI runners; a correct run observes the state within milliseconds.
  const deadline = performance.now() + 10000;
  for (;;) {
    const value = await read();
    if (condition(value)) return value;
    assert.ok(performance.now() < deadline, 'host policy observation timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const proof of [true, false, 'late', 'missing', 'throws'] as const) {
  test(`AC-P05 extended main terminal requires a matching host stop observation: ${proof}`, async (t) => {
    const paths = await directories(t);
    let release!: (stopped: boolean) => void;
    const late = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const adapter = makeAdapter({
      options: { systemPrompt: 'host extensions' },
      // `late` needs the ceiling to expire, which it does on any runner. The other cases need
      // cleanup to finish first; 300 ms was too little on a loaded CI runner.
      cleanupTimeoutMs: proof === 'late' ? 300 : 5000,
      ...(proof === 'missing'
        ? {}
        : {
            observeExecutionStop: (context: {
              target: { dispatchId: string; generation: number; providerSessionId: string };
              terminal: { type: string };
            }) => {
              assert.equal(context.target.generation, 1);
              assert.equal(context.target.providerSessionId, 'native-session');
              assert.equal(context.terminal.type, 'result');
              assert.ok(context.target.dispatchId);
              if (proof === 'throws') throw new Error('offline observation failure');
              return proof === 'late' ? late : proof;
            },
          }),
      query: withClaudeProcess(
        () =>
          (async function* () {
            yield terminal();
          })(),
        // Wait for the offline child to install its handlers before cleanup starts. This keeps
        // the cleanup ceiling scoped to process exit instead of including cold process startup.
        Promise.resolve(),
      ),
    });
    const engine = await createEngine({ ...paths, adapters: [adapter] });
    t.after(async () => {
      release(false);
      await engine.close({ mode: 'drain', timeoutMs: 1000 });
    });
    const created = (await engine.call('tasks.create', {
      spec: {
        goal: 'fixture',
        runtime: { provider: 'claude', model: 'offline' },
        acceptance: { mode: 'human', criteria: ['review'] },
      },
      idempotencyKey: 'task',
    })) as TaskSnapshot;
    const current = await until(
      async () => (await engine.call('tasks.get', { taskId: created.id })) as TaskSnapshot,
      (task) => ['blocked', 'waiting_approval'].includes(task.status),
    );
    assert.equal(current.status, proof === true ? 'waiting_approval' : 'blocked');
    assert.equal(
      ((await engine.call('scheduler.get')) as SchedulerSnapshot).executionOccupied,
      proof === true ? 0 : 1,
    );
    if (proof === 'late') {
      release(true);
      await until(
        async () => (await engine.call('scheduler.get')) as SchedulerSnapshot,
        (state) => state.executionOccupied === 0,
      );
      assert.equal(
        ((await engine.call('tasks.get', { taskId: created.id })) as TaskSnapshot).status,
        'blocked',
      );
      const events = (await engine.call('events.read', { taskId: created.id })) as EventPage;
      assert.ok(events.events.some((event) => event.type === 'execution.released'));
    }
  });
}

test('AC-P02 policy arrays and hook containers are isolated between dispatches', async (t) => {
  const paths = await directories(t);
  const hook: NativeHook = async () => ({ continue: true });
  const options = {
    tools: ['Read'],
    settingSources: ['project'],
    hooks: { PreToolUse: [{ hooks: [hook] }] },
  };
  let calls = 0;
  const adapter = makeAdapter({
    options,
    query: withClaudeProcess((request) => {
      const current = request.options as unknown as NativeOptions;
      assert.deepEqual(current.tools, ['Read']);
      assert.deepEqual(current.settingSources, ['project']);
      assert.equal(current.hooks.PreToolUse[1].hooks.length, 1);
      (current.tools as string[]).push('Grep');
      (current.settingSources as string[]).push('local');
      current.hooks.PreToolUse[1].hooks.push(hook);
      calls++;
      return (async function* () {
        yield terminal();
      })();
    }),
  });
  try {
    for (let i = 0; i < 2; i++)
      for await (const _event of adapter.execute({ ...input(paths), dispatchId: `d-${i}` })) {
        /* consume */
      }
    assert.equal(calls, 2);
    assert.deepEqual(options.tools, ['Read']);
    assert.equal(options.hooks.PreToolUse[0].hooks.length, 1);
  } finally {
    await adapter.close();
  }
});

test('AC-P02 rejected and aborted extensions never submit or expose private errors', async (t) => {
  const paths = await directories(t);
  for (const abort of [false, true]) {
    const controller = new AbortController();
    let called = false;
    const adapter = makeAdapter({
      extendOptions: async () => {
        if (abort) {
          controller.abort();
          await new Promise(() => {});
        }
        throw new Error('PRIVATE_EXTENSION_DETAIL');
      },
      query: () => {
        called = true;
        throw new Error('query');
      },
    });
    const events = await collect(adapter, { ...input(paths), signal: controller.signal });
    assert.equal(called, false);
    assert.ok(!JSON.stringify(events).includes('PRIVATE_EXTENSION_DETAIL'));
    assert.equal(events.at(-1)?.type, abort ? 'interrupted' : 'error');
  }
});

test('AC-P05 a positive remote observer does not replace local process exit', async (t) => {
  // The held child outlives its cleanup only because the adapter may not signal its group.
  refuseGroupSignals(t);
  const paths = await directories(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const evidence: { localResources: string; remoteExecution: string }[] = [];
  const adapter = makeAdapter({
    options: {},
    observeExecutionStop: () => true,
    cleanupTimeoutMs: 20,
    query: withClaudeProcess(
      () =>
        (async function* () {
          yield terminal();
        })(),
      gate,
    ),
  });
  try {
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.execute({
      ...input(paths),
      reportExecutionEvidence: (value) => evidence.push(value),
    }))
      events.push(event);
    assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
    assert.ok(evidence.some((value) => value.remoteExecution === 'stopped'));
    assert.equal(
      evidence.some((value) => value.localResources === 'stopped'),
      false,
    );
  } finally {
    release();
    // The released child exits after its SIGKILL. Wait until the adapter observes that exit; the
    // deadline only reports a child that never exits.
    const deadline = performance.now() + 5000;
    while (adapter.hasActiveResources('session') && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.close();
  }
});
