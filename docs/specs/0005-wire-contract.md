# SPEC-0005: Client recovery guidance and wire-snapshot contracts

Date: 2026-09-20. Preserve wire 1.0, storage schema 2, and existing runtime behavior. This increment fills client-documentation gaps for R04 cleanup receipts and makes the public JSON Schema accept actual host snapshots while rejecting contract-breaking payloads.

## Scope and non-goals

Add TaskSnapshot, ApprovalRequest, MessageSnapshot, and UsageRecord while preserving OperationSnapshot's generic raw JSON result/error semantics. Validation is test-only, outside production request paths, without third-party dependencies. It is not a complete JSON Schema implementation or code generator. Do not refactor the engine, implement 0003-B, or change usage deduplication, configuration migration, or other P2 items.

## Numbered acceptance criteria

- **AC-W01 Client recovery guidance:** The authoritative A2 specification, cross-language usage guide, and Python README all list RESOURCE_CLEANUP_PENDING. A/Q/R use consistent database reads; canDispatch/reasons also reflect host shutdown and in-memory cleanup. Explain RESOURCE_CLEANUP_INCOMPLETE operationId/auditCommitted, unobservedResourcesReconciled/resourceCleanup in raw camelCase result, and explicit reconcile continuation with the saved original target/evidence/key. get/lookup/wait are read-only and do not run finalizers. outcome_unknown after restart is not successful cleanup.
- **AC-W02 Complete snapshots:** Define required, nullable, array-element, enum, and numeric constraints for the four missing types against existing TypeScript types, SPEC-0001, and host output. Preserve nullable error, optional lifecycle/resolution, and open result on OperationSnapshot. Output snapshots allow future extension fields. Reusing strict input MessageSpec must neither reject MessageSnapshot server fields nor accidentally permit control messages.
- **AC-W03 Actual payloads:** Read the five snapshot categories from the real engine and Unix RPC. Cover waiting/approved tasks and approvals, durable messages, reported/null usage, and operation receipts; also validate SessionSnapshot, SchedulerSnapshot, and EventEnvelope. Merely checking definition names or constructing successful test snapshots does not count as real output validation.
- **AC-W04 Negative cases and validator boundaries:** Reject deleted required fields and broken nested types, array elements, status enums, integers, and nullable boundaries. The helper covers structural constraints used by the schema. Unsupported assertion keywords and unresolved local references must throw rather than be ignored. format retains draft 2020-12 default annotation semantics, without claiming to validate every date format.
- **AC-W05 Cross-language integration:** A real Python subprocess connects to the same host and reads the same snapshots. Verify snake_case access for known Python fields, original keys in raw result/raw, and equality with TypeScript's same stable state. Schema validation does not replace this actual cross-language regression or prove coverage of every future field/method.
- **AC-W06 additionalProperties value shapes:** During helper initialization, an explicitly present additionalProperties must be a boolean or object subschema. Reject strings (including "false"), null, numbers, arrays, and explicit undefined rather than silently weakening constraints. Cover the root, unused $defs, properties, and additionalProperties subschemas. Preserve extra-property semantics for omission, true, false, empty objects, and constrained object subschemas; recursively audit object subschemas. Tighten only the test helper, without changing production runtime/public wire schema or claiming complete metaschema validation.

## Verification

Write tests and record actual RED from missing definitions before adding schema/documentation. Run targeted contract tests, typecheck, format:check, both full suites, and diff checks. Record results in docs/tdd/0005-wire-contract.md.
