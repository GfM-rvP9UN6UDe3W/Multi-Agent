// Deterministic fixture example: no provider login, network request, or paid model call.
// node examples/typescript/local.ts /absolute/workspace /absolute/state-outside-workspace
import { createInterface } from 'node:readline/promises';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';

const [workspace, stateDir] = process.argv.slice(2);
if (!workspace || !stateDir)
  throw new Error('Usage: node examples/typescript/local.ts WORKSPACE STATE_DIR');
const client = await createOrchestrator({
  workspace,
  stateDir,
  adapters: [createFakeAdapter()],
  providers: { fake: { model: 'fake-model' } },
});
const prompt = createInterface({ input: process.stdin, output: process.stdout });
try {
  const task = await client.tasks.create({
    goal: 'Produce a deterministic result for human review',
    runtime: { provider: 'fake', model: 'fake-model' },
    acceptance: { mode: 'human', criteria: ['I reviewed this fixture result'] },
  });
  for await (const event of client.events({ taskId: task.id })) {
    if (event.type !== 'approval.requested') continue;
    const snapshot = await task.get();
    const approval = await client.approvals.get(snapshot.approvalId!);
    console.log(snapshot.result);
    const choice = await prompt.question(
      'Type approve or deny; any other answer leaves the task pending: ',
    );
    if (choice !== 'approve' && choice !== 'deny') {
      console.log({ taskId: task.id, status: snapshot.status });
      break;
    }
    await client.approvals.decide(approval.approvalId, {
      choice,
      expectedRevision: approval.revision,
    });
    console.log(await task.wait({ timeoutMs: 5000 }));
    break;
  }
} finally {
  prompt.close();
  try {
    await client.close({ mode: 'drain', timeoutMs: 1000 });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'SHUTDOWN_INCOMPLETE' &&
      'operationId' in error &&
      typeof error.operationId === 'string'
    ) {
      await client.close({ mode: 'interrupt', timeoutMs: 5000, operationId: error.operationId });
    } else throw error;
  }
}
