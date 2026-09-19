# SPEC-0003-A：TypeScript / CLI 生命周期接线证据

日期：2026-09-19。范围：TypeScript SDK、CLI 配置/本地宿主、公共 wire schema 与接线测试。模型测试全部使用 fake runtime 或明确的协议替身；不读取登录凭据、不调用付费模型。引擎和 Python 的行为证据分别记录。

## 第一轮 RED

先新增 `tests/contract/lifecycle-wiring.test.ts`，再运行：

```sh
node --test tests/contract/lifecycle-wiring.test.ts
```

实际结果：exit 1；4 tests / 0 pass / 4 fail。

- 缺少与不兼容 capability：`client.sessions.reconcile is not a function`。
- reconcile 的目标/证据/幂等键及 OperationHandle：入口尚不存在。
- CLI timeout 配置：`Unknown config field: timeouts`。
- EOF 紧急关闭预算：实际 `timeoutMs: 1000`，期望 `30000`。

后续 GREEN、真实子进程和兼容性结果在完成相应验证后追加；上述 RED 不代表实现通过。

## 接线实现与首轮真实宿主

TypeScript SDK 已在发送 reconcile 前要求精确的 lifecycle v1 capability；参数沿用精确会话目标、所有者声明和幂等键，返回正常 OperationHandle。CLI 校验并传递全部五个 timeout，stdio EOF 紧急关闭上限为 30 秒。公共 JSON Schema 补充 timeout、capability、operation lifecycle / resolution 和 reconcile 请求；旧 operation 可以没有新增可选字段。

运行：

```sh
node --test tests/contract/lifecycle-wiring.test.ts tests/contract/lifecycle-wire.test.ts
```

实际 exit 1；7 tests / 5 pass / 2 fail。

- 原四项接线回归全部 GREEN。
- 真实 Node CLI stdio 子进程的 `120ms drain deadline → outcome_unknown → 原 fake 轮次迟到结果 → 所有者 reconcile → paused → 显式 resume 仅申请人工验收` 全程通过；事件中只有一次 dispatch.started。
- 真实 socket 测试遇到沙盒 `listen EPERM`。此为环境失败，未跳过或计作通过。
- close continue 的新断言发现 shutdown operation 缺少 lifecycle，`kind` 实际 undefined，期望 shutdown；交由引擎实现修复后重跑。

随后在允许本机 IPC 的环境运行：

```sh
node --test --test-name-pattern='real Unix' tests/contract/lifecycle-wire.test.ts
npm run typecheck
```

实际均 exit 0。真实 Unix 宿主测试 1 / 1 通过：TS 客户端可读取持久化 deadline / expiredAt，但 reconcile 被服务端以 UNAUTHORIZED 拒绝；客户端断开后另一个客户端仍可连接并读取 blocked 任务。类型检查通过。以上仅为离线 fake 运行时的真实宿主/SDK 接线证据。

## 最终 GREEN

引擎补齐 shutdown lifecycle 后，在允许本机 IPC 的环境重跑：

```sh
node --test tests/contract/lifecycle-wiring.test.ts tests/contract/lifecycle-wire.test.ts
node node_modules/prettier/bin/prettier.cjs --check packages/sdk-typescript/src/index.ts packages/cli/src/config.ts packages/cli/src/host.ts schemas/protocol.schema.json tests/contract/lifecycle-wiring.test.ts tests/contract/lifecycle-wire.test.ts
```

实际均 exit 0。7 tests / 7 pass / 0 fail / 0 skipped；本范围全部格式检查通过。

真实 stdio shutdown 使用 `timeoutMs: 0` 返回 SHUTDOWN_INCOMPLETE 和 operationId，连接仍可读取同一操作及 shutdown lifecycle；`host.shutdown.continue` 沿用 operationId 等待真实 fake 轮次结束，然后返回 closed，CLI 子进程正常 exit 0。没有把初次等待超时当作停止成功，也没有创建替代 shutdown operation。

本轮仅覆盖离线接线与公共契约。引擎、适配器和 Python 的更广回归由相应证据记录；未执行真实 Claude/Codex 模型验收。

## AC-A06：真实 owner EOF 到 Codex 自有进程回收

新增两个真实回归，直接验证已实现行为，无新增源码修改，也没有人为制造 RED：

```sh
node --test --test-name-pattern='real owner EOF' tests/contract/lifecycle-wire.test.ts
npm run typecheck
node node_modules/prettier/bin/prettier.cjs --check tests/contract/lifecycle-wire.test.ts
```

实际均 exit 0；新增 2 tests / 2 pass / 0 fail / 0 skipped，类型与格式检查通过。每个测试启动真实 CLI `host --stdio`，由 codex provider 启动本地协议 fixture，分别挂在 initialize 和已经写出的 turn/start；RPC 时限设为 10 秒，回收每阶段时限设为 40 毫秒。

测试对宿主 stdin 发送真实 EOF；两条完整测试实际各约 180 毫秒，且明确断言 EOF 后宿主在 2 秒内 exit 0、自有 Codex fixture PID 已退出、stderr 没有 SHUTDOWN_INCOMPLETE。独立于宿主另启的测试进程仍存活，由测试自己的句柄在 finally 清理。

随后用同一 stateDir 启动第二个真实 CLI：initialize 阶段未提交业务 turn 的任务为 failed，activeDispatchId 已清空；turn/start 已提交但未得到回执的任务仍为 blocked / outcome_unknown，并保留原 activeDispatchId。两者 result / approvalId 都为空；重启后原幂等键重试返回同一个 task。事件只有一次 dispatch.started，没有 task.completed；fixture spawn 日志仍只有原 PID，证明没有替代派发。测试 finally 只关闭自有宿主、独立测试进程和本轮记录的 fixture PID，再清理本轮临时目录。

此项补足真实 EOF 资源链路证据；fixture 不读取真实 Codex 身份，也不调用模型。
