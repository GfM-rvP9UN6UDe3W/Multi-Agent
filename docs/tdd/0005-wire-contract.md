# SPEC-0005 验证记录

日期：2026-09-20。接续 R04 的 217 项 Node / 44 项 Python 基线。本增量仅修改客户端说明、公共 schema 与离线契约测试，没有修改生产引擎、适配器或 SDK 实现，没有增加依赖。

## RED

先定义 SPEC-0005 AC-W01..W05，再添加测试与受限 schema 辅助器，保持原 protocol.schema.json，运行：

```sh
node --test tests/contract/protocol-schema.test.ts
```

实际 **5 pass / 7 fail / 0 skipped**，共 12 个测试计数，包含父测试。四项真实 payload 校验分别失败于缺少 TaskSnapshot、ApprovalRequest、MessageSnapshot、UsageRecord；反例/兼容性检查和 Python 输出的 schema 检查也受缺失定义阻挡，父测试随之失败。OperationSnapshot、SessionSnapshot、SchedulerSnapshot、EventEnvelope 的实际输出及辅助器约束测试通过。

Python 子进程在 RED 时已完成真实 socket 查询、已知字段访问、原始 JSON 检查和与 TypeScript 的相等断言，之后才因缺失定义校验失败。类型检查通过，RED 不是语法、编译、网络权限或 mock 构造错误。

## GREEN 与覆盖范围

补齐四种定义后，同一文件 **12/12**。测试使用临时目录中的真实 Engine、SQLite 与 Unix RPC，Python 是实际启动的独立进程；运行时显式使用确定性 fake，注入已知用量，不请求模型。

- 任务：创建、待人工验收、批准后因暂停邮箱而保持 paused 的实际快照；覆盖 result/approvalId/reason 的 null 和非 null。
- 批准：实际 pending 与 approved 请求，包括嵌套 target/revision/artifactRefs。
- 消息：宿主添加的 id/fromSessionId/idempotencyKey/status；暂停会话确保收件箱与后续跨语言读取期间状态稳定。
- 用量：已报告整数、0、未知 null 与原始 provider JSON。raw 故意同时包含 input_tokens、inputTokens、嵌套 task_id，Python 属性转换不能污染这些原始键。
- 操作：实际人工批准回执；保留原始 result.taskId/choice 和可空 error。另校验真实 SessionSnapshot、SchedulerSnapshot、EventEnvelope。
- 反例：逐一删除五种快照的必填字段，破坏状态/purpose/kind、嵌套 runtime/approval target、数组元素、非负整数/安全上限、可空边界和 operation error/lifecycle，均被拒绝。
- 兼容：可选 message artifactRefs 可省略，输出快照允许未来扩展字段；原始 result/raw 可为其他 JSON。MessageSpec 继续拒绝服务端输出字段，control 消息仍不受支持。
- 双语言：Python 连接同一宿主读取五类稳定快照，验证 snake_case 属性访问、result/raw 原键保留；转回 wire 视图后与 TypeScript 精确比较，再校验 schema。没有仅靠手工构造成功对象或定义名存在断言代替实际输出。

测试辅助器支持当前文档用到的本地 $ref、type、required/properties/additionalProperties、枚举/常量、数组、数值/长度/pattern、allOf/oneOf 和条件/not。schema 加入未知校验关键字或未解析引用时，辅助器初始化就失败，包含尚未走到的定义。辅助器自测覆盖条件组合、oneOf 多分支同时匹配、额外字段、Unicode code point 长度、数组上下界与错误元素。

format 使用 draft 2020-12 默认注解语义，不做日期格式断言。辅助器不是完整 JSON Schema 验证器，不验证整个 JSON Schema 元模式，不进入生产请求路径；未来增加关键字需补相应语义与测试。有限状态样本与跨语言检查不能证明所有未来字段/方法都不会分叉。

## 文档修正

A2 权威 spec、SDK_USAGE_AND_WIRING.md 和 python/README.md 补入 RESOURCE_CLEANUP_PENDING；说明数据库 A/Q/R 与宿主内存 closing/pending 状态的区别，并要求客户端容忍未来原因字符串。README/CLAUDE.md 同步说明。

