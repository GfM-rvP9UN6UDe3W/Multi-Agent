# SPEC-0003-A2：执行占用、结果隔离与统一期限

设计日期：2026-09-19；实现验收日期：2026-09-20。状态：A2 已实现并通过离线 TDD 与真实本地子进程集成，记录见 [A2 验证证据](../tdd/0003-a2-evidence.md)；真实厂商模型验收仍待独立完成。用户已选择先修 N1，再推进 [0003-B](./0003-policy-retention-deadlines.md)。本规格修订 [0003-A](./0003-a-lifecycle.md) 的调度计数和期限策略，不改写原实现及历史测试证据。

## 1. 问题、范围与成功标准

A2 实施前的 A 基线将非空 activeDispatchId 全部计入最多 2 个执行名额，单轮默认 300 秒；两家适配器还分别保留 300 秒终态限制。离线复现中，两项任务超时后均 blocked/outcome_unknown，第三项 queued；即使前两项后来返回终态，也需人工核对才能继续派发。

目标：长任务使用一致的有限执行期限；已确认结束执行且完成资源清理的 unknown 只占结果隔离额度，让其他允许执行的任务继续。仍可能执行的 unknown 必须继续占执行名额，不能通过改状态扩大真实并发。业务结果、副作用和验收继续独立核对。

范围包括引擎调度、两家适配器、内部 RuntimeInput/RuntimeEvent 契约、TS/Python SDK、CLI 配置、只读诊断和升级恢复。只增加必要的资源证据，不实现上游历史自动 inspection、GC、跨任务会话复用、依赖调度、工作区并发写入、自动验收、fork/compact/rotate。

成功不是“任何故障下永不阻塞”：真实执行未明、资源未释放或隔离记录达到上限时，必须停止相应新派发并给出原因。两份迟到且完整的停止证据应能释放执行槽，而无需先把业务 unknown 改成成功。

## 2. 两种占用和准入公式

以 dispatch 为计数单位；当前每会话最多一个在途 dispatch，因此执行计数与会话执行名额对应。`activeDispatchId` 继续保存未核对 dispatch 的关联身份，不再独自决定执行槽是否占用，也不能为了腾槽清空它。

| 量 | 定义 | 开发默认值 / 范围 |
| --- | --- | --- |
| A：执行占用 | 已获派发许可、尚未持久化完整停止证据的 dispatch；含正常在途及仍可能执行的 unknown | `limits.maxActiveSessions=2`，仍为 1..2 |
| Q：结果隔离 | 业务结果仍为 outcome_unknown 的 dispatch；无论是否已释放执行槽 | `limits.maxQuarantinedDispatches=32`，整数 1..1024，且不小于 maxActiveSessions |
| R：隔离预留 | 租约 held、尚未隔离且尚未确定结算的 dispatch；包括初始化、执行和已见终态但仍待清理阶段，每项预留一个可能需要的隔离记录名额 | 从持久化 dispatch 推导，不是独立配置 |

新派发必须同时满足 `A < maxActiveSessions` 与 `Q + R < maxQuarantinedDispatches`，并通过已有任务、会话、权限及轮数检查；检查、取得执行租约和预留隔离名额在同一事务内完成。任务仍 queued 时不占 A/R。正常任务结束并结算后释放 A/R；超时把 R 转成 Q，因此 `Q + R` 不增加。unknown 得到完整停止证据时只释放 A，仍占 Q；完成业务 reconcile 才释放 Q。

Q 与 A 可以重叠：仍可能执行的 unknown 同时占两者。隔离上限不是额外可运行的模型名额；任何时候都不允许用 2 个正常会话加 32 个仍运行的 unknown 来规避并发限制。32 是限制人工核对积压的试点值，不是测量出的容量结论。

达到执行上限时，新任务按现有规则排队。达到 `Q + R` 上限时，既有队列保留、停止新派发；新增任务、增加待处理工作的 messages.send 和会产生新执行的 resume 返回 `QUARANTINE_CAPACITY_EXCEEDED`，不新增业务操作或消息记录。处理顺序必须先做原幂等键查重：原请求仍返回原回执，同键异载荷仍冲突，不能被新的容量状态改写。查询、核对、取消、批准和关闭仍可用；已保存结果的 resume 仅重新申请验收，作为收尾允许，不能一并拒绝。批准触发后续邮箱工作时只入队，不绕过派发门槛。

