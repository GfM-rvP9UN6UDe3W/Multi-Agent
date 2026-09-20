# SPEC-0004：调度与运行时可靠性修复

日期：2026-09-20。基线：`bba83e5`。范围：修复调度历史扫描、宿主关闭配置、TypeScript 请求等待和 Claude 清理确认；保持 SPEC-0003-A2 的 A/Q/R、人工验收与 unknown 语义。

## 目标与非目标

不重构引擎架构，不实现 GC/归档，不调整 events 分页、审批时钟、Codex 帧限制或其他 P2 项。不运行付费模型，不把离线测试当作真实厂商验收。

## 编号验收条款

- **AC-R01 调度性能**：只从持久任务表选择 queued 候选，保留既有创建顺序；历史非排队任务不能各自触发 dispatches 全表扫描。索引可重建，不改变存储 schema 2 的业务语义。准入仍以持久 A/Q/R 和冲突状态为依据，在真实派发的事务内再次校验；不能用失效的内存计数超额派发。遇到不可派发的候选后仍检查后续候选。用不同规模的离线历史数据验证扫描开销及真实创建延迟，并回归并发额度、同会话串行、重启与 unknown 隔离。
- **AC-R02 关闭配置**：Unix 与 stdio 宿主收到 SIGINT/SIGTERM 时均遵循显式 `shutdown.mode` 和 `shutdown.timeoutMs`。未配置时保留各入口的既有默认策略；意外 owner EOF 继续使用既有有界 interrupt 清理，不能等同主动 drain。drain 等当前工作完成，interrupt 请求停止；超时明确报告 SHUTDOWN_INCOMPLETE，保留可续等的宿主和 operationId，不报告关闭成功，不擅自升级 drain。用真实临时子进程及 fake provider 验证两种传输与关闭模式。
- **AC-R03 请求期限**：TypeScript Unix 客户端的普通 RPC 默认等待 30000ms，可在连接选项配置默认值并用单次请求参数覆盖；连接与 initialize 保留各自期限。超时/取消仅结束本地等待、移除 pending，不关闭健康连接或取消远端任务。迟到回执不影响后续请求；变更请求的 method/scope/idempotencyKey 保留以供核对。显式任务 wait 总期限仍有效；owner shutdown 的请求等待应覆盖其显式关闭预算。测试默认超时、覆盖、迟到回执、后续请求、幂等恢复及 CLI 无响应时的非零退出。
- **AC-R04 Claude 清理证据**：Query.close 返回、iterator.return(done:true) 和 AbortSignal 均不能单独证明自有子进程退出。通过官方 `spawnClaudeCodeProcess` 接口记录本次实际启动的进程并观察其退出；仅操作自有句柄。有进程未确认退出时保留资源占用，有限清理等待失败时返回 unknown/SHUTDOWN_INCOMPLETE；迟到退出可更新资源证据。执行租约的自动释放仍须同时有匹配的有效业务终态与本地清理证据，仅进程退出不能伪造远端终态。缺少进程观察证据的注入 factory 必须保守处理；测试使用真实离线 fixture 子进程，不把 no-op close 当退出。同步修正 SPEC-0002 的旧清理假设及相关测试。

## R04 后续增量：未知资源的人工核对与关闭挂起

本增量只补 R04 的可恢复性边界，不实现 0003-B，不改变普通客户端权限，不增加自动放行或通用 force 参数。复用现有 owner-only `sessions.reconcile` 声明与精确目标，不要求 SDK 调用者迁移 wire。

