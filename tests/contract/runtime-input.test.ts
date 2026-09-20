import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireEngineRuntimeInput as requireInput } from '../fixtures/engine.ts';
import type { ExecutionBudget, RuntimeInput } from '../../packages/engine/src/types.ts';

function input() {
  let elapsed = 0;
  const budget: ExecutionBudget = {
    policyVersion: 2,
    enteredAt: '2026-09-20T00:00:00.000Z',
    acceptanceDeadlineAt: '2026-09-20T00:00:01.000Z',
    deadlineAt: '2026-09-20T00:00:02.000Z',
    effectiveAcceptanceMs: 1000,
    effectiveTurnMs: 2000,
    acceptanceSource: 'host_explicit',
    turnSource: 'host_explicit',
    remainingAcceptanceMs: () => Math.max(0, 1000 - elapsed),
    remainingTurnMs: () => Math.max(0, 2000 - elapsed),
  };
  const value: RuntimeInput = {
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    generation: 3,
    model: 'offline',
    workspace: '/offline/workspace',
    stateDir: '/offline/state',
    prompt: 'Synthetic host request',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    executionBudget: budget,
    reportExecutionEvidence: () => {},
  };
  return {
    value,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

test('AC-H02 host preflight preserves identity and the original decreasing shared budget', () => {
  const f = input();
  const checked = requireInput(f.value);
  assert.equal(checked, f.value);
  assert.equal(checked.executionBudget, f.value.executionBudget);
  assert.equal(checked.reportExecutionEvidence, f.value.reportExecutionEvidence);
  assert.equal(checked.generation, 3);
  f.advance(800);
  assert.equal(checked.executionBudget!.remainingAcceptanceMs(), 200);
  assert.equal(checked.executionBudget!.remainingTurnMs(), 1200);
  f.advance(1500);
  assert.equal(requireInput(f.value).executionBudget!.remainingTurnMs(), 0);
});

test('AC-H02 missing or malformed engine context cannot reach the host callback', () => {
  const patches: Record<string, unknown>[] = [
    { taskId: '' },
    { sessionId: '' },
    { dispatchId: '' },
    { generation: undefined },
    { generation: 0 },
    { generation: 1.5 },
    { executionBudget: undefined },
    { executionBudget: null },
    { executionBudget: { ...input().value.executionBudget, policyVersion: 1 } },
    { executionBudget: { ...input().value.executionBudget, effectiveTurnMs: 0 } },
    { executionBudget: { ...input().value.executionBudget, effectiveTurnMs: 500 } },
    { executionBudget: { ...input().value.executionBudget, effectiveAcceptanceMs: Infinity } },
    { executionBudget: { ...input().value.executionBudget, remainingTurnMs: 42 } },
    { executionBudget: { ...input().value.executionBudget, remainingAcceptanceMs: undefined } },
    { reportExecutionEvidence: undefined },
    { reportExecutionEvidence: 'callback' },
    { signal: null },
    { signal: { aborted: false } },
  ];
  let submissions = 0;
  for (const patch of patches) {
    assert.throws(
      () => {
        requireInput({ ...input().value, ...patch } as RuntimeInput);
        submissions++;
      },
      { code: 'INVALID_RUNTIME_CONTRACT' },
    );
  }
  assert.equal(submissions, 0);
});
