import { createInterface } from 'node:readline/promises';
import type { Orchestrator } from '../../sdk-typescript/src/index.ts';

/** Observe the existing owner; local cancellation never changes the task. */
export async function observeTask(
  client: Orchestrator,
  taskId: string,
  options: { interactive: boolean; follow: boolean; timeoutMs: number; afterCursor?: string },
  print: (value: unknown) => void,
) {
  if (options.interactive && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw Object.assign(new Error('--interactive requires a terminal'), {
      code: 'INTERACTIVE_TERMINAL_REQUIRED',
    });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  const presented = new Set<string>();
  let previousRevision = -1;
  const input = options.interactive
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  const inspect = async () => {
    const task = await client.tasks.get(taskId, { signal: controller.signal });
    if (task.revision !== previousRevision) {
      print({ kind: 'task', task });
      previousRevision = task.revision;
    }
    if (terminal.has(task.status)) return true;
    if (task.approvalId) {
      const approval = await client.approvals.get(task.approvalId, { signal: controller.signal });
      const identity = `${approval.approvalId}:${approval.revision}`;
      if (approval.status === 'pending' && !presented.has(identity)) {
        presented.add(identity);
        print({ kind: 'approval', approval });
        if (input) {
          const choice = (
            await input.question(
              `Approval ${approval.approvalId} (${approval.purpose ?? 'task_acceptance'}). Type approve, deny, or detach: `,
              { signal: controller.signal },
            )
          ).trim();
          if (choice === 'detach') return true;
          if (choice === 'approve' || choice === 'deny') {
            const operation = await client.approvals.decide(
              approval.approvalId,
              { choice, expectedRevision: approval.revision },
              { signal: controller.signal },
            );
            print({ kind: 'operation', operation: operation.initial });
          } else {
            presented.delete(identity);
            print({ kind: 'notice', message: 'No decision submitted.' });
          }
        } else if (!options.follow) {
          print({ kind: 'task', task });
          return true;
        }
      }
    }
    return !options.follow && ['paused', 'blocked'].includes(task.status);
  };
  try {
    if (await inspect()) return;
    for await (const event of client.events({
      taskId,
      afterCursor: options.afterCursor,
      signal: controller.signal,
    })) {
      print({ kind: 'event', event });
      if (await inspect()) return;
    }
  } catch (error) {
    if (controller.signal.aborted)
      print({
        kind: 'detached',
        taskId,
        reason: timedOut ? 'timeout' : 'signal',
        remoteWorkCancelled: false,
      });
    else throw error;
  } finally {
    clearTimeout(timer);
    input?.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
