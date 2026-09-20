# SPEC-0010: Bundled host delivery

## Problem and scope

Axion embeds the SDK, engine and Claude adapter in a single CJS Electron main-process bundle. Its deployed directory has no node_modules. The host owns its pinned Claude SDK and native executable. A clean npm installation alone does not establish this delivery contract.

Keep the five modular packages, package-boundary mapSpecifier rewriting, SHA-256 manifest and mutually exclusive adapter installation checks. This increment changes distribution compatibility and host dependency selection, not scheduling or wire semantics. Preserve existing source changes. No Axion edits, paid models, public publication, Git commit or tag are authorized.

## Acceptance criteria

- **D01:** Generate a TypeScript schema constant from the same canonical JSON. Importing and validating wire snapshots never reads an adjacent resource file. Generated-output checking includes this constant.
- **D02:** package-smoke installs the three Claude consumer packages, bundles both CJS and ESM using pinned esbuild, deletes the temporary node_modules, and runs task creation, fixture execution, human approval and completed-snapshot validation in both formats. Assert only built-in imports remain for the host-injected path. Use actual engine and adapter behavior, without model requests.
- **D03:** Declare the Claude adapter's Zod 4 peer. Actually execute createClaudeMcpServer with the pinned native SDK in package smoke, including all four private tools. Test missing dependencies with an actionable error. Native peers remain optional when the host injects all required functions.
- **D04:** A host-supplied query never implicitly locates a different SDK for MCP or inspection. MCP requires the matching host factory; inspection without a supplied reader returns unavailable. Export typed helpers for injecting the SDK/Zod functions. Default Node dependency loading uses literal specifiers that bundlers can analyze.
- **D05:** ESM-only package exports are stated on the first screen of root/package READMEs. CJS bundle support is independently tested; direct require is not promised. No SDK startup check rejects Electron by runtime brand.
- **D06:** Document five packages and the three-package Claude installation. Produce a coherent local 0.1.0-rc.1 set, private:true, with verified SHA-256 manifest and npm lockfile integrity. Never overwrite an existing versioned output. Document future immutable versions/tags and breaking changes to RuntimeAdapter/RuntimeEvent; do not choose an open-source license or publish.

## Verification boundaries

Both ordinary package installations and node_modules-free bundles are required. Native MCP protocol fixtures do not establish paid model behavior or native binary packaging. The locally installed Node runtime is recorded; Electron 43.2.0 / Node 24.18 requires host-side acceptance and is not inferred from Node-only tests. Codex's external executable bridge and CLI doctor remain separate package-backed execution paths, covered by their existing smoke checks; neither is silently included in the three-package Claude bundle.

## Completion

D01–D06 are implemented and verified for the local RC. The final run passed 435 Node tests, 48 Python tests and nine package modes. The first concurrent Node run had one crash-fixture timeout; its isolated rerun and subsequent full run passed without changing its deadline or assertions. See [complete evidence](../tdd/0010-bundled-host-delivery.md). RC 0.1.0-rc.1 is local and unpublished; actual Axion/Electron acceptance remains pending.
