import { Store } from '../../packages/engine/src/store.ts';
import { StorageGovernance } from '../../packages/engine/src/storage.ts';
const [workspace, stateDir, action, point] = process.argv.slice(2);
let armed = false;
const store = new Store(workspace!, stateDir!, {
  now: () => Date.parse('2026-09-20T00:00:00Z'),
  fault: (stage) => {
    if (armed && stage === point) process.exit(77);
  },
});
const storage = new StorageGovernance(store, { emergencyBytes: 4096, minFreeBytes: 0 });
armed = true;
if (action === 'artifact') store.artifact('durable crash evidence');
else storage.collect();
store.close();
