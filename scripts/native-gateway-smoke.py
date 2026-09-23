"""Python client of the real-binary, scripted-loopback verification host."""
import asyncio
import json
import sys
from orchvia import Orchestrator, TaskSpec, RuntimeSpec, AcceptanceSpec
from orchvia.types import to_wire


async def main():
    socket, provider, model = sys.argv[1:]
    client = Orchestrator.connect(socket_path=socket)
    try:
        task = await client.tasks.create(TaskSpec(
            goal="ORCH_NATIVE_GATEWAY_PYTHON: return ORCH_NATIVE_GATEWAY_OK",
            runtime=RuntimeSpec(provider, model),
            acceptance=AcceptanceSpec(criteria=["Exact scripted native result"]),
        ))
        async with asyncio.timeout(65):
            while True:
                pending = await task.get()
                if pending.status == "waiting_approval":
                    break
                assert pending.status not in {"failed", "blocked", "paused", "cancelled"}, to_wire(pending)
                await asyncio.sleep(0.025)
        assert pending.result == "ORCH_NATIVE_GATEWAY_OK"
        approval = await client.approvals.get(pending.approval_id)
        await client.approvals.decide(approval.approval_id, {"choice": "approve", "expected_revision": approval.revision})
        done = await task.wait(timeout=5)
        assert done.status == "completed"
        inspected = await client.sessions.inspect(done.session_id)
        assert inspected.status == "found"
        assert inspected.execution == "unknown"
        return {"status": done.status, "inspection": inspected.status,
                "usage": to_wire(await client.usage.get(task.id))}
    finally:
        await client.close()


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main())))
