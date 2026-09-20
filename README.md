# Agent Orchestration SDK

一个 Node.js 编排引擎，TypeScript 和 Python 两种 SDK，供本地应用管理任务、持久消息、会话状态和人工验收。

**当前为未发布的开发版本，已实现基础增量、SPEC-0003-A 生命周期及 A2 执行隔离增量。** 已有可运行源码和离线 fixture 验收；完整首版设计尚未全部实现。A2 验证见 [双语言接线](docs/tdd/0003-a2-wiring.md)、[Claude](docs/tdd/0003-a2-claude.md) 和 [Codex](docs/tdd/0003-a2-codex.md)，A 与基础增量的历史结果保留在原证据文件。普通测试使用明确启用的 `fake` 运行时或协议 fixture，不请求模型、不读取登录凭据。Claude/Codex 适配器已有最小协议实现和有界资源清理，但尚未通过真实模型端到端验收。

- [基础增量 spec 与验收条款](docs/specs/0001-foundation.md)
- [运行时适配器 spec](docs/specs/0002-runtime-adapters.md)
- [生命周期实现契约](docs/specs/0003-a-lifecycle.md)
- [A2 实现契约：执行占用、结果隔离与统一期限](docs/specs/0003-a2-execution-isolation.md)
- [可靠性修复：调度、关闭配置、请求期限与 Claude 清理](docs/specs/0004-runtime-reliability.md)
- [归档与新命名空间切换规格（待实现）](docs/specs/0003-b-archive.md)
- [分阶段 spec：A/A2 已实现，B/C 保留与选路待实现](docs/specs/0003-policy-retention-deadlines.md)
- [TDD 证据](docs/tdd/0001-evidence.md)
- [开发规范](CONTRIBUTING.md)
- [完整产品设计](AGENT_ORCHESTRATION_DESIGN.md)与[未来完整接线方案](SDK_USAGE_AND_WIRING.md)

## 已实现的范围

| 部分 | 当前能力 |
| --- | --- |
| 唯一引擎 | SQLite WAL、OS 文件锁、任务/会话/操作/消息/事件/批准/原始用量持久化 |
| 任务调度 | 显式 provider/model、最多 2 个执行占用、每会话串行、轮数上限；持久租约与有上限的业务隔离分别计数 |
| 可靠通信 | 持久消息与 outbox、幂等键、目标代次校验、消息受理与完成分别记录 |
| 任务完成 | 运行结果先保存；人工验收批准后才能 completed，否决为 failed |
| 控制与恢复 | 持久期限、pause/drain、受支持的 interrupt、resume、cancel、关闭超时续等；unknown 隔离、所有者人工 reconcile，崩溃或超时不自动重发 |
| 调度诊断 | `scheduler.get/getConflict` 只读查询，所有者 `scheduler.resolveConflict` 解除已重新核实的资源证据冲突 |
| TypeScript | 进程内 `createOrchestrator`，或 Unix socket `connectOrchestrator` |
| Python | `Orchestrator.local` 管理 Node 子进程，或 `Orchestrator.connect` 连接同一宿主 |
| 本地协议 | JSON-RPC 2.0、stdio/Unix socket、版本握手、1 MiB 帧、64 个 pending 请求 |
| CLI | `host`、`doctor`、`submit`、`status`、`approve`；其他命令明确拒绝 |

第一增量每项任务自动分配一个逻辑会话。`sessions.open/fork`、compact/rotate/stop、agent 模型工具回调/MCP 桥、自动验收命令、金额预算、工作区并发写入锁和跨任务会话复用仍未实现。邮箱先通过 SDK 接入；这里不声称模型已可自行调用委派工具。当前成果验收只实现人工批准这一条路径。

SPEC-0003-A/A2 已提供执行/控制的持久 deadline、迟到证据保留、执行租约与业务隔离，以及人工所有者 `sessions.reconcile`。contextPlan、保留/GC、去重墓碑、存储压力保护、跨任务费用规则和自动策略选择仍属 SPEC-0003-B/C；长期驻留、容量故障和真实模型验收尚未完成。

