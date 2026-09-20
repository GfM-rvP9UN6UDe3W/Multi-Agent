"""SPEC-0003-A2 over real Node stdio/Unix hosts with temporary fake-only state."""
import asyncio
from datetime import datetime
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from agent_orch import (AcceptanceSpec, LifecycleTimeouts, OrchestrationError, Orchestrator,
                        ReconcileEvidence, RuntimeSpec, TaskSpec)
from agent_orch.types import to_wire


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and CLI.is_file(), "requires Node.js 22.18+ and the local host source")
class NodeExecutionIsolationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-isolation-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.workspace = self.directory / "workspace"
        self.state = self.directory / "state"
        self.workspace.mkdir()
        self.state.mkdir()
        self.config = self.directory / "config.json"

    def write_config(self, *, short_budget):
        config = {
            "configVersion": 1,
            "workspace": str(self.workspace),
            "stateDir": str(self.state),
            "providers": {"fake": {
                "model": "fake-model", "delayMs": 300 if short_budget else 50,
                "result": "late isolation fixture", "permissionProfile": "read-only",
            }},
            "limits": {"maxActiveSessions": 1},
            "shutdown": {"timeoutMs": 1000},
        }
        if short_budget:
            config["limits"]["maxQuarantinedDispatches"] = 1
            config["timeouts"] = to_wire(LifecycleTimeouts(acceptance_ms=1000, turn_ms=40))
        self.config.write_text(json.dumps(config), encoding="utf-8")

    def local(self):
        return Orchestrator.local(
            engine_command=[NODE, str(CLI), "host", "--stdio", "--config", str(self.config)],
            poll_interval=0.005, request_timeout=5, close_timeout=3,
        )

    @staticmethod
    def spec():
        return TaskSpec(
            goal="run only the deterministic execution-isolation fixture",
            runtime=RuntimeSpec("fake", "fake-model"),
            acceptance=AcceptanceSpec(criteria=["inspect the fake fixture result"]),
        )

    @staticmethod
    def resource_evidence():
        return ReconcileEvidence(
            source="owner_attestation", summary="Fixture-only resource statement",
            local_resources="stopped", remote_execution="stopped",
            side_effects="unknown", outcome="unknown",
        )

    async def wait_task(self, orch, task_id, status):
        async with asyncio.timeout(5):
            while True:
                task = await orch.tasks.get(task_id)
                if task.status == status:
                    return task
                await asyncio.sleep(0.002)

    async def wait_released_quarantine(self, orch):
        async with asyncio.timeout(5):
            while True:
                scheduler = await orch.scheduler.get()
                if (scheduler.execution_occupied, scheduler.quarantined,
                        scheduler.quarantine_reserved) == (0, 1, 0):
                    return scheduler
                await asyncio.sleep(0.005)

    def assert_capability(self, orch):
        self.assertEqual(orch.info.protocol_version, "2.0")
        self.assertEqual(orch.info.schema_version, 3)
        isolation = orch.info.capabilities.execution_isolation
        self.assertEqual(isolation.version, 1)
        self.assertIs(isolation.resource_release, True)
        self.assertIs(isolation.scheduler_status, True)
        self.assertIs(isolation.owner_conflict_resolution, True)
        self.assertEqual(isolation.budget_version, 2)
        self.assertEqual(orch.info.capabilities.lifecycle.version, 1)

    def assert_budget(self, budget, turn_ms):
        self.assertEqual(budget.policy_version, 2)
        self.assertEqual(budget.effective_turn_ms, turn_ms)
        entered = datetime.fromisoformat(budget.entered_at)
        deadline = datetime.fromisoformat(budget.deadline_at)
        self.assertAlmostEqual((deadline - entered).total_seconds() * 1000, turn_ms)
        self.assertTrue(budget.acceptance_deadline_at)
        self.assertTrue(budget.acceptance_source)
        self.assertTrue(budget.turn_source)

    async def assert_unknown_is_released(self, orch, task, scheduler):
        self.assertEqual((scheduler.execution_occupied, scheduler.quarantined,
                          scheduler.quarantine_reserved), (0, 1, 0))
        self.assertEqual(scheduler.max_active_sessions, 1)
        self.assertEqual(scheduler.max_quarantined_dispatches, 1)
        self.assertFalse(scheduler.can_dispatch)
        self.assertEqual(scheduler.reasons, ["QUARANTINE_CAPACITY_EXCEEDED"])
        self.assertEqual(scheduler.open_conflicts, 0)
        self.assertEqual(scheduler.conflicts, [])
        self.assertFalse(scheduler.truncated)
        self.assertFalse(scheduler.conflicts_truncated)

        current = await orch.tasks.get(task.id)
        self.assertEqual(current.status, "blocked")
        self.assertIsNone(current.approval_id, "late resource release must not request acceptance")
        session = await orch.sessions.get(task.session_id)
        self.assertEqual(session.status, "outcome_unknown")
        self.assertTrue(session.active_dispatch_id)
        execution = session.execution
        self.assertEqual(execution.dispatch_id, session.active_dispatch_id)
        self.assertTrue(execution.quarantined)
        self.assertEqual(execution.lease.version, 1)
        self.assertEqual(execution.lease.status, "released")
        self.assertTrue(execution.lease.acquired_at)
        self.assertTrue(execution.lease.released_at)
        self.assertTrue(execution.lease.release_evidence_ref)
        self.assertTrue(execution.last_evidence)
        self.assert_budget(execution.budget, 40)

        self.assertEqual(len(scheduler.occupants), 1)
        occupant = scheduler.occupants[0]
        self.assertEqual(occupant.task_id, task.id)
        self.assertEqual(occupant.session_id, task.session_id)
        self.assertEqual(occupant.dispatch_id, session.active_dispatch_id)
        self.assertEqual(occupant.lease_status, "released")
        self.assertTrue(occupant.quarantined)
        self.assertTrue(occupant.last_evidence)
        self.assertTrue(occupant.entered_at)
        return session

    async def test_a2_stdio_default_budget_is_visible_during_execution(self):
        self.write_config(short_budget=False)
        async with self.local() as orch:
            self.assert_capability(orch)
            scheduler = await orch.scheduler.get()
            self.assertEqual(scheduler.max_quarantined_dispatches, 32)
            self.assertEqual((scheduler.execution_occupied, scheduler.quarantined,
                              scheduler.quarantine_reserved), (0, 0, 0))
            self.assertTrue(scheduler.can_dispatch)
            self.assertEqual(scheduler.reasons, [])
            task = await orch.tasks.create(self.spec(), idempotency_key="default-isolation-budget")
            await self.wait_task(orch, task.id, "running")
            session = await orch.sessions.get(task.session_id)
            self.assertEqual(session.status, "running")
            self.assertEqual(session.execution.dispatch_id, session.active_dispatch_id)
            self.assertEqual(session.execution.lease.status, "held")
            self.assertFalse(session.execution.quarantined)
            self.assert_budget(session.execution.budget, 1800000)
            await self.wait_task(orch, task.id, "waiting_approval")

    async def test_a2_stdio_late_cleanup_releases_execution_only(self):
        self.write_config(short_budget=True)
        async with self.local() as orch:
            self.assert_capability(orch)
            task = await orch.tasks.create(self.spec(), idempotency_key="stdio-isolation-budget")
            await self.wait_task(orch, task.id, "blocked")
            scheduler = await self.wait_released_quarantine(orch)
            await self.assert_unknown_is_released(orch, task, scheduler)

    async def test_a2_socket_clients_share_isolation_and_cannot_resolve_conflicts(self):
        self.write_config(short_budget=True)
        socket_path = str(self.directory / "host.sock")
        process = await asyncio.create_subprocess_exec(
            NODE, str(CLI), "host", "--config", str(self.config), "--socket", socket_path,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(5):
                while not Path(socket_path).exists():
                    if process.returncode is not None:
                        self.fail((await process.stderr.read()).decode())
                    await asyncio.sleep(0.01)
            async with (
                Orchestrator.connect(socket_path=socket_path, poll_interval=0.005,
                                     request_timeout=5) as first,
                Orchestrator.connect(socket_path=socket_path, poll_interval=0.005,
                                     request_timeout=5) as second,
            ):
                self.assert_capability(first)
                self.assert_capability(second)
                self.assertEqual(first.info.store_id, second.info.store_id)
                self.assertEqual(first.info.instance_id, second.info.instance_id)
                task = await first.tasks.create(self.spec(), idempotency_key="socket-isolation-budget")
                await self.wait_task(first, task.id, "blocked")
                first_scheduler = await self.wait_released_quarantine(first)
                second_scheduler = await second.scheduler.get()
                self.assertEqual(first_scheduler.as_dict(), second_scheduler.as_dict())
                first_session = await self.assert_unknown_is_released(first, task, first_scheduler)
                second_session = await self.assert_unknown_is_released(second, task, second_scheduler)
                self.assertEqual(first_session.execution.as_dict(), second_session.execution.as_dict())

                conflict_id = "nonexistent-fixture-conflict"
                with self.assertRaises(OrchestrationError) as raised:
                    await second.scheduler.resolve_conflict(
                        conflict_id, self.resource_evidence(), expected_revision=1,
                        idempotency_key="socket-must-not-resolve",
                    )
                self.assertEqual(raised.exception.code, "UNAUTHORIZED")
                self.assertEqual(raised.exception.scope, conflict_id)
                self.assertEqual(raised.exception.idempotency_key, "socket-must-not-resolve")
                self.assertEqual(raised.exception.method, "scheduler.resolveConflict")
                self.assertEqual((await first.scheduler.get()).as_dict(), first_scheduler.as_dict())
            self.assertIsNone(process.returncode, "disconnecting clients must leave the host alive")
        finally:
            if process.returncode is None:
                process.terminate()
            try:
                await asyncio.wait_for(process.communicate(), 5)
            except TimeoutError:
                process.kill()
                await process.communicate()


if __name__ == "__main__":
    unittest.main()
