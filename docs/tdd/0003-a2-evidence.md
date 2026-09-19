# SPEC-0003-A2：执行隔离与统一预算的 TDD 证据

实施：2026-09-19–20。依据 [A2 spec](../specs/0003-a2-execution-isolation.md)。本轮只实现 A2；归档、GC、新 namespace 切换和策略选择仍未实施。没有初始化 Git、提交或发布包，也没有调用真实模型、读取登录凭据或执行用户业务。

## 已实现行为

持久执行租约与业务隔离分别计数。新派发在同一事务检查 `A < maxActiveSessions` 和 `Q + R < maxQuarantinedDispatches` 并取得租约/预留；默认分别为 2 和 32。初始化、执行及待清理均保留 R，超时把 R 转成 Q。证明原执行与自有资源均停止后只释放 A，保留原 activeDispatchId、任务 blocked、业务 unknown 和 Q；最终业务核对才释放 Q。新工作在容量满时背压，幂等回执、查询和必要收尾仍可用。

新轮次默认总预算 1800000ms，从派发开始计时；初始化/受理不续期。内置 fake、Claude、Codex 接受同一宿主单调预算，显式 provider 上限与宿主取较小值，持久保存实际期限和来源。定时器只唤醒重新读取预算，清理有独立有限期限。旧 adapter 在提交前明确返回 UNSUPPORTED_CAPABILITY。

新增双语言 scheduler 查询、最多 16 条占用/冲突示例、owner-only 冲突解除和资源部分核对。释放证据及租约在同一事务持久化；真实终态证书不被清理错误覆盖。重复/乱序回调不会重复释放，错误身份拒绝审计；更大序号的 unknown 不抹去明确停止证据。同一可信目标的 active 更正触发持久冲突闸门，按 conflictId 核对解除，不依赖 activeDispatchId 仍存在。

存储 schema 升为 2，wire 保持 1.0，事件格式 schemaVersion 仍为 1。schema1 升级前验证可恢复 SQLite 备份；历史 unknown 缺租约时保守恢复为 held+Q，已有 released 及原期限不因重启丢失。

## 实际 RED 与修复

先编写 `tests/engine/execution-isolation.test.ts` 的 6 项核心行为测试，运行 `node --test tests/engine/execution-isolation.test.ts`。实际 **0/6，RED**：缺预算输入/1800 秒默认、缺 scheduler.get、缺资源部分核对结果与持久隔离/冲突行为。不是编译失败。随后实现租约、额度、预算、停止证据、资源核对、冲突及 schema2，使首批 **6/6 GREEN**。

继续添加真实恢复和审阅回归；对于已正确行为直接记录回归，不人为制造 RED。以下新增边界均先复现实际断言失败，再修复：

| 新增失败行为 | 实际 RED | 修复 |
| --- | --- | --- |
| `accepted` 被冒充停止终态 | 11/12；A 错误变 0 | 严格校验证书类型、结构及 native identity |
| 清理 unknown 遮掉真实结果，可声称 not_executed 重跑；移除旧 provider 后核对崩溃 | 12/14；缺少应有拒绝、TypeError | 同时核对保留证书；无旧 adapter 时仍允许人工收尾 |
| 部分核对包含矛盾的明确结果仍可释放资源 | 14/15；缺少 EVIDENCE_CONFLICT | 只要给出明确业务结论就检查冲突，outcome=unknown 才是纯资源核对 |
| 后续 unknown 抹掉停止证明；满额错误阻止等待验收会话 resume | 15/17；第三项未启动、QUARANTINE_CAPACITY_EXCEEDED | 分别保留最后明确的资源状态；只对会增加执行的 resume 检查额度 |
| 旧 adapter 的恢复先返回 completed，异步关闭整个调度器 | 17/18；缺少 UNSUPPORTED_CAPABILITY | 恢复前能力检查；异步能力失败只暂停对应任务 |
| 空/纯空白真实结果使 Q 无法核对 | 18/19；result 校验拒绝空文本 | 原样保存结果供人工验收，不能伪造未执行；目标与摘要仍要求非空 |

根引擎最终新增 21 项。两家适配器及接线各自的独立 RED/GREEN 见 [Claude](./0003-a2-claude.md)、[Codex](./0003-a2-codex.md)、[TS/Python/CLI](./0003-a2-wiring.md)。复核还实际发现“宿主 timer 唤醒被直接当到期”和“移除 timer 后挂起流无法退出”，均先新增失败测试后修复。普通期限/旧生命周期回归保留。

