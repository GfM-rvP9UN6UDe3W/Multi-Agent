# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

单一 Node 编排引擎 + TypeScript / Python 两个瘦客户端 SDK。引擎独占 SQLite 状态、调度、期限与适配器调用；两个 SDK 只走 JSON-RPC wire，不实现第二套调度器、不打开数据库、不调模型。

当前实现范围：SPEC-0001 基础增量 + SPEC-0003-A 生命周期 + SPEC-0003-A2 执行隔离，以及 SPEC-0004 的调度、关闭配置、TS 请求期限与 Claude 清理修复。存储 schema 2，wire 1.0，事件 schemaVersion 1。0003-B/C（保留/GC/归档/选路）未实现。仓库已初始化 Git，远程为 `git@github.com:GfM-rvP9UN6UDe3W/Multi-Agent.git`；尚未发布 npm/PyPI 包。

## 常用命令

```sh
npm ci --ignore-scripts        # 依赖锁定，不联网下载运行时依赖
npm run typecheck              # tsc --noEmit
npm run format:check           # prettier --check（无 write 脚本，需要格式化时手动 npx prettier --write <file>）
npm test                       # node:test，引擎与协议契约测试
npm run test:python            # unittest，Python SDK 与真实本地宿主接线
```

跑单个文件 / 单个测试：

```sh
node --test tests/engine/lifecycle.test.ts
node --test --test-name-pattern "0003-A05" tests/engine/lifecycle.test.ts
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_lifecycle.py' -v
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -k disconnected_mutations -v
```

⚠ `npm test` 的 glob 只有 `tests/engine/*.test.ts tests/contract/*.test.ts`。新测试放到 `tests/e2e/`（目录存在但为空）不会被跑到——要么放进上面两个目录，要么同时改 package.json 的 glob。

改动涉及共享 wire、生命周期或调度时，`npm test` 与 `npm run test:python` 都要跑（CONTRIBUTING 硬要求）。

可执行示例与 CLI：

```sh
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
node examples/typescript/local.ts "$WORKSPACE" "$STATE_DIR"     # 两个目录须先存在且互不包含
node packages/cli/src/main.ts doctor --config /absolute/orchestrator.json
node packages/cli/src/main.ts host --config /absolute/orchestrator.json
```

Node 22.18+ / Python 3.11+（实测 Node 24.14.0、Python 3.14.6）。`node:sqlite` 的 experimental warning 打在 stderr，属正常输出。

## 架构

**唯一写者。** `packages/engine/src/index.ts` 的 `LocalEngine`（约 2200 行）是唯一接触 SQLite、调度、期限和适配器的组件。所有 wire 方法集中在 `call(method, params, context)` 的一个 switch（[index.ts:790](packages/engine/src/index.ts:790)）：新增方法 = 加 case + 校验 + spec AC + 双语言测试。

**三条接入路径，同一个引擎。** 进程内 `createOrchestrator`；CLI `host --stdio`（Python 受管子进程）；CLI `host --socket`（Unix socket）。三者不能同时打开同一 stateDir。

**owner 身份由传输层决定，不由参数决定。** `packages/cli/src/host.ts` 里 stdio 连接 `owner=true`，socket 连接 `owner=false`；`host.shutdown`、`sessions.reconcile`、`scheduler.resolveConflict` 靠这一位拒绝普通客户端（`UNAUTHORIZED`）。改权限要同时看 host.ts 的连接构造和引擎里的 `context.owner` 检查。

**存储。** `packages/engine/src/store.ts`：每张业务表都是 `(id TEXT PRIMARY KEY, data TEXT)` 的 JSON blob（tasks/sessions/messages/outbox/approvals/dispatches/artifacts/usage/execution_conflicts）；`operations` 另带 `UNIQUE(method,scope,key)` 做幂等；`events` 用 AUTOINCREMENT rowid 当 cursor。`owner.sqlite` 上的 `BEGIN EXCLUSIVE` 是 OS 级独占锁 → 第二个引擎报 `HOST_ALREADY_RUNNING`。stateDir 必须绝对、0700、解析符号链接后与 workspace 互不包含。

