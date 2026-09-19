# SPEC-0003：选路责任、保留策略与过渡态期限

日期：2026-09-19。状态：0003-A 生命周期及 0003-A2 执行隔离增量已实现并完成离线 fixture 验证；0003-B/C 仍待 TDD 实现。A 历史证据见 [原记录](../tdd/0003-a-evidence.md)，A2 接线证据见 [本轮记录](../tdd/0003-a2-wiring.md)，真实模型尚未验收。依据：[主设计](../../AGENT_ORCHESTRATION_DESIGN.md) 4.5、5.1、5.4、6.1、6.2、9.1、12.1 节。基础增量的历史验收继续保留在 SPEC-0001/0002 和既有证据中。

当前 [0003-A2：执行占用与结果隔离](./0003-a2-execution-isolation.md) 已将新轮次默认总预算改为 1800 秒，执行租约与业务隔离分别计数。下一步 B 的逃生契约见 [0003-B：归档与命名空间切换](./0003-b-archive.md)，归档切换仍未实现。双语言、双运行时首版承诺保持，provider 可分别开发和验收，不降低共同发布闸口。

## 1. 问题、范围与实施顺序

设计中的“独立工作/相关背景”缺少明确决策者，旧压缩估算忽略 TTL 重建和历史增长，存储保留及 pausing 等过渡态也缺少统一退出条件。本轮把这些约定变成可观察行为，防止由实现中的任意常量决定。

实施顺序如下；A/A2 为当前基线，后续推进 B/C：

1. **0003-A：deadline 与核对，已实现。** 提供持久执行/控制期限、单调计时、unknown 名额隔离、迟到证据保留、适配器有界观察/自有资源清理及所有者人工核对。fork/compact/rotate 和上游历史自动 inspection 不在此次实现范围。
2. **0003-A2：执行占用与结果隔离，已实现并通过离线 fixture 验证。** 只有执行及资源均确认停止才释放执行槽，业务 unknown 保留在有上限的隔离账本；在途任务预留隔离额度。引擎及两家适配器共享有限预算，新轮次默认 1800 秒；停止证据、重启与诊断由 A2 独立验收，真实模型结果仍未验收。
3. **0003-B：保留和存储故障，待实现。** 增加保护引用、幂等 tombstone、GC、原子快照与 cursor 下界、存储背压、显式归档/新命名空间切换及故障恢复。升级 schema 前提供可恢复备份；旧数据不因新版本启动立即删除。旧 namespace 请求不能因切换到新 store 而重新执行。
4. **0003-C：声明选路与账本，待实现。** 增加 contextPlan、候选排队/回退、唯一成本归属与逐请求成本估算。fork 和经济自动优化依旧受真实能力/收益闸口控制。

本 spec 不授权发布、部署、初始化 Git、运行付费实验或删除真实用户数据；不改变双语言双运行时产品范围。常规测试在自身临时目录和故障替身中执行。MCP 工具沙箱、性能支持矩阵、包发布和上游兼容性另有阶段闸口，不以此 spec 的测试代替。

## 2. 契约与配置

当前宿主 JSON/TS 配置 `timeouts` 默认 `acceptanceMs=30000`、`turnMs=1800000`、`drainMs=300000`、`interruptMs=30000`、`reconcileMs=60000`；每项允许 1..86400000 整数毫秒。Python 用 `LifecycleTimeouts` 的 snake_case 字段和 `to_wire` 写宿主 JSON，再经 `engine_command` 的 `--config` 传递，`local()` 不新增 timeouts 参数。SDK 等待额度独立。下表的 B/C 规则和 compact/recover/rotate 期限仍是拟议约束，不是已接受的配置；模型工具无权修改保留期或控制配置。

