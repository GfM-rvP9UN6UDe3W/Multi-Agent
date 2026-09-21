"""SPEC-0013 model-changing forks against the real Node host with the explicit fake runtime."""
import asyncio
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from agent_orch import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and CLI.is_file(), "requires Node.js 22.18+ and the local host source")
class ForkModelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-fork-model-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        workspace = self.directory / "workspace"
        workspace.mkdir()
        state = self.directory / "state"
        state.mkdir()
        self.config = self.directory / "config.json"
        self.config.write_text(json.dumps({"configVersion": 1, "workspace": str(workspace),
            "stateDir": str(state), "providers": {"fake": {"models": ["alpha", "beta"],
            "permissionProfile": "read-only"}}, "shutdown": {"timeoutMs": 1000}}), encoding="utf-8")

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(CLI), "host", "--stdio", "--config", str(self.config)],
                                  poll_interval=0.005, request_timeout=5)

    @staticmethod
    def spec(model, **extra):
        return TaskSpec(goal="only the deterministic fake runtime", runtime=RuntimeSpec("fake", model),
                        acceptance=AcceptanceSpec(criteria=["inspect fixture result"]), **extra)

    @staticmethod
    def target(session):
        return {"session_id": session.id, "expected_generation": session.generation,
                "expected_revision": session.revision, "expected_dispatch_id": session.active_dispatch_id,
                "expected_state": session.status}

    async def complete(self, orch, task):
        async with asyncio.timeout(5):
            while (current := await orch.tasks.get(task.id)).status != "waiting_approval":
                await asyncio.sleep(0.005)
        approval = await orch.approvals.get(current.approval_id)
        await orch.approvals.decide(approval.approval_id,
                                    {"choice": "approve", "expected_revision": approval.revision})
        return await task.wait(timeout=5)

    async def test_0013_m02_m06_python_fork_changes_model_only_with_acknowledgment(self):
        async with self.local() as orch:
            self.assertIs(orch.info.capabilities.session_lifecycle.fork_model, True)
            first = await self.complete(orch, await orch.tasks.create(self.spec("alpha")))
            source = await orch.sessions.get(first.session_id)
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.fork(self.target(source), first.artifact_refs[0], model="beta",
                                         idempotency_key="no-ack")
            self.assertEqual(raised.exception.code, "CACHE_LOSS_NOT_ACKNOWLEDGED")
            fork = await orch.sessions.fork(self.target(source), first.artifact_refs[0], model="beta",
                                            acknowledge_cache_loss=True, idempotency_key="python-fork")
            self.assertEqual(fork.model, "beta")
            self.assertEqual((await orch.sessions.get(source.id)).model, "alpha")
            operation = await orch.operations.lookup(method="sessions.fork", scope=source.id,
                                                     idempotency_key="python-fork")
            self.assertEqual(operation.result["modelChange"],
                             {"fromModel": "alpha", "toModel": "beta", "promptCacheReuse": False})
            plan = {"requested_mode": "reuse", "independent": True, "candidate_session_id": fork.id,
                    "dependency_task_ids": [], "context_refs": [], "fallback_modes": [],
                    "max_queue_wait_ms": 1000}
            branch = await orch.tasks.create(self.spec("beta", parent_task_id=first.id, context_plan=plan))
            self.assertEqual((await self.complete(orch, branch)).status, "completed")
            self.assertEqual((await orch.tasks.get(branch.id)).session_id, fork.id)

    async def test_0013_m06_python_requires_negotiated_fork_model_capability(self):
        fixture = Path(__file__).with_name("fake_protocol_server.py")
        async with Orchestrator.local(engine_command=[sys.executable, str(fixture), "--mode", "fork-only"],
                                      poll_interval=0.005) as orch:
            target = {"session_id": "session-1", "expected_generation": 1, "expected_revision": 1,
                      "expected_dispatch_id": None, "expected_state": "idle"}
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.fork(target, "sha256:fixture", model="beta", acknowledge_cache_loss=True)
            self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")


if __name__ == "__main__":
    unittest.main()