配置仅由宿主所有者设置，普通客户端/模型不能扩大配额。本增量不增加热更新接口；重启配置可提高额度，须保留旧记录与原期限。有效配置低于恢复出的 Q/R 时允许诊断和收尾启动，拒绝新工作，不删除、挤出或自动解决 unknown；结构非法或 maxQuarantinedDispatches 小于 maxActiveSessions 时仍在启动前报配置错误。

## 3. 释放执行槽的证据

必须同时证明“该 dispatch 的执行已结束”与“其自有本地资源已清理”。以下都不能单独释放 A：超时、AbortSignal、interrupt 回执、迭代器结束、Promise 返回、PID 消失、`hasActiveResources=false`、重启后内存句柄为空、模型文本声称完成。

允许的证据来源：

1. **明确未提交**：适配器证明没有提交业务请求，且本地资源已经清理。可按现有规则确定失败，不制造业务 unknown。
2. **匹配的运行时终态 + 清理确认**：由适配器关联 provider、原生 session/turn、dispatch 和 generation；终态可以是成功、失败或已确认中断。只有 provider/profile 的能力契约保证该终态涵盖本轮所有受管执行，且本地清理完成，才足以释放 A。派生进程/远端任务仍可能运行或能力未验证时，不能据终态擅自声明资源安全。
3. **所有者资源声明**：沿用 owner-only `sessions.reconcile`、精确 target 和幂等键；localResources 与 remoteExecution 均为 stopped，且无当前活动执行/清理句柄、无冲突证据时，允许只释放 A。sideEffects 或 outcome 为 unknown 时，操作结果 `resolved=false`，任务仍 blocked、会话仍 outcome_unknown、Q 不减少。操作者必须明确核对过资源，接口不替代调查。

第 3 项是对 0003-A“任一 unknown 都不放行”的细化：业务放行条件不变，资源放行另行记录。仅 localResources=stopped 而 remoteExecution=unknown 时仍占 A；只要运行时保留活动清理句柄，所有者也不能强行释放。

适配器新增显式执行/清理证据通道或查询，不能由引擎根据通用 result/error 的字段猜测。该内部契约至少携带 dispatchId、generation、providerSessionId、可用时的 providerTurnId、证据来源、观测时间、localResources、remoteExecution 和原始证据引用。现有 RuntimeEvent 的 outcome=failed 不自动等价于“明确未提交”。

适配器须在看到真实终态时保留它；若清理超时，业务仍 unknown，但不能丢弃终态证据。清理后来完成时必须向引擎发出与原 dispatch 关联的通知或可订阅的状态变化，使引擎重新评估租约；不得依赖已结束的事件迭代器、额外模型心跳或人工再发一次请求才能发现。通知重复、乱序或迟到不能重复释放或影响新代次。

完整停止证据、租约 released 和诊断事件在同一事务持久化后，才唤醒调度器。业务 outcome_unknown、消息/outbox 隔离、原控制状态和未决验收不随资源释放改变；不得重排原 task/session 或投递其邮箱。不同 taskId 不足以证明业务语义独立，当前仍限已有只读 profile，不新增依赖或写冲突安全承诺。

## 4. 持久化、恢复和核对

每个 dispatch 增加版本化 executionLease：`status=held|released`、acquiredAt、releasedAt?、releaseReason?、releaseEvidenceRef?；另保存是否业务隔离及隔离进入时间。释放证据包含原所有者实例及完整目标，足以区分“执行结束”与“结果已验收”。原 generation/dispatch 身份不因释放改变。

- 超时前后、收到终态、清理完成、人工部分核对、最终 reconcile 均事务性更新上述状态及 Q/R，使用数据库事实重算，不能只维护内存计数。
- 已持久化的释放证据可在重启后继续释放 A，Q 仍保留；未完成的释放事务按 held 恢复。缺少新字段的旧 unknown 按 held+Q 恢复，普通旧完成记录不重新隔离。升级不自动把旧 terminalEvidence 当作完整停止证据。
- 记录仍为 held，而新进程拿不到句柄，并不证明本地或远端执行结束；不得按保存的 PID、名称或端口查杀。恢复不重置期限、不重发旧 dispatch。
- 同一可信目标的更正/冲突证据一旦推翻释放结论，必须持久化 conflict（id、revision、dispatchId、generation、原释放/新冲突证据引用、open/resolved）并立即停止新的派发，报 `EXECUTION_EVIDENCE_CONFLICT`；重启仍保持该闸门。错误目标/过期代次的事件只拒绝和审计，不能被当作当前目标的冲突或释放证据。
- completed 的最终人工核对仍只保存成果、转 paused；resume 只重新申请验收。空字符串或纯空白结果保留原文供人工验收，不能因为没有文本就冒充未执行；结果字段仍必须是字符串并遵守长度上限。not_executed、failed、interrupted 保持 0003-A 的原分支，不因新计数规则自动执行或批准。