| 领域 | 契约 |
| --- | --- |
| 选路 | contextPlan 包含 requestedMode、independent、dependencyTaskIds、contextRefs、candidateSessionId?、snapshotRef?、fallbackModes、maxQueueWaitMs；不从自然语言自动推断独立性；有主会话而未指定时 continue |
| 排队 | 默认最多 30 秒，0 表示不等待；幂等重试不刷新首次入队时间；fallback 默认空；所有超期分支均原子撤销尚未派发的旧队列项，无 fallback 则保存 blocked/操作 failed |
| 控制 | 已实现 dispatch 受理 30 秒、drain 300 秒、interrupt 30 秒、reconcile 60 秒，以及 operation.lifecycle 的 enteredAt/deadlineAt、policyVersion、目标代次/dispatch、可能发送标记和最后证据；compact 300 秒、recover/rotate 60 秒仍待实现 |
| 业务执行 | A2 新轮次默认 1800 秒，从派发开始且包含初始化/受理，受理和输出不续时；宿主/适配器共享剩余单调预算。已有显式更短配置继续生效，较长 provider cap 不延长宿主期限，持久期限不因升级刷新 |
| 执行与隔离 | 执行名额默认 2，maxQuarantinedDispatches 默认 32（1..1024 且不小于 maxActiveSessions）；A 为 held 执行租约，Q 为业务 unknown，R 为未隔离的在途预留（含待清理）。新派发要求 A 小于执行额度且 Q+R 小于隔离额度；释放 A 不减少 Q |
| 关闭 | 每次 close/continue 默认等待 30 秒；到期仍 stopping + SHUTDOWN_INCOMPLETE，保留句柄，不暗中升级中断；EOF 触发有界紧急关闭（最多 30 秒），仅回收确认自有资源 |
| 保留 | 事件至少 30 天、终结操作/消息详情至少 90 天、未受保护终结产物至少 90 天、原始 usage 至少 180 天；起点和保护引用见主设计 4.5 |
| 防重 | 最小 tombstone 与 store 同寿命；详情过期返回 OPERATION_HISTORY_EXPIRED 及原 ID，不得当作新请求；不同载荷继续冲突 |
| 存储 | 初始配额 10 GiB、80% 告警、90% 背压；可用空间低于 1 GiB 背压；256 MiB 应急文件；100 万最小快照/tombstone 上限。均为待验证的拟定默认值 |
| GC | 唯一宿主启动恢复后/每小时执行；每批最多 500 条或 8 MiB 候选，事务目标 50 ms；引用保护、文件隔离区和删除结果可恢复 |
| 费用 | dispatch 发送前绑定 costOwnerTaskId/rootTaskId；同批次不混装计费任务；原始计量缺失保留未知；多次请求和父子汇总去重 |

已实现的 `sessions.reconcile` 只允许 `CallContext.owner=true` 的宿主所有者：TS 嵌入和 Python 受管 stdio 可调用，普通 socket 客户端返回 UNAUTHORIZED。通过 `initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true}` 在 wire 1.0 上协商，新 SDK 遇到缺失能力在发送前拒绝。evidence 是所有者人工核对后提交的声明，不是模型判断或上游历史自动 inspection；准确字段见 0003-A 实施契约。

资源停止与业务结果核对分开：确认本地进程退出不解除远端未知配额。任何 unknown 继续隔离，当前自有消费/清理句柄未结束或终态证据冲突时拒绝放行。completed 保存结果并转 paused，显式 resume 仅重新申请验收；not_executed 转 paused 后允许显式重排；failed/interrupted 将原任务置 failed。原 unknown 操作保留状态并补 resolution，任务不会因核对自动 completed。独立恢复任务的风险审批仍是后续产品流程，不能据此绕过当前隔离。

A2 已将上述“放行”分层：localResources 与 remoteExecution 均已核对 stopped、没有活动句柄或证据冲突时，可只释放执行租约；sideEffects/outcome 仍 unknown 则 `result.executionReleased=true,result.resolved=false`，原业务继续隔离，resume 仍禁止。Python 的 operation.result 保留原始 camelCase 键。

`scheduler.get` 只读返回一致的 A/Q/R、有效额度、原因及最多 16 条占用/冲突引用；`scheduler.getConflict` 读取指定冲突。已释放执行出现矛盾证据时，持久关闭派发闸门，所有者按 conflictId/revision 提交停止证据到 `scheduler.resolveConflict`，逐项解除；该操作不改写业务结果或验收历史。SDK 严格协商 executionIsolation v1/budgetVersion 2；普通 socket 允许查询，无权解除冲突，幂等 scope 为 conflictId。

