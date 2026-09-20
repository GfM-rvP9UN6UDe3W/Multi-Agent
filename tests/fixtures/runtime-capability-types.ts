import type { RuntimeCapabilities } from '../../packages/engine/src/types.ts';

const base = {
  provider: 'host',
  resume: true,
  interrupt: true,
  permissionProfiles: ['read-only'] as ['read-only'],
};

// @ts-expect-error Budget v2 is required, including explicit null caps.
const missingBudget: RuntimeCapabilities = { ...base };
const oldBudget: RuntimeCapabilities = {
  ...base,
  // @ts-expect-error An old version cannot be advertised as current engine support.
  executionBudget: { version: 1, acceptanceCapMs: null, turnCapMs: null },
};
const invalidEvidence: RuntimeCapabilities = {
  ...base,
  executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
  // @ts-expect-error Coverage is a boolean, not a truthy string.
  executionEvidence: { version: 1, terminalCoversExecution: 'false' },
};
void [missingBudget, oldBudget, invalidEvidence];
