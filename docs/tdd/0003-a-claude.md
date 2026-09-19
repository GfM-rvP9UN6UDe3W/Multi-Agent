# SPEC-0003-A Claude 适配器有界执行与清理证据

日期：2026-09-19。范围仅涉及 Claude Agent SDK 适配器与 `tests/contract/claude-deadlines.test.ts`；未调用付费模型，未修改用户凭据或共享引擎类型。

## 行为与边界

- `requestTimeoutMs` 默认 30,000 ms，从执行开始到上游带 session id 的受理证据；`turnTimeoutMs` 默认 300,000 ms，从受理到终态，是绝对截止，不随普通消息延长；`cleanupTimeoutMs` 默认 1,000 ms。三个配置均要求 1 至 2,147,483,647 的安全整数毫秒值。
- 已取消的输入在调用 `query()` 前直接报告 `interrupted`，可证明没有提交。调用 `query()` 后，即使还没有受理回执，超时、断流、取消或本地关闭都报告 `unknown`；`AbortController.abort()` 本身不作为上游确认中断的证据。
- 每次查询使用独立的 `AbortController`，消费者停止、异常、超时或适配器 `close()` 时都触发清理。优先调用公开的 `Query.close()`；同时调用并有界等待迭代器 `return()`。`Query.close()` 正常返回或 `return()` 完成，可按公开契约确认资源回收。两者都不能确认时，执行返回 `error(outcome="unknown")`，`adapter.close()` 明确拒绝，保留该未确认句柄；若 `return()` 后来完成，再次 `close()` 可成功。悬挂的 `next()` / `return()` 的迟到拒绝均有处理器，不成为未处理 Promise 异常。
- 成功结果和用量在清理确认后才交付，避免上游终态已见但本地资源仍未确认退出时误报完成。`capabilities().interrupt` 保持 `false`。
- 截止时间使用 `performance.now()` 的单调基准，系统时钟回拨不会延长受理或终态等待。`next()` Promise 在检查已取消或截止过期之前先挂上成功/失败处理器，避免早抛后迟到拒绝变成未处理异常。Query 一经创建即登记为活动资源；即使获取异步迭代器抛错也走 `Query.close()`，不能漏掉已经建立的进程句柄。
- `hasActiveResources(sessionId)` 按逻辑 session 查询未确认清理的自有 Query。即使 `execute()` 因超时返回 unknown，句柄仍保留，供引擎在人工 reconcile 前拒绝“资源已停止”的错误断言。只有 `Query.close()` 按公开契约完成，或迭代器 `return()` 返回 `done: true`，才撤销资源占用。`done: false`、拒绝或无响应都不能释放占用；迟到的 `done: true` 可以在之后撤销。

官方发布的 Agent SDK 类型声明提供 [`Options.abortController`](https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.220/files/sdk.d.ts) 与 `Query.close(): void`；`Query.close()` 的公开注释说明其结束底层进程并清理资源。`Query.interrupt()` 的控制请求仅支持流式输入输出，当前字符串 prompt 不依赖它。代码对未安装 SDK 的测试注入 `query` fixture；实际 SDK 版本和真实进程退出仍需独立验收。

## TDD 记录

先新增 7 个契约测试，然后运行 `node --test tests/contract/claude-deadlines.test.ts`：**0/7，RED**。其中 5 项因 `next()` / `return()` 无界等待超过测试 300 ms 截止而失败，另有缺失的适配器 `close()` 和超时配置校验各 1 项。实现后增加普通消息不能延长终态截止、迟到 `next()` 拒绝被处理、迟到 `return()` 可使再次关闭成功、清理未确认时压住成功结果 4 项，达到 **27/27，GREEN**。

复核时另补取消先于等待注册、时钟回拨、迭代器创建抛错 3 项，旧实现 **3 项 RED**：迟到拒绝被测试运行器报告、回拨后超过测试 300 ms 截止、`Query.close()` 未调用。旧定时器因时钟回拨被拉长，取得失败证据后终止该次测试进程。修复后再补截止已过期分支的迟到拒绝回归，达到 **31/31，GREEN**。

本轮针对 reconcile 绕过又补 2 项 RED：清理已超时却缺少 `hasActiveResources` 查询；`return()` 返回 `done: false` 仍不得释放占用。新测试运行 `node --test tests/contract/claude-deadlines.test.ts` 得到 **14/16**，2 项因查询接口缺失而失败。实现后目标命令 `node --test tests/contract/claude-deadlines.test.ts tests/contract/adapters.test.ts` 得到 **32/32，GREEN**；`npx tsc --noEmit --pretty false` 通过。完整引擎套件由主任务统一复验。

测试覆盖受理前和受理后的挂起、消费者停止、适配器关闭、`Query.close()` 确认清理、迭代器无法确认清理时拒绝关闭、提交前取消、无效时间值和迟到拒绝。JavaScript 事件循环若被同步阻塞，定时器无法运行；fixture 不能证明真实 SDK 子进程在某台机器上已经退出，也不能将 SDK API 的 `close()` 契约替代为操作系统级 PID 核对。
