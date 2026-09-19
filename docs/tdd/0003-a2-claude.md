# SPEC-0003-A2 Claude 适配器执行预算和停止证据

日期：2026-09-19。范围仅为 `packages/adapter-claude/src/index.ts` 与 `tests/contract/adapter-claude-a2.test.ts`。依据 [SPEC-0003-A2](../specs/0003-a2-execution-isolation.md) 与 [共享引擎类型](../../packages/engine/src/types.ts) 的内部契约；无付费模型调用。

## 行为

- 能力元数据将显式 `requestTimeoutMs` / `turnTimeoutMs` 报为上限；未显式配置时为 `null`，不把旧默认值报成用户上限。支持 v2 单轮预算和 v1 执行证据。单独调用时从 `execute` 开始共用默认 1,800,000 ms 总期限；受理不重置期限。宿主调用时采用引擎提供的单调剩余时间函数，并在终态返回后再次检查期限。受理等待同时受受理和总剩余预算限制。
- 提交前的关闭、权限拒绝、取消、加载失败或预算耗尽会报告 `pre_submission` 双重停止证据。提交后只有匹配当前 Claude session id 的 SDK result 终态才报告远端停止；通用异常、断流、超时和异 session 终态均不伪造远端停止。
- 匹配终态先通过同步回调记录 `runtime_terminal`，本地资源状态仍为 unknown。`Query.close()` 或迭代器 `return()` 确认清理后再报告 `resource_observation`。即使清理晚于 `execute()` 结束，原句柄仍持有回调并补报；序号按本次执行递增，重复清理不重复报告。原 RuntimeEvent 输出语义保持不变，未确认清理时成功结果仍压住为 unknown。

## TDD 证据

先新增 6 个行为测试并运行 `node --test tests/contract/adapter-claude-a2.test.ts`：**0/6，RED**。失败分别显示能力字段缺失、受理后重新给满终态期限、无执行证据回调、迟到清理无通知、异 session 被当成成功结果及提交前拒绝无停止证据。实现后运行 `node --test tests/contract/adapter-claude-a2.test.ts tests/contract/claude-deadlines.test.ts tests/contract/adapters.test.ts`：**38/38，GREEN**。

随后增加“宿主预算在提交前已耗尽”测试，运行单文件测试：**6/7**，新测试 RED，`query()` 错误地被调用。增加提交前预算检查后，相关三文件测试：**39/39，GREEN**。审查发现过期后的匹配终态被丢弃，会让已结束执行仍占名额；追加迟到终态测试，单文件 **7/8**，新测试 RED，修复后相关三文件 **40/40，GREEN**。迟到终态只补执行停止证据，不把已超时的业务结果改成成功。`npx prettier --check packages/adapter-claude/src/index.ts tests/contract/adapter-claude-a2.test.ts` 通过。

复核宿主单调预算又发现适配器把宿主 `remaining*Ms()` 返回值直接放入本地 `setTimeout`，会在宿主时钟未到期时误超时。新增固定宿主剩余 20ms、SDK 30ms 返回测试，**8/9，RED**；改为宿主回调判定到期后，该测试通过，但“SDK 永不返回且宿主预算递减”的新增测试 **9/10，RED**（200ms 守卫超时）。最终定时器只负责最多 50ms 后重新读取宿主剩余值，剩余值归零才超时；单独调用仍用本地单调期限。Claude A2、既有 Claude 期限和旧 lifecycle 合计 **40/40，GREEN**，包含 retained-cleanup 回归。

首次 `npm run typecheck` 在共享 SDK 接线测试的 `Orchestrator.scheduler` 尚未实现时失败 7 项；没有 Claude 适配器或本测试的类型错误。共享接线完成后重跑 `npm run typecheck` 已通过。完整引擎、Python 和跨语言验证由 A2 主任务合并后统一执行。fixture 证明的是离线契约与受控清理行为；真实 Claude SDK 子进程及终态涵盖范围仍须按 SPEC-0002 的厂商验收另行验证。
