import type { ExecutionBudget } from '../../packages/engine/src/types.ts';

/** Advance only after the test has observed its intended native boundary. */
export function controlledExecutionBudget(durationMs = 50) {
  const enteredAt = '2026-09-21T00:00:00.000Z';
  const deadlineAt = new Date(Date.parse(enteredAt) + durationMs).toISOString();
  let elapsed = 0;
  const budget: ExecutionBudget = {
    policyVersion: 2,
    enteredAt,
    acceptanceDeadlineAt: deadlineAt,
    deadlineAt,
    effectiveAcceptanceMs: durationMs,
    effectiveTurnMs: durationMs,
    acceptanceSource: 'host-config',
    turnSource: 'host-config',
    remainingAcceptanceMs: () => durationMs - elapsed,
    remainingTurnMs: () => durationMs - elapsed,
  };
  return {
    budget,
    expire: () => {
      elapsed = durationMs;
    },
  };
}
