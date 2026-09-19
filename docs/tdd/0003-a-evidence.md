# SPEC-0003-A：生命周期交付与 TDD 证据

日期：2026-09-19。对应 [实现契约](../specs/0003-a-lifecycle.md) 与 [SPEC-0003](../specs/0003-policy-retention-deadlines.md) 的 A 增量。实现引擎期限、未知结果隔离、所有者人工核对、双语言接线和适配器资源回收；B 的保留/GC/存储故障策略与 C 的选路/费用账本仍待实现。

## RED 与修复

先编写 8 项引擎行为测试，再运行：

```sh
node --test tests/engine/lifecycle.test.ts
```

实际 **0/8，exit 1**。失败包括：控制操作没有持久化 lifecycle；受理/drain/interrupt 超时后仍 running 或 persisted；迟到结果进入 waiting_approval；`sessions.reconcile` 方法缺失；期限配置未校验。原始输出保存在开发机 `/private/tmp/dsh-0003-a-red.log`，本记录保存关键结果而不依赖临时日志作为交付文件。

实现后扩展至 14 项引擎回归。独立复核另发现并修复两处竞态：

- 观察循环已结束，但 Claude 仍持有清理未确认的 Query；仅检查引擎 flight 会放行错误的“资源已停止”声明。引擎新增适配器活动资源检查，实际 adapter+engine 集成回归确认 `RUNTIME_STILL_ACTIVE`，没有第二次派发。独立复现脚本修复后亦确认拒绝放行、关闭仍报告未完成。
- 定时器回调尚未执行时，逾期终态 Promise 先完成，旧代码可能把 pause 记为 completed。新增测试实际 RED：期望 outcome_unknown、得到 completed。现在处理事件及提交终态前都检查单调期限；定时器只负责唤醒。修复后的原复现仍为 blocked/outcome_unknown，并保存 expiredAt。

以上复核测试首次合跑 **1/2**：定时器竞态为 RED，活动资源测试在适配器修复已落地后为 GREEN；没有把既有通过用例记作失败历史。

其他模块的实际失败与通过证据分别记录在 [Claude](./0003-a-claude.md)、[Codex](./0003-a-codex.md)、[TypeScript/CLI](./0003-a-wiring.md)、[Python](./0003-a-python.md)。

## 实际行为与覆盖

| 条款 | 实现与离线证明 |
| --- | --- |
| AC-A01 | 持久化 enteredAt/deadlineAt、策略版本及精确控制目标；有限整数配置；单调时钟回拨/回调延迟测试；重复操作不刷新期限；真实 SIGKILL 宿主后重启读取原 deadline，不重新执行暂停或派发 |
| AC-A02 | 明确提交前失败可释放名额；可能提交但无确认则任务 blocked，会话/dispatch/相关消息/outbox 与控制操作事务性 unknown；迭代器结束和重启均不释放未核对 dispatch 名额 |
| AC-A03 | drain 超时不调用 interrupt；取消信号、iterator 结束、子进程退出不伪造业务中断；被替代控制的旧定时器不影响后续操作 |
| AC-A04 | 迟到结果保留在原 dispatch 的 terminalEvidence，不能自动完成任务；相冲突的人工声明拒绝；核对后的结果只经 resume 重新申请验收，事件证明无第二次 dispatch |
| AC-A05 | 人工 owner_attestation 完整留存审计产物；普通 Unix socket 拒绝；仅本地停止或任何 unknown 均不解除隔离；仍持有活动资源时拒绝；精确目标与幂等键重试、重启后 resolution 保留 |
| AC-A06 | close/continue 沿用 operationId，有界返回 SHUTDOWN_INCOMPLETE；Claude 悬挂 next/return 有界清理，未确认句柄继续登记；Codex 挂起 RPC 可主动回收自有连接，TERM 后 KILL、退出确认、清理失败仍隔离并允许再次 close；真实 CLI stdin EOF 后自有 fixture 退出，旁边其他测试进程仍活，重启保留 failed/unknown 且不重跑 |

核对是宿主所有者的显式声明，不是自动查询 Claude/Codex 上游历史。完成声明必须提供完整结果；资源、远端执行及副作用都已核对才放行。not_executed 保持 paused，显式 resume 才重排；completed 保持 paused 并保存成果，resume 仅申请验收；failed/interrupted 将任务终结为 failed。原 unknown 控制操作保留历史，仅追加 resolution。

## 全量验证

新增真实 EOF 接线回归后，最终全量结果如下。Node 共新增 45 项（原 57 → 102），Python 共新增 7 项（原 25 → 32）。

| 命令 | 实际结果 |
| --- | --- |
| `npm test` | 102/102，通过；0 失败、0 跳过 |
| `npm run test:python` | 32/32，通过 |
| `npm run typecheck` | exit 0 |
| `npm run format:check` | 首次发现本轮 2 个文件排版问题；只格式化这两文件后 exit 0 |
| `python3 -m compileall -q python/src/agent_orch python/tests` | exit 0 |

普通沙盒首次执行基线时，57 项 Node 测试中 3 项因本机 Unix socket 的 `listen EPERM` 失败；本轮新增 socket 接线也遇到相同限制。以上全量结果来自允许本地 IPC 的执行环境，没有跳过相关测试，也没有将环境错误冒充产品 RED。

测试使用临时 workspace/stateDir、独立 SQLite 数据库、真实 Node/Python 子进程和离线协议 fixture。当前目录没有 Git 元数据，本轮以开始前的文件哈希清单核对变更范围；没有初始化仓库、提交、发布或删除既有文件。

## 尚未证明的边界

- 没有调用真实 Claude/Codex 模型，没有验证实际缓存命中、费用或生产任务验收。Claude 清理依据公开 Query API 契约及替身，不等于对真实 SDK 底层 PID 的观测。
- 没有实现重启后扫描/终止遗留进程。当前只操作本次 spawn 的句柄，不存在仅凭持久 PID 回收的路径；PID 复用、共享外部运行时接管仍不支持，不能据此声称已经通过真实 PID 复用实验。
- 有界响应依赖 JavaScript 事件循环获得调度；同步代码永久阻塞时，定时器不能强制抢占。期限检查保证恢复调度后不会把逾期结果按时入账。
- 不实现 GC、tombstone、磁盘满策略、contextPlan、自动成本选路或 compact/rotate/fork。旧记录保守恢复为 unknown，不自动重放；没有扩大模型权限或网络监听范围。
