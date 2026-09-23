# SPEC-0010 verification evidence

The accepted scope is recorded in [SPEC-0010](../specs/0010-bundled-host-delivery.md). Existing SPEC-0009 work remains uncommitted and is preserved. Verification date: 2026-09-21, macOS arm64, Node 24.14.0, Python 3.14.6, esbuild 0.28.2, Claude SDK 0.3.274, Zod 4.6.5. No model requests, edits to another application, public publication, commit or tag.

## RED evidence

Before implementation, esbuild bundled a source entry importing `validateWire` and `createClaudeAdapter` into separate temporary CJS/ESM files. Both failed on execution:

- CJS: `ERR_INVALID_URL`, input `./generated/protocol.schema.json`, at module initialization.
- ESM: `ENOENT`, attempting to read `generated/protocol.schema.json` beside the bundle.

This establishes the reported module-loading defect. New host-binding tests and native MCP/bundle acceptance were then added as regression coverage; no earlier failing history is claimed for those cases.

## Implementation and final verification

| Criterion | Change and observed result |
| --- | --- |
| D01 | `generate-protocol.mjs` now emits five artifacts, including `protocol-schema.ts`; validator no longer reads files. `check:generated` passes; canonical schema hash remains `e68a90b5cacd67a8eb491b0fe32e8c9a7d303a6f02c4b1a82e4ae3481b57ac45`. |
| D02 | package-smoke runs actual packaged SDK + engine + Claude adapter, compiles both single-file formats, removes node_modules, and verifies fake and Claude task completion through human approval. Both formats execute four real engine operations through native SDK MCP and an injected inspection callback. Bundle metadata permits only built-in external imports; it excludes Codex and CLI. |
| D03 | Adapter declares optional Zod `^4.0.0`; smoke calls default `createClaudeMcpServer` with installed native SDK and Zod. Missing both peers and missing Zod alone produce the actionable dependency error. |
| D04 | Host query requires matching MCP/inspection callbacks, with no implicit fallback SDK lookup. Two new contract tests pass. Public helper exports accept host SDK/Zod functions; default imports have literal specifiers. The documentation injection example typechecks with zero errors. |
| D05 | Root, wiring and generated package READMEs state ESM-only exports and distinguish bundled CJS from direct require. The SDK has no runtime-brand gate; a fixture marker is explicitly not Electron acceptance. |
| D06 | Five RC tarballs have coherent `0.1.0-rc.1` dependencies, private/repository/license metadata and verified SHA-256. npm lockfile contains local `file:` resolutions and SHA-512 integrity. Repeat build into the candidate directory is rejected and all tarball hashes remain unchanged. Existing mapSpecifier and adapter-isolation assertions remain. |

Commands and outcomes:

```sh
npm run check:generated   # 5 artifacts, 57 definitions, PASS
npm run typecheck         # PASS
npm run format:check      # PASS
npm test                  # final: 435/435, zero skips
npm run test:python       # 48/48, zero skips
npm run build:packages -- dist/release/0.1.0-rc.1 --version 0.1.0-rc.1
PACKAGE_BUILD_PYTHON=/private/tmp/agent-orch-package-build-20260920/bin/python \
PACKAGE_PYTHON_RELEASE=/Users/masonlee/Multi-Agent/dist/release \
  npm run test:packages -- dist/release/0.1.0-rc.1
node scripts/check-native-protocol.mjs \
  /Users/masonlee/Multi-Agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs \
  /Users/masonlee/.local/bin/codex
```

The first full Node run, concurrent with other verification, passed 434/435. The owner-kill A2-09 fixture exceeded its 10-second parent wait; it uses a 20ms turn deadline. The cause was not established from that output. The isolated A2-09 rerun passed, followed by a full 435/435 rerun. No deadline, assertion or production lifecycle behavior was changed to make it pass. Both logs are retained.

Nine package modes passed:

1. Installed embedded SDK task/approval.
2. Installed Codex private MCP, four tools.
3. Codex-only adapter import, Claude absent.
4. Installed Claude native SDK MCP and two approved tasks.
5. CJS single file after node_modules removal, same tasks and four MCP operations.
6. ESM single file after node_modules removal, same tasks and four MCP operations.
7. Claude-only installation, Codex absent.
8. Installed Python wheel to owned compiled Node host.
9. Wheel rebuilt from sdist, reinstalled, same Python round trip.

Local raw logs and manifest snapshots are under `dist/verification/0010/`. Candidate files and `npm-manifest.json` are under `dist/release/0.1.0-rc.1/`.

## Boundaries

The CJS build adapts `import.meta.url` only in the third-party native SDK 0.3.274 file. Agent-orch code gets no such rewrite. The native executable in these tests is an owned protocol fixture; actual platform binaries, model execution and an application's Vite/Electron 43.2.0 / Node 24.18 build remain unverified. CI configuration now runs the expanded package smoke, but remote CI was not executed in this task. Package exports remain ESM-only. Codex/CLI standalone resource loading remains covered by installed-package tests, with no claim of arbitrary single-file bundling.

## Subsequent MIT license decision

The user selected MIT after the RC above was delivered. Root/Python LICENSE files now carry the standard MIT text with `Copyright (c) 2026 masonlee39`; README and npm/Python package metadata declare MIT. Third-party dependencies keep their original licenses. Python uses setuptools 77.0.3+ to support the SPDX license expression and license-files metadata.

Verification-only builds in separate temporary directories confirmed that all five npm tarballs contain the exact LICENSE and `license: MIT`; Python wheel metadata contains `License-Expression: MIT`, and both wheel/sdist include the exact license text. Formatting and diff checks passed. This metadata/documentation change did not alter engine behavior. Previously delivered RC 0.1.0-rc.1 files remain unchanged; the next distributed candidate must use a new version. No public publication was performed.
