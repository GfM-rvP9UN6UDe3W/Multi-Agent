"""SPEC-0017 through the Python SDK against the real Node host."""
import asyncio
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import AcceptanceSpec, CheckAcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "workflow-host.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class AuditCorrectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-audit-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        (self.workspace / "app").mkdir(parents=True)
        self.state = directory / "state"
        self.state.mkdir()

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                  poll_interval=0.005, request_timeout=5)

    @staticmethod
    def spec(goal, acceptance=None):
        return TaskSpec(goal=goal, runtime=RuntimeSpec("fake", "fixture"),
                        acceptance=acceptance or AcceptanceSpec(criteria=["review"]))

    async def pending(self, orch, task_id):
        async with asyncio.timeout(5):
            while (task := await orch.tasks.get(task_id)).status != "waiting_approval":
                await asyncio.sleep(0.005)
        return await orch.approvals.get(task.approval_id)

    async def test_0017_a01_python_host_restarts_with_a_rule_whose_directory_was_removed(self):
        rule = {"id": "lint", "version": "1", "argv": ["/usr/bin/true"], "cwd_relative": "app",
                "timeout_ms": 1000, "permission_profile": "read-only", "success": {"exitCode": 0}}
        async with self.local() as orch:
            await orch.rules.register(rule, idempotency_key="lint-1")
        shutil.rmtree(self.workspace / "app")
        async with self.local() as orch:
            self.assertEqual([item.id for item in (await orch.rules.list()).rules], ["lint"])
            checks = CheckAcceptanceSpec(rule_refs=[{"id": "lint", "version": "1"}])
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.create(self.spec("checked", checks))
            self.assertEqual(raised.exception.code, "INVALID_WORKSPACE_SCOPE")

    async def test_0017_a03_python_revise_on_a_stopped_session_is_refused(self):
        async with self.local() as orch:
            task = await orch.tasks.create(self.spec("reviewed"))
            approval = await self.pending(orch, task.id)
            session = await orch.sessions.get(task.session_id)
            await orch.sessions.control({"session_id": session.id, "expected_generation": session.generation,
                                         "expected_revision": session.revision,
                                         "expected_dispatch_id": session.active_dispatch_id,
                                         "expected_state": session.status}, {"action": "stop"})
            with self.assertRaises(OrchestrationError) as raised:
                await orch.approvals.decide(approval.approval_id, {"choice": "revise", "comment": "Add tests",
                                                                   "expected_revision": approval.revision})
            self.assertEqual(raised.exception.code, "SESSION_CLOSED")
            self.assertEqual((await orch.approvals.get(approval.approval_id)).status, "pending")
            await orch.approvals.decide(approval.approval_id, {"choice": "approve",
                                                               "expected_revision": approval.revision})
            self.assertEqual((await orch.tasks.get(task.id)).status, "completed")

    async def test_0017_a05_python_approval_completes_after_the_session_stopped_with_a_message(self):
        async with self.local() as orch:
            task = await orch.tasks.create(self.spec("reviewed"))
            approval = await self.pending(orch, task.id)
            message = await orch.messages.send({"task_id": task.id, "to_session_id": task.session_id,
                                                "expected_generation": 1, "kind": "finding",
                                                "summary": "one more point"})
            session = await orch.sessions.get(task.session_id)
            await orch.sessions.control({"session_id": session.id, "expected_generation": session.generation,
                                         "expected_revision": session.revision,
                                         "expected_dispatch_id": session.active_dispatch_id,
                                         "expected_state": session.status}, {"action": "stop"})
            self.assertEqual((await orch.messages.get(message.id)).status, "expired")
            with self.assertRaises(OrchestrationError) as raised:
                await orch.messages.send({"task_id": task.id, "to_session_id": task.session_id,
                                          "expected_generation": 1, "kind": "finding", "summary": "late"})
            self.assertEqual(raised.exception.code, "SESSION_CLOSED")
            await orch.approvals.decide(approval.approval_id, {"choice": "approve",
                                                               "expected_revision": approval.revision})
            self.assertEqual((await orch.tasks.get(task.id)).status, "completed")


if __name__ == "__main__":
    unittest.main()
