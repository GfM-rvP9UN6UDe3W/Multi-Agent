import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0023 W: CI actions are pinned to commits and run on Node.js 24.
const workflows = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
// The first major version of each action that runs on Node.js 24 (their action.yml files).
const NODE_24_MAJOR: Record<string, number> = {
  'actions/checkout': 5,
  'actions/setup-node': 5,
  'actions/setup-python': 6,
  'actions/upload-artifact': 6,
  'actions/download-artifact': 7,
};

test('0023-W01 every action is pinned to a commit and names a version that runs on Node.js 24', () => {
  const problems: string[] = [];
  for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name)))
    readFileSync(join(workflows, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const uses = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!uses || uses[1]!.startsWith('./')) return;
        const where = `${file}:${index + 1}: ${line.trim()}`;
        const pinned = /^([\w.-]+\/[\w.-]+)@[0-9a-f]{40}$/.exec(uses[1]!);
        const version = /^\s*#\s*v(\d+)\.\d+\.\d+\s*$/.exec(uses[2]!);
        if (!pinned || !version)
          return problems.push(`not pinned with a version comment: ${where}`);
        const minimum = NODE_24_MAJOR[pinned[1]!];
        if (minimum !== undefined && Number(version[1]) < minimum)
          problems.push(`older than v${minimum}, which runs on Node.js 24: ${where}`);
      });
  assert.deepEqual(problems, []);
});