**持久状态变更一律进 `store.transaction()`，并在同一事务写事件。** A/Q/R 计数每次都从 dispatches 行重算（`scheduler()`），不维护内存计数器——改调度逻辑时不要引入缓存计数。scheduler 的 canDispatch/reasons 还结合本宿主 closing 与 pendingResourceCleanups 内存状态（RESOURCE_CLEANUP_PENDING）；它们不是 A/Q/R 缓存，整个 scheduler 结果也不是纯数据库快照。

**调度准入（A2 的核心）。** A = 持有执行租约的 dispatch；Q = 业务 outcome_unknown 的 dispatch；R = 租约 held 但尚未隔离的在途预留。新派发要求 `A < maxActiveSessions`（默认 2）且 `Q + R < maxQuarantinedDispatches`（默认 32）。释放 A 不减少 Q，只有业务 reconcile 才减 Q。`kick()` 用 microtask 扫 queued 任务；每个在途 dispatch = 内存里的 `Flight` + dispatches 表里的持久行。

**期限。** 派发时算 budget = min(宿主 timeouts, 适配器 cap)，默认总预算 1800 秒，从派发开始、含初始化与受理，受理和输出都不续时。计时用单调时钟，墙钟时间只持久化供诊断。`EngineClock` 是测试注入的 seam，只能从 `EngineConfig` 传，不接受配置文件或 wire。

**停止证据机制（最容易改错的地方）。** 自动释放执行租约要过 `stopProof()`：要么是 `pre_submission` 证据（证明没提交），要么是 terminal certificate + `terminalCoversExecution` + 本地清理确认。以下单独都不算停止证据：超时、AbortSignal、interrupt 回执、迭代器结束、Promise 返回、PID 消失、`hasActiveResources=false`。适配器通过 `input.reportExecutionEvidence` 推送证据；清理晚于 execute() 完成时回调 `reevaluateRelease` 重新评估。活着的 `Flight` 或 `adapter.hasActiveResources(sessionId)` 为真时否决自动释放。R04 的人工核对窄接口 `prepareUnobservedCleanup` 仅处理已结束观察、已封闭启动且从未观察到进程的精确目标；审计事务提交后才解除对应记录，不报告虚假退出。实际进程未退出时仍拒绝所有者声明。主动 shutdown 期间可继续人工 reconcile，但不开放新工作。矛盾证据持久化成 `execution_conflicts` 行并阻断新派发，重启不自动解除。

**收尾回执。** prepare 返回值在提交前检查函数类型。声明已提交后，finalizer 异常或完成回执落盘失败返回 RESOURCE_CLEANUP_INCOMPLETE，保留 operationId 与 pending 回执，暂停本宿主新派发。只在 owner 用原 payload/幂等键重试时续办原 finalizer；内存解除已完成时只补写确认。重启丢失原 finalizer 保留 outcome_unknown，不自动重新准备或冒充成功。正常调用仍返回 completed，资源完成事件在收尾确认事务中落盘。

**适配器契约**（`packages/engine/src/types.ts` 的 `RuntimeAdapter`）：`capabilities()` 必须声明 `executionBudget={version:2,...}`，否则 `tasks.create` 在落盘前就 `UNSUPPORTED_CAPABILITY`；`execute()` 产出 `RuntimeEvent` 流；execute 结束后仍可能持有资源的适配器必须实现 `hasActiveResources()`。`fake`（engine/src/fake.ts）是离线确定性运行时，测试只用它。

**双语言镜像。** `packages/sdk-typescript/src/index.ts` 的 `Orchestrator` 同时包装进程内引擎和 `UnixRpcClient`，对外是同一套 API；`python/src/agent_orch/client.py` 一比一镜像它。wire 上恒为 camelCase，Python 只把已知 envelope 字段转 snake_case——`operation.result` 等原始 JSON 保持 camelCase（例如要读 `result["executionReleased"]`）。改一边的 API 一定要同步另一边和 `schemas/protocol.schema.json`（手工同步，没有 codegen）。

