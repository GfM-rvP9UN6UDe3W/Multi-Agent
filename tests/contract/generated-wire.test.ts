import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateWire } from '../../packages/engine/src/wire.ts';

test('AC-F15 generated wire models validate equivalent namespace, routing, nullable session and approval data in Python and TS', () => {
  const identity = {
    storeId: 's',
    method: 'tasks.create',
    scope: 'local',
    idempotencyKey: 'K',
    digestVersion: 1,
    requestDigest: 'a'.repeat(64),
  };
  const spec = {
    goal: 'Unicode 😀',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'checks', ruleRefs: [{ id: 'check', version: '1' }] },
    contextPlan: { requestedMode: 'fresh', independent: true },
    budget: { currency: 'USD', maxCost: '1.2', reservePerDispatch: '0.1' },
  };
  const params = { spec, expectedStoreId: 's', idempotencyKey: 'K' };
  const session = {
    id: 'logical',
    taskId: null,
    provider: 'fake',
    model: 'fixture',
    providerSessionId: null,
    generation: 1,
    revision: 1,
    status: 'idle',
    activeDispatchId: null,
    retryIdentity: identity,
  };
  const cases: [string, unknown, boolean][] = [
    ['TaskCreateParams', params, true],
    ['TaskCreateParams', { spec, idempotencyKey: 'K' }, false],
    ['TaskSpec', { ...spec, contextPlan: { requestedMode: 'fresh' } }, false],
    [
      'TaskSpec',
      { ...spec, budget: { currency: 'USD', maxCost: 1.2, reservePerDispatch: '0.1' } },
      false,
    ],
    ['SessionSnapshot', session, true],
    ['SessionSnapshot', { ...session, generation: true }, false],
    ['SessionSnapshot', { ...session, status: 'paused', pauseOrigin: 'client' }, true],
    ['SessionSnapshot', { ...session, status: 'paused', pauseOrigin: 'forged' }, false],
    ['RetryIdentity', identity, true],
    ['RetryIdentity', { ...identity, digestVersion: 2 }, false],
    [
      'ControlTarget',
      {
        sessionId: 's',
        expectedGeneration: 1,
        expectedRevision: 1,
        expectedDispatchId: null,
        expectedState: 'idle',
      },
      true,
    ],
  ];
  for (const [name, value, valid] of cases) {
    if (valid) validateWire(name, value);
    else assert.throws(() => validateWire(name, value));
  }
  const script = `import sys,json\nfrom orchvia.wire import validate_wire\nfrom orchvia import wire_types\nresults=[]\nfor name,value,expected in json.load(sys.stdin):\n try: validate_wire(name,value); results.append(True)\n except Exception: results.append(False)\nprint(json.dumps(results))\n`;
  const result = spawnSync('python3', ['-c', script], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'python/src' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    cases.map((row) => row[2]),
  );
});
