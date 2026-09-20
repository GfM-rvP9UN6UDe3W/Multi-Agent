import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../fixtures/engine.ts';
import type { ApprovalRequest, RuntimeInput } from '../../packages/engine/src/types.ts';

for (const mode of ['approve', 'deny', 'expire', 'cancel'])
  test(`AC-F07 runtime permission ${mode} is distinct from result acceptance`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-permission-'));
    await mkdir(join(root, 'workspace'));
    const fake = createFakeAdapter();
    let binding: RuntimeInput | undefined, granted: boolean | undefined;
    const orch = await createOrchestrator({
      workspace: join(root, 'workspace'),
      stateDir: join(root, 'state'),
      adapters: [
        {
          ...fake,
          async *execute(input) {
            binding = input;
            yield { type: 'accepted', providerSessionId: 'native' };
            granted = await input.requestPermission!({
              requestId: 'tool-1',
              toolName: 'Read',
              permission: { path: 'approved.txt' },
              providerSessionId: 'native',
            });
            yield* fake.execute({ ...input, providerSessionId: 'native' });
          },
        },
      ],
      runtimeApprovals: { enabled: true, ttlMs: mode === 'expire' ? 80 : 2000 },
    });
    try {
      const task = await orch.tasks.create({
        goal: 'Permission test',
        runtime: { provider: 'fake', model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['review'] },
      });
      const deadline = Date.now() + 2000;
      let approval: ApprovalRequest | undefined;
      while (Date.now() < deadline) {
        const state = await orch.tasks.get(task.id);
        if (state.approvalId) {
          approval = await orch.approvals.get(state.approvalId);
          break;
        }
        await new Promise((done) => setTimeout(done, 5));
      }
      assert.ok(approval);
      assert.equal(approval.purpose, 'runtime_permission');
      assert.equal(granted, undefined);
      assert.equal(approval.target.dispatchId, binding!.dispatchId);
      if (mode === 'approve' || mode === 'deny') {
        const decision = await orch.approvals.decide(
          approval.approvalId,
          { choice: mode, expectedRevision: approval.revision },
          { idempotencyKey: 'decide' },
        );
        const replay = await orch.approvals.decide(
          approval.approvalId,
          { choice: mode, expectedRevision: approval.revision },
          { idempotencyKey: 'decide' },
        );
        assert.equal(decision.id, replay.id);
      } else if (mode === 'cancel') await orch.tasks.cancel(task.id);
      while (granted === undefined && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 5));
      assert.equal(granted, mode === 'approve');
      await assert.rejects(
        orch.approvals.decide(approval.approvalId, {
          choice: 'approve',
          expectedRevision: approval.revision,
        }),
        { code: 'STALE_TARGET' },
      );
      if (mode !== 'cancel') {
        let result;
        do {
          result = await orch.tasks.get(task.id);
          if (result.approvalId !== approval.approvalId && result.status === 'waiting_approval')
            break;
          await new Promise((done) => setTimeout(done, 5));
        } while (Date.now() < deadline);
        assert.equal(result.status, 'waiting_approval');
        assert.notEqual(result.approvalId, approval.approvalId);
        assert.equal((await orch.approvals.get(result.approvalId!)).purpose, 'task_acceptance');
      }
    } finally {
      await orch.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(root, { recursive: true, force: true });
    }
  });
