import { registerRuntimeAdapterContract } from '../../packages/engine/src/testing.ts';
import { createOfflineHostFixture } from '../../packages/engine/src/testing-host.ts';

registerRuntimeAdapterContract('deliberately unsafe bridge', () => {
  const fixture = createOfflineHostFixture();
  return {
    ...fixture,
    act: (dispatchId, action) =>
      fixture.act(dispatchId, action === 'main-result' ? 'finish' : action),
  };
});
