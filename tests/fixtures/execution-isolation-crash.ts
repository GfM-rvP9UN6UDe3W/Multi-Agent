import { createEngine } from '../../packages/engine/src/index.ts';
import { Store } from '../../packages/engine/src/store.ts';
import type {
  RuntimeAdapter,
  RuntimeInput,
  RuntimeEvent,
  TaskSnapshot,
  SessionSnapshot,
} from '../../packages/engine/src/types.ts';
let input!: RuntimeInput;
let end!: (event: RuntimeEvent) => void;
const adapter: RuntimeAdapter = {
  provider: 'fake',
  capabilities: () => ({
    provider: 'fake',
    resume: true,
    interrupt: true,
    permissionProfiles: ['read-only'],
    executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
    executionEvidence: { version: 1, terminalCoversExecution: true },
  }),
  async *execute(i) {
    input = i;
    const gate = new Promise<RuntimeEvent>((r) => (end = r));
    yield { type: 'accepted', providerSessionId: 'native-crash' };
    yield await gate;
  },
};
const engine = await createEngine({
  workspace: process.argv[2],
  stateDir: process.argv[3],
  adapters: [adapter],
  timeouts: { turnMs: 20 },
});
const task = (await engine.call('tasks.create', {
  spec: {
    goal: 'crash around release transaction',
    runtime: { provider: 'fake', model: 'test' },
    acceptance: { mode: 'human', criteria: ['review'] },
  },
  idempotencyKey: 'original',
})) as TaskSnapshot;
let session: SessionSnapshot;
do {
  await new Promise((r) => setTimeout(r, 5));
  session = (await engine.call('sessions.get', { sessionId: task.sessionId })) as SessionSnapshot;
} while (session.status !== 'outcome_unknown');
end({ type: 'error', outcome: 'unknown', message: 'observer closed; no stop proof yet' });
await new Promise<void>((r) => setImmediate(r));
const original = Store.prototype.event;
if (process.argv[4] === 'before')
  Store.prototype.event = function (...args: Parameters<Store['event']>) {
    const result = original.apply(this, args);
    if (args[0] === 'execution.released') process.kill(process.pid, 'SIGKILL');
    return result;
  };
process.on('message', () => {
  input.reportExecutionEvidence!({
    version: 1,
    sequence: 1,
    dispatchId: input.dispatchId,
    sessionId: input.sessionId,
    generation: input.generation!,
    provider: 'fake',
    providerSessionId: 'native-crash',
    source: 'runtime_terminal',
    observedAt: new Date().toISOString(),
    localResources: 'stopped',
    remoteExecution: 'stopped',
    detail: 'fixture terminal and cleanup confirmed',
    terminal: { type: 'result', text: 'late result' },
  });
  process.send!({ released: true });
});
process.send!({ task, session });
