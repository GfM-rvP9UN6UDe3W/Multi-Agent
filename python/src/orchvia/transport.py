"""Bounded JSON-RPC transport. Reads replies independently of event consumers."""
import asyncio
from collections.abc import Mapping, Sequence
import json
from typing import Any

from .errors import OrchestrationError, ShutdownIncomplete


MAX_FRAME_BYTES = 1024 * 1024
MAX_PENDING_REQUESTS = 64
MAX_STDERR_BYTES = 16 * 1024


class RpcTransport:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, *,
                 process: asyncio.subprocess.Process | None = None, request_timeout: float = 30.0):
        self.reader = reader
        self.writer = writer
        self.process = process
        self.request_timeout = request_timeout
        self.pending: dict[int, asyncio.Future[Any]] = {}
        self._next_id = 0
        self._failure: OrchestrationError | None = None
        self._closed = False
        self._stderr = bytearray()
        self._reader_task = asyncio.create_task(self._read_loop(), name="orchvia-replies")
        self._stderr_task = (asyncio.create_task(self._read_stderr(), name="orchvia-stderr")
                             if process is not None else None)

    @classmethod
    async def stdio(cls, command: Sequence[str], *, env: Mapping[str, str] | None,
                    request_timeout: float) -> "RpcTransport":
        try:
            process = await asyncio.create_subprocess_exec(
                *command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=MAX_FRAME_BYTES + 1, env=env)
        except (OSError, ValueError) as error:
            raise OrchestrationError("ENGINE_NOT_FOUND", "Cannot start the configured engine executable") from error
        assert process.stdout is not None and process.stdin is not None
        return cls(process.stdout, process.stdin, process=process, request_timeout=request_timeout)

    @classmethod
    async def unix(cls, path: str, *, request_timeout: float) -> "RpcTransport":
        try:
            reader, writer = await asyncio.open_unix_connection(path, limit=MAX_FRAME_BYTES + 1)
        except OSError as error:
            raise OrchestrationError("CONNECTION_CLOSED", "Cannot connect to the configured local socket") from error
        return cls(reader, writer, request_timeout=request_timeout)

    @property
    def stderr_tail(self) -> str:
        return self._stderr.decode("utf-8", errors="replace")

    async def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        try:
            while chunk := await self.process.stderr.read(4096):
                self._stderr.extend(chunk)
                if len(self._stderr) > MAX_STDERR_BYTES:
                    del self._stderr[:-MAX_STDERR_BYTES]
        except (OSError, asyncio.CancelledError):
            return

    def _fail(self, error: OrchestrationError) -> None:
        self._failure = error
        for future in self.pending.values():
            if not future.done():
                # Each in-flight operation attaches its own recovery key.
                future.set_exception(OrchestrationError(error.code, str(error), data=error.data))

    async def _read_loop(self) -> None:
        try:
            while True:
                try:
                    frame = await self.reader.readuntil(b"\n")
                except asyncio.LimitOverrunError:
                    raise OrchestrationError("FRAME_TOO_LARGE", "Engine response exceeds 1 MiB") from None
                except asyncio.IncompleteReadError as error:
                    code = "PROTOCOL_ERROR" if error.partial else "CONNECTION_CLOSED"
                    raise OrchestrationError(code, "Engine connection ended before the next complete response") from None
                if len(frame) - 1 > MAX_FRAME_BYTES:
                    raise OrchestrationError("FRAME_TOO_LARGE", "Engine response exceeds 1 MiB")
                try:
                    response = json.loads(frame.decode("utf-8"))
                except (ValueError, RecursionError):
                    # ValueError also covers UnicodeDecodeError, JSONDecodeError and
                    # Python's integer digit limit. A within-size frame can still
                    # exceed decoder depth/number limits; fail the entire connection.
                    raise OrchestrationError("PROTOCOL_ERROR", "Engine sent invalid or unsupported UTF-8 JSON") from None
                if (not isinstance(response, dict) or response.get("jsonrpc") != "2.0" or
                    type(response.get("id")) is not int or
                    ("result" in response) == ("error" in response)):
                    raise OrchestrationError("PROTOCOL_ERROR", "Engine sent an invalid response envelope")
                future = self.pending.get(response["id"])
                if future is None or future.done():
                    continue  # A late response to a locally cancelled/timed-out request.
                if "error" in response:
                    wire_error = response["error"]
                    if not isinstance(wire_error, dict):
                        raise OrchestrationError("PROTOCOL_ERROR", "Invalid error envelope")
                    data = wire_error.get("data", {})
                    if not isinstance(data, dict):
                        data = {}
                    code = data.get("code", "RPC_ERROR")
                    message = str(wire_error.get("message", code))
                    error = (ShutdownIncomplete(message, data=data) if code == "SHUTDOWN_INCOMPLETE"
                             else OrchestrationError(str(code), message, data=data))
                    future.set_exception(error)
                else:
                    future.set_result(response["result"])
        except asyncio.CancelledError:
            return
        except OrchestrationError as error:
            self._fail(error)
            self.writer.close()
        except (OSError, ConnectionError) as error:
            self._fail(OrchestrationError("CONNECTION_CLOSED", str(error)))

    async def request(self, method: str, params: dict[str, Any], *,
                      timeout: float | None = None) -> Any:
        if self._failure is not None:
            # Do not mutate a shared error when attaching request-specific keys later.
            raise OrchestrationError(self._failure.code, str(self._failure), data=self._failure.data)
        if self._closed:
            raise OrchestrationError("CONNECTION_CLOSED", "Client connection is closed")
        if len(self.pending) >= MAX_PENDING_REQUESTS:
            raise OrchestrationError("REQUEST_LIMIT_EXCEEDED", "At most 64 requests may be pending")
        self._next_id += 1
        request_id = self._next_id
        try:
            frame = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
                               ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError, UnicodeEncodeError) as error:
            raise OrchestrationError("VALIDATION_ERROR", "Request must contain JSON-serializable values") from error
        if len(frame) > MAX_FRAME_BYTES:
            raise OrchestrationError("FRAME_TOO_LARGE", "Request exceeds 1 MiB")
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            async with asyncio.timeout(self.request_timeout if timeout is None else timeout):
                self.writer.write(frame + b"\n")
                await self.writer.drain()
                return await future
        except TimeoutError:
            raise OrchestrationError("TIMEOUT", "Local request wait timed out; remote execution was not cancelled") from None
        except (OSError, ConnectionError) as error:
            raise OrchestrationError("CONNECTION_CLOSED", "Engine connection was lost") from error
        finally:
            self.pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()  # Also consume errors if drain failed before awaiting the reply.

    async def disconnect(self, *, terminate_owned: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        self._fail(OrchestrationError("CONNECTION_CLOSED", "Client connection is closed"))
        self.writer.close()
        try:
            await asyncio.wait_for(self.writer.wait_closed(), 1.0)
        except (OSError, NotImplementedError, TimeoutError):
            pass
        if self.process is not None:
            try:
                await asyncio.wait_for(self.process.wait(), 2.0)
            except TimeoutError:
                if terminate_owned and self.process.returncode is None:
                    self.process.terminate()
                    try:
                        await asyncio.wait_for(self.process.wait(), 2.0)
                    except TimeoutError:
                        self.process.kill()
                        await self.process.wait()
        tasks = [self._reader_task]
        if self._stderr_task is not None:
            tasks.append(self._stderr_task)
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
