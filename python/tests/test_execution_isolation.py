"""A2 execution isolation public SDK contracts against an independent protocol fixture."""
from pathlib import Path
import sys
import unittest

from orchvia import LifecycleTimeouts, OperationHandle, Orchestrator, OrchestrationError, ReconcileEvidence
from orchvia.types import to_wire


FIXTURE = Path(__file__).with_name("fake_protocol_server.py")
EVIDENCE = ReconcileEvidence(source="owner_attestation", summary="Owner checked the original resources",
    local_resources="stopped", remote_execution="stopped", side_effects="unknown", outcome="unknown")


class ExecutionIsolationTests(unittest.IsolatedAsyncioTestCase):
    def local(self, mode="isolation"):
        return Orchestrator.local(engine_command=[sys.executable, str(FIXTURE), "--mode", mode],
                                  poll_interval=0.005)

    async def test_a2_missing_or_incompatible_capability_rejects_all_scheduler_calls(self):
        for mode in ("normal", "isolation-version", "isolation-bool-version", "isolation-release",
                     "isolation-status", "isolation-owner", "isolation-budget", "isolation-number-release"):
            with self.subTest(mode=mode):
                async with self.local(mode) as orch:
                    for call in (lambda: orch.scheduler.get(), lambda: orch.scheduler.get_conflict("conflict-1"),
                                 lambda: orch.scheduler.resolve_conflict("conflict-1", EVIDENCE, expected_revision=2)):
                        with self.assertRaises(OrchestrationError) as raised:
                            await call()
                        self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")
                    self.assertEqual((await orch.capabilities())["schedulerCalls"], [])

    async def test_a2_scheduler_snapshots_and_nested_execution_fields_use_snake_case(self):
        async with self.local() as orch:
            self.assertEqual(orch.info.capabilities.execution_isolation.budget_version, 2)
            self.assertTrue(orch.info.capabilities.execution_isolation.owner_conflict_resolution)
            status = await orch.scheduler.get()
            self.assertEqual((status.execution_occupied, status.quarantined, status.quarantine_reserved), (1, 2, 1))
            self.assertEqual((status.max_active_sessions, status.max_quarantined_dispatches), (2, 32))
            self.assertFalse(status.can_dispatch)
            self.assertEqual(status.occupants[0].dispatch_id, "dispatch-1")
            self.assertEqual(status.occupants[0].lease_status, "released")
            self.assertEqual(status.conflicts[0].conflict_id, "conflict-1")
            self.assertEqual(status.open_conflicts, 1)
            self.assertFalse(status.conflicts_truncated)
            self.assertEqual(status["customPayload"], {"dispatchId": "preserve-original"})
            session = await orch.sessions.get("session-1")
            self.assertEqual(session.execution.lease.acquired_at, "2026-09-19T00:00:00Z")
            self.assertEqual(session.execution.lease.released_at, "2026-09-19T00:00:02Z")
            self.assertEqual(session.execution.lease.release_evidence_ref, "sha256:stop")
            self.assertEqual(session.execution.budget.effective_turn_ms, 1800000)
            self.assertEqual(session.execution.budget.acceptance_deadline_at, "2026-09-19T00:00:30Z")
            self.assertEqual(session.execution.budget.turn_source, "host_default")

    async def test_a2_conflict_resolution_exact_wire_handle_and_idempotency(self):
        async with self.local() as orch:
            conflict = await orch.scheduler.get_conflict("conflict-1")
            self.assertEqual(conflict.release_evidence_ref, "sha256:old")
            self.assertEqual(conflict.conflicting_evidence_ref, "sha256:new")
            op = await orch.scheduler.resolve_conflict(conflict.id, EVIDENCE, expected_revision=conflict.revision,
                                                       idempotency_key="owner-review")
            self.assertIsInstance(op, OperationHandle)
            self.assertEqual(op.scope, "conflict-1")
            self.assertEqual(op.result["executionReleased"], True)
            self.assertEqual(op.result["customPayload"], {"taskId": "raw"})
            self.assertEqual(op.result["requestEcho"], {"conflictId": "conflict-1", "expectedRevision": 2,
                "evidence": {"source": "owner_attestation", "summary": EVIDENCE.summary,
                "localResources": "stopped", "remoteExecution": "stopped", "sideEffects": "unknown", "outcome": "unknown"},
                "idempotencyKey": "owner-review"})
            self.assertEqual((await op.wait(timeout=1)).id, op.id)
            duplicate = await orch.scheduler.resolve_conflict(conflict.id, EVIDENCE, expected_revision=2,
                                                               idempotency_key="owner-review")
            self.assertEqual(duplicate.id, op.id)
            self.assertEqual((await orch.operations.lookup(method="scheduler.resolveConflict", scope=conflict.id,
                             idempotency_key="owner-review")).id, op.id)
            current = await orch.scheduler.get_conflict(conflict.id)
            self.assertEqual(current.resolution.evidence_ref, "sha256:owner")
            self.assertEqual(current.resolution.operation_id, op.id)
            with self.assertRaises(OrchestrationError) as raised:
                await orch.scheduler.resolve_conflict(conflict.id, EVIDENCE, expected_revision=3,
                                                       idempotency_key="owner-review")
            self.assertEqual(raised.exception.code, "IDEMPOTENCY_CONFLICT")

    async def test_a2_lost_resolution_receipt_preserves_conflict_scope(self):
        orch = await self.local("isolation-drop")
        try:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.scheduler.resolve_conflict("conflict-1", EVIDENCE, expected_revision=2,
                                                       idempotency_key="lost-review")
            self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")
            self.assertEqual(raised.exception.scope, "conflict-1")
            self.assertEqual(raised.exception.method, "scheduler.resolveConflict")
            self.assertEqual(raised.exception.idempotency_key, "lost-review")
        finally:
            await orch.disconnect()

    def test_a2_public_timeout_default_is_1800_seconds(self):
        self.assertEqual(LifecycleTimeouts().turn_ms, 1800000)
        self.assertEqual(to_wire(LifecycleTimeouts(turn_ms=300000))["turnMs"], 300000)


if __name__ == "__main__":
    unittest.main()
