"""R04 owner recovery through the real Python SDK, Node stdio host and SQLite."""
import asyncio
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

from agent_orch import Orchestrator, OrchestrationError, ReconcileEvidence, ShutdownIncomplete


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "claude-unobserved-owner.ts"
NODE = shutil.which("node")


class ClaudeCleanupReconcileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.assertIsNotNone(NODE, "Node is required for actual subprocess acceptance")
        self.temp = tempfile.TemporaryDirectory(prefix="claude-owner-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.state = self.root / "state"

    def local(self, mode="normal"):
        return Orchestrator.local(engine_command=[NODE, str(FIXTURE), str(self.workspace), str(self.state), mode],
                                  request_timeout=2, close_timeout=1, poll_interval=0.005)

    @staticmethod
    def spec(provider="claude"):
        return {"goal": "offline owner cleanup", "runtime": {"provider": provider, "model": "fixture"},
                "acceptance": {"mode": "human", "criteria": ["review"]}}

    @staticmethod
    def target(session):
        return {"session_id": session.id, "expected_generation": session.generation,
                "expected_revision": session.revision, "expected_dispatch_id": session.active_dispatch_id,
                "expected_state": session.status}

    @staticmethod
    def proof(complete=False):
        return ReconcileEvidence(source="owner_attestation", summary="Owner checked the offline fixture",
            local_resources="stopped", remote_execution="stopped",
            side_effects="resolved" if complete else "unknown", outcome="completed" if complete else "unknown",
            **({"result": "done"} if complete else {}))

    async def wait_status(self, orch, task_id, status):
        async with asyncio.timeout(3):
            while (await orch.tasks.get(task_id)).status != status:
                await asyncio.sleep(0.005)

    async def test_r04_owner_reconcile_recovers_capacity_and_survives_restart_without_replay(self):
        orch = self.local()
        try:
            await orch.start()
            host = orch._transport.process
            task = await orch.tasks.create(self.spec(), idempotency_key="unknown")
            await self.wait_status(orch, task.id, "blocked")
            queued = await orch.tasks.create(self.spec("fake"), idempotency_key="queued")
            self.assertEqual((await orch.tasks.get(queued.id)).status, "queued")
            self.assertEqual((await orch.scheduler.get()).execution_occupied, 1)
            original_target = self.target(await orch.sessions.get(task.session_id))
            op = await orch.sessions.reconcile(original_target, self.proof(), idempotency_key="owner-release")
            self.assertTrue(op.result["executionReleased"])
            self.assertTrue(op.result["unobservedResourcesReconciled"])
            self.assertFalse(op.result["resolved"])
            duplicate = await orch.sessions.reconcile(original_target, self.proof(), idempotency_key="owner-release")
            self.assertEqual(duplicate.id, op.id)
            await self.wait_status(orch, queued.id, "waiting_approval")
            self.assertEqual((await orch.tasks.get(task.id)).status, "blocked")
            self.assertEqual((await orch.scheduler.get()).quarantined, 1)
            await orch.close(timeout=1)
            self.assertEqual(host.returncode, 0, "successful close must include the real host exit")
        finally:
            if not orch.closed:
                await orch.disconnect()
        async with self.local() as restarted:
            duplicate = await restarted.sessions.reconcile(original_target, self.proof(), idempotency_key="owner-release")
            self.assertEqual(duplicate.id, op.id)
            self.assertTrue(duplicate.result["unobservedResourcesReconciled"])
            self.assertEqual((await restarted.scheduler.get()).execution_occupied, 0)
            self.assertEqual((await restarted.tasks.get(task.id)).status, "blocked")
        with closing(sqlite3.connect(self.state / "store.sqlite")) as db:
            events = [json.loads(row[0]) for row in db.execute("SELECT data FROM events")]
            self.assertEqual(sum(e["type"] == "session.resources_reconciled" for e in events), 1)
            self.assertEqual(sum(e["type"] == "dispatch.started" for e in events), 2)
            row = db.execute("SELECT data FROM dispatches WHERE id = ?", (original_target["expected_dispatch_id"],)).fetchone()
            dispatch = json.loads(row[0])
            self.assertEqual(dispatch["executionState"]["localResources"], "unknown")
            self.assertEqual(dispatch["executionLease"]["releaseReason"], "owner_attestation")

    async def test_r04_incomplete_shutdown_allows_owner_reconcile_and_continues_same_shutdown(self):
        orch = self.local()
        try:
            await orch.start()
            host = orch._transport.process
            task = await orch.tasks.create(self.spec(), idempotency_key="shutdown-unknown")
            await self.wait_status(orch, task.id, "blocked")
            with self.assertRaises(ShutdownIncomplete) as raised:
                await orch.close(timeout=0.2)
            self.assertIsNone(host.returncode)
            shutdown_id = raised.exception.operation_id
            self.assertTrue(shutdown_id)
            session = await orch.sessions.get(task.session_id)
            for action in (
                lambda: orch.tasks.create(self.spec(), idempotency_key="forbidden-create"),
                lambda: orch.tasks.resume(task.id, idempotency_key="forbidden-resume"),
                lambda: orch.messages.send({"task_id": task.id, "to_session_id": session.id,
                    "expected_generation": session.generation, "kind": "finding", "summary": "must not send"},
                    idempotency_key="forbidden-message"),
            ):
                with self.assertRaises(OrchestrationError) as blocked:
                    await action()
                self.assertEqual(blocked.exception.code, "HOST_STOPPING")
            op = await orch.sessions.reconcile(self.target(await orch.sessions.get(task.session_id)),
                self.proof(complete=True), idempotency_key="shutdown-owner-reconcile")
            self.assertTrue(op.result["resolved"])
            self.assertEqual((await orch.tasks.get(task.id)).status, "paused")
            closed = await orch.close(timeout=1)
            self.assertEqual(closed.operation_id, shutdown_id)
            self.assertEqual(host.returncode, 0)
        finally:
            if not orch.closed:
                await orch.disconnect()

    async def test_r04_finalizer_failure_has_a_durable_receipt_and_same_key_retry(self):
        orch = self.local("fail-finalizer-once")
        try:
            task = await orch.tasks.create(self.spec(), idempotency_key="faulted-finalizer")
            await self.wait_status(orch, task.id, "blocked")
            target = self.target(await orch.sessions.get(task.session_id))
            proof = self.proof(complete=True)
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.reconcile(target, proof, idempotency_key="owner-finalizer")
            error = raised.exception
            self.assertEqual(error.code, "RESOURCE_CLEANUP_INCOMPLETE")
            self.assertTrue(error.data["auditCommitted"])
            self.assertEqual(error.scope, task.session_id)
            self.assertEqual(error.idempotency_key, "owner-finalizer")
            pending = await orch.operations.lookup(method="sessions.reconcile", scope=task.session_id,
                                                   idempotency_key="owner-finalizer")
            self.assertEqual(pending.id, error.operation_id)
            self.assertEqual(pending.status, "persisted")
            self.assertEqual(pending.result["resourceCleanup"]["status"], "pending")
            self.assertFalse(pending.result["unobservedResourcesReconciled"])
            self.assertIn("RESOURCE_CLEANUP_PENDING", (await orch.scheduler.get()).reasons)
            completed = await orch.sessions.reconcile(target, proof, idempotency_key="owner-finalizer")
            self.assertEqual(completed.id, pending.id)
            self.assertEqual(completed.status, "completed")
            self.assertTrue(completed.result["unobservedResourcesReconciled"])
            self.assertEqual((await orch.tasks.get(task.id)).status, "paused")
            await orch.close(timeout=1)
        finally:
            if not orch.closed:
                await orch.disconnect()

    async def test_r04_restart_preserves_unknown_receipt_when_old_finalizer_is_unavailable(self):
        orch = self.local("fail-finalizer-once")
        try:
            task = await orch.tasks.create(self.spec(), idempotency_key="lost-finalizer")
            await self.wait_status(orch, task.id, "blocked")
            target = self.target(await orch.sessions.get(task.session_id))
            proof = self.proof(complete=True)
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.reconcile(target, proof, idempotency_key="owner-unavailable")
            operation_id = raised.exception.operation_id
        finally:
            await orch.disconnect()
        async with self.local() as restarted:
            pending = await restarted.operations.get(operation_id)
            self.assertEqual(pending.status, "outcome_unknown")
            self.assertFalse(pending.result["unobservedResourcesReconciled"])
            with self.assertRaises(OrchestrationError) as raised:
                await restarted.sessions.reconcile(target, proof, idempotency_key="owner-unavailable")
            self.assertEqual(raised.exception.code, "RESOURCE_CLEANUP_INCOMPLETE")
            self.assertEqual(raised.exception.operation_id, operation_id)
            self.assertEqual((await restarted.tasks.get(task.id)).status, "paused")
