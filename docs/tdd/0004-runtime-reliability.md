# SPEC-0004：运行时可靠性修复验证

日期：2026-09-20。修复前基线：`bba83e5`；对应 [验收规格](../specs/0004-runtime-reliability.md)。本次只处理 R01–R04，不实现其他 P2 项、GC、归档或真实模型验收。

## 1. AC-R01：历史任务下的调度开销

新增 `tests/engine/scheduler-history.test.ts`，先执行：

```sh
node --test tests/engine/scheduler-history.test.ts
```

真实 RED：30、60 条 waiting_approval 历史分别导致一次创建解码 1051、3901 条 dispatch 记录，同时解码 30、60 条非排队历史任务，超过线性扫描预算；FIFO/容量回归原本通过。实现后分别为 152、302 条 dispatch，非排队任务解码数均为 0。

修复通过 SQLite 状态索引读取 queued 候选，只在实际派发后重算外层准入；派发事务内继续校验 A/Q/R 与冲突。轮数按 taskId 索引计数，不再为每个候选解码整张派发表。新增索引在已有 schema 2 上重建，不更改业务 schema。

最终该文件 6/6 通过，覆盖失去适配器能力的首个候选、FIFO、并发额度、每任务轮数的精确边界与后续候选、填充过的 schema 2 索引重建与历史保持。后补测试属于回归，不伪造额外 RED。

## 2. AC-R02：信号关闭配置

新增 `tests/contract/cli-shutdown.test.ts`。修复前运行 14 项，5 pass / 9 fail：Unix/stdio 忽略显式 drain，stdio 忽略自定义预算，关闭不完整时缺少 operationId，或 stdio 提前退出。省略配置与意外 EOF 的原行为测试已经通过。

修复后以下定向命令 28/28 通过：

```sh
node --test tests/contract/cli-shutdown.test.ts tests/contract/host-cli.test.ts tests/contract/host.test.ts tests/contract/lifecycle-wire.test.ts
```

测试启动真实 Node 宿主和 fake 轮次，发送 SIGINT/SIGTERM 并读取持久结果。显式配置在两种传输均生效；不完整 drain 保留控制与 operationId，允许续等而不自动升级 interrupt。未配置时保留 Unix 1000ms / stdio 30000ms 的 interrupt 默认值；意外 owner EOF 独立使用原 30000ms interrupt 策略。

## 3. AC-R03：TypeScript RPC 期限

新增 `tests/contract/request-timeouts.test.ts`。真实 RED 为 8 项中 3 pass / 5 fail：普通请求不超时、默认配置不生效、变更请求覆盖不生效、非法期限未拒绝、CLI status 在截止后继续等待。原 initialize、显式 wait 与 owner close 预算测试已经通过。

实现后新增 8/8 通过；与 sdk、lifecycle-wire、execution-isolation-wire 合计 20/20 通过。真实 Unix fixture 验证 pending 回收、迟到回执忽略与后续连接可用；真实 SQLite 验证超时变更的幂等查询和重试保持同一任务；真实 CLI 子进程返回 TIMEOUT、退出码 1。30 秒边界通过虚拟时钟验证，不真实等待 30 秒。

普通请求默认 30000ms；连接的 requestTimeoutMs 与单次 timeoutMs 可覆盖，合法范围为整数 1..2147483647。连接时限与 initialize 的 5000ms 独立。显式 wait 使用剩余总预算，owner close 请求保留关闭预算并增加 1000ms 回执余量。超时不等于远端取消。

一次中间回归因测试自身的 fake runtime 定时器被虚拟时间冻结而挂在清理；改用无定时器的离线 unknown fixture 后完成。该挂起不计入产品 RED 或通过结果。

## 4. AC-R04：Claude 进程退出证据

只读检查声明支持的 SDK [0.3.241 源码](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.241/sdk.mjs)：Query.close 调用 cleanup 后立即返回，而 cleanup 包含异步清理与有界 waitForExit；返回不是退出确认。公开 [类型声明](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.241/sdk.d.ts) 提供 spawnClaudeCodeProcess 回调。