A2 新轮次默认总预算为 1800 秒。执行停止与本地清理都得到证明后，unknown 可释放执行槽，业务结果继续隔离：A=`executionOccupied` 是仍持有的执行租约，Q=`quarantined` 是业务 unknown，R=`quarantineReserved` 是未隔离在途执行的预留（含待清理）。新派发要求 `A < maxActiveSessions` 且 `Q + R < maxQuarantinedDispatches`；默认分别为 2 和 32。两项仍可能执行的 unknown 仍会占满执行名额；释放 A 不减少 Q，不自动 resume、重发或批准。

协议数据结构见 [JSON Schema](schemas/protocol.schema.json)。[实际 payload 契约测试](tests/contract/protocol-schema.test.ts) 通过真实 Unix 宿主读取任务、批准、消息、用量、操作及相关快照，校验字段约束及破坏后的反例，并让 Python 子进程读取同一状态比较字段映射与原始 JSON。测试辅助器仅实现当前使用的 schema 约束子集，未知校验关键字直接报错，format 保持注解语义；没有生产 schema 校验器或 schema→双语言代码生成。[范围与验收条款](docs/specs/0005-wire-contract.md)。

## 本地开发与验证

声明最低 Node.js 22.18+、Python 3.11+；当前已实测 Node.js 24.14.0、Python 3.14.6。Node 内建 SQLite 当前有 experimental warning，输出在 stderr。最低版本矩阵尚未单独验收。

在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run format:check
npm test
npm run test:python
```

测试只创建并清理自己在系统临时目录中的工作区、数据库、socket 和子进程。Unix socket 测试需要本机 IPC 权限；受限沙盒若报 EPERM，应在允许本机 socket 的测试环境重跑，不能把跳过当通过。

源代码现在直接由 Node 执行可擦除的 TypeScript；未制作可发布的编译包。不要从 npm/PyPI 安装文档中的暂定名称来冒充本工作区代码。

调度只从 SQLite 索引读取 queued 候选，并在实际派发后更新准入判断；历史非排队任务不再逐项触发派发表全扫描。已有 schema 2 状态会在启动时补建任务状态、派发 taskId 索引，不改写业务记录。A/Q/R 仍从持久派发记录计算，历史存储与部分查询仍随数据量增长；GC/归档尚未实现。可执行 `node tests/fixtures/scheduler-benchmark.ts . 50,100,150,300` 复测离线创建延迟，结果与边界见 [本轮验证](docs/tdd/0004-runtime-reliability.md)。

## 先运行 Python 完整示例

```sh
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
```

示例启动真实 Node stdio 宿主，创建 fake 任务、读取批准请求、只批准预先确定的 fixture 证据、等待 completed，随后关闭并清理自身临时文件。这个自动决定只用于已知 fake fixture，不能复制为真实 agent 的通用自动批准策略。

Python 无运行时第三方依赖。安装进自己的虚拟环境和更多 API 用法见 [Python README](python/README.md)。

## TypeScript 嵌入模式

先创建分离的临时目录，再运行交互示例：

```sh
DEMO_ROOT="$(python3 -c 'import pathlib,tempfile; print(pathlib.Path(tempfile.mkdtemp(prefix="agent-orch-demo-")).resolve())')"
mkdir -p "$DEMO_ROOT/workspace" "$DEMO_ROOT/state"
node examples/typescript/local.ts "$DEMO_ROOT/workspace" "$DEMO_ROOT/state"
```

看到 fixture 结果后输入 `approve` 或 `deny`。其他输入保留待处理任务。该示例保留调用者提供的状态目录，方便检查重启状态；引擎停止后再决定是否保留。源码入口：

```ts
import { createOrchestrator } from './packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from './packages/engine/src/fake.ts';

const orch = await createOrchestrator({
  workspace: '/absolute/existing/workspace',
  stateDir: '/absolute/private/state-outside-workspace',
  adapters: [createFakeAdapter()],
  providers: { fake: { model: 'fake-model' } },
  limits: { maxActiveSessions: 2, maxTurnsPerTask: 20, maxQuarantinedDispatches: 32 },
});
```

上述片段只演示创建。完整示例负责批准与关闭。`task.wait({timeoutMs, signal})` 超时/取消仅停止本地等待；取消远端任务必须显式调用 `tasks.cancel`。任务 paused/blocked 时先查询并处理原因，不能一直等完成而忽略状态。

## 独立宿主和双语言接线

```text
TS 应用 ── 进程内 SDK ───────────────────┐
                                      ↓
