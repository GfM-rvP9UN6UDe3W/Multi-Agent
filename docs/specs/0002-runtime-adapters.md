# SPEC-0002：最小真实运行时适配器

日期：2026-09-19。状态：已实现协议接线及 [SPEC-0003-A](./0003-a-lifecycle.md) 的有界观察/资源清理，待真实厂商模型验收。基础契约见 [SPEC-0001](./0001-foundation.md)。本文件覆盖 `packages/adapter-claude`、`packages/adapter-codex`；基础测试为 `tests/contract/adapters.test.ts`，生命周期追加证据见文末。

## 目标与接口

每个 adapter 实现内部 `RuntimeAdapter.execute(input): AsyncIterable<RuntimeEvent>`。本增量只允许 `read-only`；`workspace-write` 请求必须立即返回失败。`resume` 在有 `providerSessionId` 时沿用供应商会话；fork、compact 和工具桥明确不支持。adapter 构造和 `capabilities()` 不读取凭据、不启动进程、不调用模型。只有 `execute()` 才接触官方运行时。

`accepted` 必须来自上游的明确受理证据：Claude SDK 的 `system/init.session_id`（或带 session id 的终态消息），Codex 的 `turn/start` 成功响应。启动进程、`initialize` 成功以及仅创建 Codex thread 都不算受理。向 Claude `query()` 或 Codex `turn/start` 提交后，如果流/进程断开而无上游终态，即使还未收到受理回执，也报告 `error(outcome="unknown")`，因为请求可能已经执行；在提交前确定失败则报告 `failed`。

## Claude Agent SDK

调用已安装的可选 peer dependency `@anthropic-ai/claude-agent-sdk` 的 `query()`。测试可注入 `query` factory，因此不需要登录或模型费用。每次 `execute` 自有流句柄；`resume` 映射至 `options.resume`。本增量设置 `settingSources: []`、`tools: [Read, Glob, Grep]`、对应 allow list、`disallowedTools: [mcp__*]` 和 `permissionMode: dontAsk`。不暴露写工具或 MCP 工具。`interrupt` 能力暂标 `false`：`AbortSignal` 的触发或 SDK 抛错不能单独证明上游已终止，不能伪造 `interrupted`；执行前已取消则可确定尚未提交。

成功的 SDK `result` 产生终态 `result`。`usage` 缺字段保留 `null`，不推导费用或零用量；本增量从终态 `usage` 取四类 token 字段，按 `dispatchId:result` 去重。`query()` 已启动但未收到终态时保留 unknown。上游 SDK 作为 peer dependency 可选，离线测试不会加载它；真实调用要求调用方安装兼容版本并提供官方支持的身份验证。

0003-A 已增加单调时钟期限：`requestTimeoutMs` 默认 30 秒（执行开始至受理）、`turnTimeoutMs` 默认 300 秒（受理至终态）、`cleanupTimeoutMs` 默认 1 秒，均为有限正整数毫秒。普通流消息不延长期限。超时和取消触发自有查询清理，但提交后不能仅凭取消信号报告 interrupted。`Query.close()` 按公开契约完成，或迭代器 `return()` 返回 `done:true` 后，才确认资源清理；未确认时保持 unknown、`close()` 拒绝，并通过 `hasActiveResources(sessionId)` 保留资源占用。成功结果和用量在清理确认后才交付。此资源状态供引擎拒绝不实的“已停止”核对声明，不是上游业务结果自动 inspection。

## Codex App Server

每次 `execute` 独立启动一个受管 `codex app-server` stdio 子进程，结束、异常或消费者停止迭代时关闭本次子进程。默认进程环境仅保留启动所需的 `PATH`、`HOME`、`TMPDIR`，调用方若要使用凭据须通过 `env` 显式提供；适配器不复制用户登录凭据。无论传入什么 `env.CODEX_HOME` 或 `env.CODEX_SQLITE_HOME`，均强制改为 `stateDir/runtime/codex` 的真实路径。此目录及其 `config.toml` 为适配器受管且权限收紧；配置只含空 MCP 服务器列表和关闭原生多 agent、应用、插件、浏览器、计算机操作、图像生成及钩子的设置。已有配置与预期不一致即在启动前失败，不覆盖。命令行还重复关闭 `multi_agent`、`multi_agent_v2` 等已知外部功能，覆盖工作区及其祖先项目的信任等级为 `untrusted`，并显式传 `mcp_servers={}`，避免项目级 `.codex/config.toml` 注入。可注入 `command` / `args` 用于离线 fixture；真实命令默认是 `codex app-server`。