新增 `tests/contract/claude-cleanup.test.ts` 的初始 3 项实际运行结果为 1 pass / 2 fail：仍有活子进程，以及没有进程观察的 query，都错误交付 result，预期为 error。实现后扩展为 9 项，连同已有 Claude/生命周期测试 65/65 通过。

现在通过公开 spawn 回调记录实际 ChildProcess；仅真实 exit 或确认未产生 PID 的启动失败认定本地结束。清理开始即封闭迟到 spawn，多个句柄须全部结束。close/return/abort 不作为退出证明。真实引擎回归验证活句柄阻止 owner reconcile 与下一任务；迟到退出释放 A，但保留 Q/blocked，且不重放任务。只有退出而没有匹配终态时仍不自动释放。

全量整合还发现 `execution-isolation-wiring.test.ts` 的旧动态 SDK fixture 使用 return(done:true) 表示清理。已替换为真实子进程并保留其 17ms 清理预算断言；该文件 6/6 通过。未放宽生产退出证据来兼容旧替身。

## 5. 性能样本与最终验证

同机、同一 `tests/fixtures/scheduler-benchmark.ts` 工作负载：每个 fake 任务达到 waiting_approval 后再创建下一个。旧版从 `git archive bba83e5` 解压至独立临时目录，测试后清理。以下是最后 5 次创建的均值，不包含等待 fake 轮次完成的时间：

| 累计任务数 | 修复前均值 | 修复后均值 |
| ---------- | ---------- | ---------- |
| 50         | 8.59ms     | 1.25ms     |
| 100        | 36.30ms    | 2.05ms     |
| 150        | 74.61ms    | 2.89ms     |
| 300        | 未测       | 5.52ms     |
| 1000       | 未测       | 21.02ms    |

复测当前工作区：

```sh
node tests/fixtures/scheduler-benchmark.ts . 50,100,150,300,1000
```

该样本支持消除历史 tasks × dispatches 的重复扫描，不是延迟 SLA。准入快照、审批扫描和其他历史查询仍有线性成本，持久数据不会自动 GC，长期容量验收仍未完成。

最终验证：

| 命令                   | 结果                                                     |
| ---------------------- | -------------------------------------------------------- |
| `npm run typecheck`    | 通过                                                     |
| `npm run format:check` | 通过                                                     |
| `npm test`             | 194/194 通过；0 fail、0 cancelled、0 skipped，约 2.69 秒 |
| `npm run test:python`  | 40/40 通过，约 4.18 秒                                   |
| `git diff --check`     | 通过                                                     |

测试只使用临时目录、离线 fixture、本机 IPC 和自有子进程；未读取登录凭据、安装真实 SDK 或请求付费模型。沙盒 EPERM 结果不计入行为验收，IPC 测试在允许本机 socket 的环境运行。新增 schema 2 索引及相关数据库行为只在临时数据库验证，未接触用户既有运行状态。

## 6. R04 后续增量：人工核对与挂起关闭

日期：2026-09-20。接续以上 194/40 基线，先补 AC-R04.1–R04.4；实际 Python 宿主测试发现关闭后的人工收尾入口被阻挡后，追加 AC-R04.5。实现范围仅为 R04，不开始 0003-B，不清理其他 P2。

### RED

```sh
node --test tests/contract/claude-cleanup-recovery.test.ts
```

首批 7 项运行结果为 **0 pass / 7 fail**，类型检查在测试的 JSON 结果类型收窄后通过，才保留这份行为 RED：

- 永久 pending、no-op close、没有匹配终态三种清理路径都没有回收使用独立 AbortSignal 的实际子进程，资源仍 active。
- 多进程场景中本可退出的子进程也没有收到兜底关闭；忽略 EOF/SIGTERM 的另一进程仍存活。
- 两条未知记录占满 A 后，所有者核对被 RUNTIME_STILL_ACTIVE 阻止；冲突声明和注入的 SQLite 提交失败尚未走到相应检查。

