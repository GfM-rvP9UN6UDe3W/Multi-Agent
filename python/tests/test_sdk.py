import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest

from agent_orch import AcceptanceSpec, Orchestrator, OrchestrationError, RuntimeSpec, ShutdownIncomplete, TaskSpec


FIXTURE = Path(__file__).with_name("fake_protocol_server.py")


def spec(goal="inspect fixture"):
    return TaskSpec(goal=goal, runtime=RuntimeSpec(provider="fake", model="fixture"),
                    acceptance=AcceptanceSpec(mode="human", criteria=["review evidence"]))


class SDKContractTests(unittest.IsolatedAsyncioTestCase):
    def local(self, mode="normal", **kwargs):
        return Orchestrator.local(engine_command=[sys.executable, str(FIXTURE), "--mode", mode],
                                  poll_interval=0.005, **kwargs)

    async def test_ac12_typed_task_approval_to_terminal(self):
        async with self.local() as orch:
            task = await orch.tasks.create(spec(), idempotency_key="task-key")
            self.assertEqual(task.status, "waiting_approval")
            self.assertEqual(task.spec.runtime.provider, "fake")
            approval = await orch.approvals.get(task.approval_id)
            self.assertEqual(approval.target.task_revision, 2)
            op = await orch.approvals.decide(approval.approval_id,
                {"choice": "approve", "expected_revision": approval.revision}, idempotency_key="approve-key")
            self.assertEqual((await op.wait(timeout=1)).status, "completed")
            self.assertEqual((await task.wait(timeout=1)).status, "completed")
            self.assertEqual((await orch.operations.lookup(method="approvals.decide", scope=approval.approval_id,
                             idempotency_key="approve-key")).id, op.id)

    async def test_ac02_idempotency_and_error_key(self):
        async with self.local() as orch:
            first = await orch.tasks.create(spec(), idempotency_key="same-key")
            second = await orch.tasks.create(spec(), idempotency_key="same-key")
            self.assertEqual(first.id, second.id)
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.create(spec("changed"), idempotency_key="same-key")
            self.assertEqual(raised.exception.code, "IDEMPOTENCY_CONFLICT")
            self.assertEqual(raised.exception.idempotency_key, "same-key")

    async def test_ac06_wait_timeout_and_cancel_do_not_cancel_task(self):
        async with self.local() as orch:
            task = await orch.tasks.create(spec())
            with self.assertRaises(OrchestrationError) as raised:
                await task.wait(timeout=0.02)
            self.assertEqual(raised.exception.code, "TIMEOUT")
            waiter = asyncio.create_task(task.wait())
            await asyncio.sleep(0.01)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertEqual((await orch.tasks.get(task.id)).status, "waiting_approval")
            await orch.tasks.cancel(task.id)
            self.assertEqual((await task.wait(timeout=1)).status, "cancelled")

    async def test_ac05_events_replay_cursor_and_preserve_custom_data(self):
        async with self.local() as orch:
            task = await orch.tasks.create(spec())
            events = orch.events(task_id=task.id)
            first = await anext(events)
            self.assertEqual(first.event_id, "e1")
            self.assertEqual(first.data.approval_id, "approval-1")
            self.assertEqual(first.data["customPayload"], {"someCustomKey": {"taskId": "must-not-rename"}})
            await events.aclose()
            await orch.tasks.cancel(task.id)
            resumed = orch.events(task_id=task.id, after_cursor=first.cursor, store_id=first.store_id)
            second = await anext(resumed)
            self.assertEqual(second.type, "task.cancelled")
            self.assertGreater(int(second.cursor), int(first.cursor))
            await resumed.aclose()
            bad = orch.events(after_cursor="1")
            with self.assertRaises(OrchestrationError) as raised:
                await anext(bad)
            self.assertEqual(raised.exception.code, "VALIDATION_ERROR")

    async def test_ac11_stderr_is_drained_without_event_consumer(self):
        async with self.local("stderr-flood", request_timeout=2.0) as orch:
            task = await orch.tasks.create(spec())
            self.assertEqual((await orch.tasks.get(task.id)).id, task.id)
            self.assertLessEqual(len(orch.stderr_tail.encode()), 16384)

    async def test_ac07_owner_shutdown_timeout_retains_live_handle(self):
        orch = self.local("shutdown-timeout")
        with self.assertRaises(ShutdownIncomplete) as raised:
            async with orch:
                task = await orch.tasks.create(spec())
        self.assertIs(raised.exception.client, orch)
        self.assertEqual(raised.exception.operation_id, "shutdown-1")
        self.assertEqual((await orch.tasks.get(task.id)).id, task.id)
        await raised.exception.client.close(operation_id=raised.exception.operation_id, mode="interrupt", timeout=0.1)
        self.assertTrue(orch.closed)

    async def test_ac07_context_keeps_original_exception(self):
        with self.assertRaisesRegex(RuntimeError, "business failure"):
            async with self.local():
                raise RuntimeError("business failure")

    async def test_ac10_session_control_and_unsupported_capabilities(self):
        async with self.local() as orch:
            session = await orch.sessions.get("session-1")
            op = await orch.sessions.control({"session_id": session.id, "expected_generation": session.generation,
                "expected_revision": session.revision, "expected_dispatch_id": None, "expected_state": session.status},
                {"action": "pause", "mode": "drain"})
            self.assertEqual((await op.wait(timeout=1)).status, "completed")
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.control({}, {"action": "compact"})
            self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")
            for method in (orch.sessions.open, orch.sessions.fork):
                with self.assertRaises(OrchestrationError) as raised:
                    await method({})
                self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")

    async def test_ac09_messages_and_unknown_usage(self):
        async with self.local() as orch:
            task = await orch.tasks.create(spec())
            receipt = await orch.messages.send({"task_id": task.id, "to_session_id": task.session_id,
                "expected_generation": 1, "kind": "finding", "summary": "fixture", "artifact_refs": []})
            self.assertEqual(receipt.status, "persisted")
            self.assertTrue(receipt.idempotency_key)
            self.assertEqual((await orch.messages.get(receipt.id)).status, "persisted")
            usage = await orch.usage.get(task_id=task.id)
            self.assertIsNone(usage.records[0].input_tokens)
            self.assertEqual(usage.records[0].raw, {"vendorCustomKey": {"taskId": "unchanged"}})
            self.assertFalse((await orch.capabilities(provider="fake")).compact)

    async def test_ac11_outbound_frame_bound(self):
        async with self.local() as orch:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.create(spec("x" * (1024 * 1024)))
            self.assertEqual(raised.exception.code, "FRAME_TOO_LARGE")
            self.assertTrue(raised.exception.idempotency_key)
            self.assertTrue((await orch.capabilities(provider="fake")).resume)

    async def test_ac11_inbound_frame_bound(self):
        orch = await self.local()
        try:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.get("oversized")
            self.assertEqual(raised.exception.code, "FRAME_TOO_LARGE")
        finally:
            await orch.disconnect()

    async def test_ac11_pending_request_bound(self):
        async with self.local() as orch:
            pending = [asyncio.create_task(orch.tasks.get("hold")) for _ in range(64)]
            await asyncio.sleep(0.02)
            with self.assertRaises(OrchestrationError) as raised:
                await orch.tasks.get("hold")
            self.assertEqual(raised.exception.code, "REQUEST_LIMIT_EXCEEDED")
            results = await asyncio.gather(*pending)
            self.assertEqual(len(results), 64)

    async def test_ac11_handshake_version_and_missing_engine(self):
        with self.assertRaises(OrchestrationError) as raised:
            async with self.local("mismatch"):
                self.fail("must not accept mismatched protocol")
        self.assertEqual(raised.exception.code, "PROTOCOL_MISMATCH")
        with self.assertRaises(OrchestrationError) as raised:
            async with Orchestrator.local(engine_command=["/definitely/not/an/executable"]):
                self.fail("must not start missing executable")
        self.assertEqual(raised.exception.code, "ENGINE_NOT_FOUND")

    async def test_ac11_disconnect_fails_pending_without_hanging(self):
        with self.assertRaises(OrchestrationError) as raised:
            async with self.local("die", request_timeout=1):
                self.fail("fixture closes during handshake")
        self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")

    async def test_ac02_disconnected_mutations_keep_distinct_recovery_keys(self):
        orch = await self.local("drop-mutations")
        try:
            outcomes = await asyncio.gather(
                orch.tasks.create(spec(), idempotency_key="lost-first"),
                orch.tasks.create(spec(), idempotency_key="lost-second"), return_exceptions=True)
            self.assertTrue(all(isinstance(item, OrchestrationError) for item in outcomes))
            self.assertEqual([item.idempotency_key for item in outcomes], ["lost-first", "lost-second"])
            self.assertEqual([item.method for item in outcomes], ["tasks.create", "tasks.create"])
            self.assertEqual([item.scope for item in outcomes], ["local", "local"])

            with self.assertRaises(OrchestrationError) as raised:
                await orch.approvals.decide("approval-lost", {"choice": "approve", "expected_revision": 1})
            self.assertEqual(raised.exception.scope, "approval-lost")
            self.assertEqual(raised.exception.method, "approvals.decide")
            self.assertTrue(raised.exception.idempotency_key)
        finally:
            await orch.disconnect()

    async def test_ac07_socket_close_only_disconnects(self):
        with tempfile.TemporaryDirectory(prefix="orch-python-", dir="/tmp") as directory:
            socket_path = str(Path(directory) / "host.sock")
            process = await asyncio.create_subprocess_exec(sys.executable, str(FIXTURE), "--socket", socket_path,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                ready = await asyncio.wait_for(process.stdout.readline(), 3)
                if ready != b"READY\n":
                    self.fail((await process.stderr.read()).decode())
                async with Orchestrator.connect(socket_path=socket_path) as first:
                    task = await first.tasks.create(spec())
                self.assertIsNone(process.returncode)
                async with Orchestrator.connect(socket_path=socket_path) as second:
                    self.assertEqual((await second.tasks.get(task.id)).id, task.id)
            finally:
                if process.returncode is None:
                    process.terminate()
                await process.wait()


if __name__ == "__main__":
    unittest.main()