Python SDK ── stdio ── Node 子进程 ── 统一引擎 ── SQLite/事件/邮箱
                                      ↑
TS / Python SDK ── Unix socket ── 独立 Node 宿主
                                      ↓
                         fake 或显式选择的运行时适配器
```

嵌入、受管子进程、独立宿主是三种选择，不能各自打开同一 stateDir。公共宿主拥有调度器；连接它的客户端 `close()` 只断开自己，不能把宿主关闭。

下面是**当前支持**的 fake 配置，替换三个绝对路径；CLI 要求 workspace/stateDir 目录已存在且不含符号链接。socket 必须位于当前用户独占的私有目录，避免公共目录上的连接竞争。

```json
{
  "configVersion": 1,
  "workspace": "/absolute/workspace",
  "stateDir": "/absolute/private-state",
  "transport": { "mode": "unix", "socketPath": "/absolute/private-state/host.sock" },
  "providers": { "fake": { "model": "fake-model", "permissionProfile": "read-only", "delayMs": 20 } },
  "limits": { "maxActiveSessions": 2, "maxTurnsPerTask": 20, "maxQuarantinedDispatches": 32 },
  "timeouts": { "acceptanceMs": 30000, "turnMs": 1800000, "drainMs": 300000, "interruptMs": 30000, "reconcileMs": 60000 }
}
```

`timeouts` 可省略或只覆盖部分字段；上例给出五个默认值，均为 1..86400000 的整数毫秒。TS 嵌入模式使用相同配置对象。Python 所有者把配置写入 JSON，通过 `engine_command=[node, cli, "host", "--stdio", "--config", config_file]` 传给宿主；没有 `Orchestrator.local(timeouts=...)` 参数。SDK 的本地 wait 时限与这些执行期限独立，重试或重启不会刷新原操作期限。

总期限从派发开始，包含初始化与受理等待，收到受理/输出不续时。Claude/Codex 的显式 `requestTimeoutMs`、`turnTimeoutMs` 可进一步缩短宿主预算，较长值不能延长宿主期限；独立清理预算使用 Claude `cleanupTimeoutMs`、Codex `closeTimeoutMs`，不能混用字段名。CLI 的这些 provider 参数均接受 1..3600000 整数毫秒。`maxQuarantinedDispatches` 接受 1..1024 整数且不能小于有效 `maxActiveSessions`；降低额度不会删除历史记录，超额时只阻止新增工作。

`scheduler.get()` 返回 A/Q/R、有效额度、`canDispatch`、原因及最多 16 条占用/冲突引用；`sessions.get()` 的可选 `execution` 返回租约、隔离状态、预算起止与来源。TS 和 Python 都可通过普通 socket 读取。SDK 要求精确的 `executionIsolation={version:1,resourceRelease:true,schedulerStatus:true,ownerConflictResolution:true,budgetVersion:2}`，旧宿主缺能力时发送前返回 `UNSUPPORTED_CAPABILITY`。[实际查询与所有者冲突处理示例](SDK_USAGE_AND_WIRING.md#115-本轮已实现调度查询与资源冲突)说明字段与权限。

当前存储 schema 为 2，wire 仍为 1.0、事件 schemaVersion 仍为 1。打开 schema 1 状态目录时，宿主先在同目录生成并核验 `store-schema1-<uuid>.sqlite` 备份，再事务升级；失败时不提交模型调用。旧记录缺少租约时保守恢复，已有期限不刷新。旧宿主不支持 schema 2；备份恢复不等于撤销备份后的副作用，不能用旧库重放工作。自定义适配器须实现 `executionBudget.version=2`，用 `null` 表示未显式设置的 provider cap，并遵循剩余单调预算；缺能力的适配器在任务创建/派发前被拒绝。停止证据能力与通知契约见 A2 规格，不能只添加声明就声称可安全释放资源。

```sh
node packages/cli/src/main.ts doctor --config /absolute/orchestrator.json
node packages/cli/src/main.ts host --config /absolute/orchestrator.json
```

`doctor --config` 当前只验证配置，不代表依赖、官方运行时或模型已经可用；输出明确标记 `configuration-only`。`doctor --socket` 只验证运行宿主的握手。通过 `--stdio` 启动时不打开业务 socket，stdout 只传协议帧。

客户端连接示例：

```ts
import { connectOrchestrator } from './packages/sdk-typescript/src/index.ts';
const orch = await connectOrchestrator({
  socketPath: '/absolute/private-state/host.sock',
  requestTimeoutMs: 30_000,
});
```

TypeScript Unix 连接的普通 RPC 默认等待 30 秒，与 Python 的默认请求等待一致；`requestTimeoutMs` 可调整默认值。连接参数 `timeoutMs` 只控制建立连接，initialize 单独限时 5 秒。读取与变更方法可用请求选项 `{timeoutMs, signal}` 覆盖单次等待，例如 `orch.tasks.get(taskId, {timeoutMs: 5000})`。连接、默认请求与单次请求期限均为 1..2147483647 的整数毫秒。变更超时保留 method/scope/idempotencyKey，先查询回执再决定后续操作；超时不取消远端任务，也不关闭仍可使用的连接。显式 task.wait 总期限独立；owner close 的 RPC 等待使用关闭预算加 1000ms 回执余量。

```python
from agent_orch import Orchestrator

