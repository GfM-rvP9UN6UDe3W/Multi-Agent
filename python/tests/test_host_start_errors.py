"""SPEC-0023 E: when an owned host ends before it answers, the error says why."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

from orchvia import OrchestrationError, Orchestrator


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
NODE = shutil.which("node")
REASON = '{"code":"INVALID_CONFIG","message":"no provider"}'


def host(script: str) -> list[str]:
    return [sys.executable, "-c", script]


class HostStartErrorTests(unittest.IsolatedAsyncioTestCase):
    async def start_error(self, command: list[str], **options) -> OrchestrationError:
        with self.assertRaises(OrchestrationError) as caught:
            await Orchestrator.local(engine_command=command, close_timeout=3, **options)
        return caught.exception

    async def test_0023_e01_the_host_error_output_ends_the_message(self):
        error = await self.start_error(host(
            f"import sys; sys.stderr.write({REASON!r} + '\\n'); sys.exit(1)"))
        self.assertEqual(error.code, "CONNECTION_CLOSED")
        self.assertTrue(str(error).rstrip().endswith(REASON), str(error))
        self.assertEqual(error.data["stderrTail"].strip(), REASON)

    async def test_0023_e01_a_host_without_error_output_keeps_the_error(self):
        error = await self.start_error(host("import sys; sys.exit(1)"))
        self.assertEqual(error.code, "CONNECTION_CLOSED")
        self.assertNotIn("stderrTail", error.data)
        self.assertNotIn("error output", str(error))

    @unittest.skipUnless(NODE and CLI.is_file(), "requires Node.js 22.18+ and the local host source")
    async def test_0023_e01_a_real_host_with_an_invalid_configuration(self):
        with tempfile.TemporaryDirectory(prefix="orchvia-start-error-") as directory:
            base = Path(directory).resolve()
            (base / "work").mkdir()
            (base / "state").mkdir(mode=0o700)
            config = base / "orchestrator.json"
            config.write_text(json.dumps({"workspace": str(base / "work"),
                                          "stateDir": str(base / "state"), "providers": {}}))
            error = await self.start_error([NODE, str(CLI), "host", "--stdio", "--config", str(config)])
        self.assertEqual(error.code, "CONNECTION_CLOSED")
        self.assertIn("INVALID_CONFIG", str(error))
        self.assertIn("Configure at least one provider explicitly", error.data["stderrTail"])

    async def test_0023_e02_the_last_line_of_a_long_error_output_is_kept(self):
        error = await self.start_error(host(
            "import sys\n"
            "for index in range(4000): sys.stderr.write(f'line {index:05} of an error report\\n')\n"
            "sys.stderr.write('LAST LINE\\n'); sys.exit(1)"))
        self.assertTrue(error.data["stderrTail"].endswith("LAST LINE\n"), error.data["stderrTail"][-80:])
        self.assertLessEqual(len(error.data["stderrTail"].encode()), 16 * 1024)

    async def test_0023_e02_error_output_written_just_after_the_host_exits_is_kept(self):
        # A leftover process of the host writes the last line 0.3 seconds after the host exited.
        late = "import sys, time; time.sleep(0.3); sys.stderr.write('LATE LINE\\n')"
        error = await self.start_error(host(
            "import subprocess, sys\n"
            f"subprocess.Popen([sys.executable, '-c', {late!r}],\n"
            "                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)\n"
            f"sys.stderr.write({REASON!r} + '\\n'); sys.stderr.flush(); sys.exit(1)"))
        self.assertTrue(error.data["stderrTail"].endswith("LATE LINE\n"), error.data["stderrTail"])

    async def test_0023_e02_an_error_output_held_open_by_a_leftover_process_is_waited_for_at_most_one_second(self):
        # The host leaves a child that keeps its error output, but not its standard output, open for
        # 10 seconds, then exits.
        started = time.monotonic()
        error = await self.start_error(host(
            "import subprocess, sys\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'],\n"
            "                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)\n"
            f"sys.stderr.write({REASON!r} + '\\n'); sys.stderr.flush(); sys.exit(1)"))
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn(REASON, error.data["stderrTail"])

    async def test_0023_e03_a_start_fails_promptly_when_the_host_exits_but_its_output_stays_open(self):
        # A process that the host left behind holds its standard output, not its error output.
        started = time.monotonic()
        error = await self.start_error(host(
            "import subprocess, sys\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'],\n"
            "                 stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
            f"sys.stderr.write({REASON!r} + '\\n'); sys.stderr.flush(); sys.exit(1)"))
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(error.code, "CONNECTION_CLOSED")
        self.assertIn(REASON, error.data["stderrTail"])

    async def test_0023_e03_a_pending_request_fails_promptly_when_the_host_exits_but_its_output_stays_open(self):
        # The host answers initialize, leaves a process holding its standard output and exits
        # while the next request waits for its answer.
        answer = {"protocolVersion": "2.0", "engineVersion": "fixture", "schemaVersion": 1,
                  "instanceId": "fixture", "storeId": "fixture-store",
                  "capabilities": {"storeNamespaces": {"version": 1}}}
        script = (
            "import json, subprocess, sys\n"
            "request = json.loads(sys.stdin.readline())\n"
            f"sys.stdout.write(json.dumps({{'jsonrpc': '2.0', 'id': request['id'], 'result': {answer!r}}}) + '\\n')\n"
            "sys.stdout.flush()\n"
            "sys.stdin.readline()\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'],\n"
            "                 stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
            "sys.exit(0)")
        orch = await Orchestrator.local(engine_command=host(script), close_timeout=3)
        started = time.monotonic()
        with self.assertRaises(OrchestrationError) as caught:
            await orch.tasks.get("task-that-never-answers")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(caught.exception.code, "CONNECTION_CLOSED")
        # The host is gone, so there is nothing to shut down; drop the failed connection.
        await orch.disconnect()

    @unittest.skipUnless(Path("/dev/fd").is_dir(), "lists open file descriptors through /dev/fd")
    async def test_0023_e02_a_leftover_process_does_not_keep_the_sdk_pipes_open(self):
        # A process that the host left behind holds both of its outputs for 10 seconds.
        before = set(os.listdir("/dev/fd"))
        error = await self.start_error(host(
            "import subprocess, sys\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'],\n"
            "                 stdin=subprocess.DEVNULL)\n"
            f"sys.stderr.write({REASON!r} + '\\n'); sys.stderr.flush(); sys.exit(1)"))
        self.assertEqual(error.code, "CONNECTION_CLOSED")
        self.assertEqual(set(os.listdir("/dev/fd")) - before, set())
    async def test_0023_e02_disconnect_leaves_a_host_that_still_runs_to_finish(self):
        # After its input ends, the host needs 3 seconds to finish, longer than the SDK waits for it.
        answer = {"protocolVersion": "2.0", "engineVersion": "fixture", "schemaVersion": 1,
                  "instanceId": "fixture", "storeId": "fixture-store",
                  "capabilities": {"storeNamespaces": {"version": 1}}}
        with tempfile.TemporaryDirectory(prefix="orchvia-disconnect-") as directory:
            marker = Path(directory) / "finished"
            script = (
                "import json, sys, time\n"
                "request = json.loads(sys.stdin.readline())\n"
                f"sys.stdout.write(json.dumps({{'jsonrpc': '2.0', 'id': request['id'], 'result': {answer!r}}}) + '\\n')\n"
                "sys.stdout.flush()\n"
                "sys.stdin.read()\n"
                "time.sleep(3)\n"
                f"open({str(marker)!r}, 'w').close()")
            orch = await Orchestrator.local(engine_command=host(script), close_timeout=3)
            await orch.disconnect()
            deadline = time.monotonic() + 6
            while not marker.exists() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            self.assertTrue(marker.exists(), "the host was stopped before it finished")


if __name__ == "__main__":
    unittest.main()
