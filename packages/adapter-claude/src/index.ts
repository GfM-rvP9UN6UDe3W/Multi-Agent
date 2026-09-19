import type {
  ExecutionEvidence,
  Json,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInput,
  RuntimeTerminalEvent,
} from '../../engine/src/types.ts';
import { performance } from 'node:perf_hooks';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function nonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ClaudeQueryRequest {
  prompt: string;
  options: {
    model: string;
    cwd: string;
    resume?: string;
    settingSources: [];
    tools: string[];
    allowedTools: string[];
    disallowedTools: string[];
    permissionMode: 'dontAsk';
    abortController: AbortController;
  };
}
export type ClaudeQuery = AsyncIterable<unknown> & { close?(): void };
export type ClaudeQueryFactory = (request: ClaudeQueryRequest) => ClaudeQuery;
export interface ClaudeAdapterConfig {
  query?: ClaudeQueryFactory;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
export interface ClaudeRuntimeAdapter extends RuntimeAdapter {
  hasActiveResources(sessionId: string): boolean;
}
interface ActiveQuery {
  sessionId: string;
  controller: AbortController;
  query: ClaudeQuery;
  iterator: AsyncIterator<unknown> | null;
  cleaned: boolean;
  cleanupPromise: Promise<boolean> | null;
  onCleanupConfirmed: () => void;
}

function deadlineOption(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new RangeError(`${name} must be a finite positive millisecond integer`);
  return value;
}

class WaitEnded extends Error {}
async function withinDeadline<T>(
  work: Promise<T>,
  remainingMs: () => number,
  signal: AbortSignal,
  stage: string,
  useLocalTimer: boolean,
  onLateValue?: (value: T) => void,
): Promise<T> {
  // Observe both outcomes before an already-expired deadline or signal can return early.
  const observed = work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  if (signal.aborted) throw new WaitEnded(`${stage} aborted`);
  const remaining = remainingMs();
  if (remaining <= 0) throw new WaitEnded(`${stage} timed out`);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new WaitEnded(`${stage} aborted`)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recheck = (): void => {
      if (settled) return;
      const left = remainingMs();
      if (left <= 0) {
        finish(() => reject(new WaitEnded(`${stage} timed out`)));
        return;
      }
      // In host mode this is only a wake-up. The host's monotonic callback decides expiry.
      timer = setTimeout(recheck, useLocalTimer ? left : Math.min(left, 50));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (!settled) timer = setTimeout(recheck, useLocalTimer ? remaining : Math.min(remaining, 50));
    // The observed promise cannot reject, including after timeout or cancellation wins.
    observed.then((result) => {
      if (result.ok) {
        if (settled || remainingMs() <= 0) {
          try {
            onLateValue?.(result.value);
          } catch {
            /* A late observation cannot change the already-settled wait. */
          }
          finish(() => reject(new WaitEnded(`${stage} timed out`)));
        } else finish(() => resolve(result.value));
      } else finish(() => reject(result.error));
    });
  });
}

async function loadDefaultQuery(): Promise<ClaudeQueryFactory> {
  const sdkName = '@anthropic-ai/claude-agent-sdk';
  const sdk = (await import(sdkName)) as { query?: ClaudeQueryFactory };
  if (typeof sdk.query !== 'function') throw new Error('Claude Agent SDK query() is unavailable');
  return sdk.query;
}

