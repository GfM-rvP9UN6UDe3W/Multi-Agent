"""Internal Python path for the explicitly authorized native harness. Never ordinary tests."""
import asyncio
import json
import os
from pathlib import Path
import sys
from agent_orch import Orchestrator, TaskSpec, RuntimeSpec, AcceptanceSpec
from agent_orch.types import to_wire


async def main():
    config, provider, model, goal = sys.argv[1:]
    cli = Path(__file__).resolve().parents[1] / "packages/cli/src/main.ts"
    client = await Orchestrator.local(engine_command=[os.environ["ORCH_NATIVE_NODE"], str(cli),
        "host", "--stdio", "--config", config], close_timeout=10)
    try:
        task = await client.tasks.create(TaskSpec(goal=goal, runtime=RuntimeSpec(provider, model),
            acceptance=AcceptanceSpec(criteria=["Review exact native output and usage"])))
        async with asyncio.timeout(125):
            while True:
                current = await client.tasks.get(task.id)
                if current.status in {"waiting_approval", "blocked", "paused", "failed", "cancelled", "completed"}:
                    break
                await asyncio.sleep(0.1)
        return {"task": to_wire(current), "session": to_wire(await client.sessions.get(current.session_id)),
                "usage": to_wire(await client.usage.get(task.id)), "costs": to_wire(await client.costs.get(task.id)),
                "scheduler": to_wire(await client.scheduler.get())}
    finally:
        await client.close(mode="interrupt", timeout=10)


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main())))
