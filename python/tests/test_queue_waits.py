"""SPEC-0015 queue waits through the Python SDK against the real Node host."""
from pathlib import Path
import shutil
import tempfile
import unittest

from agent_orch import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "workflow-host.ts"
NODE = shutil.which("node")
WEEK = 604_800_000


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class QueueWaitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-queue-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    @staticmethod
    def spec(goal, wait):
        return TaskSpec(goal=goal, runtime=RuntimeSpec("fake", "fixture"), acceptance=AcceptanceSpec(criteria=["review"]),
                        context_plan={"requested_mode": "fresh", "independent": True, "max_queue_wait_ms": wait})

    async def test_0015_q06_python_round_trips_a_seven_day_wait(self):
        async with Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                      poll_interval=0.005, request_timeout=5) as orch:
            task = await orch.tasks.create(self.spec("week", WEEK))
            self.assertEqual(task.routing.max_queue_wait_ms, WEEK)
            self.assertEqual((await orch.tasks.get(task.id)).routing.max_queue_wait_ms, WEEK)
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.create(self.spec("too long", WEEK + 1))
            self.assertEqual(raised.exception.code, "VALIDATION_ERROR")


if __name__ == "__main__":
    unittest.main()
