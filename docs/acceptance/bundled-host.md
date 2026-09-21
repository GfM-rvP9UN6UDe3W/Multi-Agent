# Local RC and bundled-host integration

## Package contract

The five modular npm packages are `@agent-orch/sdk`, `@agent-orch/engine`, `@agent-orch/adapter-claude`, `@agent-orch/adapter-codex` and `@agent-orch/cli`. They export ESM and declarations. Direct CommonJS `require()` is not exported. A build tool may include the first three in either a CJS or ESM host bundle. SDK installation alone does not supply a provider.

The engine requires the filesystem, child-process and SQLite APIs available in Node.js 22.18+. Embedded startup does not reject Electron by runtime brand or automatically resolve a native provider before considering host injection. CLI `doctor` is a separate explicit diagnostic command.

## Host-owned Claude SDK

The host owns its pinned native SDK, Zod and platform executable. Inject `query`; if orchestration tools are enabled, inject `createMcpServer` using that same SDK. Inject `inspectSession` when retained native history is required. An injected query without an inspection callback reports `unavailable`; it does not locate another SDK. Enabling tools without the matching MCP factory fails before submission.

```ts
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import * as zod from 'zod';
import {
  createClaudeAdapter,
  createClaudeMcpServer,
  inspectClaudeSession,
} from '@agent-orch/adapter-claude';

const adapter = createClaudeAdapter({
  query: (request) => sdk.query({
    ...request,
    options: {
      ...request.options,
      pathToClaudeCodeExecutable: hostPinnedExecutablePath,
    },
  }),
  createMcpServer: (tools) => createClaudeMcpServer(tools, { sdk, zod }),
  inspectSession: (input) => inspectClaudeSession(input, sdk),
});
```

Keep the adapter's supplied `spawnClaudeCodeProcess` callback when wrapping native query options so the engine can observe cleanup. For ordinary Node installations without injection, install the Claude SDK and its peers; the adapter explicitly declares optional peers `@anthropic-ai/claude-agent-sdk` and `zod: 4.4.3`. They are optional because complete host injection needs no runtime dependency lookup. Claude SDK 0.3.274 with Zod 4.6.5 fails native tools/list schema conversion; do not widen the tested Zod peer without repeating native enumeration. Missing MCP peers produce `CLAUDE_DEPENDENCY_UNAVAILABLE` with the dependency names.

All adapter default imports use literal module names so bundlers can analyze them. A host that excludes native peers from its main bundle must provide its own callbacks and may mark those peer names external in its bundler. The host is responsible for how it packages third-party SDK code. The pinned SDK 0.3.274 itself uses `import.meta.url`; the CJS smoke applies a narrowly scoped URL shim to that third-party file only. It applies no URL shim to any agent-orch source. See [the smoke implementation](../../scripts/package-bundles-smoke.mjs) for the exact configuration.

The protocol validator imports a generated TypeScript constant and needs no adjacent JSON. Codex's executable MCP bridge and CLI doctor use package-backed resource resolution and are outside this three-package Claude bundle. Their installed-package smoke remains required; this RC does not claim arbitrary Codex/CLI single-file bundling.

## Build, verify and install

Build one coherent local candidate; do not overwrite an existing candidate directory:

```sh
npm run build:packages -- dist/release/0.1.0-rc.4 --version 0.1.0-rc.4
/absolute/pinned-build-env/bin/python scripts/build-python.py dist/release/0.1.0-rc.4 --version 0.1.0-rc.4
PACKAGE_BUILD_PYTHON=/absolute/pinned-build-env/bin/python \
  npm run test:packages -- dist/release/0.1.0-rc.4
```

The same directory contains npm 0.1.0-rc.4 and Python 0.1.0rc4 (PEP 440 spelling), with separate SHA-256 manifests. Wire protocol remains 2.0. These commands reproduce the candidate only in a fresh directory; use a new version after changing source.

Install the three Claude tarballs from the same candidate and keep the resulting lockfile:

```sh
npm install /absolute/rc/agent-orch-sdk-0.1.0-rc.4.tgz \
  /absolute/rc/agent-orch-engine-0.1.0-rc.4.tgz \
  /absolute/rc/agent-orch-adapter-claude-0.1.0-rc.4.tgz
```

Verify each file against `npm-manifest.json` before installation. npm additionally records local tarball SHA-512 integrity in the consumer lockfile. The smoke verifies the SHA-256 manifest, lockfile integrity, adapter isolation, installed native MCP, and separate CJS/ESM bundles after deleting their entire temporary node_modules. Both bundles execute fake and Claude protocol-fixture tasks through human approval to completion, four real engine MCP operations, and an injected history reader. No model requests are made.

This is Node-based package evidence. Electron 43.2.0 / Node 24.18, Axion's Vite configuration, platform-binary distribution and real model execution require acceptance inside the host. Merely setting an Electron version marker in a fixture is only a regression check against an accidental runtime-brand gate.

## Release policy

The project now uses the [MIT License](../../LICENSE). Future package builds include the full LICENSE and `license: MIT`; local candidates remain `private: true`. Third-party SDKs and executables retain their own licenses. Public npm release still requires account selection, explicit publication authority and removal of `private`.

The previously delivered `0.1.0-rc.1` artifacts predate this license decision and remain byte-for-byte unchanged with their original `UNLICENSED` metadata. Existing rc.2, rc.3 and rc.4 artifacts are preserved. SPEC-0012 builds local rc.5 with MIT metadata and coherent Python 0.1.0rc5 artifacts from its uncommitted source.

Every delivered candidate uses an immutable version, such as `0.1.0-rc.4`, followed by `rc.5` for changed bytes. Keep all five npm package versions aligned. Before 1.0, incompatible public API changes increment the minor version; after 1.0 they increment the major version. Removing/renaming required fields, changing method signatures or lifecycle semantics, and changing RuntimeAdapter/RuntimeEvent requirements are breaking changes. A new RuntimeEvent union variant is also breaking for exhaustive consumers. Additive optional fields may be minor changes after 1.0. Wire-version changes require their own explicit negotiation/migration policy.

Each authorized publication must have a matching immutable Git tag and retained checksums. Never republish different bytes under a published version. This local RC does not commit, tag, publish to npm/PyPI or run a paid model.