export function createClaudeAdapter(config: ClaudeAdapterConfig = {}): ClaudeRuntimeAdapter {
  const requestTimeoutMs = deadlineOption(config.requestTimeoutMs, 'requestTimeoutMs', 30_000);
  const turnTimeoutMs = deadlineOption(config.turnTimeoutMs, 'turnTimeoutMs', 1_800_000);
  const cleanupTimeoutMs = deadlineOption(config.cleanupTimeoutMs, 'cleanupTimeoutMs', 1_000);
  const active = new Set<ActiveQuery>();
  let closed = false;

  function cleanup(handle: ActiveQuery): Promise<boolean> {
    if (handle.cleaned) return Promise.resolve(true);
    if (handle.cleanupPromise) return handle.cleanupPromise;
    handle.controller.abort();
    handle.cleanupPromise = (async () => {
      const markCleaned = (): void => {
        if (handle.cleaned) return;
        handle.cleaned = true;
        active.delete(handle);
        handle.onCleanupConfirmed();
      };
      let closeConfirmed = false;
      if (typeof handle.query.close === 'function') {
        try {
          handle.query.close();
          // The public Query.close() contract says the subprocess and transports are terminated.
          closeConfirmed = true;
        } catch {
          /* A completed iterator.return() may still confirm cleanup. */
        }
      }
      let returned: Promise<boolean>;
      try {
        returned =
          typeof handle.iterator?.return === 'function'
            ? Promise.resolve(handle.iterator.return()).then(
                (result) => {
                  try {
                    return result?.done === true;
                  } catch {
                    return false;
                  }
                },
                () => false,
              )
            : Promise.resolve(false);
      } catch {
        returned = Promise.resolve(false);
      }
      returned.then((ok) => {
        if (ok) markCleaned();
      });
      if (closeConfirmed) {
        markCleaned();
        return true;
      }
      const withinCleanup = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), cleanupTimeoutMs);
        returned.then((ok) => {
          clearTimeout(timer);
          resolve(ok);
        });
      });
      if (withinCleanup) markCleaned();
      return withinCleanup;
    })();
    return handle.cleanupPromise;
  }

  return {
    provider: 'claude',
    hasActiveResources(sessionId: string): boolean {
      return [...active].some((handle) => handle.sessionId === sessionId && !handle.cleaned);
    },
    capabilities: () => ({
      provider: 'claude',
      resume: true,
      interrupt: false,
      permissionProfiles: ['read-only'],
      fork: false,
      compact: false,
      toolBridge: false,
      executionBudget: {
        version: 2,
        acceptanceCapMs: config.requestTimeoutMs ?? null,
        turnCapMs: config.turnTimeoutMs ?? null,
      },
      executionEvidence: { version: 1, terminalCoversExecution: true },
    }),
    async close(): Promise<void> {
      closed = true;
      const results = await Promise.all([...active].map(cleanup));
      if (results.some((result) => !result) || [...active].some((handle) => !handle.cleaned))
        throw new Error('Claude SDK cleanup unconfirmed; adapter resources may still be active');
    },
    async *execute(input: RuntimeInput): AsyncIterable<RuntimeEvent> {
      const startedAt = performance.now();
      let sequence = 0;
      let sessionId: string | null = null;
      let matchedTerminal: RuntimeTerminalEvent | null = null;
      const report = (
        source: ExecutionEvidence['source'],
        localResources: ExecutionEvidence['localResources'],
        remoteExecution: ExecutionEvidence['remoteExecution'],
        detail: string,
        terminal?: RuntimeTerminalEvent,
      ): void => {
        if (!input.reportExecutionEvidence) return;
        const evidence: ExecutionEvidence = {
          version: 1,
          sequence: ++sequence,
          dispatchId: input.dispatchId,
          sessionId: input.sessionId,
          generation: input.generation ?? 1,
          provider: 'claude',
          providerSessionId: sessionId ?? input.providerSessionId,
          source,
          observedAt: new Date().toISOString(),
          localResources,
          remoteExecution,
          detail,
          ...(terminal ? { terminal } : {}),
        };
        // An engine callback records its own persistence failure and stops scheduling.
        try {
          input.reportExecutionEvidence(evidence);
        } catch {
          /* Preserve the runtime outcome; never manufacture a successful release. */
        }
      };
      const preSubmission = (detail: string): void =>
        report('pre_submission', 'stopped', 'stopped', detail);
      const remainingAcceptance = (): number =>
        input.executionBudget
          ? Math.min(
              input.executionBudget.remainingAcceptanceMs(),
              input.executionBudget.remainingTurnMs(),
            )
          : Math.min(requestTimeoutMs, turnTimeoutMs) - (performance.now() - startedAt);
      const remainingTurn = (): number =>
        input.executionBudget
          ? input.executionBudget.remainingTurnMs()
          : turnTimeoutMs - (performance.now() - startedAt);
      if (closed) {
        preSubmission('adapter closed before submission');
        yield { type: 'error', message: 'Claude adapter is closed', outcome: 'failed' };
        return;
      }
      if (input.permissionProfile !== 'read-only') {
        preSubmission('unsupported permission profile');
        yield {
          type: 'error',
          message: 'Claude adapter supports read-only only',
          outcome: 'failed',
        };
        return;
      }
      if (input.signal.aborted) {
        preSubmission('input cancelled before submission');
        yield { type: 'interrupted' };
        return;
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      input.signal.addEventListener('abort', onAbort, { once: true });
      const request: ClaudeQueryRequest = {
        prompt: input.prompt,
        options: {
          model: input.model,
          cwd: input.workspace,
          ...(input.providerSessionId ? { resume: input.providerSessionId } : {}),
          settingSources: [],
          tools: ['Read', 'Glob', 'Grep'],
          allowedTools: ['Read', 'Glob', 'Grep'],
          disallowedTools: ['mcp__*'],
          permissionMode: 'dontAsk',
          abortController: controller,
        },
      };
      let submitted = false;
      let accepted = false;
      let terminal = false;
      let handle: ActiveQuery | null = null;
      let pending: RuntimeEvent[] = [];
      let cleanupConfirmed = true;
      const observeLateStep = (step: IteratorResult<unknown>): void => {
        if (step.done || matchedTerminal) return;
        const message = record(step.value);
        if (!message || message.type !== 'result') return;
        const observedId =
          typeof message.session_id === 'string' && message.session_id.length > 0
            ? message.session_id
            : null;
        const expectedId = sessionId ?? input.providerSessionId;
        if (!observedId || (expectedId && observedId !== expectedId)) return;
        sessionId = observedId;
        matchedTerminal =
          message.subtype !== 'success' || message.is_error === true
            ? {
                type: 'error',
                message: Array.isArray(message.errors)
                  ? message.errors.map(String).join('; ') ||
                    String(message.subtype ?? 'Claude failed')
                  : String(message.subtype ?? 'Claude failed'),
                outcome: 'failed',
              }
            : typeof message.result === 'string'
              ? { type: 'result', text: message.result, providerSessionId: observedId }
              : { type: 'error', message: 'Claude success result lacks text', outcome: 'unknown' };
        report(
          'runtime_terminal',
          handle?.cleaned ? 'stopped' : 'unknown',
          'stopped',
          'late matched Claude SDK result terminal',
          matchedTerminal,
        );
      };
      try {
        const factory =
          config.query ??
          (await withinDeadline(
            loadDefaultQuery(),
            remainingAcceptance,
            controller.signal,
            'Claude request',
            !input.executionBudget,
          ));
        // This is the last pre-submission check; a cancelled request never calls query().
        if (closed) {
          preSubmission('adapter closed before submission');
          pending = [
            {
              type: 'error',
              message: 'Claude adapter closed before submission',
              outcome: 'failed',
            },
          ];
        } else if (input.signal.aborted || controller.signal.aborted) {
          preSubmission('input cancelled before submission');
          pending = [{ type: 'interrupted' }];
        } else if (remainingAcceptance() <= 0) {
          preSubmission('execution budget expired before submission');
          pending = [
            {
              type: 'error',
              message: 'Claude acceptance timed out before submission',
              outcome: 'failed',
            },
          ];
        } else {
          submitted = true;
          const query = factory(request);
          handle = {
            sessionId: input.sessionId,
            controller,
            query,
            iterator: null,
            cleaned: false,
            cleanupPromise: null,
            onCleanupConfirmed: () =>
              report(
                'resource_observation',
                'stopped',
                matchedTerminal ? 'stopped' : 'unknown',
                'Claude query cleanup confirmed',
              ),
          };
          active.add(handle);
          const iterator = query[Symbol.asyncIterator]();
          handle.iterator = iterator;
          while (true) {
            const stage = accepted ? 'Claude terminal' : 'Claude acceptance';
            const step = await withinDeadline(
              Promise.resolve().then(() => iterator.next()),
              accepted ? remainingTurn : remainingAcceptance,
              controller.signal,
              stage,
              !input.executionBudget,
              observeLateStep,
            );
            if (step.done) break;
            const message = record(step.value);
            if (!message) continue;
            const observedId =
              typeof message.session_id === 'string' && message.session_id.length > 0
                ? message.session_id
                : null;
            if (observedId && !accepted) {
              sessionId = observedId;
              accepted = true;
              yield { type: 'accepted', providerSessionId: observedId };
            }
            if (message.type !== 'result') continue;
            terminal = true;
            if (!sessionId || !observedId || observedId !== sessionId) {
              pending = [
                {
                  type: 'error',
                  message: 'Claude terminal session id mismatch',
                  outcome: 'unknown',
                },
              ];
            } else if (message.subtype !== 'success' || message.is_error === true) {
              const errors = Array.isArray(message.errors)
                ? message.errors.map(String).join('; ')
                : null;
              pending = [
                {
                  type: 'error',
                  message: errors || String(message.subtype ?? 'Claude failed'),
                  outcome: 'failed',
                },
              ];
            } else if (typeof message.result !== 'string') {
              pending = [
                { type: 'error', message: 'Claude success result lacks text', outcome: 'unknown' },
              ];
            } else {
              const source = record(message.usage);
              pending = [
                {
                  type: 'usage',
                  usageId: `${input.dispatchId}:result`,
                  usage: {
                    inputTokens: nonnegativeInt(source?.input_tokens),
                    cachedInputTokens: nonnegativeInt(source?.cache_read_input_tokens),
                    cacheWriteInputTokens: nonnegativeInt(source?.cache_creation_input_tokens),
                    outputTokens: nonnegativeInt(source?.output_tokens),
                    raw: source ? (source as Json) : null,
                  },
                },
                { type: 'result', text: message.result, providerSessionId: sessionId },
              ];
            }
            if (sessionId && observedId === sessionId) {
              matchedTerminal =
                pending.find(
                  (event): event is RuntimeTerminalEvent =>
                    event.type === 'result' ||
                    event.type === 'error' ||
                    event.type === 'interrupted',
                ) ?? null;
              if (matchedTerminal)
                report(
                  'runtime_terminal',
                  'unknown',
                  'stopped',
                  'matched Claude SDK result terminal',
                  matchedTerminal,
                );
            }
            break;
          }
          if (!terminal)
            pending = [
              {
                type: 'error',
                message: 'Claude SDK stream ended before terminal result',
                outcome: 'unknown',
              },
            ];
        }
      } catch (error) {
        if (!submitted) preSubmission(`failed before submission: ${errorMessage(error)}`);
        pending =
          !submitted && input.signal.aborted
            ? [{ type: 'interrupted' }]
            : [
                {
                  type: 'error',
                  message: errorMessage(error),
                  outcome: submitted ? 'unknown' : 'failed',
                },
              ];
      } finally {
        input.signal.removeEventListener('abort', onAbort);
        if (handle) cleanupConfirmed = await cleanup(handle);
      }
      if (!cleanupConfirmed) {
        const reason = pending.find((event) => event.type === 'error');
        yield {
          type: 'error',
          message: `${reason?.message ?? 'Claude SDK execution stopped'}; cleanup unconfirmed`,
          outcome: 'unknown',
        };
        return;
      }
      for (const event of pending) yield event;
    },
  };
}
