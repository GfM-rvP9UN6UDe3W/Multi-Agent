"""Versioned cross-language immutable request identity."""
import hashlib
import json
import math
import struct
from typing import Any


def _normalize(value: Any) -> str:
    if value is None:
        return "z"
    if isinstance(value, bool):
        return "t" if value else "f"
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("Only finite JSON numbers are supported")
        return "n" + struct.pack(">d", number if number != 0 else 0.0).hex()
    if isinstance(value, str):
        return "s" + json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_normalize(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(_normalize(key) + ":" + _normalize(value[key])
                              for key in sorted(value, key=lambda key: key.encode("utf-8"))) + "}"
    raise TypeError("Expected JSON data")


def request_digest(method: str, params: dict[str, Any]) -> str:
    payload = {key: value for key, value in params.items()
               if key not in {"expectedStoreId", "idempotencyKey", "requestDigest"}}
    normalized = "agent-orch-request-v1:" + _normalize({"method": method, "payload": payload})
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
