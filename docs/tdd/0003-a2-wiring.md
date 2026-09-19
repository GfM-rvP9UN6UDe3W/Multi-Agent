# SPEC-0003-A2：双语言 SDK、CLI 与公共 schema 接线证据

日期：2026-09-19。范围仅含公开接线、配置校验和离线协议验证。引擎状态机与适配器内部证据另行记录；本文件不证明真实 Claude/Codex 身份或付费模型验收。

## RED

先新增 `tests/contract/execution-isolation-wiring.test.ts`、`python/tests/test_execution_isolation.py`，扩展独立 Python 协议 fixture，再运行：

```sh
node --test tests/contract/execution-isolation-wiring.test.ts
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_execution_isolation.py -v
```

TS 实际 5 项全部失败：SDK 缺少 scheduler 入口；CLI 拒绝 maxQuarantinedDispatches；公开 schema turnMs 默认仍为 300000。Python 的 5 个测试方法实际报 1 failure、11 errors（部分包含 capability 子测试）：缺少 scheduler、executionIsolation 的 snake_case 接线，turn_ms 默认仍为 300000。以上为实现前实际 RED，后加的真实宿主集成为回归验证，没有人为制造其 RED。

## 实现

- TS 暴露 `scheduler.get()`、`getConflict({conflictId})`、`resolveConflict({conflictId,expectedRevision,evidence}, {idempotencyKey})`。三者均在发送前检查完整且精确的 executionIsolation v1/budgetVersion 2 能力；解除操作保留正常 OperationHandle 和 conflictId 幂等 scope。
- Python 暴露 `scheduler.get()`、`get_conflict(conflict_id)`、`resolve_conflict(conflict_id,evidence,expected_revision=...,idempotency_key=...)`，同样严格检查 capability（bool 不充当版本号，数字 1 不充当 true）。已知快照及嵌套 execution/lease/budget 字段转为 snake_case；用户 JSON 与 operation.result 保持原字段。
- CLI 校验 maxQuarantinedDispatches 为 1..1024 的整数且不小于有效 maxActiveSessions；配置原样进入引擎。两家显式 requestTimeoutMs/turnTimeoutMs 均保留并校验，独立清理字段为 Claude cleanupTimeoutMs、Codex closeTimeoutMs；未以新默认覆盖显式短期限。
- Python LifecycleTimeouts 默认 turn_ms=1800000，其余期限不变。公开 schema 增加 11 个定义，含 scheduler 请求/响应、冲突、租约、预算、会话摘要及 EngineLimits；wire 仍为 1.0，事件 schemaVersion 仍为 1。

## GREEN 与真实跨语言宿主

```sh
node --test tests/contract/execution-isolation-wiring.test.ts tests/contract/sdk.test.ts
node --test tests/contract/execution-isolation-wire.test.ts
npm run typecheck
PYTHONPATH=python/src:python/tests python3 -m unittest test_execution_isolation test_reconcile test_sdk test_lifecycle test_transport_parsing -v
```

TS 接线与既有 SDK 回归为 11/11 通过；真实 Unix 跨语言集成为 1/1 通过；类型检查通过。Python 32 项中沙盒内 31 项通过，旧 Unix fixture 单项因 `bind EPERM` 失败；允许本机 IPC 后单独重跑同项 1/1 通过，未将环境失败当成功。

真实 Unix 测试启动临时 Node CLI、明确启用 fake provider：40ms 总期限后任务保持 blocked/outcome_unknown；迟到终态与清理证据使 A=0、Q=1、R=0。额度为 1 时原因仍为 QUARANTINE_CAPACITY_EXCEEDED；租约 released 不伪造业务成功。TS 与另一个真实 Python 子进程连接同一宿主，读取的完整 scheduler/session 快照在已知字段转回 wire 后逐值相等。普通 socket 的冲突解除由宿主拒绝为 UNAUTHORIZED；仅一个 dispatch.started，没有 approval.requested。

Python 独立协议 fixture 验证缺失/不兼容能力不会发送 scheduler 请求；owner 解除冲突返回句柄、原 JSON、精确 request echo、同键回执与 payload 冲突；丢失回执错误保留 method、conflict scope 和幂等键。

格式检查命令：

```sh
npx prettier --check packages/sdk-typescript/src/index.ts packages/cli/src/config.ts schemas/protocol.schema.json tests/contract/execution-isolation-wiring.test.ts tests/contract/execution-isolation-wire.test.ts
```

以上本范围文件检查通过。所有宿主、fixture 和临时目录由测试自己的 finally/after 清理；没有调用真实模型。

## Python 真实宿主与全量回归

新增 `python/tests/test_node_execution_isolation.py` 三项集成，使用真实 Node CLI stdio/Unix：运行中的会话公开默认 1800000ms 预算；显式 40ms 轮次迟到清理后 A=0/Q=1/R=0、activeDispatchId 与业务 unknown 保留；双客户端读取一致状态且普通 socket 不能解除冲突。默认预算同时核验 deadlineAt-enteredAt=1800000ms。

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_node_execution_isolation.py -v
npm run test:python
```

在允许本机 IPC 的环境中，新集成 3/3 通过；随后独立重跑完整 Python 套件，40/40 通过、0 失败、0 跳过。先前沙盒 Unix 监听失败已由该完整运行覆盖。

## Claude 清理参数接线修正

复核发现 CLI 曾错误地允许 Claude `closeTimeoutMs`，而真实适配器读取 `cleanupTimeoutMs`，导致用户配置被忽略。先新增 provider 专属参数及实际适配器执行测试：

```sh
node --test --test-name-pattern='provider-specific cleanup keys' tests/contract/execution-isolation-wiring.test.ts
```

实际 RED 为 1/1 失败，`INVALID_CONFIG: Unknown claude provider field: cleanupTimeoutMs`。随后将 Claude 白名单/整数校验改为 cleanupTimeoutMs，Codex 保持 closeTimeoutMs，互用错名都拒绝。

测试从 JSON 读取 17ms 清理值，经 engineConfig 创建真实 Claude adapter，仅在配置读取后注入离线 query fixture；挂住 iterator.return，并用虚拟计时验证 16ms 尚未结束、17ms 返回清理未知且资源仍被持有。随后兑现迟到 return，确认测试自有适配器能关闭。此路径证明值实际影响适配器清理等待，而非只检查配置回显；没有加载官方 SDK 或调用模型。

```sh
node --test tests/contract/execution-isolation-wiring.test.ts
npm run typecheck
npx prettier --check packages/cli/src/config.ts tests/contract/execution-isolation-wiring.test.ts schemas/protocol.schema.json
```

实际 GREEN 为接线 6/6 通过，类型与格式检查通过。README/SDK 说明已区分两家清理字段。completed 核对仍要求 result 字段，但允许真实结果为空字符串；公共 schema 同步移除 result.minLength，仍保留字符串类型与 524288 长度上限。
