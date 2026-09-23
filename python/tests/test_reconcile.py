"""SPEC-0003-A Python negotiation and wire contracts; fixture calls no models."""
from pathlib import Path
import sys
import unittest

import orchvia
from orchvia import OperationHandle, Orchestrator, OrchestrationError
from orchvia.types import to_wire


FIXTURE = Path(__file__).with_name("fake_protocol_server.py")
TARGET = {"session_id": "session-1", "expected_generation": 1, "expected_revision": 2,
          "expected_dispatch_id": "dispatch-1", "expected_state": "outcome_unknown"}
EVIDENCE = {"source": "owner_attestation", "summary": "Checked fixture resources and effects",
            "local_resources": "stopped", "remote_execution": "stopped",
            "side_effects": "resolved", "outcome": "completed", "result": "reviewed fixture result"}


class ReconcileContractTests(unittest.IsolatedAsyncioTestCase):
    def local(self, mode="lifecycle", **options):
        return Orchestrator.local(engine_command=[sys.executable, str(FIXTURE), "--mode", mode],
                                  poll_interval=0.005, **options)

    async def test_a_negotiation_rejects_absent_or_incompatible_lifecycle_without_sending(self):
        for mode in ("normal", "lifecycle-version", "lifecycle-bool-version", "lifecycle-method",
                     "lifecycle-no-deadlines", "lifecycle-numeric-deadlines"):
            with self.subTest(mode=mode):
                async with self.local(mode) as orch:
                    with self.assertRaises(OrchestrationError) as raised:
                        await orch.sessions.reconcile(TARGET, EVIDENCE, idempotency_key="not-sent")
                    self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")
                    self.assertEqual((await orch.capabilities(provider="fake"))["reconcileCalls"], 0)

    async def test_a_typed_reconcile_exact_wire_fields_and_operation_handle(self):
        async with self.local() as orch:
            evidence = orchvia.ReconcileEvidence(**EVIDENCE)
            op = await orch.sessions.reconcile(TARGET, evidence, idempotency_key="owner-review")
            self.assertIsInstance(op, OperationHandle)
            self.assertEqual(orch.info.capabilities.lifecycle.version, 1)
            self.assertTrue(orch.info.capabilities.lifecycle.durable_deadlines)
            self.assertEqual(op.method, "sessions.reconcile")
            self.assertEqual(op.scope, "session-1")
            self.assertEqual(op.idempotency_key, "owner-review")
            self.assertEqual(op.lifecycle.entered_at, "2026-09-19T00:00:00Z")
            self.assertEqual(op.lifecycle.deadline_at, "2026-09-19T00:01:00Z")
            self.assertEqual(op.lifecycle.policy_version, 1)
            self.assertEqual(op.lifecycle.expected_dispatch_id, "dispatch-1")
            self.assertFalse(op.lifecycle.may_have_been_sent)
            self.assertEqual(op.lifecycle.last_evidence, "owner attestation")
            self.assertEqual(op.lifecycle.expired_at, "2026-09-19T00:01:01Z")
            self.assertEqual(op.resolution.operation_id, op.id)
            self.assertEqual(op.resolution.occurred_at, "2026-09-19T00:00:01Z")
            # Operation result is provider/application JSON and must keep its raw keys.
            echo = op.result["requestEcho"]
            self.assertEqual(echo["target"], {"sessionId": "session-1", "expectedGeneration": 1,
                "expectedRevision": 2, "expectedDispatchId": "dispatch-1", "expectedState": "outcome_unknown"})
            self.assertEqual(echo["evidence"], {"source": "owner_attestation",
                "summary": EVIDENCE["summary"], "localResources": "stopped", "remoteExecution": "stopped",
                "sideEffects": "resolved", "outcome": "completed", "result": "reviewed fixture result"})
            self.assertEqual((await op.wait(timeout=1)).id, op.id)
            duplicate = await orch.sessions.reconcile(TARGET, EVIDENCE, idempotency_key="owner-review")
            self.assertEqual(duplicate.id, op.id)
            self.assertEqual((await orch.operations.lookup(method=op.method, scope=op.scope,
                             idempotency_key=op.idempotency_key)).id, op.id)

    async def test_a_lost_reconcile_receipt_retains_key_method_and_session_scope(self):
        orch = await self.local("lifecycle-drop")
        try:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.reconcile(TARGET, EVIDENCE, idempotency_key="lost-owner-review")
            self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")
            self.assertEqual(raised.exception.idempotency_key, "lost-owner-review")
            self.assertEqual(raised.exception.method, "sessions.reconcile")
            self.assertEqual(raised.exception.scope, "session-1")
        finally:
            await orch.disconnect()

    async def test_a_wait_timeout_does_not_modify_persisted_reconcile_deadline(self):
        async with self.local("lifecycle-pending") as orch:
            op = await orch.sessions.reconcile(TARGET, EVIDENCE)
            self.assertTrue(op.idempotency_key)
            with self.assertRaises(OrchestrationError) as raised:
                await op.wait(timeout=0.02)
            self.assertEqual(raised.exception.code, "TIMEOUT")
            current = await orch.operations.get(op.id)
            self.assertEqual(current.status, "persisted")
            self.assertEqual(current.lifecycle.deadline_at, op.lifecycle.deadline_at)
            self.assertEqual((await orch.capabilities(provider="fake"))["reconcileCalls"], 1)

    def test_a_public_types_use_snake_case_and_wire_milliseconds(self):
        defaults = orchvia.LifecycleTimeouts()
        self.assertEqual(to_wire(defaults), {"acceptanceMs": 30000, "turnMs": 1800000,
            "drainMs": 300000, "interruptMs": 30000, "reconcileMs": 60000})
        self.assertEqual(to_wire(orchvia.LifecycleTimeouts(turn_ms=1200))["turnMs"], 1200)
        evidence = orchvia.ReconcileEvidence(source="owner_attestation", summary="No dispatch occurred",
            local_resources="stopped", remote_execution="stopped", side_effects="resolved", outcome="not_executed")
        self.assertNotIn("result", to_wire(evidence))


if __name__ == "__main__":
    unittest.main()
