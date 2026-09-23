"""Offline parity example: registered checks, dependencies and fixed snapshots."""
import asyncio
import json
from pathlib import Path
import shutil
import tempfile

from orchvia import CheckAcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec

ROOT = Path(__file__).resolve().parents[2]


async def main():
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 22.18+ is required")
    with tempfile.TemporaryDirectory(prefix="orch-checks-example-") as directory:
        base = Path(directory).resolve()
        workspace, state = base / "work", base / "state"
        workspace.mkdir()
        state.mkdir()
        config = base / "host.json"
        config.write_text(json.dumps({
            "workspace": str(workspace), "stateDir": str(state),
            "providers": {"fake": {"model": "fixture"}},
            "storage": {"emergencyBytes": 4096, "minFreeBytes": 0},
            "verificationRules": [{"id": "fixture", "version": "1",
                "argv": [node, "-e", 'console.log("fixture verified")'],
                "cwdRelative": ".", "timeoutMs": 1000,
                "permissionProfile": "read-only", "success": {"exitCode": 0}}],
        }), encoding="utf-8")
        orch = await Orchestrator.local(engine_command=[node, str(ROOT / "packages/cli/src/main.ts"),
            "host", "--stdio", "--config", str(config)], close_timeout=3)
        try:
            common = {"goal": "Produce deterministic offline output",
                "runtime": RuntimeSpec("fake", "fixture"),
                "acceptance": CheckAcceptanceSpec(rule_refs=[{"id": "fixture", "version": "1"}])}
            parent = await orch.tasks.create(TaskSpec(**common))
            child = await orch.tasks.create(TaskSpec(**common, parent_task_id=parent.id,
                dependency_task_ids=[parent.id], context_plan={
                    "requested_mode": "fresh", "independent": True,
                    "dependency_task_ids": [parent.id], "context_refs": [],
                    "fallback_modes": [], "max_queue_wait_ms": 30000}))
            for task in (parent, child):
                done = await task.wait(timeout=5)
                if done.status != "completed":
                    raise RuntimeError(f"Fixture acceptance failed: {done.status}")
            snapshot = await orch.state.snapshot(limit=8)
            try:
                page, items = snapshot, len(snapshot["items"])
                while not page.done:
                    page = await orch.state.snapshot(snapshot_id=snapshot.snapshot_id,
                        offset=page.next_offset, limit=8)
                    items += len(page["items"])
                print(json.dumps({"language": "python", "completed": 2,
                    "snapshotItems": items, "modelCalls": 0}))
            finally:
                await orch.state.release_snapshot(snapshot.snapshot_id)
        finally:
            await orch.close(mode="interrupt", timeout=3)


if __name__ == "__main__":
    asyncio.run(main())