## 验收覆盖与证据边界

| 条款 | 当前离线证据 |
| --- | --- |
| AC-A2-01/02 | 引擎虚拟推进 300001ms 与墙钟回拨仍在新预算内；provider 更短/更长上限；Claude/Codex 协议 fixture 覆盖超过旧 300 秒、初始化计入总预算、受理不续时、终态提交前再检查 |
| AC-A2-03/04 | 两个仍可能执行的 unknown 保持 A=2/Q=2；本地退出不放行；迟到匹配终态+清理后自动启动第三项，原任务不重跑、不批准，activeDispatchId 保留 |
| AC-A2-05/06 | 待清理仍占 R/A；Claude 迟到 return/close、Codex 真实自有进程迟到退出；错误 native ID/generation、乱序、重复、伪终态、未验证能力及通用 failed 均不能错误释放；明确未提交可确定失败 |
| AC-A2-07/08 | 所有者资源部分核对、活动句柄拒绝、终态冲突/幂等校验；Q+R 小额度、原回执及同键异载荷；验收恢复不产生模型执行；业务核对后释放 Q |
| AC-A2-09 | `execution-isolation-crash.ts` 在释放事件尚处事务时实际 SIGKILL 宿主，重启 held；提交完成后实际 SIGKILL，重启 released。两者均保留 unknown/期限/原 dispatch，无重放。验证 schema1 备份 integrity/身份、缺字段保守恢复、备份故障不升级、不提交；降低额度到历史 Q 以下保留 17 条记录 |
| AC-A2-10 | 同一单调预算和精确边界；旧 drain/interrupt/关闭续等不变；能力缺失恢复不会关闭其他调度；不真实等待 30 分钟 |
| AC-A2-11 | 真实 Node stdio/Unix、TS 和 Python 同宿主快照逐值一致；旧宿主缺能力在发送前拒绝；普通 socket 无核对/冲突解除权限；诊断有界且重复读取不新增事件 |
| AC-A2-12 | 可信 active 更正持久停止派发，重启仍保留；按 conflictId 解除，activeDispatchId 清空后仍能操作；owner/revision/幂等检查；多个冲突全部解决才恢复 |

另以本轮修改前保存的真实 `Store` 源码执行兼容检查：新 Store 创建 schema2 后关闭，旧 Store 打开返回 SCHEMA_MISMATCH；输出 `PASS: actual pre-A2 Store rejects schema 2 without opening model execution`。该一次性检查使用临时目录并清理，不把手写的模拟版本检查当作旧引擎证据。

旧 foundation/lifecycle 自定义 fake fixtures 仅补明确的预算能力和与其原语义相符的资源证据；unknown 分支仍不提供远端停止证明。旧测试的数量与结果保留在 A 的历史证据中，不倒填成 A2 验收。

## 最终命令

```sh
npm test
npm run test:python
npm run typecheck
npm run format:check
```

最终实际结果：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 157/157 通过，0 失败、0 跳过 |
| `npm run test:python` | 40/40 通过，0 失败、0 跳过 |
| `npm run typecheck` | 通过 |
| `npm run format:check` | 通过 |

运行环境为 Node.js 24.14.0、Python 3.14.6、macOS。Unix socket 测试在允许本机 IPC 的环境执行，未将沙盒 EPERM 当成功或跳过。最后一轮 CLI 校验还发现 Claude 的真实参数名为 `cleanupTimeoutMs`，Codex 为 `closeTimeoutMs`；新增真实失败测试后分别接线并拒绝错名，通过配置加载到真实适配器的 17ms 清理边界验证生效。

工作区没有 Git 元数据，本轮以开始时的文件 SHA-256 清单核对范围：修改 21 个既有文件、新增 12 个文件、没有删除；源码、对应测试和当前文档以外的基线文件保持原哈希，依赖清单与锁文件未改。

当前证据覆盖源码工作区、协议 fixture 和本地真实子进程，未覆盖真实 Claude/Codex 模型、厂商派生/远端执行范围、长期驻留或生产容量。30 分钟与 32 条是开发默认值，后续需按真实任务校准。发布包、最低版本矩阵、归档恢复和完整首版仍是独立工作。