- **AC-R04.1 人工核对未知记录**：未观察到 spawn 的记录仍阻止自动释放；仅在执行观察已结束、适配器已封闭后续启动、目标 dispatch/session/generation 精确匹配且不存在已观察进程时，允许所有者以 `localResources=stopped` 的显式声明核对该记录。普通客户端、过期目标、冲突证据、仍有执行观察或真实活进程均不能走此路径；不支持此窄接口的适配器保持原阻挡行为。人工核对本地资源后，远端仍 unknown 时不能释放 A；两端 stopped 只释放 A，业务证据未齐时仍保留 Q/blocked。
- **AC-R04.2 先落盘后解除记录**：保存原目标、操作者、声明、未知资源处置方式及独立资源核对事件；事务成功提交后才解除对应的适配器记录。持久写入失败、期限超限、证据冲突或目标失效时，资源记录与租约保持原状。相同幂等键重试不重复解除记录或写核对事件；不能影响同 provider 的其他会话或该会话之后的派发。人工处置不是自动 `resource_observation`，不能产生虚假的进程退出证据。
- **AC-R04.3 独立、有界清理**：cleanup 开始后，即使 Query.close/iterator.return 永久 pending 或无效返回，也须在原 `cleanupTimeoutMs` 总预算内对本次自有进程执行兜底 stdin EOF/SIGTERM。先给 SDK 半个预算自行关闭，再用剩余预算观察兜底退出；缺少 close 或同步/异步失败可立即兜底。不得依赖 SDK 透传 abortController，不对其他进程发信号，不以发出信号、Promise 返回或截止时间充当退出。拒绝退出的子进程在预算用尽后仍 unknown；迟到真实退出才更新观察证据。该预算不能抢占阻塞 JS 线程的同步代码。
- **AC-R04.4 真实调用链回归**：以离线实际子进程覆盖永久 pending、无效 close、独立 signal、忽略 SIGTERM/EOF、多个自有进程及非目标进程；以实际引擎/SQLite、SDK 与 owner stdio 验证人工核对、权限、事务回滚、幂等重试、调度恢复与关闭。测试不得读取登录凭据或调用付费模型。
- **AC-R04.5 关闭期间收尾**：所有者已经发起 shutdown、因未知资源收到 SHUTDOWN_INCOMPLETE 后，仍可调用上述受约束的 `sessions.reconcile`；不能因此重新开放任务创建、执行恢复或消息派发。核对后沿用原 shutdown operationId 续等，真实宿主退出后才算关闭。已彻底关闭的引擎、以及未进入 owner shutdown 的存储降级状态，不因这条例外放开写入。
- **AC-R04.6 适配器收尾契约硬化**：prepare 返回 null/undefined 时维持原阻挡；返回其他非函数值或抛错时，提交前以 INVALID_RUNTIME_CONTRACT 拒绝，不解除租约或写成功核对记录。合法 finalizer 仍在人工声明事务提交后执行：回执先以 persisted、`result.resourceCleanup.status=pending` 和 `unobservedResourcesReconciled=false` 落盘，成功后才更新为 completed/true 并写资源核对完成事件。同步抛错须返回带 operationId、auditCommitted 的 RESOURCE_CLEANUP_INCOMPLETE，保留原 finalizer；同键、同 payload 的 owner 显式重试继续该收尾，不重复业务核对、调用 prepare 或影响后续派发。失败期间本宿主暂停新派发，成功后恢复；不盲目自动重试。finalizer 已执行但完成回执写入失败时只重试持久确认，不再次执行 finalizer。重启后不能恢复的内存 finalizer 保持回执未知并明确报错，不用新适配器或空内存冒充原收尾成功。本增量不修改 resolveConflict 的当前不可达路径或其他 P2，不实现 0003-B。

  对违约返回的 Promise 仅安装成功/失败观察，不进行无界等待；等待期间的同键重试不得并行调用 finalizer。Promise 失败后可显式重试原函数，成功后仍须显式续等才能完成回执。finalizer 返回但资源查询仍为 active 时不得报告收尾完成。声明已提交不等于 finalizer 已完成。

## 验证与证据

先运行各项新增行为测试并记录实际 RED，再实现并记录 GREEN。最终执行 `npm run typecheck`、`npm run format:check`、`npm test`、`npm run test:python`；Unix socket 测试需允许本机 IPC。另保存可复现的调度性能样本，区分扫描回归与绝对耗时。结果写入 `docs/tdd/0004-runtime-reliability.md`。