两种语言的用法明确 RESOURCE_CLEANUP_INCOMPLETE 的 operationId/auditCommitted、camelCase result 字段和可选 resourceCleanup。保存首次请求的 target/evidence/key，在同一所有者上显式重试 reconcile 才推进收尾；get/lookup/wait 都只读。重启丢失原 finalizer 后仍是 outcome_unknown，不把阻塞消失或 wait 返回 unknown 当完成。本轮没有为低风险文字修改增加字符串匹配测试；行为依据是既有 R04 真实 stdio/SQLite 回归。

## 最终验证

| 命令 | 结果 |
| --- | --- |
| `node --test tests/contract/protocol-schema.test.ts` | **12/12**，0 fail、0 skipped |
| `npm test` | **229/229**，0 fail、0 cancelled、0 skipped，约 2.70 秒 |
| `npm run test:python` | **44/44**，约 4.59 秒 |
| `npm run typecheck` | 通过 |
| `npm run format:check` | 通过 |
| `git diff --check` | 通过 |

完整套件包含最终扩充后的逐字段缺失、嵌套数组与安全整数边界反例。Unix socket 与实际子进程测试在有本机 IPC 权限的环境运行；没有将跳过当通过。没有重跑性能 benchmark，因为生产调度实现没有变化；本记录不新增性能结论。

0003-B、引擎拆分、Codex 用量去重/配置迁移和其余 P2 未纳入本增量。未调用真实模型，未提交、推送、合并或发布。

## AC-W06：additionalProperties 值形态补漏

日期：2026-09-20。仅修改测试辅助器、对应契约测试和本 spec/TDD 记录，保留上述历史验证结果。目标是在初始化阶段拒绝不支持的 additionalProperties 值，避免字符串 "false" 等拼写错误静默取消额外字段限制。

### RED

先补 AC-W06，再添加非法值初始化反例和合法值兼容性测试，保持辅助器原实现，执行：

```sh
node --test --test-name-pattern=AC-W06 tests/contract/protocol-schema.test.ts
```

实际 **1 pass / 1 fail / 0 skipped**。反例失败为 `Missing expected exception: root: "nope"`，证明测试因原实现没有拒绝非法值而失败；合法值和对象子 schema 递归审计的既有行为通过。没有以编译或 IPC 失败代替 RED。

### GREEN 与范围核验

在初始化 audit 中用 `Object.hasOwn` 判断关键字是否显式出现，并断言其值为布尔或对象子 schema；保留原有递归 audit 和 payload 检查。显式 undefined 不等于省略关键字；即使辅助器从 JavaScript 对象接收它也必须拒绝。

新增两个测试：非法值覆盖 "nope"、"false"、null、0、1、空/非空数组和 undefined，在根节点、未使用的 $defs、properties 与额外属性子 schema 四种位置都于初始化阶段失败。合法值回归覆盖省略、true、false、空对象以及通过 $ref 指定非负整数的对象子 schema；明确开放形式仍检查已声明属性，false 仍拒绝额外属性，对象形式仍拒绝错误类型/数值，子 schema 内未知关键字仍被递归拒绝。

| 命令 | 本次实际结果 |
| --- | --- |
| `node --test --test-name-pattern=AC-W06 tests/contract/protocol-schema.test.ts` | **2/2**，0 fail、0 skipped |
| `npm test` | **231/231**，0 fail、0 cancelled、0 skipped，约 2.79 秒 |
| `npm run test:python` | **44/44**，约 4.94 秒 |
| `npm run typecheck` | 通过 |
| `npm run format:check` | 通过 |
| `git diff --check` 与本轮四个文件相对备份的 `git diff --no-index --check` | 通过 |

完整 Node 套件继续包含真实 Unix 宿主、Python 子进程和实际 payload schema 校验；运行时使用 fake，未调用真实模型。开始时保存工作区文件 SHA-256 清单，完成后比对仅本轮四个文件变化；已有生产代码、公共 schema 和其他未提交文件保持开始时内容。不重新运行性能 benchmark，因为本轮没有修改调度实现，也不新增性能结论。未提交、推送、合并或发布。
