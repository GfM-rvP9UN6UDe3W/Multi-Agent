"""SPEC-0019 corrections to the SPEC-0018 routing layer through the Python SDK."""
import asyncio
from pathlib import Path
import re
import shutil
import socketserver
import tempfile
import threading
import time
import unittest

from agent_orch import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec
from agent_orch.routing import JevJudge, JudgeError, Router, RouteRuntime


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
WRITE = RuntimeSpec("fake-write", "w-default")
READ = RuntimeSpec("fake-read", "r-default")
RUNTIMES = {"read_only": RouteRuntime("fake-read", "r-default"), "writable": RouteRuntime("fake-write", "w-default")}
ACCEPT = AcceptanceSpec(criteria=["Review the result"])


class Judged:
    """A judge that answers from keywords in the descriptions it is shown, without normalizing."""

    def __init__(self, *, best=None, confidence=None, relevant=None, clash=None, depends=None, affects=None,
                 writes=0.9):
        self.best, self.confidence, self.writes = best or {}, confidence, writes
        self.maps = {"relevant": relevant or {}, "clash": clash or {}, "affects": affects or {}}
        self.depends = depends or {}
        self.requests = []

    async def evaluate(self, state, questions):
        self.requests.append({"state": state, "questions": questions})
        agents = state.get("agents", {})

        def lookup(mapping, alias):
            for keyword, value in mapping.items():
                if keyword in agents.get(alias, {}).get("description", ""):
                    return value
            return None

        answers = {}
        for question_id, question in questions.items():
            kind, _, alias = question_id.partition(".")
            if question["type"] == "choice":
                probabilities = {option: self.best.get("fresh", 0.0) if option == "fresh"
                                 else (lookup(self.best, option) or 0.0) for option in question["options"]}
                choice = max(probabilities, key=probabilities.get)
                answers[question_id] = {"type": "choice", "choice": choice, "probabilities": probabilities,
                                        "confidence": probabilities[choice] if self.confidence is None
                                        else self.confidence}
            elif question["type"] == "yesno":
                if kind in self.maps:
                    value = lookup(self.maps[kind], alias)
                    probability = 0.1 if value is None else value
                else:
                    probability = self.writes
                answers[question_id] = {"type": "yesno", "probability": probability}
            else:
                levels = (lookup(self.depends, alias) if kind == "depends" else None) or \
                    ([0.9, 0.1, 0.0] if kind == "depends" else [0.1, 0.8, 0.1])
                answers[question_id] = {"type": "score", "probabilities": list(levels), "confidence": max(levels)}
        return {"answers": answers, "model": "scripted"}


def codes(proposal):
    return [reason["code"] for reason in proposal.reasons]


def refs(proposal):
    return [ref["artifact_ref"] for ref in proposal.spec.context_plan["context_refs"]]