async with Orchestrator.connect(socket_path="/absolute/private-state/host.sock") as orch:
    current = await orch.tasks.get(task_id)
```

CLI 提交、查看、批准的参数可运行 `node packages/cli/src/main.ts --help` 查看。CLI 没有自动批准，也不会默认启用 fake。SIGINT/SIGTERM 按宿主自己的关闭流程处理，只回收自有进程。

当前 CLI 配置可用 `"shutdown": {"mode": "drain", "timeoutMs": 30000}` 指定 SIGINT/SIGTERM 的关闭行为，Unix 与 stdio 均生效。未配置时保留原默认值：Unix 为 interrupt / 1000ms，stdio 为 interrupt / 30000ms。关闭超时在 stderr 返回 `SHUTDOWN_INCOMPLETE` 和 `operationId`，保持控制入口，可再次发送信号按同一模式续等；stdio 所有者也可发送 `host.shutdown.continue`。drain 不自动升级为 interrupt。父进程意外断开 stdio 的 EOF 清理另按 30000ms interrupt 执行。

## 结果与异常的处理

- 较长输出的全文在 `stateDir/artifacts/<sha256>.txt`，快照 result/批准 summary 超过 64 KiB 时只显示明确标记的预览和 artifactRefs；不要只看截断预览就批准完整成果。事件重放同时限制条数与编码字节。
- 创建回执表示落盘；`runtime_accepted` 表示取得上游受理证据；消息 completed 表示该批次处理结束。只有 task.completed 表示成果已验收。
- 幂等作用域：tasks.create 为 `local`；任务控制为 taskId；session 控制和消息为目标 sessionId；批准为 approvalId；scheduler.resolveConflict 为 conflictId。回执丢失时用 `operations.lookup({method,scope,idempotencyKey})` 查询，不换键盲目重发。
- 事件游标必须和 storeId 一起保存。`events()` 使用有界只读轮询，不请求模型，也不因慢消费者无限缓存推送。非零游标缺 storeId/来自另一 store 时拒绝。
- `SHUTDOWN_INCOMPLETE` 保留 client 与 operationId；选择继续 drain 或显式 interrupt，直到关闭确认。关闭异常不能吞掉原业务异常或 Python 取消。
- 重启不自动恢复任务。running/dispatching 无法核对时进入 blocked/outcome_unknown；超时和迟到结果也不会自动解除隔离。用下述人工核对入口处理，不直接编辑数据库。
- usage 字段缺失保留 null，不估算费用、不声称缓存命中或成本下降。没有付费心跳或额外管理 LLM。

`sessions.reconcile(target, evidence, options)` 仅供 TS 嵌入所有者或 Python 受管 stdio 所有者提交人工核对声明；普通 socket 客户端返回 `UNAUTHORIZED`。SDK 先协商 `initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true}`；旧宿主缺能力时拒绝调用。该入口不会自动读取上游历史，也不会替人证明外部副作用。

声明必须分别记录本地资源、远端执行及副作用是否已核对。两端均 stopped 且没有活动句柄/证据冲突时，允许只释放执行租约：`result.executionReleased=true`、`result.resolved=false`；业务 outcome/sideEffects 仍 unknown 时 Q、blocked 状态和原 activeDispatchId 保留。Python 的 operation.result 是原始 JSON，使用 `["executionReleased"]`。确认 completed 后保存结果并保持 paused，显式 resume 只重新申请验收；确认 not_executed 后才允许显式重排；failed/interrupted 将原任务置 failed。原 unknown 操作保留历史并追加 resolution。[双语言核对示例](SDK_USAGE_AND_WIRING.md#114-本轮已实现所有者人工核对)提供精确目标和幂等键用法。

Claude 缺少 spawn 观察时也可由所有者人工收尾：执行观察必须已经结束，启动回调已封闭，且不存在已观察进程。提交精确目标与 `localResources: "stopped"` 声明后，宿主先提交审计与收尾准备记录，再解除对应的未知记录；收尾成功后记录 `session.resources_reconciled`，回执含 `unobservedResourcesReconciled: true`。这不产生自动退出证据，远端仍 unknown 时不释放执行额度。真实活进程、过期目标、证据冲突与普通 socket 客户端仍被拒绝。宿主主动关闭返回 `SHUTDOWN_INCOMPLETE` 后，这个核对入口仍可用，随后可沿用原 operationId 续等关闭；任务创建、执行恢复和消息派发仍保持关闭。

第三方适配器 prepare 返回非函数或抛错时，提交前拒绝并返回 `INVALID_RUNTIME_CONTRACT`。finalizer 在声明已提交后失败，则返回 `RESOURCE_CLEANUP_INCOMPLETE`，包含 `operationId` 与 `auditCommitted: true`；可查回执的 `result.resourceCleanup.status`，并用原目标、原声明和同一幂等键显式重试 reconcile。get/lookup/wait 只读取回执，不推进收尾；单纯等待 persisted 回执会到达本地超时。pending 时 scheduler 原因含 `RESOURCE_CLEANUP_PENDING`，本宿主停止新派发，成功后恢复，不自动重试。若内存解除已完成但确认写入失败，重试只补写完成回执；重启后丢失原 finalizer 则保留 outcome_unknown，不借用新适配器冒充原收尾成功。人工声明已落盘与资源记录已解除是两个独立状态。

已释放执行出现匹配的矛盾证据时，`EXECUTION_EVIDENCE_CONFLICT` 会持久阻止后续派发，重启不自动解除。所有者通过 `scheduler.getConflict` 读取原 conflictId/revision，再以新的停止证据调用 `scheduler.resolveConflict`；它不修改业务验收历史或自动减少业务隔离 Q。普通 socket 无权解除，多个冲突须逐项处理。

## Claude/Codex 现状

两者均实现只读单轮入口、显式 native session resume 和本轮有界观察/清理；未确认回收的自有资源继续阻止 reconcile 放行。完整能力与未验收项见 [SPEC-0002](docs/specs/0002-runtime-adapters.md)。Claude 官方包是可选依赖，只有 execute 时才加载；Codex 使用本地受管 App Server 子进程。支持矩阵按锁定版本与实际测试证据判断，不能用命令行版本号代替运行验收。

Claude 通过 SDK 的 `spawnClaudeCodeProcess` 回调记录本次自有子进程，并以实际退出事件确认本地清理；Query.close 返回、iterator.return(done:true) 或 AbortSignal 不再代替退出证据。SDK 使用前半段 cleanupTimeoutMs 预算自行清理，随后对尚未退出的自有进程执行 stdin EOF/SIGTERM 兜底，并在剩余预算内观察退出；close 失败或不存在时立即兜底。永久 pending、无效返回或 SDK 未透传 signal 都不会跳过兜底，整个异步等待不额外延长原总预算。仍未退出的资源继续占用，迟到退出可更新证据；仅本地退出不足以证明远端终态。自定义测试 query factory 需要通过 `request.options.spawnClaudeCodeProcess({command,args,cwd,env,signal})` 启动可观察的 fixture；忽略该回调会保守保持资源未知，需满足上述条件后由所有者核对。当前验证使用真实离线 fixture 子进程，尚未完成真实厂商模型验收。

完整接线设计中的 `auth`、`executable`、MCP 桥和网关示例不是当前 CLI 的完整实现接口。尚不支持的字段会拒绝；未来开发必须同步 spec、配置校验、双语言契约和文档。真实模型验收、发布包和许可证选择是后续明确的工作项。
