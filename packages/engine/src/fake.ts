import { setTimeout } from 'node:timers/promises';
import type { RuntimeAdapter, RuntimeEvent } from './types.ts';

/** Deterministic offline runtime. Never reads the workspace or calls a model. */
export function createFakeAdapter(
  options: { provider?: string; delayMs?: number; result?: string } = {},
): RuntimeAdapter {
  const provider = options.provider ?? 'fake';
  return {
    provider,
    capabilities() {
      return {
        provider,
        executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
        executionEvidence: { version: 1, terminalCoversExecution: true },
        resume: true,
        interrupt: true,
        permissionProfiles: ['read-only', 'workspace-write'],
        evidence: 'deterministic-test-runtime',
        fork: true,
        compact: true,
        manualCompact: true,
      };
    },
    async *execute(input): AsyncIterable<RuntimeEvent> {
      const terminal = (
        event: Extract<RuntimeEvent, { type: 'result' | 'interrupted' | 'error' }>,
      ) => {
        input.reportExecutionEvidence?.({
          version: 1,
          sequence: 1,
          dispatchId: input.dispatchId,
          sessionId: input.sessionId,
          generation: input.generation ?? 1,
          provider,
          providerSessionId: input.providerSessionId ?? `fake-${input.sessionId}`,
          source: 'runtime_terminal',
          observedAt: new Date().toISOString(),
          localResources: 'stopped',
          remoteExecution: 'stopped',
          detail: 'Deterministic fake execution has no external work or retained resources',
          terminal: event,
        });
        return event;
      };
      yield {
        type: 'accepted',
        providerSessionId: input.providerSessionId ?? `fake-${input.sessionId}`,
      };
      try {
        await setTimeout(options.delayMs ?? 0, undefined, { signal: input.signal });
      } catch (error) {
        if (input.signal.aborted) {
          yield terminal({ type: 'interrupted' });
          return;
        }
        throw error;
      }
      yield terminal({
        type: 'result',
        text: options.result ?? `Fake result: ${input.prompt}`,
        nativeCheckpoint: `fake-point-${input.dispatchId}`,
        ...(input.nativeAction === 'compact'
          ? {
              compacted: {
                kind: 'boundary' as const,
                evidence: { source: 'deterministic-fake', dispatchId: input.dispatchId },
              },
            }
          : {}),
      });
    },
  };
}
