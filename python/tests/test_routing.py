"""SPEC-0018 routing layer through the Python SDK against the real Node host."""
import asyncio
import http.server
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest

from orchvia import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec
from orchvia.routing import JevJudge, JudgeError, Router, RouteRuntime, RoutingPolicy


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
WRITE = RuntimeSpec("fake-write", "w-default")
READ = RuntimeSpec("fake-read", "r-default")
LADDERS = {"read_only": RouteRuntime("fake-read", "r-default", small="r-small", large="r-large"),
           "writable": RouteRuntime("fake-write", "w-default", small="w-small", large="w-large")}
ACCEPT = AcceptanceSpec(criteria=["Review the result"])


class Scripted:
    """A judge that answers from keywords in the agent descriptions it is shown."""

    def __init__(self, **script):
        self.script = script
        self.requests = []

    async def evaluate(self, state, questions):
        self.requests.append({"state": state, "questions": questions})
        agents = state.get("agents", {})

        def lookup(mapping, alias):
            for keyword, value in (mapping or {}).items():
                if keyword in agents.get(alias, {}).get("description", ""):
                    return value
            return None

        answers = {}
        for question_id, question in questions.items():
            kind, _, alias = question_id.partition(".")
            if question["type"] == "choice":
                best = self.script.get("best", {})
                raw = {option: best.get("fresh", 0) if option == "fresh" else (lookup(best, option) or 0)
                       for option in question["options"]}
                total = sum(raw.values()) or 1
                probabilities = {option: value / total for option, value in raw.items()}
                choice = max(probabilities, key=probabilities.get)
                answers[question_id] = {"type": "choice", "choice": choice, "probabilities": probabilities,
                                        "confidence": probabilities[choice]}
            elif question["type"] == "yesno":
                if kind in ("relevant", "clash", "affects"):
                    value = lookup(self.script.get(kind), alias)
                    value = 0.1 if value is None else value
                else:
                    value = self.script.get("writes", 0.9)
                answers[question_id] = {"type": "yesno", "probability": value}
            else:
                levels = lookup(self.script.get("depends"), alias) if kind == "depends" else None
                levels = levels or ([0.9, 0.1, 0.0] if kind == "depends" else self.script.get("size", [0.1, 0.8, 0.1]))
                answers[question_id] = {"type": "score", "probabilities": list(levels), "confidence": max(levels)}
        return {"answers": answers, "model": "scripted"}