连接使用 JSONL 上的双向 JSON-RPC，依次发送 `initialize`、`initialized`、`thread/start` 或 `thread/resume`、`turn/start`。新建和恢复都固定 `sandbox: read-only`、`approvalPolicy: never`；轮次再次设置 `sandboxPolicy: {type: readOnly, networkAccess: false}`。只把匹配当前 thread 和 turn 的条目、用量、终态通知映射为事件。未关联消息缓冲及请求期间暂存各最多 256 条；单帧最多 1 MiB。请求默认最多等待 30 秒，轮次受理后终态默认最多等待 5 分钟，均可由 `requestTimeoutMs` / `turnTimeoutMs` 正整数配置。超时或溢出关闭连接；轮次已提交时报告 unknown。关闭自有子进程时先 SIGTERM，默认最多等 1 秒，仍未退出则 SIGKILL 再等 1 秒；此上限可由 `closeTimeoutMs` 调整。收到上游终态后仍无法核实自有进程退出时报告 unknown。

`turn/completed` 的 `completed`、`failed`、`interrupted` 分别映射为 `result`、`error(failed)`、`interrupted`。AbortSignal 在获得 turn id 后发送 `turn/interrupt`，但只有收到 `turn/completed(status=interrupted)` 才确认取消；断线仍为 unknown。`item/completed(agentMessage)` 提取最终文本。`thread/tokenUsage/updated` 仅用 `last` 作为单次用量；相同 `total` 快照在同一 dispatch 内去重。若没有用量通知，终态成功时记录四字段全为 `null`。不把 `thread.tokenUsage.total` 当本轮增量或直接当费用。

适配器不修改 `~/.codex` 或用户级配置；`CODEX_HOME`、配置覆盖及 `--disable` 的实际启动选项已用本机 `codex-cli 0.153.4` 做离线预检。系统或组织托管配置仍可能高于本地选项，本轮未验证真实模型或托管策略下的最终工具暴露，不能把离线 fixture 等同于外部系统只读验收。

0003-A 的 RPC/终态等待使用单调时钟，无关帧和墙钟回拨不刷新期限。`adapter.close()` 主动回收本次 spawn 持有的连接，未观察到子进程退出时明确失败；`hasActiveResources(sessionId)` 保持 true，供引擎阻止人工核对释放该会话。回收失败后仍保留句柄并可再次关闭。此实现只处理本次启动的自有进程，不扫描进程、不依据重启后保存的 PID 杀进程，也不把资源退出当作业务终态。

## 兼容边界和来源

- Claude Agent SDK [官方概览](https://code.claude.com/docs/en/agent-sdk/overview)、[会话](https://code.claude.com/docs/en/agent-sdk/sessions)、[权限](https://code.claude.com/docs/en/agent-sdk/permissions)。peer dependency 声明 `>=0.3.241 <1`；此范围仅是安装约束，不是全范围验证声明。
- Codex [App Server 文档](https://developers.openai.com/zh-Hans/docs/app-server) 描述初始化、线程、轮次与中断。[配置参考](https://developers.openai.com/zh-Hans/docs/config-file/config-reference) 说明 `agents.enabled`、项目不受信任时跳过项目配置，以及特性和 MCP 设置；[环境变量](https://developers.openai.com/es-419/docs/config-file/environment-variables) 说明 `CODEX_HOME` 和 `CODEX_SQLITE_HOME`。实现字段与本机 `codex-cli 0.153.4` 运行 `codex app-server generate-ts --out /private/tmp/agent-orch-codex-schema` 生成的 v2 类型核对；其他版本需重新生成类型并执行契约测试。默认 stdio；不启用实验性 WebSocket。
- 本轮未连接 Claude 或 Codex 付费模型，也未证明任一实际账户登录、授权、网络、MCP 或第三方网关端到端可用。

## TDD 证据

先加入 `tests/contract/adapters.test.ts`，执行 `node --test tests/contract/adapters.test.ts`，观察 RED：`ERR_MODULE_NOT_FOUND`，找不到 `packages/adapter-claude/src/index.ts`。基础实现后 10 项通过。第二轮先补隔离配置、等待/队列上限、子进程退出和 Claude 迭代器清理测试并观察 RED（隔离测试读到继承的 `/user/codex`，无界请求导致测试挂起）；修正后 16 项通过。覆盖真实 SDK 消息替身、实际 fixture 子进程、握手与受理、恢复、发送轮次后未确认就断线的 unknown、取消终态、用量 null、重复通知、隔离参数和受管配置、不受支持权限的启动前拒绝。此结果是离线协议契约验证，不是付费模型验收。

以上为基础增量的历史记录，未改写为本轮总数。0003-A 追加测试与 RED/GREEN 分别见 [Claude 生命周期证据](../tdd/0003-a-claude.md)、[Codex 资源证据](../tdd/0003-a-codex.md) 和 [引擎/双语言汇总](../tdd/0003-a-evidence.md)。
