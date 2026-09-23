# Contributing

Thank you for helping. Bug reports and pull requests are welcome; for a larger change, open an issue first so the design can be agreed before code.

## Set up

You need Node.js 22.18 or later and Python 3.11 or later, on macOS or Linux.

```sh
git clone https://github.com/masonlee39/orchvia.git
cd orchvia
npm ci --ignore-scripts
npm test
npm run test:python
```

`npm run typecheck` and `npm run format:check` must pass too. Unix-socket tests need permission to create local sockets; a skipped test is not a pass.

## How changes are made

This project uses TDD. Start from the accepted design and acceptance criteria in `docs/specs/`: define observable behavior, run failing tests, then implement it. Distinguish compilation failures, passing test doubles, and interface responses from production acceptance.

Complete each increment in this order:

1. Write the specification: problem, target behavior, scope, non-goals, state/protocol rules, and numbered acceptance criteria.
2. Write tests for the main call path and relevant failure cases. Cross-language, restart, shutdown, and messaging changes require real subprocess integration, not only mocks of your own methods.
3. Run RED and record the command and actual failure. Behavior that is already correct may receive regression coverage directly; do not fabricate a failure history.
4. Implement GREEN. Refactoring must preserve behavior and passing tests without unrelated changes.
5. Run relevant tests and `npm run typecheck`. Shared wire or lifecycle changes require both `npm test` and `npm run test:python`.
6. Update the specification, runnable README examples, and verification evidence. Distinguish future interfaces from implemented behavior.

Ordinary tests use temporary workspace/stateDir directories and a deterministic fake runtime, without login credentials or paid model requests. Real Claude/Codex acceptance must separately record versions, identity sources, task budgets, and model results; fake fixtures cannot prove it.

The foundation assumes a trusted local boundary under one OS user. Contributions must not silently expand network listeners, tool permissions, directory access, or automatic recovery. Preserve unknown external outcomes without blind retries. Generated idempotency keys must remain available for recovery after a lost receipt.

Node executes TypeScript source through type stripping, and tests use `node:test`; use only erasable TypeScript syntax. Dependencies are locked in package-lock.json. Normal startup must not download dependencies. Python runtime dependencies are standard-library-only.

Write repository documentation, examples, and source comments in English. Preserve intentional multilingual test data where it verifies Unicode behavior.

The project is licensed under MIT, and contributions are accepted under the same license. Third-party dependencies retain their own licenses. Releases are published by the maintainer through the release workflow; see [docs/release/publishing.md](docs/release/publishing.md).
