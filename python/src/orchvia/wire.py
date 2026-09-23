"""Runtime validation for the generated wire schema; no third-party dependency."""
import json
import math
import re
from importlib.resources import files
from typing import Any
from .errors import OrchestrationError

_DOCUMENT = json.loads(files(__package__).joinpath("protocol.schema.json").read_text(encoding="utf-8"))
_KEYWORDS = {"$schema", "$id", "$defs", "$ref", "title", "description", "default", "format", "type",
             "required", "properties", "additionalProperties", "items", "enum", "const", "minimum",
             "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "allOf", "oneOf",
             "if", "then", "else", "not"}


def _reference(reference: str) -> dict[str, Any]:
    if not reference.startswith("#/$defs/") or "/" in reference[8:]:
        raise ValueError(f"Unsupported schema reference: {reference}")
    return _DOCUMENT["$defs"][reference[8:].replace("~1", "/").replace("~0", "~")]


def _audit(schema: dict[str, Any]) -> None:
    if not isinstance(schema, dict) or set(schema) - _KEYWORDS:
        raise ValueError("Unsupported schema keyword")
    if "$ref" in schema:
        _reference(schema["$ref"])
    for group in ("$defs", "properties"):
        for child in schema.get(group, {}).values():
            _audit(child)
    for group in ("allOf", "oneOf"):
        for child in schema.get(group, []):
            _audit(child)
    for key in ("items", "if", "then", "else", "not"):
        if key in schema:
            _audit(schema[key])
    extra = schema.get("additionalProperties", True)
    if isinstance(extra, dict):
        _audit(extra)
    elif not isinstance(extra, bool):
        raise ValueError("Unsupported additionalProperties value")
    if "pattern" in schema:
        re.compile(schema["pattern"])


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    return a == b


def _check(schema: dict[str, Any], value: Any, path: str) -> list[str]:
    errors: list[str] = []
    def require(ok: bool, rule: str) -> None:
        if not ok:
            errors.append(f"{path}: {rule}")
    if "$ref" in schema:
        errors.extend(_check(_reference(schema["$ref"]), value, path))
    number = isinstance(value, (int, float)) and not isinstance(value, bool)
    if "type" in schema:
        allowed = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        matches = {"object": isinstance(value, dict), "array": isinstance(value, list),
                   "string": isinstance(value, str), "boolean": isinstance(value, bool), "null": value is None,
                   "number": number and (not isinstance(value, float) or math.isfinite(value)),
                   "integer": number and (isinstance(value, int) or value.is_integer())}
        require(any(matches.get(kind, False) for kind in allowed), "type " + "|".join(allowed))
    if "const" in schema:
        require(_same(value, schema["const"]), "const")
    if "enum" in schema:
        require(any(_same(value, candidate) for candidate in schema["enum"]), "enum")
    if number:
        for key, ok in (("minimum", lambda n: value >= n), ("maximum", lambda n: value <= n)):
            if key in schema:
                require(ok(schema[key]), key)
    if isinstance(value, str):
        if "minLength" in schema:
            require(len(value) >= schema["minLength"], "minLength")
        if "maxLength" in schema:
            require(len(value) <= schema["maxLength"], "maxLength")
        if "pattern" in schema:
            require(re.search(schema["pattern"], value) is not None, "pattern")
    if isinstance(value, list):
        if "minItems" in schema:
            require(len(value) >= schema["minItems"], "minItems")
        if "maxItems" in schema:
            require(len(value) <= schema["maxItems"], "maxItems")
        if "items" in schema:
            for index, item in enumerate(value):
                errors.extend(_check(schema["items"], item, f"{path}[{index}]"))
    if isinstance(value, dict):
        for key in schema.get("required", []):
            require(key in value, "required " + key)
        for key, item in value.items():
            if key in schema.get("properties", {}):
                errors.extend(_check(schema["properties"][key], item, path + "." + key))
            elif schema.get("additionalProperties") is False:
                require(False, "additional property " + key)
            elif isinstance(schema.get("additionalProperties"), dict):
                errors.extend(_check(schema["additionalProperties"], item, path + "." + key))
    for child in schema.get("allOf", []):
        errors.extend(_check(child, value, path))
    if "oneOf" in schema:
        require(sum(not _check(child, value, path) for child in schema["oneOf"]) == 1, "oneOf")
    if "not" in schema:
        require(bool(_check(schema["not"], value, path)), "not")
    if "if" in schema:
        branch = schema.get("then") if not _check(schema["if"], value, path) else schema.get("else")
        if branch is not None:
            errors.extend(_check(branch, value, path))
    return errors


_audit(_DOCUMENT)


def validate_wire(name: str, value: Any) -> None:
    """Validate camelCase JSON data. Raises INVALID_WIRE_DATA before caller submission."""
    errors = _check(_reference("#/$defs/" + name), value, name)
    if errors:
        raise OrchestrationError("INVALID_WIRE_DATA", "\n".join(errors[:32]))
