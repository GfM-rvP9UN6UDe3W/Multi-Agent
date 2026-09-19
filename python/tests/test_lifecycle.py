"""Deterministic start/close races with real owned fixture processes."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from agent_orch import Orchestrator, OrchestrationError
from agent_orch.transport import RpcTransport


FIXTURE = Path(__file__).with_name("fake_protocol_server.py")


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def local(self, mode="normal"):
        return Orchestrator.local(
            engine_command=[sys.executable, str(FIXTURE), "--mode", mode], request_timeout=1)

    @asynccontextmanager
    async def gate_transport(self):
        created = asyncio.Event()
        release = asyncio.Event()
        held = []
        jobs = []
        original = RpcTransport.stdio

        async def gated(*args, **kwargs):
            transport = await original(*args, **kwargs)
            held.append(transport)
            created.set()
            await release.wait()
            return transport

        with patch.object(RpcTransport, "stdio", side_effect=gated):
            try:
                yield created, release, held, jobs
            finally:
                release.set()
                for job in jobs:
                    if not job.done():
                        job.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
                for transport in held:
                    await transport.disconnect(terminate_owned=True)

    async def test_ac07_close_during_transport_creation_reaps_owned_process(self):
        orch = self.local()
        async with self.gate_transport() as (created, release, held, jobs):
            starting = asyncio.create_task(orch.start())
            jobs.append(starting)
            await asyncio.wait_for(created.wait(), 2)
            closing = asyncio.create_task(orch.close())
            jobs.append(closing)
            await asyncio.sleep(0)
            release.set()
            await asyncio.wait_for(asyncio.gather(starting, closing), 3)
            self.assertTrue(orch.closed)
            self.assertIsNotNone(held[0].process.returncode, "close returned with its owned host still alive")
            self.assertTrue(held[0]._reader_task.done(), "response reader leaked after close")
            self.assertTrue(held[0]._stderr_task.done(), "stderr reader leaked after close")

    async def test_ac07_cancel_start_after_transport_creation_reaps_process(self):
        orch = self.local()
        async with self.gate_transport() as (created, release, held, jobs):
            starting = asyncio.create_task(orch.start())
            jobs.append(starting)
            await asyncio.wait_for(created.wait(), 2)
            starting.cancel()
            await asyncio.sleep(0)
            starting.cancel()  # Repeated caller cancellation must not interrupt resource cleanup.
            closing = asyncio.create_task(orch.close())
            jobs.append(closing)
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(starting, 3)
            await asyncio.wait_for(closing, 3)
            self.assertIsNotNone(held[0].process.returncode, "cancelled startup lost the transport's process")
            self.assertTrue(held[0]._reader_task.done())
            self.assertTrue(held[0]._stderr_task.done())
            self.assertTrue(orch.closed)
            self.assertIsNone(orch.info, "cancelled startup must not accept business work")

    async def test_ac07_start_failure_and_concurrent_close_do_not_deadlock(self):
        orch = self.local("mismatch")
        async with self.gate_transport() as (created, release, held, jobs):
            starting = asyncio.create_task(orch.start())
            jobs.append(starting)
            await asyncio.wait_for(created.wait(), 2)
            closing = asyncio.create_task(orch.close())
            jobs.append(closing)
            await asyncio.sleep(0)
            release.set()
            outcomes = await asyncio.wait_for(asyncio.gather(starting, closing, return_exceptions=True), 3)
            self.assertIsInstance(outcomes[0], OrchestrationError)
            self.assertEqual(outcomes[0].code, "PROTOCOL_MISMATCH")
            self.assertIsNone(outcomes[1])
            self.assertIsNotNone(held[0].process.returncode)
            self.assertTrue(held[0]._reader_task.done())
            self.assertTrue(orch.closed)

    async def test_ac07_cancel_during_subprocess_creation_reaps_unassigned_process(self):
        orch = self.local()
        created = asyncio.Event()
        release = asyncio.Event()
        processes = []
        original = asyncio.create_subprocess_exec

        async def gated(*args, **kwargs):
            process = await original(*args, **kwargs)
            processes.append(process)
            created.set()
            await release.wait()
            return process

        with patch("agent_orch.transport.asyncio.create_subprocess_exec", side_effect=gated):
            starting = asyncio.create_task(orch.start())
            try:
                await asyncio.wait_for(created.wait(), 2)
                starting.cancel()
                await asyncio.sleep(0)
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(starting, 3)
                self.assertIsNotNone(processes[0].returncode, "cancelled spawn left an unassigned host alive")
                self.assertTrue(orch.closed)
            finally:
                release.set()
                if not starting.done():
                    starting.cancel()
                await asyncio.gather(starting, return_exceptions=True)
                if orch._transport is not None:
                    await orch._transport.disconnect(terminate_owned=True)
                for process in processes:
                    if process.stdin is not None:
                        process.stdin.close()
                    if process.returncode is None:
                        process.terminate()
                    await process.wait()


if __name__ == "__main__":
    unittest.main()
