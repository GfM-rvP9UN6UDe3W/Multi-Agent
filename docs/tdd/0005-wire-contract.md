# SPEC-0005 verification record

Date: 2026-09-20. Continue from R04's 217 Node / 44 Python baseline. This increment changed client guidance, public schema, and offline contract tests only, without production engine/adapter/SDK changes or new dependencies. Counts below retain the history of each increment.

## RED

First define SPEC-0005 AC-W01..W05, then add tests and a restricted schema helper while leaving protocol.schema.json unchanged. Run:

```sh
node --test tests/contract/protocol-schema.test.ts
```

Actual **5 pass / 7 fail / 0 skipped**, 12 counted tests including the parent. Four actual-payload checks failed because TaskSnapshot, ApprovalRequest, MessageSnapshot, and UsageRecord definitions were missing. Negative/compatibility checks and schema validation of Python output were blocked by those missing definitions, and the parent failed accordingly. Actual OperationSnapshot, SessionSnapshot, SchedulerSnapshot, and EventEnvelope output plus helper-constraint tests passed.

During RED, the Python subprocess had already completed actual socket queries, known-field access, raw JSON checks, and equality assertions against TypeScript before its schema check encountered the missing definitions. Typecheck passed. RED was not caused by syntax, compilation, network permissions, or incorrect mock construction.

## GREEN and coverage

After adding the four definitions, the same file passed **12/12**. Tests use the actual Engine, SQLite, and Unix RPC in temporary directories, with a real independent Python subprocess. Explicit deterministic fake runtime and known injected usage avoid model requests.

- Tasks: actual creation, waiting-for-human-approval, and approved-but-paused mailbox snapshots; result/approvalId/reason cover null and non-null values.
- Approvals: actual pending/approved requests, including nested target/revision/artifactRefs.
- Messages: host-added id/fromSessionId/idempotencyKey/status. Pausing keeps mailbox state stable throughout cross-language reads.
- Usage: reported integers, zero, unknown null, and original provider JSON. raw intentionally contains input_tokens, inputTokens, and nested task_id; Python attribute conversion must preserve those original keys.
- Operations: an actual human-approval receipt, preserving raw result.taskId/choice and nullable error. Also validate actual SessionSnapshot, SchedulerSnapshot, and EventEnvelope.
- Negative cases: remove every required field from five snapshot types; corrupt status/purpose/kind, nested runtime/approval target, array elements, nonnegative integers/safe limits, nullable boundaries, and operation error/lifecycle. All must fail.
- Compatibility: optional message artifactRefs can be omitted; output snapshots allow future fields; result/raw retain arbitrary JSON. MessageSpec still rejects server-only output fields and unsupported control messages.
- Cross-language: Python reads five stable snapshot categories from the same host, checks snake_case access and raw result/raw keys, converts known fields back to wire form for exact comparison with TypeScript, then validates that output with the same schema. Hand-built successful objects or definition-name assertions do not replace actual output.

The helper supports the document's local $ref, type, required/properties/additionalProperties, enum/const, arrays, numeric/length/pattern bounds, allOf/oneOf, and conditional/not constraints. Unsupported assertion keywords or unresolved references fail initialization, including unused definitions. Self-tests cover conditional composition, simultaneous oneOf matches, extra properties, Unicode code-point length, array bounds, and invalid elements.

format uses draft 2020-12 default annotation semantics without date-format assertions. This helper is not a complete JSON Schema implementation or metaschema validator and is not used in production request paths. New keywords require corresponding semantics/tests. Finite samples and cross-language checks cannot prove every future field/method will remain aligned.

## Documentation corrections

The authoritative A2 specification, the integration guide (now `docs/guide.md`), and python/README.md now include RESOURCE_CLEANUP_PENDING. They distinguish database A/Q/R from host-memory closing/pending state and require clients to tolerate future reason strings. README/CLAUDE.md explain the same boundary.

Both language guides document RESOURCE_CLEANUP_INCOMPLETE operationId/auditCommitted, camelCase result fields, and optional resourceCleanup. Save the first target/evidence/key and explicitly retry reconcile on the same owner to advance cleanup. get/lookup/wait are read-only. Losing the finalizer after restart remains outcome_unknown; a disappearing blocker or wait returning unknown does not prove completion. No string-matching tests were added for low-risk prose; behavior is grounded in existing R04 actual stdio/SQLite regression.

