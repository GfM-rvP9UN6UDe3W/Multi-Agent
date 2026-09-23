"""Fatal decoder failures fail every pending call without waiting for its timeout."""
import asyncio
import json
import sys
import unittest
from unittest.mock import patch

from orchvia import OrchestrationError
from orchvia.transport import MAX_FRAME_BYTES, RpcTransport


class WriterFixture:
    def __init__(self):
        self.closed = False

    def write(self, data):
        pass

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass


class DecoderFailureTests(unittest.IsolatedAsyncioTestCase):
    async def assert_fatal_decode_failure(self, value):
        reader = asyncio.StreamReader(limit=MAX_FRAME_BYTES + 1)
        writer = WriterFixture()
        transport = RpcTransport(reader, writer, request_timeout=5)
        pending = [asyncio.create_task(transport.request("tasks.get", {"taskId": task_id}))
                   for task_id in ("first", "second")]
        try:
            await asyncio.sleep(0)
            frame = b'{"jsonrpc":"2.0","id":1,"result":' + value + b'}\n'
            self.assertLess(len(frame), MAX_FRAME_BYTES)
            reader.feed_data(frame)
            # A parser failure must terminate both calls now, not at their 5 s deadlines.
            outcomes = await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), 0.25)
            self.assertTrue(all(isinstance(error, OrchestrationError) for error in outcomes))
            self.assertEqual([error.code for error in outcomes], ["PROTOCOL_ERROR", "PROTOCOL_ERROR"])
            self.assertIsNot(outcomes[0], outcomes[1], "pending calls must not share a mutable error")
            self.assertTrue(writer.closed)
            self.assertEqual(transport._failure.code, "PROTOCOL_ERROR")
            self.assertTrue(transport._reader_task.done())
            self.assertIsNone(transport._reader_task.exception())
        finally:
            await transport.disconnect()
            await asyncio.gather(*pending, return_exceptions=True)

    async def test_ac11_large_integer_decode_fails_all_pending_immediately(self):
        original_limit = sys.get_int_max_str_digits()
        sys.set_int_max_str_digits(4300)
        try:
            await self.assert_fatal_decode_failure(b"1" * 5000)
        finally:
            sys.set_int_max_str_digits(original_limit)

    async def test_ac11_deep_json_decode_fails_all_pending_immediately(self):
        depth = sys.getrecursionlimit() + 100
        value = b"[" * depth + b"0" + b"]" * depth
        # Python 3.14's C scanner may accept this depth. Use the stdlib Python
        # scanner so the decoder's RecursionError path is reproducible on 3.11+.
        decoder = json.JSONDecoder()
        decoder.scan_once = json.scanner.py_make_scanner(decoder)
        with self.assertRaises(RecursionError):
            decoder.decode(value.decode())
        with patch("orchvia.transport.json.loads", side_effect=decoder.decode):
            await self.assert_fatal_decode_failure(value)


if __name__ == "__main__":
    unittest.main()