class Failing:
    async def evaluate(self, state, questions):
        raise JudgeError("JUDGE_UNAVAILABLE", "down")


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class RoutingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-routing-", dir=str(Path("/tmp").resolve()))
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

    async def group(self, orch):
        root = await orch.tasks.create(TaskSpec("Group root for the payments product", WRITE, ACCEPT))
        await self.approve(orch, root.id)

        async def child(goal, runtime):
            return await orch.tasks.create(TaskSpec(goal, runtime, ACCEPT, parent_task_id=root.id,
                                                    context_plan={"requested_mode": "fresh", "independent": True}))

        auth = await child("Refactor login to OAuth2 in src/auth", WRITE)
        await self.approve(orch, auth.id)
        payments = await child("Fix refund rounding in src/payments", WRITE)
        await self.wait(orch, payments.id, "waiting_approval")
        review = await child("Security review: the refund endpoint lacks a rate limit", READ)
        await self.approve(orch, review.id)
        other = await orch.tasks.create(TaskSpec("Unrelated marketing site copy", WRITE, ACCEPT))
        await self.approve(orch, other.id)
        return {"root": root.id, "auth": auth.session_id, "payments": payments.session_id,
                "review": review.session_id, "other": other.session_id, "payments_task": payments.id,
                "auth_task": auth.id, "review_task": review.id,
                "members": [auth.session_id, payments.session_id, review.session_id]}

    @staticmethod
    async def count(orch):
        total, cursor = 0, None
        while True:
            page = await orch.tasks.list(limit=100, after_cursor=cursor)
            total += len(page.tasks)
            cursor = page.next_cursor
            if not cursor:
                return total

    async def test_0018_r09_python_router_follows_the_policy_table(self):
        async with self.local() as orch:
            g = await self.group(orch)

            async def route(needs_writes=True, **script):
                router = Router(orch, Scripted(**script), **LADDERS)
                return await router.route("Work item", ACCEPT, g["members"], root_task_id=g["root"],
                                          needs_writes=needs_writes)

            before = await self.count(orch)
            idle = await route(best={"OAuth2": 0.9, "fresh": 0.1}, relevant={"OAuth2": 0.9})
            self.assertEqual(await self.count(orch), before)
            self.assertEqual(idle.decision, {"mode": "reuse", "session_id": g["auth"]})
            self.assertEqual(idle.spec.parent_task_id, g["root"])

            clash = await route(best={"rounding": 0.9, "fresh": 0.1}, relevant={"rounding": 0.9},
                                clash={"rounding": 0.8})
            self.assertEqual(clash.decision, {"mode": "reuse", "session_id": g["payments"]})
            self.assertEqual(clash.spec.context_plan["max_queue_wait_ms"], 20 * 60_000)
            self.assertEqual(clash.spec.context_plan["fallback_modes"], ["fresh"])

            essential = await route(best={"rounding": 0.9, "fresh": 0.1}, relevant={"rounding": 0.9},
                                    depends={"rounding": [0.0, 0.2, 0.8]})
            self.assertEqual(essential.spec.context_plan["fallback_modes"], [])

            parallel = await route(best={"rounding": 0.9, "fresh": 0.1}, relevant={"rounding": 0.9},
                                   depends={"rounding": [0.8, 0.2, 0.0]}, clash={"rounding": 0.1})
            self.assertEqual(parallel.decision, {"mode": "fresh"})
            payments = await orch.tasks.get(g["payments_task"])
            self.assertEqual([ref["artifact_ref"] for ref in parallel.spec.context_plan["context_refs"]],
                             [payments.artifact_refs[0]])

            unrelated = await route(best={"OAuth2": 0.6, "fresh": 0.4})
            self.assertEqual(unrelated.decision, {"mode": "fresh"})
            self.assertIn("NO_RELEVANT_AGENT", [reason["code"] for reason in unrelated.reasons])

            writes = await route(best={"rate limit": 0.7, "OAuth2": 0.2, "fresh": 0.1},
                                 relevant={"rate limit": 0.9, "OAuth2": 0.8})
            self.assertEqual(writes.decision, {"mode": "reuse", "session_id": g["auth"]})
            self.assertNotIn(g["review"], [alternative["option"] for alternative in writes.alternatives])

            small = await route(needs_writes=None, best={"fresh": 0.9}, writes=0.05, size=[0.9, 0.1, 0.0])
            self.assertEqual((small.spec.runtime.provider, small.spec.runtime.model), ("fake-read", "r-small"))
            large = await route(needs_writes=None, best={"fresh": 0.9}, writes=0.95, size=[0.0, 0.2, 0.8])
            self.assertEqual((large.spec.runtime.provider, large.spec.runtime.model), ("fake-write", "w-large"))

            shell = await orch.tasks.create(TaskSpec(
                "Build the app shell in app/", RuntimeSpec("fake-write", "w-small"), ACCEPT, parent_task_id=g["root"],
                write_scope="app", context_plan={"requested_mode": "fresh", "independent": True}))
            await self.approve(orch, shell.id)
            kept = await Router(orch, Scripted(best={"app shell": 0.95, "fresh": 0.05}, relevant={"app shell": 0.9}),
                                **LADDERS).route("Work item", ACCEPT, [shell.session_id], root_task_id=g["root"],
                                                 needs_writes=True)
            self.assertEqual((kept.spec.runtime.model, kept.spec.write_scope), ("w-small", "app"))
            self.assertEqual((await Router(orch, Scripted(), **LADDERS).submit(kept)).session_id, shell.session_id)

            fresh = await route(needs_writes=False, best={"fresh": 0.9, "OAuth2": 0.1},
                                relevant={"OAuth2": 0.75, "rate limit": 0.95, "rounding": 0.4})
            auth = await orch.tasks.get(g["auth_task"])
            review = await orch.tasks.get(g["review_task"])
            self.assertEqual([ref["artifact_ref"] for ref in fresh.spec.context_plan["context_refs"]],
                             [review.artifact_refs[0], auth.artifact_refs[0]])
            created = await Router(orch, Scripted(), **LADDERS).submit(fresh)
            self.assertNotIn(created.session_id, g["members"])
            # Submitted last: reusing an agent makes this request its latest task and description.
            submitted = await Router(orch, Scripted(), **LADDERS).submit(idle)
            self.assertEqual(submitted.session_id, g["auth"])

    async def test_0018_r09_python_uncertain_and_failing_judges(self):
        async with self.local() as orch:
            g = await self.group(orch)
            request = dict(goal="Work item", acceptance=ACCEPT, members=g["members"], root_task_id=g["root"])
            low = await Router(orch, Scripted(best={"OAuth2": 0.6, "fresh": 0.4}, relevant={"OAuth2": 0.9}),
                               **LADDERS).route(**request, needs_writes=True)
            self.assertTrue(low.needs_confirmation)
            self.assertEqual([alternative["option"] for alternative in low.alternatives],
                             [g["auth"], "fresh", g["payments"]])
            unsure = await Router(orch, Scripted(best={"OAuth2": 0.95, "fresh": 0.05}, relevant={"OAuth2": 0.9},
                                                 writes=0.5), **LADDERS).route(**request)
            self.assertIn("WRITES_UNCERTAIN", [reason["code"] for reason in unsure.reasons])

            fallback = await Router(orch, Failing(), **LADDERS).route(**request, needs_writes=True)
            self.assertEqual(fallback.decision, {"mode": "fresh"})
            self.assertEqual(fallback.spec.context_plan["context_refs"], [])
            self.assertEqual((fallback.spec.runtime.provider, fallback.spec.runtime.model), ("fake-write", "w-default"))
            self.assertTrue(fallback.needs_confirmation)
            self.assertEqual(fallback.judge, {"unavailable": "JUDGE_UNAVAILABLE"})

            class Partial:
                async def evaluate(self, state, questions):
                    return {"answers": {}}

            broken = await Router(orch, Partial(), policy=RoutingPolicy(on_judge_failure="fresh"),
                                  **LADDERS).route(**request, needs_writes=True)
            self.assertEqual(broken.judge, {"unavailable": "JUDGE_PROTOCOL"})
            self.assertFalse(broken.needs_confirmation)

    async def test_0018_r09_python_findings_reach_only_affected_agents(self):
        async with self.local() as orch:
            g = await self.group(orch)
            judge = Scripted(affects={"rounding": 0.85, "rate limit": 0.6, "marketing": 0.99})
            router = Router(orch, judge, **LADDERS)
            plan = await router.notifications("The auth API now returns 401 for expired tokens.", g["auth"],
                                              [*g["members"], g["other"]], root_task_id=g["root"])
            self.assertEqual([target["session_id"] for target in plan.notify], [g["payments"]])
            self.assertEqual(plan.confirm, [])
            self.assertEqual([target["session_id"] for target in plan.follow_up], [g["review"]])
            text = json.dumps(judge.requests[0])
            self.assertNotIn("Refactor login", text)
            self.assertNotIn("marketing", text)
            sent = await router.notify(plan)
            message = await orch.messages.get(sent[0].id)
            self.assertEqual((message.to_session_id, message.kind, message.status),
                             (g["payments"], "finding", "persisted"))

    async def test_0018_r09_python_engine_scope_crosses_roots_only_when_allowed(self):
        async with self.local("cross-root") as orch:
            g = await self.group(orch)
            router = Router(orch, Scripted(best={"marketing": 0.95, "fresh": 0.05}, relevant={"marketing": 0.9}),
                            scope="engine", **LADDERS)
            proposal = await router.route("Tighten the landing page copy", ACCEPT, [*g["members"], g["other"]],
                                          needs_writes=True)
            self.assertEqual(proposal.decision, {"mode": "reuse", "session_id": g["other"]})
            self.assertEqual((await router.submit(proposal)).session_id, g["other"])
        self.state = Path(self.temp.name) / "state-2"
        self.state.mkdir()
        async with self.local() as orch:
            g = await self.group(orch)
            router = Router(orch, Scripted(best={"marketing": 0.95, "fresh": 0.05}, relevant={"marketing": 0.9}),
                            scope="engine", **LADDERS)
            proposal = await router.route("Tighten the landing page copy", ACCEPT, [g["other"], g["auth"]],
                                          needs_writes=True)
            with self.assertRaises(OrchestrationError) as raised:
                await router.submit(proposal)
            self.assertEqual(raised.exception.code, "HISTORY_REUSE_FORBIDDEN")


