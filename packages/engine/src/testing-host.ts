/** Deterministic, in-memory host boundary for examples and contract tests. No real execution. */
import { requireEngineRuntimeInput } from './runtime.ts';
import type { RuntimeContractAction, RuntimeContractFixture } from './testing.ts';
import type {
  EngineRuntimeInput,
  ExecutionEvidence,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeTerminalEvent,
} from './types.ts';

type Turn = {
  input: EngineRuntimeInput;
  nativeId: string;
  nativeTurnId: string;
  accepted: boolean;
  resources: boolean;
  sequence: number;
  events: RuntimeEvent[];
  ended: boolean;
  observationEnded: boolean;
  toolConfirmations: number;
  timer?: ReturnType<typeof setTimeout>;
  terminal?: RuntimeTerminalEvent;
  wake?: () => void;
};

export function createOfflineHostFixture(
  options: { interrupt?: boolean } = {},
): RuntimeContractFixture {
  const provider = 'offline-host';
  const result = 'Deterministic host result; no model, tool, or external side effect.';
  const usage = {
    inputTokens: 5,
    outputTokens: 7,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    raw: { source: 'deterministic-host-fixture' },
  };
  const turns = new Map<string, Turn>();
  let closed = false;
  const push = (turn: Turn, event: RuntimeEvent) => {
    turn.events.push(event);
    turn.wake?.();
  };
  const proof = (
    turn: Turn,
    source: ExecutionEvidence['source'],
    terminal?: RuntimeTerminalEvent,
    mismatch?: 'generation' | 'dispatch',
  ) => {
    turn.input.reportExecutionEvidence({
      version: 1,
      sequence: ++turn.sequence,
      dispatchId: turn.input.dispatchId + (mismatch === 'dispatch' ? '-other' : ''),
      sessionId: turn.input.sessionId,
      generation: turn.input.generation + (mismatch === 'generation' ? 1 : 0),
      provider,
      providerSessionId: turn.accepted ? turn.nativeId : null,
      providerTurnId: turn.accepted ? turn.nativeTurnId : null,
      source,
      observedAt: new Date().toISOString(),
      localResources: turn.resources && !mismatch ? 'active' : 'stopped',
      remoteExecution: turn.resources && !mismatch ? 'active' : 'stopped',
      detail: 'Deterministic fixture evidence only; no native process or model was invoked.',
      ...(terminal ? { terminal } : {}),
    });
  };
  const act = (dispatchId: string, action: RuntimeContractAction) => {
    const turn = turns.get(dispatchId);
    if (!turn) throw new Error('Unknown offline host dispatch');
    if (action === 'confirm-tool') {
      if (turn.ended) throw new Error('Fixture tool confirmation requires an active host turn');
      turn.toolConfirmations++;
      return;
    }
    if (action === 'accept') {
      if (turn.accepted || turn.ended)
        throw new Error('Offline host acceptance is no longer available');
      turn.accepted = true;
      push(turn, { type: 'accepted', providerSessionId: turn.nativeId });
      arm(turn);
      return;
    }
    if (action === 'stale-stop' || action === 'wrong-dispatch-stop') {
      proof(
        turn,
        'runtime_terminal',
        turn.terminal ?? { type: 'interrupted' },
        action === 'stale-stop' ? 'generation' : 'dispatch',
      );
      return;
    }
    if (action === 'stop') {
      turn.resources = false;
      const terminal =
        turn.terminal?.type === 'result' ? turn.terminal : ({ type: 'interrupted' } as const);
      proof(turn, 'runtime_terminal', terminal);
      if (!turn.ended) push(turn, terminal);
      turn.ended = true;
      turn.wake?.();
      return;
    }
    if (turn.ended) throw new Error('Offline host stream has ended');
    let terminal: RuntimeTerminalEvent;
    if (action === 'reject') {
      if (turn.accepted)
        throw new Error('Cannot claim pre-submission rejection after native acceptance');
      turn.resources = false;
      terminal = {
        type: 'error',
        outcome: 'failed',
        message: 'Fixture host rejected before submission',
      };
      proof(turn, 'pre_submission');
    } else if (action === 'disconnect') {
      terminal = {
        type: 'error',
        outcome: 'unknown',
        message: 'Fixture host receipt disconnected',
      };
    } else {
      if (!turn.accepted) throw new Error('Fixture result requires prior native acceptance');
      terminal = { type: 'result', text: result, providerSessionId: turn.nativeId };
      turn.resources = action === 'main-result';
      if (action === 'finish') {
        for (let n = 0; n < 2; n++) push(turn, { type: 'usage', usageId: 'fixture-result', usage });
      }
      proof(turn, 'runtime_terminal', terminal);
    }
    turn.terminal = terminal;
    push(turn, terminal);
    turn.ended = true;
  };
  const dispose = () => {
    closed = true;
    for (const [id, turn] of turns) if (turn.resources || !turn.ended) act(id, 'stop');
  };
  function arm(turn: Turn): void {
    clearTimeout(turn.timer);
    if (turn.ended) return;
    const budget = turn.input.executionBudget;
    const remaining = turn.accepted
      ? budget.remainingTurnMs()
      : Math.min(budget.remainingAcceptanceMs(), budget.remainingTurnMs());
    if (remaining <= 0) act(turn.input.dispatchId, 'disconnect');
    else turn.timer = setTimeout(() => arm(turn), remaining);
  }
  const adapter: RuntimeAdapter = {
    provider,
    capabilities: () => ({
      provider,
      resume: true,
      interrupt: options.interrupt ?? true,
      permissionProfiles: ['read-only'],
      executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
      executionEvidence: { version: 1, terminalCoversExecution: true },
      hostBoundary: { fixture: true, persistentBindings: false },
    }),
    hasActiveResources: (sessionId) =>
      [...turns.values()].some((turn) => turn.input.sessionId === sessionId && turn.resources),
    close: async () => dispose(),
    async *execute(raw): AsyncIterable<RuntimeEvent> {
      const input = requireEngineRuntimeInput(raw);
      if (closed || input.permissionProfile !== 'read-only' || turns.has(input.dispatchId))
        throw new Error('Offline host cannot admit this dispatch');
      const turn: Turn = {
        input,
        nativeId: input.providerSessionId ?? `fixture-native-${input.sessionId}`,
        nativeTurnId: `fixture-turn-${input.dispatchId}`,
        accepted: false,
        resources: true,
        sequence: 0,
        events: [],
        ended: false,
        observationEnded: false,
        toolConfirmations: 0,
      };
      // The fixture host has queued this exact identity; native acceptance is a separate action.
      turns.set(input.dispatchId, turn);
      const abort = () => {
        if (!turn.ended) act(input.dispatchId, 'disconnect');
      };
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      arm(turn);
      try {
        while (turn.events.length || !turn.ended) {
          if (turn.events.length) yield turn.events.shift()!;
          else
            await new Promise<void>((resolve) => {
              turn.wake = resolve;
            });
        }
      } finally {
        input.signal.removeEventListener('abort', abort);
        clearTimeout(turn.timer);
        turn.observationEnded = true;
        turn.wake = undefined;
        // Iterator completion never clears owned resources; only an explicit stop observation does.
      }
    },
  };
  return {
    adapter,
    result,
    usage,
    submissions: () => [...turns.values()].map((t) => t.input),
    nativeIdentity: (dispatchId) => {
      const turn = turns.get(dispatchId);
      if (!turn?.accepted) throw new Error('Fixture has no accepted native identity');
      return { sessionId: turn.nativeId, turnId: turn.nativeTurnId };
    },
    observationEnded: (dispatchId) => turns.get(dispatchId)?.observationEnded === true,
    act,
    dispose,
  };
}
