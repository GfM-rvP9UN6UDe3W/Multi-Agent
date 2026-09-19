# SPEC-0003-A：本轮生命周期实现契约

日期：2026-09-19。状态：代码已实现，离线回归通过；[TDD 与验收边界](../tdd/0003-a-evidence.md)。细化 [SPEC-0003](./0003-policy-retention-deadlines.md) 的 AC-A01–A06；本轮不实现 GC、自动选路、fork/compact/rotate。

后续修订已确定于 [SPEC-0003-A2](./0003-a2-execution-isolation.md)：拆分执行占用与结果隔离，统一新轮次的 1800 秒开发默认预算。A2 尚未实现；下列 300 秒及 unknown 占执行名额的条款保留为当前 A 实现基线，不应据新规格宣称行为已经改变。

- 引擎配置 `timeouts`：`acceptanceMs=30000`、`turnMs=300000`、`drainMs=300000`、`interruptMs=30000`、`reconcileMs=60000`，均为 1..86400000 整数毫秒。已有调用保持默认值。控制期限来自所有者配置，不允许普通客户端任意延长；SDK wait 时限独立。
- 引擎持久化 dispatch 的进入时间、受理期限、总期限、目标代次、可能发送标记与最后证据；待完成控制操作的 `lifecycle` 保存 enteredAt/deadlineAt、policyVersion、kind、expectedGeneration/expectedDispatchId、mayHaveBeenSent/lastEvidence。运行计时使用单调时钟，重启不重置持久期限。
- watchdog 超时将目标和相关操作/消息/outbox 事务性收束为 unknown/blocked，但继续收集原轮次的迟到证据，不自动将任务变为成功或重发。隔离名额从持久化未核对 dispatch 计算，不因观察 Promise 返回就释放。
- `sessions.reconcile({target,evidence,idempotencyKey})` 使用与 control 相同的精确目标字段。仅 `CallContext.owner=true` 的宿主所有者可调用；嵌入 TS/受管 stdio Python 可用，普通 socket 客户端拒绝。当前是显式人工核对入口，不宣称已实现两家上游历史自动 inspection。
- evidence 是可序列化的所有者声明：`source:"owner_attestation"`、`summary:string`、`localResources:"stopped"|"unknown"`、`remoteExecution:"stopped"|"unknown"`、`sideEffects:"resolved"|"unknown"`、`outcome:"not_executed"|"completed"|"failed"|"interrupted"|"unknown"`，可带 `result:string`（completed 必填）。服务端保存声明全文、摘要、操作者、时间和原 dispatch 引用；这是具名责任的人工证据，不能当作适配器独立观测。模型及普通客户端无此权限。
- 当前进程仍持有未结束的消费/清理句柄时拒绝“资源已停止”的放行；迟到证据与声明冲突也拒绝。只停止本地进程或任一 unknown 不放行。所有证据已核对后：not_executed → paused，显式 resume 才重排且沿用原 provider 历史；completed → 保存成果并保持 paused，resume 仅重新申请验收；failed/interrupted → 终结该任务为 failed（如需继续，另建任务，不重放副作用）。原 unknown 控制操作保留历史并追加 resolution，不伪装成按时完成。
- 新方法通过 initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true} 协商；wire 维持 1.0 的兼容扩展，旧 SDK 不调用新方法，新 SDK 在能力缺失时拒绝 reconcile。新增对象字段允许旧客户端忽略；schema 版本不因 JSON 对象的可选字段扩展改变，旧记录缺字段在恢复时保守 unknown，不自动迁移/重发。
- Claude 适配器新增有限观察/清理等待。公开 API 的取消只用于资源收尾，不伪造停止证据；无法确认资源关闭时 close 返回 SHUTDOWN_INCOMPLETE。宿主 EOF 的紧急策略需有界执行并只处理自有资源。
- `RuntimeAdapter.hasActiveResources(sessionId)` 是核对放行前的资源约束。若适配器在 `execute()` 结束后仍可能持有清理未确认的资源，就必须实现该查询；Claude 保留未确认的 Query，Codex 保留本次 spawn 的连接，直到观察到相应清理证据。Codex 只向自有子进程句柄发信号；TERM/KILL 各使用 `closeTimeoutMs` 原有阶段预算，不根据重启后的 PID 或进程名称查杀。

验收包括可控单调时钟、回拨、超时前后、重启持久期限、迟到事件、权限拒绝、仅进程停止不放行、核对完成后的 resume 不重跑，以及真实 stdio/socket 接线和自有子进程清理。测试/源码变更只限本轮，RED/GREEN 证据单独记录。