旧 schema 的升级必须经过版本检查和可恢复备份；较旧引擎拒绝打开新 schema。schemaVersion 与 wire 版本分别处理，不能把新租约字段伪装成旧实现已支持的行为。

冲突解除使用 owner-only `scheduler.resolveConflict({conflictId,expectedRevision,evidence,idempotencyKey})`，以原 dispatch 的持久冲突记录定位，不依赖 session 当前 activeDispatchId。只有原执行与受其影响的资源占用已重新核实、原执行本地及远端均停止且无保留句柄，才可标记 resolved；声明及依据完整留存。仍运行、证据不足或未知则拒绝解除；多个冲突逐项处理，全部解决且普通容量/关闭闸门允许后才恢复新派发。该操作不改写已完成的业务记录、原 unknown 或验收历史；业务矛盾单独留存并交由原核对流程处理，不通过资源解除伪造成功。同键回执可重取，普通 socket、旧 revision、冲突证据均拒绝。

## 5. 单一执行预算

新建 dispatch 的宿主默认 `timeouts.turnMs=1800000`（30 分钟）；受理仍 30000、drain 300000、interrupt 30000、reconcile 60000，校验范围仍为 1..86400000 整数毫秒。1800 秒是待真实任务校准的开发默认值，不是正常任务耗时保证，也不是成本收益结论。既有持久期限不被升级、重试、消息输出或配置变更延长。

单轮总预算从派发落盘前确定的开始点计算，包含适配器启动、初始化和受理等待；受理后不得重新获得完整 turnMs。引擎及两家适配器使用同一单调预算，UTC deadline 仅用于持久化与重启诊断。运行时既不依赖可回拨的墙钟，也不通过每个 RPC/普通消息刷新预算。

内部 RuntimeInput 新增宿主预算，含 policyVersion=2、持久化的起止时间以及同一单调时钟下读取剩余受理/总预算的只读接口；该接口是进程内能力，不进入 JSON 或 Python wire。引擎持有截止判断权，适配器对每次等待使用剩余预算，终态提交前再次检查。即使 event-loop 定时器迟到也不能把逾期事件当按时完成。

两家适配器在宿主模式下取消各自隐含的 300 秒限制，缺省值统一来自上述预算；离开引擎单独调用时，适配器自己的默认总期限也改为 1800 秒。已有显式 `requestTimeoutMs` / `turnTimeoutMs` 不被悄悄忽略：适配器在派发前以静态能力元数据声明显式上限，宿主取相应宿主上限与显式上限的较小值，保存实际 effectiveAcceptanceMs/effectiveTurnMs 和来源。请求等待还须受剩余总预算约束；显式设置 300 秒的使用者仍得到 300 秒限制，并可从诊断确认原因。

默认值与“显式设置”的来源必须可区分，不能把适配器旧默认 300 秒伪装成用户显式配置。新内部预算契约经 adapter capability 协商；不支持的适配器在本模式下于提交前返回 UNSUPPORTED_CAPABILITY，不降级成有隐藏期限的执行。fake 和两家内置适配器均需接通，独立适配器迁移说明列出新增要求。

清理使用独立有限预算，保持 Claude 默认 1 秒、Codex TERM/KILL 各默认 1 秒的原语义；不通过延长清理获得更多业务执行时间。SDK wait、控制期限和宿主 close/continue 的等待上限不因 turnMs 调整而改变。只改引擎常量、遗漏 provider 的隐藏超时，不满足本规格。

## 6. 对外可观测性和兼容

本增量已新增 `initialize.capabilities.executionIsolation={version:1,resourceRelease:true,schedulerStatus:true,ownerConflictResolution:true,budgetVersion:2}`，原 lifecycle v1 能力继续保留。配置、能力、公共 schema 与双语言接线已同步实现；wire 版本保持 1.0，存储 schema 独立升级到 2。

