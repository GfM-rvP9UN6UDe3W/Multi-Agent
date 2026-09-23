"""SPEC-0014 host workflow controls against the real Node host and the offline protocol fixture."""
import asyncio
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from orchvia import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "workflow-host.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class HostWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-workflow-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.workspace = self.directory / "workspace"
        self.workspace.mkdir()
        self.state = self.directory / "state"
        self.state.mkdir()

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                  poll_interval=0.005, request_timeout=5)

    @staticmethod
    def spec(goal, provider="fake", **extra):
        return TaskSpec(goal=goal, runtime=RuntimeSpec(provider, "fixture"),
                        acceptance=AcceptanceSpec(criteria=["review"]), **extra)

    async def pending(self, orch, task_id):
        async with asyncio.timeout(5):
            while (task := await orch.tasks.get(task_id)).status != "waiting_approval":
                await asyncio.sleep(0.005)
        return await orch.approvals.get(task.approval_id)

    async def test_0014_x02_python_lists_revises_and_resolves_handoffs(self):
        async with self.local() as orch:
            workflow = orch.info.capabilities.workflow
            self.assertEqual(workflow.version, 1)
            self.assertIs(workflow.task_list, True)
            self.assertIs(workflow.delegation_approval, True)
            agent = await orch.tasks.create(self.spec("agent b"))
            approval = await self.pending(orch, agent.id)
            await orch.approvals.decide(approval.approval_id, {"choice": "revise", "expected_revision": approval.revision,
                                                               "comment": "Please tighten it"})
            revised = await orch.approvals.get(approval.approval_id)
            self.assertEqual((revised.status, revised.comment), ("revised", "Please tighten it"))
            approval = await self.pending(orch, agent.id)
            await orch.approvals.decide(approval.approval_id, {"choice": "approve",
                                                               "expected_revision": approval.revision})
            done = await agent.wait(timeout=5)
            requester = await orch.tasks.create(self.spec(f"handoff to {done.session_id}"))
            await self.pending(orch, requester.id)
            page = await orch.tasks.list(limit=1)
            self.assertEqual(page.tasks[0].id, agent.id)
            self.assertIsInstance(page.next_cursor, str)
            rest = await orch.tasks.list(limit=1, after_cursor=page.next_cursor)
            self.assertEqual([task.id for task in rest.tasks], [requester.id])
            self.assertEqual([task.id for task in (await orch.tasks.list(session_id=done.session_id)).tasks],
                             [agent.id])
            listed = await orch.handoffs.list(status="pending")
            handoff = listed.handoffs[0]
            self.assertEqual(handoff.target_session_id, done.session_id)
            self.assertEqual(handoff.from_task_id, requester.id)
            plan = {"requested_mode": "reuse", "independent": True, "candidate_session_id": done.session_id}
            takeover = await orch.tasks.create(self.spec("handed off", parent_task_id=agent.id, context_plan=plan))
            await orch.handoffs.resolve(handoff.handoff_id, expected_revision=handoff.revision, outcome="accepted",
                                        task_id=takeover.id, comment="Assigned to B")
            resolved = await orch.handoffs.get(handoff.handoff_id)
            self.assertEqual((resolved.status, resolved.task_id), ("accepted", takeover.id))

    async def test_0014_x02_python_registers_rules_and_narrows_write_paths(self):
        async with self.local() as orch:
            rule = {"id": "lint", "version": "1", "argv": ["/usr/bin/true"], "cwd_relative": ".",
                    "timeout_ms": 1000, "permission_profile": "read-only", "success": {"exitCode": 0}}
            await orch.rules.register(rule, idempotency_key="lint-1")
            listed = await orch.rules.list()
            self.assertEqual([(item.id, item.source) for item in listed.rules], [("lint", "runtime")])
            task = await orch.tasks.create(self.spec("write", provider="fake-write", write_scope="agents",
                                                     write_path="agents/alice"))
            self.assertEqual(task.spec.write_path, "agents/alice")
            created = await orch.tasks.get(task.id)
            self.assertEqual(created.write_paths, [str((self.workspace / "agents" / "alice").resolve())])


class HostWorkflowNegotiationTests(unittest.IsolatedAsyncioTestCase):
    async def test_0014_x01_python_checks_workflow_before_sending(self):
        fixture = Path(__file__).with_name("fake_protocol_server.py")
        async with Orchestrator.local(engine_command=[sys.executable, str(fixture), "--mode", "normal"],
                                      poll_interval=0.005) as orch:
            attempts = [
                orch.tasks.list(),
                orch.handoffs.get("h"),
                orch.handoffs.list(),
                orch.handoffs.resolve("h", expected_revision=1, outcome="rejected"),
                orch.rules.list(),
                orch.rules.register({"id": "x"}),
                orch.approvals.decide("a", {"choice": "revise", "expected_revision": 1, "comment": "x"}),
                orch.tasks.create(TaskSpec(goal="x", runtime=RuntimeSpec("fake", "f"),
                                           acceptance=AcceptanceSpec(criteria=["c"]), write_scope="a",
                                           write_path="a/b")),
            ]
            for attempt in attempts:
                with self.assertRaises(OrchestrationError) as raised:
                    await attempt
                self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")


if __name__ == "__main__":
    unittest.main()
