import type { RuntimeStopContext, RuntimeStopObserver } from './types.ts';

/** Bound the initial wait while retaining a late positive observation for its original target. */
export async function observeRuntimeStop(
  observer: RuntimeStopObserver | undefined,
  context: Omit<RuntimeStopContext, 'signal' | 'remainingMs'>,
  timeoutMs: number,
  onStopped: () => void,
): Promise<boolean> {
  if (!observer) return false;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observation = Promise.resolve()
    .then(() =>
      observer(
        Object.freeze({
          target: Object.freeze({ ...context.target }),
          terminal: Object.freeze({ ...context.terminal }),
          signal: controller.signal,
          remainingMs: () => Math.max(0, deadline - performance.now()),
        }),
      ),
    )
    .then(
      (stopped) => {
        if (stopped !== true) return false;
        onStopped();
        return true;
      },
      () => false,
    )
    .catch(() => false);
  try {
    return await Promise.race([
      observation,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