def goal_for(tag, size, filler):
    """A goal whose fake result ("Fake result: " + goal) has exactly `size` UTF-8 bytes."""
    head = f"{tag} "
    room = size - len("Fake result: ".encode()) - len(head.encode())
    width = len(filler.encode())
    return head + filler * (room // width) + "x" * (room % width)


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class RoutingCorrectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-routing-fix-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    def local(self, *extra):
        return Orchestrator.local(
            engine_command=[NODE, str(HOST), str(self.workspace), str(self.state), *extra],
            poll_interval=0.005, request_timeout=5)

    @staticmethod
    async def wait(orch, task_id, status):
        async with asyncio.timeout(5):
            while (task := await orch.tasks.get(task_id)).status != status:
                await asyncio.sleep(0.005)
        return task

    async def approve(self, orch, task_id):
        task = await self.wait(orch, task_id, "waiting_approval")
        approval = await orch.approvals.get(task.approval_id)
        await orch.approvals.decide(task.approval_id, {"choice": "approve", "expected_revision": approval.revision})
        return await self.wait(orch, task_id, "completed")

    async def child(self, orch, root_id, goal, runtime=WRITE, done=True):
        task = await orch.tasks.create(TaskSpec(goal, runtime, ACCEPT, parent_task_id=root_id,
                                                context_plan={"requested_mode": "fresh", "independent": True}))
        return await (self.approve(orch, task.id) if done else self.wait(orch, task.id, "waiting_approval"))

    async def groups(self, orch):
        """Group A under one root, and root B awaiting approval so its session could receive messages."""
        root_a = await orch.tasks.create(TaskSpec("Group A root for the payments product", WRITE, ACCEPT))
        await self.approve(orch, root_a.id)
        auth = await self.child(orch, root_a.id, "Refactor login to OAuth2 in src/auth")
        payments = await self.child(orch, root_a.id, "Fix refund rounding in src/payments", done=False)
        review = await self.child(orch, root_a.id, "Security review: the refund endpoint lacks a rate limit", READ)
        root_b = await orch.tasks.create(TaskSpec("Group B root for the marketing site", WRITE, ACCEPT))
        root_b = await self.wait(orch, root_b.id, "waiting_approval")
        return {"root_a": root_a.id, "root_b": root_b.id, "b": root_b.session_id, "auth": auth.session_id,
                "payments": payments.session_id, "payments_task": payments.id, "review": review.session_id,
                "members": [auth.session_id, payments.session_id, review.session_id]}

    @staticmethod
    async def message_events(orch, task_id):
        found = []
        try:
            async with asyncio.timeout(0.3):
                async for event in orch.events(task_id=task_id):
                    if event.type.startswith("message."):
                        found.append(event.type)
        except TimeoutError:
            pass
        return found

    async def test_0019_c01_python_confirmation_uses_the_judge_confidence(self):
        async with self.local() as orch:
            g = await self.groups(orch)

            async def route(members=None, **script):
                return await Router(orch, Judged(**script), **RUNTIMES).route(
                    "Work item", ACCEPT, g["members"] if members is None else members, root_task_id=g["root_a"],
                    needs_writes=True)

            low = await route(best={"OAuth2": 0.95, "fresh": 0.05}, confidence=0.2, relevant={"OAuth2": 0.9})
            self.assertEqual(low.decision, {"mode": "reuse", "session_id": g["auth"]})
            self.assertTrue(low.needs_confirmation, "the judge reported that it is unsure")
            self.assertIn("LOW_CONFIDENCE", codes(low))
            self.assertEqual((low.confidence, low.judge_confidence), (0.2, 0.2))

            filtered = await route(best={"rate limit": 0.5, "OAuth2": 0.45, "fresh": 0.05}, confidence=0.9,
                                   relevant={"rate limit": 0.9, "OAuth2": 0.8})
            self.assertEqual(filtered.decision, {"mode": "reuse", "session_id": g["auth"]})
            self.assertTrue(filtered.needs_confirmation, "the judge gave the proposed agent 0.45")
            self.assertEqual(filtered.confidence, 0.45)
            top = filtered.alternatives[0]
            self.assertEqual((top["option"], top["judge_probability"]), (g["auth"], 0.45))
            self.assertAlmostEqual(top["probability"], 0.9)

            at = await route(best={"OAuth2": 0.85, "fresh": 0.15}, confidence=0.85, relevant={"OAuth2": 0.9})
            self.assertFalse(at.needs_confirmation, "exactly at the threshold is confident")
            unsure = await route(best={"OAuth2": 0.85, "fresh": 0.15}, confidence=0.849, relevant={"OAuth2": 0.9})
            self.assertTrue(unsure.needs_confirmation)
            fresh = await route(best={"fresh": 0.9, "OAuth2": 0.1}, confidence=0.5)
            self.assertIn("FRESH_CHOSEN", codes(fresh))
            self.assertTrue(fresh.needs_confirmation)
            empty = await route(members=[])
            self.assertEqual((empty.confidence, empty.judge_confidence, empty.needs_confirmation), (1.0, None, False))
            # Confirmation stays the host's decision: submit does not refuse the proposal.
            self.assertEqual((await Router(orch, Judged(), **RUNTIMES).submit(low)).session_id, g["auth"])

    async def test_0019_c02_python_notifications_stay_in_the_source_group(self):
        async with self.local() as orch:
            g = await self.groups(orch)
            judge = Judged(affects={"rounding": 0.9, "marketing": 0.99})
            router = Router(orch, judge, **RUNTIMES)
            text = "Refunds are now rounded half-even."
            with self.assertRaises(Exception) as raised:
                await router.notifications(text, g["auth"], [g["auth"], g["b"]], root_task_id=g["root_b"])
            self.assertEqual(getattr(raised.exception, "code", None), "ROUTING_ROOT_MISMATCH")
            with self.assertRaises(Exception) as raised:
                await router.notifications(text, g["auth"], [g["payments"], g["review"]], root_task_id=g["root_a"])
            self.assertEqual(getattr(raised.exception, "code", None), "ROUTING_SOURCE_NOT_MEMBER")
            self.assertEqual(judge.requests, [], "a refused finding is never shown to the judge")
            self.assertEqual(await self.message_events(orch, g["root_b"]), [])

            for root_task_id in (None, g["root_a"]):
                plan = await router.notifications(text, g["auth"], [g["auth"], g["payments"], g["b"]],
                                                  root_task_id=root_task_id)
                self.assertEqual([target["session_id"] for target in plan.notify], [g["payments"]])
            sent = await router.notify(plan)
            self.assertEqual([(message.to_session_id, message.task_id, message.status) for message in sent],
                             [(g["payments"], g["payments_task"], "persisted")])
            self.assertEqual(await self.message_events(orch, g["root_b"]), [])

    async def test_0019_c02_python_engine_scope_notifies_other_roots(self):
        async with self.local("cross-root") as orch:
            g = await self.groups(orch)
            judge = Judged(affects={"marketing": 0.9})
            router = Router(orch, judge, scope="engine", **RUNTIMES)
            text = "The login page now links to the marketing site."
            plan = await router.notifications(text, g["auth"], [g["auth"], g["b"]])
            self.assertEqual([target["session_id"] for target in plan.notify], [g["b"]])
            [message] = await router.notify(plan)
            self.assertEqual((message.to_session_id, message.task_id, message.kind, message.status),
                             (g["b"], g["root_b"], "finding", "persisted"))
            asked = len(judge.requests)
            with self.assertRaises(Exception) as raised:
                await router.notifications(text, g["auth"], [g["b"]])
            self.assertEqual(getattr(raised.exception, "code", None), "ROUTING_SOURCE_NOT_MEMBER")
            self.assertEqual(len(judge.requests), asked)

    async def test_0019_c03_python_oversized_results_are_left_out(self):
        async with self.local() as orch:
            root = await orch.tasks.create(TaskSpec("Group root for context references", WRITE, ACCEPT))
            await self.approve(orch, root.id)
            made = {}
            for tag, size, filler in (("TAG-SMALL", 200, "s"), ("TAG-EXACT", 32768, "e"), ("TAG-OVER", 32769, "o"),
                                      ("TAG-WEXACT", 32768, "€"), ("TAG-WOVER", 32769, "€")):
                made[tag] = await self.child(orch, root.id, goal_for(tag, size, filler), READ)
                self.assertEqual(len(made[tag].result.encode()), size, "precondition: the intended result size")
            self.assertLess(len(made["TAG-WOVER"].result), 32768, "precondition: fewer characters than bytes")
            members = [made[tag].session_id for tag in ("TAG-OVER", "TAG-SMALL", "TAG-WOVER", "TAG-EXACT",
                                                        "TAG-WEXACT")]
            judge = Judged(best={"fresh": 0.95}, relevant={"TAG-OVER": 0.99, "TAG-SMALL": 0.98, "TAG-WOVER": 0.97,
                                                           "TAG-EXACT": 0.96, "TAG-WEXACT": 0.95})
            router = Router(orch, judge, describe=lambda candidate: candidate.task.spec.goal[:16], **RUNTIMES)
            proposal = await router.route("Summarize every report", ACCEPT, members, root_task_id=root.id,
                                          needs_writes=False)
            self.assertEqual(proposal.decision, {"mode": "fresh"})
            carried = [made[tag].artifact_refs[0] for tag in ("TAG-SMALL", "TAG-EXACT", "TAG-WEXACT")]
            self.assertEqual(refs(proposal), carried)
            self.assertEqual([reason["detail"] for reason in proposal.reasons if reason["code"] == "CONTEXT_OMITTED"],
                             [{"session_id": made[tag].session_id, "artifact_ref": made[tag].artifact_refs[0],
                               "reason": "too_large", "bytes": 32769, "max_bytes": 32768}
                              for tag in ("TAG-OVER", "TAG-WOVER")])
            self.assertFalse(proposal.needs_confirmation)
            created = await router.submit(proposal)
            admitted = await self.wait(orch, created.id, "waiting_approval")
            self.assertEqual([ref["artifactRef"] for ref in admitted.spec.context_plan.context_refs], carried)


REPLY = (b'{"model": "jev-1.13.0", "answers": {"w": {"type": "noul", "noul": 0.9}}}' + b" " * 600)
QUESTIONS = {"w": {"type": "yesno", "instructions": "Writes?"}}


class SlowJev:
    """A loopback server that answers each request piece by piece and records whether the client left.

    A reply is ``(status, body, head_delay, head_step, body_step, interval)``: after ``head_delay`` seconds the
    status line and headers go out ``head_step`` bytes at a time (0: at once), then the body ``body_step`` bytes at
    a time, with ``interval`` seconds between pieces.
    """

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = 0
        self.outcomes = []
        self.changed = threading.Condition()
        outer = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = self.request.recv(65536)
                    if not chunk:
                        return
                    data += chunk
                head, _, body = data.partition(b"\r\n\r\n")
                length = int(re.search(rb"(?i)content-length:\s*(\d+)", head).group(1))
                while len(body) < length:
                    chunk = self.request.recv(65536)
                    if not chunk:
                        return
                    body += chunk
                with outer.changed:
                    outer.requests += 1
                    reply = outer.replies[min(outer.requests, len(outer.replies)) - 1]
                status, payload, head_delay, head_step, body_step, interval = reply
                header = (f"HTTP/1.1 {status} {'OK' if status == 200 else 'Unavailable'}\r\n"
                          f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
                          "Connection: close\r\n\r\n").encode()
                try:
                    time.sleep(head_delay)
                    for part, step in ((header, head_step), (payload, body_step)):
                        step = step or len(part) or 1
                        for start in range(0, len(part), step):
                            self.request.sendall(part[start:start + step])
                            if step < len(part):
                                time.sleep(interval)
                    outcome = "completed"
                except OSError:
                    outcome = "disconnected"
                with outer.changed:
                    outer.outcomes.append(outcome)
                    outer.changed.notify_all()

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def outcome(self, index, timeout):
        """The outcome of request ``index``, or None if it is still being answered after ``timeout`` seconds."""
        with self.changed:
            self.changed.wait_for(lambda: len(self.outcomes) > index, timeout)
            return self.outcomes[index] if len(self.outcomes) > index else None

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class JevDeadlineTests(unittest.IsolatedAsyncioTestCase):
    """``timeout_ms`` bounds one whole evaluation, and an abandoned request does not keep reading."""

    def serve(self, *replies):
        server = SlowJev(replies)
        self.addCleanup(server.stop)
        return server

    async def assert_times_out(self, server, timeout_ms, within):
        started = time.monotonic()
        with self.assertRaises(JudgeError) as raised:
            await JevJudge("synthetic", base_url=server.url, timeout_ms=timeout_ms).evaluate({}, QUESTIONS)
        elapsed = time.monotonic() - started
        self.assertEqual(raised.exception.code, "JUDGE_TIMEOUT")
        self.assertLess(elapsed, within, f"a {timeout_ms} ms deadline took {elapsed:.3f} s")

    async def test_0019_c04_python_slow_body_cannot_extend_the_deadline(self):
        server = self.serve((200, REPLY, 0, 0, 10, 0.025))
        await self.assert_times_out(server, 100, 0.5)
        self.assertEqual(server.outcome(0, 1.0), "disconnected", "the client stopped reading")

    async def test_0019_c04_python_slow_headers_cannot_extend_the_deadline(self):
        server = self.serve((200, REPLY, 0, 1, 0, 0.02))
        await self.assert_times_out(server, 150, 0.6)
        self.assertEqual(server.outcome(0, 1.0), "disconnected")

    async def test_0019_c04_python_late_headers_time_out(self):
        server = self.serve((200, REPLY, 1.0, 0, 0, 0))
        await self.assert_times_out(server, 150, 0.6)

    async def test_0019_c04_python_the_retry_shares_the_deadline(self):
        server = self.serve((503, b"{}", 0, 0, 0, 0), (200, REPLY, 0, 0, 10, 0.025))
        await self.assert_times_out(server, 300, 0.8)
        self.assertEqual(server.requests, 2)
        self.assertEqual(server.outcome(1, 1.0), "disconnected")

    async def test_0019_c04_python_cancellation_stops_the_request(self):
        server = self.serve((200, REPLY, 0, 0, 10, 0.025))
        judge = JevJudge("synthetic", base_url=server.url, timeout_ms=10_000)
        task = asyncio.create_task(judge.evaluate({}, QUESTIONS))
        await asyncio.sleep(0.15)
        cancelled = time.monotonic()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertLess(time.monotonic() - cancelled, 0.2)
        self.assertEqual(server.outcome(0, 1.0), "disconnected", "the cancelled request stopped reading")

    async def test_0019_c04_python_the_request_stops_at_its_deadline_while_the_loop_is_busy(self):
        server = self.serve((200, REPLY, 0, 0, 10, 0.025))
        task = asyncio.create_task(JevJudge("synthetic", base_url=server.url, timeout_ms=100).evaluate({}, QUESTIONS))
        await asyncio.sleep(0)  # The request starts on its own thread.
        time.sleep(0.6)  # Meanwhile the event loop cannot enforce the deadline.
        self.assertEqual(server.outcome(0, 0), "disconnected", "the request stopped reading by itself")
        with self.assertRaises(JudgeError) as raised:
            await task
        self.assertEqual(raised.exception.code, "JUDGE_TIMEOUT")

    async def test_0019_c04_python_a_slow_answer_within_the_deadline_succeeds(self):
        server = self.serve((200, REPLY, 0, 0, 40, 0.01))
        result = await JevJudge("synthetic", base_url=server.url, timeout_ms=5000).evaluate({}, QUESTIONS)
        self.assertEqual(result["answers"], {"w": {"type": "yesno", "probability": 0.9}})
        self.assertEqual(server.outcome(0, 1.0), "completed")


if __name__ == "__main__":
    unittest.main()