存储 schema 已升至 2，wire 1.0 与事件 schemaVersion 1 保持。schema 1 升级前先生成并核验同目录 `store-schema1-<uuid>.sqlite` 备份，再事务升级；未知/缺字段记录保守恢复，旧期限不刷新。自定义适配器须实现 executionBudget v2 及剩余单调预算语义，未显式设置的 provider cap 用 null；缺能力时任务创建/派发前拒绝，不能仅靠添加 capability 字段获得安全释放承诺。恢复旧备份后的副作用核对与 B 的完整归档/身份切换仍属不同边界。

拟议 `state.snapshot` 在一个一致数据库视图中返回当前可见任务/会话/批准、retentionFloorCursor、storeId 和快照 cursor，按固定 snapshotId/cursor 分页并遵守帧上限；默认租期 60 秒，超期 SNAPSHOT_EXPIRED，期间视图和续传基线受保护。后续从完整快照的 cursor 排他读取。retentionFloorCursor 是已清理连续前缀的最后 cursor；等于下界可续读，小于下界才过期。GC 后旧的 0 不能无提示跳过历史。所有变更与重试绑定已确认 storeId；新增方法和字段需协议版本协商，旧客户端不得静默忽略。未知能力与不兼容协议仍在发送模型请求前拒绝。

## 3. 编号验收条款

### 0003-A：有限期限与逃生

- AC-A01：使用受控时钟验证每种已支持控制的边界前后行为。SDK wait 超时不取消控制，operation 的执行 deadline 也不被重试/重启刷新；时钟回拨不造成无限等待。
- AC-A02：同一超时分别覆盖“明确未提交”和“可能已提交”。只有前者可记录确定失败；后者将 operation、Session、dispatch、消息/outbox 及 Task 事务性收束为 unknown/blocked。结果未知不得重发，资源配额不误释放。
- AC-A03：pause(drain) 超时不自动调用 interrupt；interrupt 回执、iterator 结束或进程退出均不能单独伪造停止终态。未支持的动作在发送前拒绝。
- AC-A04：迟到的终态按身份与代次关联原 dispatch；核对可补 resolution，但不能重复结果/账单、使新代次暂停或自动验收任务。
- AC-A05：重启读取已过期 deadline，默认不调用模型；人工 reconcile 记录证据、操作者和结果。单纯进程退出不解除业务 unknown；仅在活动资源及 dispatch/消息/副作用均核对后转 paused。后续 resume 不重放已执行请求；证据不足不解除 unknown。
- AC-A06：关闭超时保留有效句柄/operationId；所有者可继续等候或显式升级。真实 fixture 子进程验证 EOF 紧急处理、自有进程退出及无法确认退出分支；PID 复用和共享进程另有活动会话时不得误杀。迭代器 next/return 永不返回也不能卡住 SDK 的有界关闭响应。

### 0003-A2：已实现的执行隔离增量

AC-A2-01–12 定义于 [A2 子规格](./0003-a2-execution-isolation.md)。它们追加于 A 的历史验收，而非用新默认值重写旧 RED/GREEN。先验证仍可能执行的 unknown 不释放名额，再验证停止已证明的 unknown 能释放名额；不以扩大实际并发来消除原来的阻塞。

### 0003-B：保留、恢复与背压

