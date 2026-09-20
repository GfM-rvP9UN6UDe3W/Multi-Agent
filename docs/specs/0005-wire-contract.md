# SPEC-0005：客户端恢复说明与 wire 快照契约

日期：2026-09-20。保持 wire 1.0、存储 schema 2 和既有运行行为。本增量修复 R04 收尾回执的客户端文档遗漏，并让公共 JSON Schema 接受真实宿主产出的快照、拒绝破坏契约的 payload。

## 范围与非目标

补齐 TaskSnapshot、ApprovalRequest、MessageSnapshot、UsageRecord，保留 OperationSnapshot 的通用原始 JSON result/error 语义。校验工具只用于离线测试，不进入生产请求路径、不增加第三方依赖，不声称实现完整 JSON Schema 验证器或代码生成。不重构引擎，不实现 0003-B，不顺带改用量去重、配置迁移或其他 P2。

## 编号验收条款

- **AC-W01 客户端恢复说明**：A2 权威 spec、双语言用法和 Python README 均列出 RESOURCE_CLEANUP_PENDING。A/Q/R 来自一致数据库读取；canDispatch/reasons 同时包含本宿主关闭与内存收尾状态。写明 RESOURCE_CLEANUP_INCOMPLETE 的 operationId/auditCommitted、原始 camelCase result 中的 unobservedResourcesReconciled/resourceCleanup，以及保留原 target/evidence/key 显式重试 reconcile 的步骤。get/lookup/wait 只读，不执行 finalizer；重启后的 outcome_unknown 不等于收尾成功。
- **AC-W02 完整快照**：上述四个缺失类型按现有 TypeScript 类型、SPEC-0001 和宿主输出声明必填、可空、数组元素、枚举及数值约束。OperationSnapshot 保留可空 error、可选 lifecycle/resolution 与开放 result。输出快照允许未来扩展字段；严格输入 MessageSpec 不能因复用而拒绝 MessageSnapshot 的服务端字段，也不能意外允许 control 消息。
- **AC-W03 真实 payload**：从真实引擎及 Unix RPC 取得五种快照，至少覆盖待验收/批准后的任务与批准、持久消息、已报告及 null 用量、操作回执；相关 SessionSnapshot、SchedulerSnapshot、EventEnvelope 一并校验。测试不能只判断定义名存在、或用测试手工构造的成功快照冒充真实输出。
- **AC-W04 反例与验证器边界**：删去必填字段、破坏嵌套类型/数组元素、状态枚举、整数或可空边界时必须拒绝。测试辅助器覆盖该 schema 使用的结构约束；遇到不支持的校验关键字或未解析的本地引用必须报错，不静默忽略。format 保持 draft 2020-12 默认的注解语义，不声称校验所有日期格式。
- **AC-W05 双语言接线**：真实 Python 子进程连接同一宿主，查询同一组快照；验证 Python 已知字段的 snake_case 访问、原始 result/raw 的原键保留，并与 TypeScript 的同一稳定状态比较。通过 schema 校验不取代这条实际跨语言回归，也不代表覆盖所有未来字段/方法。
- **AC-W06 additionalProperties 值形态**：测试辅助器初始化时，显式出现的 additionalProperties 只能是布尔值或对象子 schema；字符串（包括 "false"）、null、数字、数组和显式 undefined 必须报错，不能静默放宽约束。检查覆盖根节点、未使用的 $defs、properties 和 additionalProperties 内的子 schema。省略该关键字、true、false、空对象和带约束的对象子 schema 保持原有额外属性语义，对象子 schema 仍须递归审计。本条只收紧测试辅助器，不修改生产运行时或公共 wire schema，也不扩展为完整元模式验证器。

## 验证

先写测试并记录缺失定义导致的实际 RED，再补 schema 与文档。执行定向契约测试、typecheck、format:check、两套完整测试与 diff 检查。结果记录在 docs/tdd/0005-wire-contract.md。