`tests/contract/protocol-schema.test.ts` 用真实 Unix 宿主输出验证任务、批准、消息、用量、操作及相关快照，并让 Python 子进程读取同一状态，检查字段映射与原始 JSON 保留。测试辅助器只支持当前 schema 所用的约束，未知校验关键字直接失败，format 是注解；不是生产校验器或完整 JSON Schema 实现。扩展 wire 时同步补实际 payload 与反例，不能只增加定义名存在断言。

**跨包引用走相对路径**（`../../engine/src/types.ts`），不用 `@agent-orch/*` 包名——虽然 npm workspaces 建了软链，但没有任何代码按包名 import。

## 开发约束

- **TDD 是硬性流程**：先写 spec 与编号验收条款，再写测试并观察真实 RED，再实现，最后把 RED/GREEN 记进 `docs/tdd/`。测试名必须引用 AC 编号（`AC04 ...`、`0003-A05 ...`）。已正确的行为可以直接补回归，但不许伪造失败历史。
- **只用可擦除 TS 语法**（Node type stripping 直接执行源码）：不能用 enum、namespace、参数属性；`verbatimModuleSyntax` 要求类型一律 `import type`；import 必须带 `.ts` 后缀。
- **运行时零第三方依赖**：Python 只用标准库；`@anthropic-ai/claude-agent-sdk` 是可选 peer dependency，只在 `execute()` 内动态加载。
- **unknown 一律保守**：不自动解除 outcome_unknown、不自动重发/重试、不自动释放租约、计量字段缺失保留 null 不估算费用。
- **未实现的能力必须显式拒绝**，不能模拟成功。当前明确拒绝：`sessions.open/fork`、compact/rotate/stop、自动验收、`verificationRules`。
- **测试不碰真实模型和凭据**：只用临时 workspace/stateDir 和显式 `fake` provider；配置里 `fake` 永不默认启用。Unix socket 测试需要本机 IPC 权限，沙箱报 EPERM 要换环境重跑，不能当通过。
- Git 提交、推送及包发布按用户明确授权执行。
- 文档（README/CONTRIBUTING/specs/tdd）用中文，源码注释和 Python 文档用英文——延续既有风格。

## 文档权威层级

改行为前先读对应 spec，spec 与代码不一致时以 spec 为准并同步更新：

| 文件                                            | 权威范围                                                   |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `docs/specs/0001-foundation.md`                 | wire 1.0 方法表、AC01–AC12、快照字段基线                   |
| `docs/specs/0002-runtime-adapters.md`           | Claude / Codex 适配器边界与受理证据定义                    |
| `docs/specs/0003-a-lifecycle.md`                | 持久期限、owner reconcile；其 300 秒 turn 默认已被 A2 取代 |
| `docs/specs/0003-a2-execution-isolation.md`     | **当前权威**：A/Q/R 计数、1800 秒预算、租约/证据/冲突      |
| `docs/specs/0003-policy-retention-deadlines.md` | 分阶段计划，B/C 条款尚未实现                               |
| `docs/specs/0003-b-archive.md`                  | 归档/命名空间切换，未实现                                  |
| `docs/specs/0004-runtime-reliability.md`         | 调度历史扫描、信号关闭配置、TS 请求期限、Claude 退出证据     |
| `docs/tdd/*.md`                                 | 各增量的 RED/GREEN 实测证据                                |
| `schemas/protocol.schema.json`                  | wire 数据结构的规范定义                                    |

`AGENT_ORCHESTRATION_DESIGN.md` 和 `SDK_USAGE_AND_WIRING.md` 是完整产品设计与未来接线方案，里面的 `auth`、`executable`、MCP 桥、网关等**不是已实现接口**，不要照着它们宣称当前能力。