- AC-B01：通过注入时钟验证保留边界。活动任务、unknown dispatch、pending 批准、未处理 outbox、恢复检查点和 pin 引用都不被清理；共用摘要的产物必须检查全部保护引用。
- AC-B02：90 天窗口内同键同载荷返回原回执；详情回收及重启后仍指向原操作并返回明确过期状态，不创建第二 dispatch；不同载荷继续冲突。消息消费去重也遵循该规则。
- AC-B03：清理事件连续前缀与推进 retentionFloorCursor 原子完成；并发 snapshot 分页/提交/续读无静默遗漏、单帧不越限；快照到期不可与新快照拼接。旧游标（含 0）返回 CURSOR_EXPIRED，绑定错误 storeId 拒绝。
- AC-B04：在产物候选标记、引用核对、移入隔离区、删除、登记结果各步注入崩溃；恢复后无未标记悬空引用、不删正在新增引用的产物、GC 自身不产生模型调用。
- AC-B05：容量阈值阻止新增工作但保留查询/收尾；达到 tombstone 上限不能通过删除防重数据继续接单。所有者改配额可审计，普通模型工具无此权限。
- AC-B06：在操作落盘前、发送后、终态提交时注入 SQLITE_FULL/ENOSPC/I/O 故障。未提交不发 durable 回执；持久化未知也写不下时宿主停止派发，重启从旧 dispatch 核对，不靠补偿写必然成功的假设。不得退回内存队列继续运行。
- AC-B07：已有数据库迁移保存旧幂等键和 unknown 证据；首次迁移不立即回收旧数据。回滚旧备份或将备份用于独立实例时分配新 storeId 并记录来源，普通重启不换身份。验证“备份后 K 执行、恢复旧备份、重试 K”不能因 tombstone 丢失再次自动派发；SDK 拒绝旧身份透明重试，备份后副作用须独立核对。

归档与命名空间切换的 AC-B08–B18 见 [0003-B 子规格](./0003-b-archive.md)，与 B01–B07 共同构成 B 的验收：必须覆盖阈值后的收尾预留、旧请求身份绑定、无未决执行的切换前置条件、归档可查询、损坏失败闭合、旧写入者失效及每步崩溃恢复。不能以“允许归档迁移”四字代替实现和证明。

### 0003-C：声明、排队与核算

- AC-C01：相同授权、能力快照、状态和 contextPlan 得到相同候选/理由；只改变自然语言 goal 不自动增开会话。模型声明独立性不能绕过依赖、权限、预算或写入冲突检查；未声明 fallback 不静默降级。
- AC-C02：忙会话的等待项不占全局执行槽、不阻塞其他就绪会话；首次入队计时稳定，所有过期分支均原子撤销未派发旧项。无 fallback 保存 blocked/操作 failed 并确保日后不派发；有 fallback 最多发一条路径。若已开始提交则返回真实 dispatch 状态或 unknown，不能同时报告确定未执行的队列失败。
- AC-C03：逐请求费用 fixture 同时覆盖 keep/compact 的持续命中、跨 TTL 重建、部分前缀保留及 H_i/K_i 增长；压缩自身只计一次，价格单位正确，重叠累计字段归一化后不重复计价。缺失关键计量或未来请求间隔不可估时返回区间/unknown，不自动宣称某策略省钱。
- AC-C04：A/B/C/D 串行复用会话，D 的读取和重建全部归 D；父委派/汇总归父、子执行归子，root 汇总按计费记录去重。失败尝试和 host_overhead 进入实验总费用；成功数为 0 不报零成本。
- AC-C05：每项能力记录运行时/profile/验证证据。模拟 A01–A08 假设证伪，分别触发禁用、不支持、unknown 或优化关闭；不能靠放宽权限、自动换模型/重建会话或伪造已通过来跨越闸口。

## 4. TDD 与交付证据

每个增量先选择对应 AC 写失败测试并记录真实 RED 原因，再实现 GREEN；已有正确行为只补回归，不伪造失败历史。保留期/期限使用可控时钟；进程、存储崩溃与跨语言协议使用实际临时子进程/数据库验证，不能全靠 mock 引擎方法。

共享 wire、迁移或生命周期改变时运行 `npm test`、`npm run test:python`、`npm run typecheck` 与 `npm run format:check`。0003-A 证据单独记录在 [汇总](../tdd/0003-a-evidence.md)、[接线](../tdd/0003-a-wiring.md)、[Python](../tdd/0003-a-python.md)、[Claude](../tdd/0003-a-claude.md) 和 [Codex](../tdd/0003-a-codex.md)；基础增量的旧测试数不替代新增 AC。B/C、真实运行时能力、缓存/费用和容量上限仍需独立实现或实验，结果与离线故障回归分别报告。

实施结束同步主设计、SDK 使用说明、实际 README、能力表和 schema；保留未实现项。规格中的超时/配额默认值修改需记录理由及受影响行为，不以调整常量绕过失败用例。