新增只读 `scheduler.get`（SDK 为 `orch.scheduler.get()`），返回 maxActiveSessions、maxQuarantinedDispatches、executionOccupied=A、quarantined=Q、quarantineReserved=R、canDispatch、原因列表，以及最多 16 条占用示例（taskId/sessionId/dispatchId、租约状态、最后证据、进入时间）和 `truncated`；另返回未解决冲突数及最多 16 条 conflictId/revision/dispatch 引用。当前可信本地客户端可读取，不授予核对权限；当前任务明细从任务/会话查询获得，指定冲突可通过只读 `scheduler.getConflict({conflictId})` 查回原证据和 revision。当前稳定原因含 `EXECUTION_CAPACITY_EXHAUSTED`、`QUARANTINE_CAPACITY_EXCEEDED`、`HOST_STOPPING`、`RESOURCE_CLEANUP_PENDING`、`EXECUTION_EVIDENCE_CONFLICT`；客户端须容忍未来新增原因。A/Q/R 和冲突数据在同一数据库事务内读取，canDispatch/reasons 还结合本宿主关闭标志与内存收尾记录，因此整体不是纯数据库快照。查询不执行资源探测、模型调用或变更。

R04 的 `RESOURCE_CLEANUP_PENDING` 表示所有者声明已提交，但适配器记录的解除或其完成回执尚未确认，阻止本宿主新派发。所有者收到 `RESOURCE_CLEANUP_INCOMPLETE` 时保存 operationId 与原 target/evidence/idempotencyKey；错误的 auditCommitted=true 仅确认声明已提交。get/lookup/wait 只读，persisted 回执不会因轮询而完成：所有者须以原参数和原键显式重试 `sessions.reconcile`，继续原收尾。result 的 `unobservedResourcesReconciled` 只有收尾确认后才为 true，存在的 `resourceCleanup.status` 从 pending 变 completed；没有此类资源处置时该对象缺省，布尔值为 false。重启会丢失原 finalizer，原操作保持 outcome_unknown、同键重试仍明确报错；内存阻塞消失不证明原收尾完成。完整规则见 SPEC-0004 AC-R04.6。

`sessions.get` 增加可选的当前 dispatch 租约/隔离摘要；reconcile 的 result 增加 `executionReleased`，与原 `resolved` 分别表示资源与业务结论。配置/派发诊断展示实际期限、默认/显式来源和策略版本。Python 新字段按既有规则映射 snake_case；普通 socket 只读可用，owner-only 资源/业务声明仍由引擎授权。

释放租约、进入/退出准入阻塞发出持久事件，重复读取不产生重复事件；每个期限/配额事件都携带足够的原目标与原因。操作建议必须区分继续等待真实执行结束、核对停止证据、核对业务结果、所有者重启调整有限额度；不得建议删除记录、换键重试或强行清空 activeDispatchId。

## 7. 编号验收条款

- AC-A2-01：默认新建轮次记录 1800000ms；引擎、Claude、Codex、TS 嵌入、CLI、Python stdio 配置一致。受控时钟推进超过 300 秒而未到新期限，正常已受理的运行不超时；两家协议 fixture 都必须覆盖，不能只改 fake。
- AC-A2-02：宿主与 provider 的显式更短期限仍生效；较长 provider 配置不能延长宿主期限；有效值与来源可查询。受理/初始化耗时计入总期限，收到回执、噪声消息或墙钟回拨不续时。
- AC-A2-03：两项超时仍在运行或远端状态不明，A=2、Q=2，第三项不启动。即使两个本地 PID 均已退出，缺少远端停止证据仍不释放；证明未知请求不会靠新隔离槽形成额外并发。
- AC-A2-04：上述两项后来都有匹配终态和清理确认，A 降为 0、Q 保持 2，第三项自动启动；前两项继续 blocked/unknown，无批准、无重发、activeDispatchId 不被清空。
- AC-A2-05：终态先到、清理卡住时仍占 A；清理迟到后通过通知释放，无额外模型调用。覆盖 Claude Query.close/iterator.return 和 Codex 真实自有 fixture 进程退出；通知重复、乱序、过期代次与相冲突证据不会错误释放。
- AC-A2-06：只有本地停止、只有远端停止、仅 iterator 结束、通用 error(failed)、取消回执均不足；明确未提交且清理完成可确定失败并释放名额。能力未验证的终态保留 held。
- AC-A2-07：所有者 localResources/remoteExecution 均 stopped、业务 outcome 或副作用 unknown 时，`executionReleased=true,resolved=false`，仅释放 A；普通 socket 拒绝，活动句柄/陈旧目标/冲突证据拒绝。同键重试不重复释放，改 payload 仍冲突。
- AC-A2-08：用小隔离额度覆盖 Q+R 边界：在途同时超时、终态已到但清理随后超时均不会超过上限，待清理阶段仍占 R；达到上限阻止新派发和新增工作，同键原请求照常返回原回执。查询、取消、核对、批准及关闭仍能收尾；已保存成果的 resume 即使满额也只重新申请验收。释放 A 不减少 Q，最终核对减少 Q 后恢复准入。
- AC-A2-09：释放事务前后实际杀死临时宿主并重启：提交前按 held、提交后按 released，业务 unknown 均保留，无替代派发或旧请求重放。旧记录缺字段保守恢复；低于历史占用的新额度只背压，不丢记录。
- AC-A2-10：回调迟到、精确截止边界、重复控制、配置重启均不延长持久期限；1800 秒采用虚拟时间验证，不让测试真实等待 30 分钟。现有 drain 不自动升级 interrupt、关闭可续等规则继续成立。
- AC-A2-11：真实 Node stdio/Unix 和 TS/Python 查询得到一致 A/Q/R、期限与原因；旧宿主不支持新查询时新 SDK 明确拒绝；旧客户端不会因忽略字段获得资源释放权限。协议与 schema 升级失败在模型提交前停止。
- AC-A2-12：对已释放执行注入同一可信目标的矛盾证据，宿主持久停止后续派发，重启后仍报告 EXECUTION_EVIDENCE_CONFLICT。即使 activeDispatchId 已清空，也可按 conflictId 查询并由所有者提供停止证据解除；权限、revision、同键重试和多个未解决冲突均校验。错目标事件不能解除租约或冒充该冲突；不能自动撤销外部操作、杀无关进程或继续使用可疑空闲计数。

