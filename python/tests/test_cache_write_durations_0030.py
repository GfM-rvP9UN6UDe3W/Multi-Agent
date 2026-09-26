"""SPEC-0030 A05 through the Python SDK and a real host: cache writes split by duration."""
import asyncio
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "usage-host.ts"
NODE = shutil.which("node")
FAKE = RuntimeSpec("fake", "fixture")
ACCEPT = AcceptanceSpec(criteria=["Review the result"])


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class CacheWriteDurationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-0030-", dir=str(Path("/tmp").resolve()))
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

    async def test_0030_a05_python_reads_cache_writes_by_duration(self):
        async with self.local() as orch:
            split = await orch.tasks.create(TaskSpec("split=9/3", FAKE, ACCEPT))
            whole = await orch.tasks.create(TaskSpec("whole=7", FAKE, ACCEPT))
            await self.wait(orch, split.id, "waiting_approval")
            await self.wait(orch, whole.id, "waiting_approval")

            result = await orch.usage.by_task([split.id, whole.id])
            totals = [(entry.totals.cache_write_input_tokens, entry.totals.cache_write_5m_input_tokens,
                       entry.totals.cache_write_1h_input_tokens) for entry in result.tasks]
            self.assertEqual(totals, [(12, 9, 3), (7, 0, 0)])
            model = result.tasks[0].by_model[0]
            self.assertEqual((model.cache_write_5m_input_tokens, model.cache_write_1h_input_tokens), (9, 3))
            summary = await orch.usage.summary(split.id)
            self.assertEqual(summary.totals.cache_write_1h_input_tokens, 3)

            record = (await orch.usage.get(split.id)).records[0]
            self.assertEqual((record.cache_write_5m_input_tokens, record.cache_write_1h_input_tokens), (9, 3))
            # Raw provider JSON keeps its own keys.
            self.assertEqual(record.raw, {"cache_creation": {"ephemeral_5m_input_tokens": "kept as reported"}})
            plain = (await orch.usage.get(whole.id)).records[0]
            self.assertNotIn("cache_write_5m_input_tokens", plain)
            async with asyncio.timeout(5):
                async for recorded in orch.events(task_id=split.id):
                    if recorded.type == "usage.recorded":
                        break
            self.assertEqual(recorded.data.cache_write_5m_input_tokens, 9)


if __name__ == "__main__":
    unittest.main()
