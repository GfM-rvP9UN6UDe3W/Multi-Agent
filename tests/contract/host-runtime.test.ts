import { registerRuntimeAdapterContract } from '../../packages/engine/src/testing.ts';
import { createOfflineHostFixture } from '../../packages/engine/src/testing-host.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeInput } from '../../packages/engine/src/types.ts';

registerRuntimeAdapterContract('offline host', () => createOfflineHostFixture());
registerRuntimeAdapterContract('host without interruption', () =>
  createOfflineHostFixture({ interrupt: false }),
);

test('AC-H02 actual host adapter rejects a standalone input before submitting to its host', async () => {
  const fixture = createOfflineHostFixture();
  const standalone: RuntimeInput = {
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    model: 'offline',
    workspace: '/offline/workspace',
    stateDir: '/offline/state',
    prompt: 'Never submitted',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
  };
  try {
    await assert.rejects(
      async () => {
        for await (const _event of fixture.adapter.execute(standalone)) {
          /* consume */
        }
      },
      { code: 'INVALID_RUNTIME_CONTRACT' },
    );
    assert.equal(fixture.submissions().length, 0);
  } finally {
    await fixture.dispose();
  }
});