## 8. 实施顺序与交付证据

先为 AC-A2-03/04/08 和统一期限写失败测试，记录真实 RED，再扩展资源证据、持久租约、调度、双语言接线和诊断。旧 102 项 Node / 32 项 Python 结果是 A 的历史证据，不证明 A2；任何当前已正确行为只补回归，不编造 RED。

实现后运行 `npm test`、`npm run test:python`、`npm run typecheck`、`npm run format:check`，追加独立 A2 TDD 记录并同步实际 README。常规验证仅用临时目录、虚拟时间与真实本地 fixture 子进程，不读取登录或调用付费模型。真实 provider 停止证据是否可靠仍由 A01/A02/A07 的独立验收决定；1800 秒及 32 条的调优另记版本、任务分布与实测结果。


## 9. 实施确认与适配器迁移

2026-09-20 完成 A2。历史 A 的 RED/GREEN 不修改；新增验收、补充审阅回归及全量命令记录于 [A2 TDD 汇总](../tdd/0003-a2-evidence.md)。归档、GC、namespace 切换仍属于未实施的 B。

第三方 RuntimeAdapter 必须声明 `executionBudget={version:2,acceptanceCapMs,turnCapMs}`，未显式配置的上限使用 null。宿主模式只用 `RuntimeInput.executionBudget` 的剩余时间接口判定到期；定时器仅负责唤醒并重新读取剩余值，不自行建立第二个到期时钟。独立执行须自己从 execute 入口建立单调总预算。旧适配器的新建及产生执行的 resume 在提交前明确拒绝，不能把已结算成果的验收恢复一起拒绝，也不能因恢复某个旧 provider 的能力不足关闭整个宿主。

停止证明通过 `reportExecutionEvidence` 独立回调，按原 dispatch/session/generation/native identity 和递增 sequence 关联；通用 RuntimeEvent 不能代替它。终态能力须显式声明 `executionEvidence={version:1,terminalCoversExecution:true}` 并按 provider/profile 独立验收。适配器保留真实终态，在清理确认时补报，即使迭代器早已结束。unknown 观测不覆盖已确认的 stopped；active 更正才推翻它并在已释放后触发持久冲突。释放凭据持久保存终态、本地、远端证据引用与原目标。

引擎核对同时检查业务终态与适配器保留的终态证书；清理错误不能覆盖真实结果，也不能通过 sideEffects=unknown 加一个矛盾的明确 outcome 绕过检查。移除历史 provider 配置不阻断 owner-only 的人工收尾；没有进程句柄本身仍不是停止证明。

升级到 schema 2 前在原 stateDir 保存 `store-schema1-<uuid>.sqlite` 备份，验证 integrity、schema、workspace 和 storeId。备份或迁移失败时不提交新 schema 或模型请求；旧引擎拒绝 schema 2。备份恢复/新 namespace 的产品流程尚未实现，不可把备份直接当另一个可自动派发的宿主来用。