## Initial final verification

| Command | Actual result |
| --- | --- |
| node --test tests/contract/protocol-schema.test.ts | **12/12**, 0 failed or skipped |
| npm test | **229/229**, 0 failed, cancelled, or skipped; about 2.70 seconds |
| npm run test:python | **44/44**, about 4.59 seconds |
| npm run typecheck | Passed |
| npm run format:check | Passed |
| git diff --check | Passed |

The full suite includes final required-field, nested-array, and safe-integer negative cases. Actual Unix sockets/subprocesses ran with local IPC permitted; skips were not counted as passes. No performance benchmark was rerun because production scheduling was unchanged; this record adds no performance claim.

0003-B, engine decomposition, Codex usage deduplication/configuration migration, and other P2 work remain excluded. During this increment there were no real-model calls, commits, pushes, merges, or package publications.

## AC-W06: Validate additionalProperties value shapes

Date: 2026-09-20. Change only the helper, its contract tests, and the specification/evidence documents, preserving the historical results above. Reject unsupported additionalProperties values at initialization so a typo such as string "false" cannot silently disable extra-property constraints.

### RED

Add AC-W06, invalid-value initialization tests, and valid-value compatibility coverage before modifying the helper. Run:

```sh
node --test --test-name-pattern=AC-W06 tests/contract/protocol-schema.test.ts
```

Actual **1 pass / 1 fail / 0 skipped**. The negative case failed with `Missing expected exception: root: "nope"`, proving the implementation did not reject an invalid value. Existing valid-value semantics and recursive object-subschema auditing passed. Compilation or IPC failures were not used as RED.

### GREEN and scope verification

Use Object.hasOwn in initialization audit to distinguish explicit additionalProperties from omission, and assert a boolean or object subschema. Preserve existing recursive auditing and payload checks. Explicit undefined is not omission; it must be rejected even when supplied through a JavaScript object.

Two added tests cover invalid "nope", "false", null, 0, 1, empty/nonempty arrays, and undefined at four locations: root, unused $defs, properties, and additionalProperties subschemas. All fail at initialization. Valid regressions cover omission, true, false, empty object, and a $ref to a nonnegative-integer subschema. Open forms still validate declared properties; false still rejects extras; constrained objects reject wrong types/values; unknown subschema keywords are recursively rejected.

| Command | Actual result for AC-W06 |
| --- | --- |
| node --test --test-name-pattern=AC-W06 tests/contract/protocol-schema.test.ts | **2/2**, 0 failed or skipped |
| npm test | **231/231**, 0 failed, cancelled, or skipped; about 2.79 seconds |
| npm run test:python | **44/44**, about 4.94 seconds |
| npm run typecheck | Passed |
| npm run format:check | Passed |
| git diff --check and git diff --no-index --check against backups of the four changed files | Passed |

The complete Node suite still includes actual Unix hosts, Python children, and real-payload schema validation. Runtime execution uses fake without real-model calls. A starting SHA-256 inventory confirmed only these four files changed; existing production code, public schema, and other uncommitted files retained their original contents. No scheduling benchmark was rerun and no performance claim added. No commit, push, merge, or publication was performed during the AC-W06 implementation increment.

## Integration verification before pushing main

Date: 2026-09-20. Integrate local reliability/contract commit `5a75edf` with English-documentation commit `644d8b3`. Resolve six documentation conflicts by retaining the English base and incorporating the new behavior/recovery guidance. Translate the new SPEC-0004/0005 specifications and evidence, preserving acceptance IDs, historical failures, counts, timings, and limits. Update the repository URL after the account rename.

All source, test, schema, and dependency files are byte-identical to `5a75edf`; both English diagrams are byte-identical to `644d8b3`. All 28 Markdown documents parse, 107 relative file/heading links resolve, and every specification retains its acceptance-ID set. Example syntax checks pass for 14 TypeScript, 18 Python, 49 shell, four JSON, and two TOML blocks.

The final merged working tree passes `npm test` **231/231**, with zero failures, cancellations, or skips (about 2.71 seconds), and `npm run test:python` **44/44** (about 4.82 seconds). `npm run typecheck` and `npm run format:check` pass. This integration adds no runtime behavior, real-model acceptance, or new performance claim.
