"""SPEC-0020 context.checkRefs and the router that uses it, through the Python SDK and a real host."""
import asyncio
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from agent_orch import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec
from agent_orch.routing import Router, RouteRuntime
from agent_orch.types import snapshot


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
WRITE = RuntimeSpec("fake-write", "w-default")
READ = RuntimeSpec("fake-read", "r-default")
RUNTIMES = {"read_only": RouteRuntime("fake-read", "r-default"), "writable": RouteRuntime("fake-write", "w-default")}
ACCEPT = AcceptanceSpec(criteria=["Review the result"])
UNKNOWN = "sha256:" + "0" * 64


def goal_for(tag, size, filler):
    """A goal whose fake result ("Fake result: " + goal) has exactly `size` UTF-8 bytes."""
    head = f"{tag} "
    room = size - len("Fake result: ".encode()) - len(head.encode())
    width = len(filler.encode())
    return head + filler * (room // width) + "x" * (room % width)


class Relevant:
    """A judge that always starts a fresh session and finds the tagged agents relevant."""

    def __init__(self, relevant):
        self.relevant = relevant

    async def evaluate(self, state, questions):
        agents = state.get("agents", {})
        answers = {}
        for question_id, question in questions.items():
            alias = question_id.partition(".")[2]
            if question["type"] == "choice":
                probabilities = {option: 0.95 if option == "fresh" else 0.0 for option in question["options"]}
                answers[question_id] = {"type": "choice", "choice": "fresh", "probabilities": probabilities,
                                        "confidence": 0.95}
            elif question["type"] == "yesno":
                description = agents.get(alias, {}).get("description", "")
                hits = [value for tag, value in self.relevant.items() if tag in description]
                answers[question_id] = {"type": "yesno", "probability": hits[0] if hits else 0.1}
            else:
                answers[question_id] = {"type": "score", "probabilities": [0.1, 0.8, 0.1], "confidence": 0.8}
        return {"answers": answers}


class Legacy:
    """The orchestrator as seen through a host that does not offer context.checkRefs."""

    def __init__(self, orch, context=None):
        self._orch = orch
        self._context = context

    def __getattr__(self, name):
        if name == "context" and self._context is not None:
            return self._context
        return getattr(self._orch, name)

    @property
    def info(self):
        return snapshot({"capabilities": {"workflow": {"version": 1}}}) if self._context is None else self._orch.info


class Refusing:
    async def check_refs(self, context_refs):
        raise OrchestrationError("TRANSPORT_CLOSED", "host went away")


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class ContextCheckTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-context-check-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
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

    async def root(self, orch):
        return await self.approve(orch, (await orch.tasks.create(TaskSpec("Group root", WRITE, ACCEPT))).id)

    async def child(self, orch, root_id, goal):
        task = await orch.tasks.create(TaskSpec(goal, READ, ACCEPT, parent_task_id=root_id,
                                                context_plan={"requested_mode": "fresh", "independent": True}))
        return await self.approve(orch, task.id)

    def damage(self, artifact_ref):
        path = self.state / "artifacts" / f"{artifact_ref[len('sha256:'):]}.txt"
        os.chmod(path, 0o600)
        path.write_text("damaged on disk")

    async def test_0020_k01_python_check_refs_reports_what_admission_would_do(self):
        async with self.local() as orch:
            root = await self.root(orch)
            exact = await self.child(orch, root.id, goal_for("TAG-EXACT", 32768, "e"))
            wide = await self.child(orch, root.id, goal_for("TAG-WIDE", 32769, "€"))
            damaged = await self.child(orch, root.id, "TAG-DAMAGED notes")
            self.damage(damaged.artifact_refs[0])
            refs = [exact.artifact_refs[0], wide.artifact_refs[0], damaged.artifact_refs[0], UNKNOWN]
            checked = await orch.context.check_refs([{"artifact_ref": ref, "version": 1} for ref in refs])
            self.assertEqual(checked.context_refs, [
                {"artifactRef": refs[0], "admissible": True, "bytes": 32768},
                {"artifactRef": refs[1], "admissible": False, "code": "ARTIFACT_TOO_LARGE", "bytes": 32769},
                {"artifactRef": refs[2], "admissible": False, "code": "ARTIFACT_CORRUPT",
                 "bytes": len(damaged.result.encode())},
                {"artifactRef": refs[3], "admissible": False, "code": "NOT_FOUND"},
            ])
            self.assertTrue(orch.info.capabilities.workflow.get("context_check"))
            with self.assertRaises(OrchestrationError) as raised:
                await orch.context.check_refs([])
            self.assertEqual(raised.exception.code, "VALIDATION_ERROR")

    async def test_0020_k05_python_router_leaves_out_damaged_results(self):
        async with self.local() as orch:
            root = await self.root(orch)
            damaged = await self.child(orch, root.id, "TAG-DAMAGED notes")
            kept = await self.child(orch, root.id, "TAG-KEPT notes")
            self.damage(damaged.artifact_refs[0])
            router = Router(orch, Relevant({"TAG-DAMAGED": 0.99, "TAG-KEPT": 0.9}),
                            describe=lambda candidate: candidate.task.spec.goal[:16], **RUNTIMES)
            proposal = await router.route("Summarize the notes", ACCEPT, [damaged.session_id, kept.session_id],
                                          root_task_id=root.id, needs_writes=False)
            self.assertEqual([ref["artifact_ref"] for ref in proposal.spec.context_plan["context_refs"]],
                             [kept.artifact_refs[0]])
            self.assertEqual([reason["detail"] for reason in proposal.reasons if reason["code"] == "CONTEXT_OMITTED"],
                             [{"session_id": damaged.session_id, "artifact_ref": damaged.artifact_refs[0],
                               "reason": "corrupt", "code": "ARTIFACT_CORRUPT",
                               "bytes": len(damaged.result.encode())}])
            self.assertFalse(proposal.needs_confirmation)
            created = await router.submit(proposal)
            admitted = await self.wait(orch, created.id, "waiting_approval")
            self.assertEqual([ref["artifactRef"] for ref in admitted.spec.context_plan.context_refs],
                             [kept.artifact_refs[0]])

    async def test_0020_k06_python_router_without_the_capability_says_it_did_not_check(self):
        async with self.local() as orch:
            root = await self.root(orch)
            kept = await self.child(orch, root.id, "TAG-KEPT notes")
            request = dict(goal="Summarize the notes", acceptance=ACCEPT, members=[kept.session_id],
                           root_task_id=root.id, needs_writes=False)
            judge = Relevant({"TAG-KEPT": 0.9})
            proposal = await Router(Legacy(orch), judge, **RUNTIMES).route(**request)
            self.assertEqual([ref["artifact_ref"] for ref in proposal.spec.context_plan["context_refs"]],
                             [kept.artifact_refs[0]])
            self.assertEqual([reason["detail"] for reason in proposal.reasons if reason["code"] == "CONTEXT_UNCHECKED"],
                             [{"count": 1}])
            self.assertFalse(proposal.needs_confirmation)
            with self.assertRaises(OrchestrationError) as raised:
                await Router(Legacy(orch, context=Refusing()), judge, **RUNTIMES).route(**request)
            self.assertEqual(raised.exception.code, "TRANSPORT_CLOSED")


if __name__ == "__main__":
    unittest.main()
