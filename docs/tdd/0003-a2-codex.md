# SPEC-0003-A2：Codex 统一预算与执行停止证据

日期：2026-09-19。范围：`packages/adapter-codex/src/index.ts`、`tests/contract/codex-execution-isolation.test.ts` 和本证据。依据 [A2 spec](../specs/0003-a2-execution-isolation.md) 与冻结内部 RuntimeInput / ExecutionEvidence 契约实现；不修改引擎或其他适配器，不请求真实模型。

## RED

先新增 12 项真实行为测试，再运行：

```sh
node --test tests/contract/codex-execution-isolation.test.ts
```

实际 exit 1；12 tests / 0 pass / 12 fail，不是类型或编译失败。

- 缺少显式 provider cap 与停止证据能力元数据。
- 宿主/独立模式虚拟时间越过 301 秒，旧 300 秒期限错误地结束任务。
- 初始化耗尽宿主总预算仍继续提交；accepted 后仍给新期限；显式 total cap 也从 accepted 后重新开始。
- 真实匹配终态、清理卡住后的迟到 child exit、本地断开、错原生身份和明确未提交分支均没有独立证据回调。
- 模拟证据落盘期间宿主期限耗尽，旧实现仍输出成功。

首轮实现后，再为两条兼容边界补失败测试：

```sh
node --test --test-name-pattern='longer explicit standalone' tests/contract/codex-execution-isolation.test.ts
node --test --test-name-pattern='negotiated host clock' tests/contract/codex-execution-isolation.test.ts
```

实际均 exit 1，分别 2 / 2 和 1 / 1 失败。独立模式把显式较长配置误夹在默认值内；宿主模式额外建立本地 cap 时钟，会在宿主注入时钟尚有预算时提前退出。修复后，独立模式以显式配置替代默认值，宿主只使用已协商的 remaining 回调；provider cap 通过静态能力交给引擎计算最小值。

最终补查计时器唤醒语义：

```sh
node --test --test-name-pattern='timer wakeups|stalled stream' tests/contract/codex-execution-isolation.test.ts
```

修复前实际 exit 1，2 tests / 1 pass / 1 fail。固定宿主 remaining=20ms、真实 fixture 消息延迟 30ms 时，旧等待器把本地 timer 唤醒直接当作超时；宿主实际递减预算的挂起流本来就正确超时，直接保留为回归。等待器改为每次唤醒重新读取权威 remaining，尚有预算则重新安排计时器，只有 remaining<=0 才拒绝。

## 实现约定

- 默认独立执行总预算为 1800000ms，受理为 30000ms，二者从 execute 开始一次确定；accepted、后续 RPC、输出均不续期。宿主模式使用 ExecutionBudget v2 的剩余受理/总预算，RPC 同时受二者约束，输出终态前再次检查总预算。清理仍为独立的 TERM / KILL 两阶段，每阶段沿用 closeTimeoutMs。
- 能力元数据只公开显式 requestTimeoutMs / turnTimeoutMs，缺省为 null，不把旧默认冒充用户配置。只读适配器声明 terminalCoversExecution；该内部协议能力不等于真实 provider 生产验收。
- 匹配原生 thread / turn 的结果、失败或确认中断先回报 runtime_terminal；清理未确认时 localResources=unknown，原终态保留。真实 child exit 通过独立 resource_observation 回调通知；即使 execute 迭代器已结束也保留原 dispatch、session、generation 和递增 sequence。
- 已提交而无匹配终态时，child exit 仅证明 localResources=stopped，remoteExecution 仍 unknown。错 thread / turn 不提供停止证据。明确未提交且资源清理后才用 pre_submission 双 stopped；独立调用缺省 generation=1。
- 回调不改变原 RuntimeEvent 字段或数量；清理失败后的错误不会被迟到资源通知替换为成功。callback 异常仅发 stderr warning，宿主回调负责将持久化失败转为停止调度。

## GREEN

运行：

```sh
node --test tests/contract/codex-execution-isolation.test.ts tests/contract/codex-lifecycle-resources.test.ts tests/contract/adapters.test.ts
npm run typecheck
node node_modules/prettier/bin/prettier.cjs --check packages/adapter-codex/src/index.ts tests/contract/codex-execution-isolation.test.ts
```

实际均 exit 0。39 tests / 39 pass / 0 fail / 0 skipped：本轮 17 项、原 Codex 资源 6 项、原适配器 16 项。类型检查和本范围格式检查通过。

所有 Codex 协议交互都使用本地真实 fixture 子进程；301 秒、显式较长预算和时钟分歧使用注入单调时钟/宿主回调验证，测试没有真实等待长周期。迟到清理测试让自有 fixture 在 TERM/KILL 替身失败后保持运行，确认迭代器已结束且未报告本地停止，再终止该自有 PID，验证原 dispatch 的独立资源通知。测试最终只回收自身进程和临时目录。

本文件只证明 Codex 适配器 A2 契约及旧行为回归；租约落盘、调度计数、跨语言、迁移与真实模型验收由各自证据覆盖。