class FakeJev(http.server.ThreadingHTTPServer):
    """A local stand-in for TypeSafe's API that records requests and replays scripted responses."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
                outer.requests.append((self.path, self.headers.get("authorization"), body))
                status, payload, delay = outer.replies[min(len(outer.requests), len(outer.replies)) - 1]
                if delay:
                    threading.Event().wait(delay)
                data = json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

            def log_message(self, *args):
                pass

        super().__init__(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"

    def stop(self):
        self.shutdown()
        self.server_close()


QUESTIONS = {
    "best": {"type": "choice", "instructions": "Pick one", "options": {"A1": "first", "fresh": None}},
    "w": {"type": "yesno", "instructions": "Writes?"},
    "s": {"type": "score", "instructions": "Size?", "levels": ["small", "medium", "large"]},
}
JEV_ANSWERS = {
    "best": {"type": "choice", "choice": "A1", "probabilities": {"A1": 0.8, "fresh": 0.2}, "confidence": 0.7},
    "w": {"type": "noul", "noul": 0.25},
    "s": {"type": "score", "score": 1.1, "legend": {}, "probabilities": {"0": 0.1, "1": 0.7, "2": 0.2},
          "confidence": 0.6},
}


class JevJudgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_0018_r09_python_jev_request_mapping(self):
        server = FakeJev([(200, {"model": "jev-1.13.0", "answers": JEV_ANSWERS,
                                 "usage": {"input_tokens": 42, "output_tokens": 7}}, 0)])
        self.addCleanup(server.stop)
        result = await JevJudge("test-key", base_url=server.url).evaluate({"request": "x"}, QUESTIONS)
        path, auth, body = server.requests[0]
        self.assertEqual((path, auth), ("/v1/systemone", "Bearer test-key"))
        self.assertEqual(body, {"state": {"request": "x"}, "model": "jev-1.13.0", "questions": {
            "best": {"type": "choice", "instructions": "Pick one", "criteria": {"A1": "first", "fresh": None}},
            "w": {"type": "noul", "instructions": "Writes?"},
            "s": {"type": "score", "instructions": "Size?", "criteria": ["small", "medium", "large"]}}})
        self.assertEqual(result["answers"], {
            "best": {"type": "choice", "choice": "A1", "probabilities": {"A1": 0.8, "fresh": 0.2}, "confidence": 0.7},
            "w": {"type": "yesno", "probability": 0.25},
            "s": {"type": "score", "probabilities": [0.1, 0.7, 0.2], "confidence": 0.6}})
        self.assertEqual((result["model"], result["usage"]), ("jev-1.13.0", {"input_tokens": 42, "output_tokens": 7}))

    async def test_0018_r09_python_jev_retries_and_errors(self):
        ok = (200, {"model": "jev-1.13.0", "answers": JEV_ANSWERS}, 0)
        cases = [([(401, {}, 0)], "JUDGE_AUTH", 1), ([(422, {}, 0)], "JUDGE_INVALID_REQUEST", 1),
                 ([(503, {}, 0), ok], None, 2), ([(529, {}, 0), (529, {}, 0)], "JUDGE_UNAVAILABLE", 2),
                 ([(429, {}, 0), (429, {}, 0)], "JUDGE_RATE_LIMITED", 2),
                 ([(200, {"answers": {"best": JEV_ANSWERS["best"]}}, 0)], "JUDGE_PROTOCOL", 1),
                 ([(200, {"answers": JEV_ANSWERS}, 0.5)], "JUDGE_TIMEOUT", 1)]
        for replies, code, calls in cases:
            server = FakeJev(replies)
            try:
                judge = JevJudge("k", base_url=server.url, timeout_ms=200 if code == "JUDGE_TIMEOUT" else 5000)
                if code:
                    with self.assertRaises(JudgeError) as raised:
                        await judge.evaluate({}, QUESTIONS)
                    self.assertEqual(raised.exception.code, code)
                else:
                    await judge.evaluate({}, QUESTIONS)
                self.assertEqual(len(server.requests), calls, str(replies))
            finally:
                server.stop()


if __name__ == "__main__":
    unittest.main()
