import { readFileSync } from 'node:fs';
import { createEngine } from '../../packages/engine/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
const [path, point] = process.argv.slice(2);
const config = JSON.parse(readFileSync(path!, 'utf8'));
const engine = await createEngine({
  ...config,
  adapters: [createFakeAdapter()],
  storageFault: (stage: string) => {
    if (stage === point) process.exit(73);
  },
});
await engine.call(
  'stores.rollover',
  { expectedStoreId: engine.storeId, idempotencyKey: 'crash-rollover' },
  { owner: true },
);
await engine.close();
