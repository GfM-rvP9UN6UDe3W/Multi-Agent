"""SPEC-0028 through the Python SDK and a real host: task queries, queue reasons, usage totals, rule
retirement and a pausing close."""
import asyncio
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from orchvia import (AcceptanceSpec, CheckAcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec,
                     TaskSpec)


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
READ = RuntimeSpec("fake-read", "r-default")
ACCEPT = AcceptanceSpec(criteria=["Review the result"])
RULE = {"id": "lint", "version": "1", "argv": ["/usr/bin/true"], "cwd_relative": ".",
        "timeout_ms": 1000, "permission_profile": "read-only", "success": {"exitCode": 0}}


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class HostQueryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-0028-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                  poll_interval=0.005, request_timeout=5)

    @staticmethod
    async def wait(orch, task_id, status):
        async with asyncio.timeout(5):
            while (task := await orch.tasks.get(task_id)).status != status:
                await asyncio.sleep(0.005)
        return task

    async def test_0028_p05_b01_python_lists_reads_and_explains_waits(self):
        async with self.local() as orch:
            workflow = orch.info.capabilities.workflow
            for feature in ("task_queries", "queue_reasons", "pause_close", "rule_retirement"):
                self.assertTrue(workflow.get(feature), feature)
            root = await orch.tasks.create(TaskSpec("Root", READ, ACCEPT))
            waiting = await self.wait(orch, root.id, "waiting_approval")
            other = await orch.tasks.create(TaskSpec("Other", READ, ACCEPT))
            await self.wait(orch, other.id, "waiting_approval")
            child = await orch.tasks.create(TaskSpec(
                "Child", READ, ACCEPT, parent_task_id=root.id,
                context_plan={"requested_mode": "reuse", "independent": True,
                              "candidate_session_id": waiting.session_id}))
            read = await orch.tasks.get(child.id)
            self.assertEqual(read.status, "queued")
            self.assertEqual(read.blocked_by.reason, "session_busy")
            self.assertEqual(read.blocked_by.session_id, waiting.session_id)
            self.assertEqual(read.blocked_by.task_ids, [root.id])

            listed = await orch.tasks.list(status=["waiting_approval"], order="desc")
            self.assertEqual([item.id for item in listed.tasks], [other.id, root.id])
            queued = await orch.tasks.list(status=["queued"])
            self.assertEqual(queued.tasks[0].blocked_by.reason, "session_busy")
            many = await orch.tasks.get_many([child.id, "missing", root.id])
            self.assertEqual([item.id for item in many.tasks], [child.id, root.id])
            self.assertEqual(many.missing, ["missing"])
            self.assertEqual(many.tasks[0].blocked_by.reason, "session_busy")

            summary = await orch.usage.summary(root.id)
            self.assertEqual(summary.root_task_id, root.id)
            self.assertEqual(summary.by_model, [])
            self.assertEqual(summary.totals.records, 0)
            self.assertEqual(summary.totals.unknown_records, 0)
            self.assertEqual(summary.completeness, "unknown")
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.list(status=[])
            self.assertEqual(raised.exception.code, "VALIDATION_ERROR")

    async def test_0028_u05_s04_python_retires_rules_and_closes_with_pause(self):
        orch = self.local()
        await orch.start()
        try:
            await orch.rules.register(RULE, idempotency_key="lint-1")
            await orch.rules.register({**RULE, "version": "2"}, idempotency_key="lint-2")
            retired = await orch.rules.retire("lint", "1", idempotency_key="retire-1")
            self.assertEqual(retired.status, "completed")
            # Raw result JSON keeps its camelCase keys.
            self.assertIn("retiredAt", retired.result)
            self.assertEqual([item.version for item in (await orch.rules.list()).rules], ["2"])
            everything = await orch.rules.list(include_retired=True)
            self.assertEqual([(item.version, "retired_at" in item) for item in everything.rules],
                             [("2", False), ("1", True)])
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.create(TaskSpec("Checks", READ,
                                                 CheckAcceptanceSpec(rule_refs=[{"id": "lint", "version": "1"}])))
            self.assertEqual(raised.exception.code, "RULE_RETIRED")
            closed = await orch.close(mode="pause", timeout=2)
            self.assertEqual(closed.status, "closed")
        finally:
            await orch.close()


class HostQueryNegotiationTests(unittest.IsolatedAsyncioTestCase):
    async def test_0028_p05_u05_s04_python_checks_the_features_before_sending(self):
        fixture = Path(__file__).with_name("fake_protocol_server.py")
        async with Orchestrator.local(engine_command=[sys.executable, str(fixture), "--mode", "workflow-0.1.4"],
                                      poll_interval=0.005) as orch:
            attempts = [
                orch.tasks.list(status=["queued"]),
                orch.tasks.list(order="desc"),
                orch.tasks.get_many(["a"]),
                orch.usage.summary("a"),
                orch.rules.retire("lint", "1"),
                orch.rules.list(include_retired=True),
                orch.close(mode="pause"),
            ]
            for attempt in attempts:
                with self.assertRaises(OrchestrationError) as raised:
                    await attempt
                self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")
                # Refused by the SDK: the fixture host answers unknown methods with the same code.
                self.assertTrue(str(raised.exception).startswith("Host does not support"),
                                str(raised.exception))


if __name__ == "__main__":
    unittest.main()
