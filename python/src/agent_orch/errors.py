"""Stable client errors; transport failures never imply remote cancellation."""
from typing import Any


class OrchestrationError(Exception):
    def __init__(self, code: str, message: str, *, data: dict[str, Any] | None = None,
                 idempotency_key: str | None = None):
        super().__init__(message)
        self.code = code
        self.data = dict(data or {})
        self.idempotency_key = idempotency_key or self.data.get("idempotencyKey")
        self.retry_identity = self.data.get("retryIdentity")
        self.operation_id = self.data.get("operationId")
        self.method: str | None = self.data.get("method")
        self.scope: str | None = self.data.get("scope")


class ShutdownIncomplete(OrchestrationError):
    """The owner is still live. Continue close using client and operation_id."""
    def __init__(self, message: str, *, data: dict[str, Any] | None = None, client: Any = None):
        super().__init__("SHUTDOWN_INCOMPLETE", message, data=data)
        self.client = client


def unsupported(capability: str) -> OrchestrationError:
    return OrchestrationError("UNSUPPORTED_CAPABILITY", f"This increment does not implement {capability}")
