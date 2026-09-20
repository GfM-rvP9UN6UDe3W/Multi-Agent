"""Independent stdio/socket protocol fixture. Never invokes a model."""
import argparse
import asyncio
import json
import sys


class Fixture:
    def __init__(self, mode):
        self.mode = mode
        self.tasks = {}
        self.operations = {}
        self.events = []
        self.creates = {}
        self.shutdown_attempts = 0
        self.drop_count = 0
        self.drop_ready = asyncio.Event()
        self.reconcile_calls = 0
        self.scheduler_calls = []
        self.scheduler_keys = {}
        self.conflict = {"id": "conflict-1", "revision": 2, "dispatchId": "dispatch-1",
                         "sessionId": "session-1", "taskId": "task-1", "generation": 1,
                         "status": "open", "releaseEvidenceRef": "sha256:old",
                         "conflictingEvidenceRef": "sha256:new", "createdAt": "2026-09-19T00:00:00Z"}

    def event(self, task_id, kind, data):
        cursor = str(len(self.events) + 1)
        self.events.append({"eventId": "e" + cursor, "cursor": cursor,
                            "storeId": "fixture-store", "schemaVersion": 1,
                            "type": kind, "taskId": task_id, "sessionId": "session-1",
                            "operationId": None, "occurredAt": "2026-09-19T00:00:00Z",
                            "data": data})

    def operation(self, method, params, result=None):
        scope = (params.get("conflictId") or params.get("approvalId") or params.get("taskId") or
                 params.get("target", {}).get("sessionId") or "local")
        op = {"id": "op-" + str(len(self.operations) + 1), "method": method,
              "scope": scope, "idempotencyKey": params.get("idempotencyKey", ""),
              "status": "completed", "targetId": params.get("taskId", "task-1"),
              "result": result, "error": None}
        self.operations[op["id"]] = op
        return op

    async def call(self, method, p):
        if method == "initialize":
            if self.mode == "die":
                raise EOFError()
            capabilities = {"storeNamespaces": {"version": 1}, "fake": {"resume": True, "interrupt": True}}
            if self.mode.startswith("lifecycle"):
                lifecycle = {"version": 1, "reconcile": "owner-attestation", "durableDeadlines": True}
                overrides = {
                    "lifecycle-version": {"version": 2},
                    "lifecycle-bool-version": {"version": True},
                    "lifecycle-method": {"reconcile": "automatic"},
                    "lifecycle-no-deadlines": {"durableDeadlines": False},
                    "lifecycle-numeric-deadlines": {"durableDeadlines": 1},
                }
                capabilities["lifecycle"] = {**lifecycle, **overrides.get(self.mode, {})}
            if self.mode.startswith("isolation"):
                isolation = {"version": 1, "resourceRelease": True, "schedulerStatus": True,
                             "ownerConflictResolution": True, "budgetVersion": 2}
                overrides = {
                    "isolation-version": {"version": 2},
                    "isolation-bool-version": {"version": True},
                    "isolation-release": {"resourceRelease": False},
                    "isolation-status": {"schedulerStatus": False},
                    "isolation-owner": {"ownerConflictResolution": False},
                    "isolation-budget": {"budgetVersion": 1},
                    "isolation-number-release": {"resourceRelease": 1},
                }
                capabilities["executionIsolation"] = {**isolation, **overrides.get(self.mode, {})}
            return {"protocolVersion": "99.0" if self.mode == "mismatch" else "2.0",
                    "engineVersion": "0.1.0", "schemaVersion": 1,
                    "instanceId": "fixture-instance", "storeId": "fixture-store",
                    "capabilities": capabilities}
        if method == "tasks.create":
            if self.mode == "drop-mutations":
                self.drop_count += 1
                if self.drop_count == 2:
                    self.drop_ready.set()
                await self.drop_ready.wait()
                raise EOFError()
            key = p["idempotencyKey"]
            if key in self.creates:
                if self.creates[key][0] != p["spec"]:
                    raise ValueError("IDEMPOTENCY_CONFLICT")
                return self.creates[key][1]
            task_id = "task-" + str(len(self.tasks) + 1)
            task = {"id": task_id, "status": "waiting_approval", "revision": 2,
                    "sessionId": "session-1", "spec": p["spec"], "artifactRefs": [],
                    "result": "fixture result", "reason": None, "approvalId": "approval-1",
                    "createdAt": "2026-09-19T00:00:00Z", "updatedAt": "2026-09-19T00:00:01Z"}
            self.tasks[task_id] = task
            self.creates[key] = (p["spec"], task)
            self.event(task_id, "approval.requested", {"approvalId": "approval-1", "revision": 1,
                "customPayload": {"someCustomKey": {"taskId": "must-not-rename"}}})
            if self.mode == "stderr-flood":
                sys.stderr.write("fixture-log\n" * 25000)
                sys.stderr.flush()
            return task
        if method == "tasks.get":
            if p["taskId"] == "hold":
                await asyncio.sleep(0.2)
                return {"id": "hold", "status": "running"}
            if p["taskId"] == "oversized":
                return {"id": "oversized", "result": "x" * (1024 * 1024)}
            if p["taskId"] not in self.tasks:
                raise ValueError("NOT_FOUND")
            return self.tasks[p["taskId"]]
        if method == "tasks.cancel":
            task = self.tasks[p["taskId"]]
            task["status"] = "cancelled"
            self.event(task["id"], "task.cancelled", {})
            return self.operation(method, p)
        if method == "tasks.resume":
            return self.operation(method, p)
        if method == "sessions.get":
            result = {"id": p["sessionId"], "taskId": "task-1", "provider": "fake",
                    "model": "fixture", "providerSessionId": "runtime-1", "generation": 1,
                    "revision": 2, "status": "idle", "activeDispatchId": None}
            if self.mode.startswith("isolation"):
                result["execution"] = {"dispatchId": "dispatch-1", "quarantined": True,
                    "lastEvidence": "runtime_terminal", "lease": {"version": 1, "status": "released",
                    "acquiredAt": "2026-09-19T00:00:00Z", "releasedAt": "2026-09-19T00:00:02Z",
                    "releaseReason": "terminal_and_cleanup", "releaseEvidenceRef": "sha256:stop"},
                    "budget": {"policyVersion": 2, "enteredAt": "2026-09-19T00:00:00Z",
                    "acceptanceDeadlineAt": "2026-09-19T00:00:30Z", "deadlineAt": "2026-09-19T00:30:00Z",
                    "effectiveAcceptanceMs": 30000, "effectiveTurnMs": 1800000,
                    "acceptanceSource": "host_default", "turnSource": "host_default"}}
            return result
        if method.startswith("scheduler."):
            self.scheduler_calls.append(method)
        if method == "scheduler.get":
            return {"maxActiveSessions": 2, "maxQuarantinedDispatches": 32, "executionOccupied": 1,
                    "quarantined": 2, "quarantineReserved": 1, "canDispatch": False,
                    "reasons": ["EXECUTION_EVIDENCE_CONFLICT"], "occupants": [{"taskId": "task-1",
                    "sessionId": "session-1", "dispatchId": "dispatch-1", "leaseStatus": "released",
                    "quarantined": True, "lastEvidence": "runtime_terminal", "enteredAt": "2026-09-19T00:00:00Z"}],
                    "truncated": False, "openConflicts": 1, "conflicts": [{"conflictId": "conflict-1",
                    "revision": 2, "dispatchId": "dispatch-1"}], "conflictsTruncated": False,
                    "customPayload": {"dispatchId": "preserve-original"}}
        if method == "scheduler.getConflict":
            if p != {"conflictId": "conflict-1"}:
                raise ValueError("NOT_FOUND")
            return self.conflict
        if method == "scheduler.resolveConflict":
            if p.pop("expectedStoreId", None) != "fixture-store":
                raise ValueError("STORE_NAMESPACE_MISMATCH")
            p.pop("requestDigest", None)
            if self.mode == "isolation-drop":
                raise EOFError()
            key = p["idempotencyKey"]
            if key in self.scheduler_keys:
                previous, op = self.scheduler_keys[key]
                if previous != p:
                    raise ValueError("IDEMPOTENCY_CONFLICT")
                return op
            if set(p) != {"conflictId", "expectedRevision", "evidence", "idempotencyKey"}:
                raise ValueError("VALIDATION_ERROR")
            if p["conflictId"] != "conflict-1" or p["expectedRevision"] != self.conflict["revision"]:
                raise ValueError("STALE_TARGET")
            if set(p["evidence"]) != {"source", "summary", "localResources", "remoteExecution", "sideEffects", "outcome"}:
                raise ValueError("VALIDATION_ERROR")
            op = self.operation(method, p, {"conflictId": "conflict-1", "executionReleased": True,
                                            "requestEcho": p, "customPayload": {"taskId": "raw"}})
            self.scheduler_keys[key] = (p, op)
            self.conflict = {**self.conflict, "revision": 3, "status": "resolved", "resolution": {
                "operationId": op["id"], "evidenceRef": "sha256:owner", "occurredAt": "2026-09-19T00:01:00Z"}}
            return op
        if method == "sessions.control":
            if p["target"]["expectedRevision"] != 2:
                raise ValueError("STALE_TARGET")
            return self.operation(method, p)
        if method == "sessions.reconcile":
            self.reconcile_calls += 1
            if self.mode == "lifecycle-drop":
                raise EOFError()
            required_target = {"sessionId", "expectedGeneration", "expectedRevision",
                               "expectedDispatchId", "expectedState"}
            required_evidence = {"source", "summary", "localResources", "remoteExecution",
                                 "sideEffects", "outcome"}
            if (set(p["target"]) != required_target or
                set(p["evidence"]) - {"result"} != required_evidence):
                raise ValueError("VALIDATION_ERROR")
            for op in self.operations.values():
                if op["method"] == method and op["idempotencyKey"] == p["idempotencyKey"]:
                    return op
            op = self.operation(method, p, {"requestEcho": p})
            op["lifecycle"] = {
                "enteredAt": "2026-09-19T00:00:00Z", "deadlineAt": "2026-09-19T00:01:00Z",
                "policyVersion": 1, "kind": "reconcile", "expectedGeneration": 1,
                "expectedDispatchId": "dispatch-1", "mayHaveBeenSent": False,
                "lastEvidence": "owner attestation", "expiredAt": "2026-09-19T00:01:01Z",
            }
            op["resolution"] = {"operationId": op["id"], "outcome": p["evidence"]["outcome"],
                                "occurredAt": "2026-09-19T00:00:01Z"}
            if self.mode == "lifecycle-pending":
                op["status"] = "persisted"
            return op
        if method == "messages.send":
            return {**p["spec"], "id": "message-1", "fromSessionId": "local",
                    "idempotencyKey": p["idempotencyKey"], "status": "persisted"}
        if method == "messages.get":
            return {"id": p["messageId"], "status": "persisted"}
        if method == "approvals.get":
            return {"approvalId": p["approvalId"], "taskId": "task-1", "purpose": "task_acceptance",
                    "revision": 1, "status": "pending", "target": {"taskId": "task-1", "taskRevision": 2},
                    "summary": "review fixture", "evidenceRefs": [], "expiresAt": "2099-01-01T00:00:00Z"}
        if method == "approvals.decide":
            if p["decision"]["expectedRevision"] != 1:
                raise ValueError("STALE_TARGET")
            task = self.tasks["task-1"]
            task["status"] = "completed" if p["decision"]["choice"] == "approve" else "failed"
            self.event(task["id"], "task." + task["status"], {})
            return self.operation(method, p)
        if method == "operations.get":
            return self.operations[p["operationId"]]
        if method == "operations.lookup":
            for op in self.operations.values():
                if all(op[k] == p[k] for k in ("method", "scope", "idempotencyKey")):
                    return op
            raise ValueError("NOT_FOUND")
        if method == "usage.get":
            return {"records": [{"taskId": p["taskId"], "dispatchId": "dispatch-1", "inputTokens": None,
                                  "cachedInputTokens": None, "cacheWriteInputTokens": None,
                                  "outputTokens": None, "raw": {"vendorCustomKey": {"taskId": "unchanged"}}}],
                    "completeness": "unknown"}
        if method == "events.read":
            if p.get("storeId", "fixture-store") != "fixture-store":
                raise ValueError("CURSOR_INVALID")
            cursor = int(p.get("afterCursor", "0"))
            events = [e for e in self.events if int(e["cursor"]) > cursor and
                      (p.get("taskId") is None or e["taskId"] == p["taskId"])][:p.get("limit", 128)]
            return {"events": events, "cursor": events[-1]["cursor"] if events else str(len(self.events)),
                    "storeId": "fixture-store"}
        if method == "capabilities.get":
            return {"provider": p.get("provider", "fake"), "resume": True, "compact": False,
                    "reconcileCalls": self.reconcile_calls, "schedulerCalls": self.scheduler_calls}
        if method.startswith("host.shutdown"):
            self.shutdown_attempts += 1
            if self.mode == "shutdown-timeout" and self.shutdown_attempts == 1:
                return {"__error__": {"code": "SHUTDOWN_INCOMPLETE", "operationId": "shutdown-1"}}
            return {"status": "closed", "operationId": p.get("operationId", "shutdown-1")}
        raise ValueError("UNSUPPORTED_CAPABILITY")


