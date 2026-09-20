"""Actual Node host integration with the explicitly configured fake runtime only."""
import asyncio
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from agent_orch import AcceptanceSpec, CheckAcceptanceSpec, Orchestrator, RuntimeSpec, ShutdownIncomplete, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and CLI.is_file(), "requires Node.js 22.18+ and the local host source")
class NodeHostTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-e2e-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.workspace = self.directory / "workspace"
        self.state = self.directory / "state"
        self.workspace.mkdir()
        self.state.mkdir()
        self.config = self.directory / "config.json"
        self.write_config()

    def write_config(self, delay_ms=0):
        self.config.write_text(json.dumps({"configVersion": 1, "workspace": str(self.workspace),
            "stateDir": str(self.state), "providers": {"fake": {"model": "fake-model",
            "delayMs": delay_ms, "result": "verified fake fixture", "permissionProfile": "read-only"}},
            "limits": {"maxActiveSessions": 2}, "shutdown": {"timeoutMs": 1000}}), encoding="utf-8")

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(CLI), "host", "--stdio", "--config", str(self.config)],
                                  poll_interval=0.005, request_timeout=5.0)

    @staticmethod
    def spec():
        return TaskSpec(goal="run only the deterministic fake fixture",
                        runtime=RuntimeSpec(provider="fake", model="fake-model"),
                        acceptance=AcceptanceSpec(mode="human", criteria=["matches known fixture"]))

    async def approval(self, orch, task_id):
        async with asyncio.timeout(5):
            events = orch.events(task_id=task_id)
            try:
                async for event in events:
                    if event.type == "approval.requested":
                        return await orch.approvals.get(event.data.approval_id)
            finally:
                await events.aclose()
        self.fail("missing approval event")

    async def test_ac12_node_stdio_approval_persistence_and_replay(self):
        async with self.local() as orch:
            task = await orch.tasks.create(self.spec(), idempotency_key="python-node-roundtrip")
            approval = await self.approval(orch, task.id)
            self.assertEqual(approval.purpose, "task_acceptance")
            before = await orch.tasks.get(task.id)
            self.assertEqual(before.status, "waiting_approval")
            approval_operation = await orch.approvals.decide(approval.approval_id,
                {"choice": "approve", "expected_revision": approval.revision}, idempotency_key="fixture-approve")
            recovered = await orch.operations.lookup(method=approval_operation.method,
                scope=approval_operation.scope, idempotency_key=approval_operation.idempotency_key)
            self.assertEqual(recovered.id, approval_operation.id)
            result = await task.wait(timeout=3)
            self.assertEqual(result.status, "completed")
            self.assertEqual(result.result, "verified fake fixture")
            store_id = orch.info.store_id
            task_id = task.id
        async with self.local() as restarted:
            self.assertEqual(restarted.info.store_id, store_id)
            self.assertEqual((await restarted.tasks.get(task_id)).status, "completed")
            duplicate = await restarted.tasks.create(self.spec(), idempotency_key="python-node-roundtrip")
            self.assertEqual(duplicate.id, task_id)
            self.assertEqual((await duplicate.wait(timeout=1)).status, "completed")

    async def test_f07_runtime_permission_is_not_task_acceptance(self):
        async with Orchestrator.local(engine_command=[NODE, str(ROOT / "tests/fixtures/permission-host.ts"),
                str(self.workspace), str(self.state)], poll_interval=0.005, request_timeout=5.0) as orch:
            task = await orch.tasks.create(self.spec())
            runtime = await self.approval(orch, task.id)
            self.assertEqual(runtime.purpose, "runtime_permission")
            self.assertEqual(runtime.target.tool_name, "Read")
            self.assertEqual(runtime.target.session_id, task.session_id)
            await orch.approvals.decide(runtime.approval_id,
                {"choice": "approve", "expected_revision": runtime.revision}, idempotency_key="runtime-approve")
            async with asyncio.timeout(3):
                while True:
                    current = await orch.tasks.get(task.id)
                    if current.approval_id and current.approval_id != runtime.approval_id:
                        break
                    await asyncio.sleep(0.005)
            acceptance = await orch.approvals.get(current.approval_id)
            self.assertEqual(acceptance.purpose, "task_acceptance")
            self.assertEqual(current.result, "permission-approved")
            self.assertEqual(current.status, "waiting_approval")
            await orch.approvals.decide(acceptance.approval_id,
                {"choice": "approve", "expected_revision": acceptance.revision})
            self.assertEqual((await task.wait(timeout=3)).status, "completed")

    async def test_ac07_node_owner_shutdown_timeout_and_interrupt(self):
        self.write_config(delay_ms=1000)
        orch = await self.local()
        try:
            task = await orch.tasks.create(self.spec(), idempotency_key="shutdown-node")
            async with asyncio.timeout(3):
                while (await orch.tasks.get(task.id)).status != "running":
                    await asyncio.sleep(0.005)
            with self.assertRaises(ShutdownIncomplete) as raised:
                await orch.close(timeout=0.001)
            self.assertIs(raised.exception.client, orch)
            self.assertTrue(raised.exception.operation_id)
            await orch.close(mode="interrupt", operation_id=raised.exception.operation_id, timeout=2)
            self.assertTrue(orch.closed)
        finally:
            if not orch.closed:
                await orch.close(mode="interrupt", timeout=3)

    async def test_f01_f08_real_node_dependency_and_registered_check(self):
        config = json.loads(self.config.read_text())
        config["verificationRules"] = [{"id": "fixture-check", "version": "1",
            "argv": [NODE, "-e", 'console.log("checked from Python")'], "cwdRelative": ".",
            "timeoutMs": 1000, "permissionProfile": "read-only", "success": {"exitCode": 0}}]
        self.config.write_text(json.dumps(config))
        async with self.local() as orch:
            parent = await orch.tasks.create(self.spec())
            approval = await self.approval(orch, parent.id)
            dependent = await orch.tasks.create(TaskSpec(goal="wait for accepted prerequisite",
                runtime=RuntimeSpec(provider="fake", model="fake-model"),
                acceptance=CheckAcceptanceSpec(rule_refs=[{"id": "fixture-check", "version": "1"}]),
                dependency_task_ids=[parent.id]))
            self.assertEqual(dependent.status, "waiting_dependency")
            self.assertEqual((await orch.scheduler.get()).execution_occupied, 0)
            await orch.approvals.decide(approval.approval_id,
                {"choice": "approve", "expected_revision": approval.revision})
            done = await dependent.wait(timeout=3)
            self.assertEqual(done.status, "completed")
            self.assertEqual(len(done.artifact_refs), 2)
            self.assertEqual(done.spec.dependency_task_ids, [parent.id])

    async def test_ac12_node_socket_two_clients_share_task_and_host_survives(self):
        socket_path = str(self.directory / "host.sock")
        process = await asyncio.create_subprocess_exec(NODE, str(CLI), "host", "--config", str(self.config),
            "--socket", socket_path, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            async with asyncio.timeout(5):
                while not Path(socket_path).exists():
                    if process.returncode is not None:
                        self.fail((await process.stderr.read()).decode())
                    await asyncio.sleep(0.01)
            async with Orchestrator.connect(socket_path=socket_path, poll_interval=0.005) as first:
                task = await first.tasks.create(self.spec(), idempotency_key="shared-node-task")
                task_id = task.id
            self.assertIsNone(process.returncode)
            async with Orchestrator.connect(socket_path=socket_path, poll_interval=0.005) as second:
                task = await second.tasks.get(task_id)
                self.assertEqual(task.id, task_id)
                approval = await self.approval(second, task_id)
                await second.approvals.decide(approval.approval_id,
                    {"choice": "approve", "expected_revision": approval.revision})
                self.assertEqual((await second.tasks.get(task_id)).status, "completed")
            self.assertIsNone(process.returncode)
        finally:
            if process.returncode is None:
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


if __name__ == "__main__":
    unittest.main()
