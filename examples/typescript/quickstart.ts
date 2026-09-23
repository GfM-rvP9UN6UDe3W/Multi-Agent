// Offline quickstart: two tasks on one warm session, each accepted before it counts as done.
// Uses the fake runtime: no login, network request or model call.
// node examples/typescript/quickstart.ts
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';

const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-quickstart-')));
await mkdir(join(root, 'workspace'));
await mkdir(join(root, 'state'), { mode: 0o700 });
const orch = await createOrchestrator({
  workspace: join(root, 'workspace'),
  stateDir: join(root, 'state'),
  adapters: [createFakeAdapter()],
  providers: { fake: { model: 'fake-model' } },
  // One team per engine: a new request may reuse any idle agent.
  allowCrossRootReuse: true,
});
type Spec = Parameters<typeof orch.tasks.create>[0];
const runtime = { provider: 'fake', model: 'fake-model' };
const acceptance = { mode: 'human' as const, criteria: ['A reviewer read the result'] };

/** Runs one task to completion. A real host shows the result to a person; this demo approves it. */
async function run(spec: Spec) {
  const task = await orch.tasks.create(spec);
  for await (const event of orch.events({ taskId: task.id, signal: AbortSignal.timeout(10_000) })) {
    if (event.type !== 'approval.requested') continue;
    const approval = await orch.approvals.get(String(event.data.approvalId));
    await orch.approvals.decide(approval.approvalId, {
      choice: 'approve',
      expectedRevision: approval.revision,
    });
    break;
  }
  return task.wait({ timeoutMs: 10_000 });
}

try {
  const draft = await run({ goal: 'Draft the release notes', runtime, acceptance });
  console.log(`1. "${draft.spec.goal}": ${draft.status}, session ${draft.sessionId}`);
  const review = await run({
    goal: 'Tighten the draft you just wrote',
    runtime,
    acceptance,
    contextPlan: {
      requestedMode: 'reuse',
      candidateSessionId: draft.sessionId!,
      independent: true,
      dependencyTaskIds: [],
      contextRefs: [],
      fallbackModes: [],
      maxQueueWaitMs: 30_000,
    },
  });
  console.log(`2. "${review.spec.goal}": ${review.status}, session ${review.sessionId}`);
  console.log(
    `The second task reused the first agent's session: ${review.sessionId === draft.sessionId}`,
  );
} finally {
  await orch.close();
  await rm(root, { recursive: true, force: true });
}