async def serve(reader, writer, fixture, owner):
    running = set()
    async def respond(frame):
        request = json.loads(frame)
        method = request["method"]
        try:
            if (method.startswith("host.shutdown") or method in {"sessions.reconcile", "scheduler.resolveConflict"}) and not owner:
                raise ValueError("UNAUTHORIZED")
            result = await fixture.call(method, request["params"])
            if "__error__" in result:
                response = {"jsonrpc": "2.0", "id": request["id"], "error": {
                    "code": -32000, "message": "shutdown is still running", "data": result["__error__"]}}
            else:
                response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except EOFError:
            writer.close()
            reader.feed_eof()
            return
        except (ValueError, KeyError) as error:
            response = {"jsonrpc": "2.0", "id": request["id"], "error": {
                "code": -32000, "message": str(error), "data": {"code": str(error)}}}
        writer.write((json.dumps(response) + "\n").encode())
        await writer.drain()
        if owner and method.startswith("host.shutdown") and "result" in response:
            writer.close()
            # Exit only this known fixture, after flushing its final response.
            asyncio.get_running_loop().call_later(0.01, lambda: reader.feed_eof())
    try:
        while frame := await reader.readline():
            job = asyncio.create_task(respond(frame))
            running.add(job)
            job.add_done_callback(running.discard)
        if running:
            await asyncio.gather(*running, return_exceptions=True)
    finally:
        writer.close()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="normal")
    parser.add_argument("--socket")
    args = parser.parse_args()
    fixture = Fixture(args.mode)
    if args.socket:
        server = await asyncio.start_unix_server(lambda r, w: serve(r, w, fixture, False), args.socket)
        print("READY", flush=True)
        async with server:
            await server.serve_forever()
    else:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=2 * 1024 * 1024)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
        writer = asyncio.StreamWriter(transport, protocol, reader, loop)
        await serve(reader, writer, fixture, True)


if __name__ == "__main__":
    asyncio.run(main())
