"""SPEC-0027 through the Python SDK and real hosts: read-only access, labels, cursor errors and the
idempotency cache."""
import asyncio
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
NODE = shutil.which("node")
READ = RuntimeSpec("fake-read", "r-default")
ACCEPT = AcceptanceSpec(criteria=["Review the result"])


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class HostCorrectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-0027-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                  poll_interval=0.005, request_timeout=5)

    def read_only(self):
        return Orchestrator.local(engine_command=[NODE, str(CLI), "host", "--read-only", "--state-dir",
                                                  str(self.state), "--stdio"],
                                  poll_interval=0.005, request_timeout=5)

    @staticmethod
    async def wait(orch, task_id, status):
        async with asyncio.timeout(5):
            while (task := await orch.tasks.get(task_id)).status != status:
                await asyncio.sleep(0.005)
        return task

    async def test_0027_r09_python_reads_through_the_read_only_host(self):
        async with self.local() as orch:
            task = await orch.tasks.create(TaskSpec("Offline reading", READ, ACCEPT, label="group:alpha"))
            await self.wait(orch, task.id, "waiting_approval")
            store_id = orch.info.store_id
        async with self.read_only() as reader:
            self.assertEqual(reader.info.capabilities["readOnly"], {"version": 1})
            self.assertEqual(reader.info.store_id, store_id)
            self.assertEqual((await reader.tasks.get(task.id)).status, "waiting_approval")
            listed = await reader.tasks.list(label="group:alpha")
            self.assertEqual([item["id"] for item in listed.tasks], [task.id])
            events = reader.events(task_id=task.id)
            first = await anext(events)
            self.assertEqual(first.task_id, task.id)
            await events.aclose()
            with self.assertRaises(OrchestrationError) as raised:
                await reader.tasks.create(TaskSpec("Not while reading", READ, ACCEPT))
            self.assertEqual(raised.exception.code, "READ_ONLY")

    async def test_0027_l01_l03_python_labels_and_metadata_round_trip(self):
        metadata = {"task_id": "kept as written", "agentId": "kept too", "nested": {"parent_task_id": 1}}
        async with self.local() as orch:
            self.assertTrue(orch.info.capabilities.workflow.get("labels"))
            task = await orch.tasks.create(TaskSpec("Labeled", READ, ACCEPT, label="group:alpha",
                                                    metadata=metadata))
            self.assertEqual(task.spec["label"], "group:alpha")
            self.assertEqual(task.spec["metadata"], metadata)
            await orch.tasks.create(TaskSpec("Unlabeled", READ, ACCEPT))
            listed = await orch.tasks.list(label="group:alpha")
            self.assertEqual([item["id"] for item in listed.tasks], [task.id])
            session = await orch.sessions.open({"runtime": {"provider": "fake-read", "model": "r-small"},
                                                "label": "session:reviewer", "metadata": metadata})
            self.assertEqual(session.label, "session:reviewer")
            self.assertEqual(session.metadata, metadata)

    async def test_0027_c02_python_cursor_errors_carry_the_reason(self):
        async with self.local() as orch:
            await orch.tasks.create(TaskSpec("Write events", READ, ACCEPT))
            with self.assertRaises(OrchestrationError) as raised:
                await anext(orch.events(after_cursor="1", store_id="another-store"))
            self.assertEqual(raised.exception.code, "CURSOR_EXPIRED")
            self.assertEqual(raised.exception.data["reason"], "store_changed")
            self.assertEqual(raised.exception.data["currentStoreId"], orch.info.store_id)
            self.assertEqual(raised.exception.data["retentionFloorCursor"], "0")

    async def test_0027_k01_k03_python_corrects_a_rejected_request_under_its_key(self):
        async with self.local() as orch:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.open({"runtime": {"provider": "fake-read", "model": "unlisted"}},
                                         idempotency_key="k1")
            self.assertEqual(raised.exception.code, "VALIDATION_ERROR")
            opened = await orch.sessions.open({"runtime": {"provider": "fake-read", "model": "r-small"}},
                                              idempotency_key="k1")
            self.assertEqual(opened.model, "r-small")
            with self.assertRaises(OrchestrationError) as local:
                await orch.sessions.open({"runtime": {"provider": "fake-read", "model": "r-large"}},
                                         idempotency_key="k1")
            self.assertEqual(str(local.exception), "Retry identity or payload changed")
            self.assertEqual(orch.forget_idempotency_key("k1"), 1)
            self.assertEqual(orch.forget_idempotency_key("k1"), 0)
            with self.assertRaises(OrchestrationError) as engine:
                await orch.sessions.open({"runtime": {"provider": "fake-read", "model": "r-large"}},
                                         idempotency_key="k1")
            self.assertEqual(engine.exception.code, "IDEMPOTENCY_CONFLICT")
            self.assertEqual(str(engine.exception), "Key was already used with different payload")


if __name__ == "__main__":
    unittest.main()
