import { createEngine as createRawEngine } from '../../packages/engine/src/index.ts';
import { MUTATIONS } from '../../packages/engine/src/identity.ts';
import type { EngineConfig } from '../../packages/engine/src/types.ts';
export async function createEngine(config: EngineConfig) {
  const engine = await createRawEngine({
    ...config,
    storage: { emergencyBytes: 4096, ...config.storage },
  });
  const call = engine.call.bind(engine);
  engine.call = (method, params = {}, context) =>
    call(
      method,
      MUTATIONS.has(method) ? { expectedStoreId: engine.storeId, ...params } : params,
      context,
    );
  return engine;
}

export * from '../../packages/engine/src/index.ts';
