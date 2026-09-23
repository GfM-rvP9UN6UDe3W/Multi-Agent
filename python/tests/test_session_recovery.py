"""SPEC-0016 through the Python SDK against the real Node host."""
import asyncio
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "workflow-host.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class SessionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-session-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    @staticmethod
    def spec(goal, **extra):
        return TaskSpec(goal=goal, runtime=RuntimeSpec("fake", "fixture"), acceptance=AcceptanceSpec(criteria=["review"]),
                        **extra)

    @staticmethod
    def target(session):
        return {"session_id": session.id, "expected_generation": session.generation,
                "expected_revision": session.revision, "expected_dispatch_id": session.active_dispatch_id,
                "expected_state": session.status}

    async def pending(self, orch, task_id):
        async with asyncio.timeout(5):
            while (task := await orch.tasks.get(task_id)).status != "waiting_approval":
                await asyncio.sleep(0.005)
        return await orch.approvals.get(task.approval_id)

    async def test_0016_s01_python_resumes_a_session_whose_task_ended(self):
        async with Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                      poll_interval=0.005, request_timeout=5) as orch:
            agent = await orch.tasks.create(self.spec("agent"))
            approval = await self.pending(orch, agent.id)
            await orch.sessions.control(self.target(await orch.sessions.get(agent.session_id)), {"action": "pause"})
            await orch.approvals.decide(approval.approval_id, {"choice": "approve",
                                                               "expected_revision": approval.revision})
            paused = await orch.sessions.get(agent.session_id)
            self.assertEqual((paused.status, paused.pause_origin), ("paused", "client"))
            await orch.sessions.control(self.target(paused), {"action": "resume"})
            self.assertEqual((await orch.sessions.get(agent.session_id)).status, "idle")
            plan = {"requested_mode": "reuse", "independent": True, "candidate_session_id": agent.session_id}
            follow = await orch.tasks.create(self.spec("continue", parent_task_id=agent.id, context_plan=plan))
            await self.pending(orch, follow.id)
            self.assertEqual((await orch.tasks.get(follow.id)).session_id, agent.session_id)


if __name__ == "__main__":
    unittest.main()
