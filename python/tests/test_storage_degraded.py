"""Actual SQLite full -> Node owner shutdown error -> Python process cleanup."""
import shutil
import tempfile
from pathlib import Path
import unittest

from agent_orch import Orchestrator, OrchestrationError

ROOT = Path(__file__).resolve().parents[2]


class StorageDegradedTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_storage_closes_stdio_owner_without_faking_a_receipt(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "The actual Node host is required")
        with tempfile.TemporaryDirectory(prefix="orch-py-full-") as directory:
            root = Path(directory).resolve()
            work = root / "work"
            work.mkdir()
            client = await Orchestrator.local(engine_command=[node,
                str(ROOT / "tests/fixtures/storage-full-owner.ts"), str(work),
                str(root / "state"), "after_send", "--stdio"], close_timeout=2)
            try:
                with self.assertRaises(OrchestrationError) as raised:
                    await client.close(mode="interrupt", timeout=2)
                self.assertEqual(raised.exception.code, "STORAGE_DEGRADED_CLOSED")
                self.assertFalse(raised.exception.data["durableReceipt"])
                self.assertTrue(client._closed, "A completed resource shutdown must retire the client")
                self.assertEqual(client._transport.process.returncode, 0, "The Node owner must exit normally")
                await client.close()
            finally:
                await client.disconnect()