实现窄接口后再追加观察状态回归：在执行观察暂停、cleanup 已开始时，prepare 错误返回可解除记录的函数，预期为 null。定向运行 `node --test --test-name-pattern='cleanup preparation' tests/contract/claude-cleanup-recovery.test.ts` 为 **0 pass / 1 fail**；增加 observationEnded 条件后通过。目标身份、幂等 finalizer 与同会话后续派发追加为回归，不伪造 RED。

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_claude_cleanup_reconcile.py -v
```

真实 Python→Node stdio 的首次结果为 **1 pass / 1 error**：普通 owner 核对、调度恢复和重启已通过；主动 shutdown 返回 SHUTDOWN_INCOMPLETE 后，owner reconcile 被 HOST_STOPPING 拒绝。先补 AC-R04.5 和“新建/恢复/消息继续拒绝”的断言再复跑，保留同一失败；随后只允许已进入 owner shutdown 的 `sessions.reconcile` 通过停止写入门禁，权限、目标、进程和证据检查仍执行。

### 实现与可观察结果

- `RuntimeAdapter.prepareUnobservedCleanup({sessionId,dispatchId,generation})` 是可选内部适配器接口，不增加 wire 参数。Claude 只为已结束观察、已封闭启动、从未观察到进程且全体记录目标匹配的情况返回无副作用的准备结果；旧适配器或真实活进程保持阻挡。
- 引擎先写 owner 声明、处置类型 `owner_attested_unobserved` 和 `session.resources_reconciled` 事件，在事务成功提交后才解除内存记录；SQLite trigger 令最终 operation 写入失败、期限超限、终态冲突与持久资源冲突均保持原记录和租约。相同键重试不重复写事件或解除其他记录。
- 实际引擎中两条未知记录占满 A，核对其中一条后另一条仍 held，排队任务得以派发；原任务的 Q/blocked 保留。仅声明本地 stopped、远端仍 unknown 时不释放 A。明确 completed 仍先进入 paused，不自动批准或重跑。
- 所有者人工声明不调用自动 resource_observation。真实 Python 重启后检查 SQLite，原 dispatch 的 `executionState.localResources` 仍为 unknown，租约释放原因是 owner_attestation；原核对回执和唯一审计事件持久保留。
- cleanup 用前半段原预算等待 SDK，然后独立对自有句柄 EOF/SIGTERM，剩余预算观察真实退出；close 不存在或失败时立即兜底。永久 pending、无效返回和独立 signal 都不跳过回收。SIGTERM/EOF 均被忽略时仍有界返回 unknown；真实迟到退出才确认清理。旁观进程保持存活。
- TS 嵌入 SDK 可提交人工核对并关闭；实际 Unix SDK 客户端仍 UNAUTHORIZED。Python 在 SHUTDOWN_INCOMPLETE 后核对并沿用原 shutdown operationId 续等，确认实际 Node 宿主退出；新建、恢复和消息仍 HOST_STOPPING。

### 整合回归与最终 GREEN

兜底回收使旧的“等待 stdin” fixture 正常退出，不能继续用它模拟拒绝清理的资源。相应测试改用实际忽略 EOF/SIGTERM 的子进程，并等待 ready 后才进入受测路径。断言仍要求真正存活的进程阻挡人工核对。

中间一次全量为 205 pass / 2 fail：一个旧生命周期 fixture 尚未替换；另一个晚到终态测试的 20ms 期限在并行负载下早于子进程启动完成，第二次 next 尚未开始。后者还暴露了断言失败后未释放 fixture 的问题；仅终止确认属于本次运行的该子进程，保存失败报告。测试改用就绪握手及注入的剩余预算，增加失败时的清理钩子；没有延长生产期限或放宽退出证据。

最终结果：

| 命令 | 结果 |
| --- | --- |
| `node --test tests/contract/claude-cleanup-recovery.test.ts` | 13/13；含实际 Unix socket、SQLite 回滚与真实子进程 |
| Python 上述新增测试命令 | 2/2；真实 owner stdio、重启、关闭续等 |
| `npm test` | **207/207**；0 fail、0 cancelled、0 skipped；约 2.68 秒 |
| `npm run test:python` | **42/42**；约 4.48 秒 |
| `npm run typecheck` | 通过 |
| `npm run format:check` | 通过 |
| `git diff --check` | 通过 |

本轮未调用真实 SDK/付费模型、未提交或推送。异步清理预算不能抢占阻塞 JS 线程的同步代码；人工声明仍要求所有者独立核对真实环境，离线 fixture 不证明上游版本或真实业务结果。

## 7. AC-R04.6：finalizer 违约与提交后的收尾回执

本增量针对第三方适配器在 prepare/finalizer 边界违反运行时契约的实际可复现行为。保留 resolveConflict 原门禁，不为当前不可达路径增加放行接口；0003-B 与其他 P2 继续不在范围内。

先补 AC-R04.6 与 `tests/engine/reconcile-finalizer.test.ts`，执行：

```sh
node --test tests/engine/reconcile-finalizer.test.ts
```

首次 **0 pass / 7 fail**：三种真值非函数返回在提交后才抛 TypeError；prepare/finalizer 的异常未转为可核对错误；原实现没有 pending 收尾回执，不能通过同键重试处理 finalizer 或完成回执写入失败；重启后也无法区分已提交声明与未完成收尾。类型检查在违约测试使用显式 unknown 转换后通过，保留的 RED 为实际运行行为。

首批实现后追加三项 Promise/无效返回边界，实际 **7 pass / 3 fail**：finalizer 返回 Promise.reject、未完成 Promise 或 no-op 时，原初稿仍错误报告收尾完成。修正为观察 Promise 两种结局而不无界等待、不并行重复调用，并在完成回执前检查资源查询；最终该文件 **10/10**。这些是注入适配器违约的契约测试，不声称内置 Claude 产生过上述故障。

实现结果：

- 非函数返回与 prepare 抛错在初始事务内拒绝为 INVALID_RUNTIME_CONTRACT，租约和记录保留，无成功核对回执。
- 初始事务只确认 owner 声明和业务处理，记录 `session.resource_cleanup_prepared`；对应操作先是 persisted，`resourceCleanup.status=pending`、`unobservedResourcesReconciled=false`。原执行租约若已依据 owner 声明释放，不把后续收尾异常伪装成事务回滚。
- 宿主保留原 finalizer。异常返回 RESOURCE_CLEANUP_INCOMPLETE，携带 operationId/auditCommitted；pending 期间 scheduler 原因包含 RESOURCE_CLEANUP_PENDING，停止新派发。普通客户端和不同 payload 的同键请求不能触发重试。
- 原 owner 同键重试只继续这次收尾；成功后第二个事务将回执改为 completed/true，写唯一的 `session.resources_reconciled` 和 operation.updated，再恢复调度。重复成功请求不会再次执行 prepare/finalizer、改变业务状态或重写核对事件。
- 用 SQLite UPDATE trigger 注入完成回执写入失败：内存解除已完成后，只重试持久确认，finalizer 调用次数仍为 1。这里补测的是真实 SQLite 第二事务失败，区别于上一增量的初始声明事务失败。
- 违约 Promise 的 pending 状态不阻塞 RPC；同键重试不会并发调用。Promise 成功/失败仅更新内存进展，仍需 owner 显式重试完成回执。finalizer 返回后仍 active 则继续 pending，不声称已解除记录。
- 真实 Node owner 重启后，未完成操作按现有规则进入 outcome_unknown；原 finalizer 已不可恢复时明确返回原 operationId 和 RESOURCE_CLEANUP_INCOMPLETE，不重新调用新适配器、不利用空内存伪造原收尾成功。

Python 新增两项真实 stdio 回归，验证错误字段、回执 lookup、同键续等，以及断开原宿主再启动后的未知回执。既有 SQLite 只读断言改用显式 closing 关闭连接，消除扩展测试触发 GC 时发现的测试资源警告。

最终验证：

| 命令 | 结果 |
| --- | --- |
| 新增 finalizer 测试 + 原 claude-cleanup-recovery 测试 | 23/23 |
| `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_claude_cleanup_reconcile.py -v` | 4/4 |
| `npm test` | **217/217**；0 fail、0 cancelled、0 skipped；约 2.74 秒 |
| `npm run test:python` | **44/44**；约 4.83 秒 |
| `npm run typecheck` | 通过 |
| `npm run format:check` | 通过 |
| `git diff --check` | 通过 |

全部使用临时状态与离线 fixture，没有调用付费模型、提交、推送或合并。新增收尾回执区分“声明已提交”与“记录已解除”，不是通用 force、自动重试或真实厂商验收。
