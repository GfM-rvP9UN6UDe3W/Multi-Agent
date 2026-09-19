# SPEC-0003-A：Codex 自有资源回收与单调时钟证据

日期：2026-09-19。范围只包含 `packages/adapter-codex/src/index.ts`、新增 Codex 资源生命周期测试及本证据。测试运行本地协议 fixture 子进程，不读取用户登录、不调用真实 Codex 或付费模型；进程检查及清理只针对本测试启动且自行写出 PID 的 fixture。

## RED

先新增 6 项测试，再运行：

```sh
node --test tests/contract/codex-lifecycle-resources.test.ts
```

实际 exit 1；6 tests / 0 pass / 6 fail。

- initialize 与 turn/start 挂起、忽略 SIGTERM、回收失败保留隔离四项：`adapter.close` 实际为 undefined，期望 function。
- request / terminal 两项：在墙钟回拨 60 秒且持续收到无关帧时，实际等待超过 700 毫秒测试截止时限；配置 RPC 或 turn 时限为 180 毫秒。

## 实现

- 每个 session 登记本次 spawn 返回的 AppServerConnection；`hasActiveResources(sessionId)` 只在 child 的真实 exit 事件或未成功 spawn 的 error 事件确认后解除资源占用。没有进程扫描、按名称查杀或重启后按持久 PID 回收。
- `adapter.close()` 主动关闭所持连接，唤醒正在等待的 RPC，并阻止新的请求/执行；未确认退出时拒绝为 SHUTDOWN_INCOMPLETE。失败后资源仍可查询且允许再次关闭，直到观察到退出。
- 保留既有 `closeTimeoutMs` 语义：TERM 与 KILL 两阶段各使用该等待上限；不是新增的总预算。initialize 未提交业务 turn 且确认退出时为 failed；turn/start 已写出而无终态证据时仍为 unknown。资源回收本身不生成 interrupted / completed 业务终态。
- RPC 与 turn terminal 截止时刻使用 `performance.now()`，无关帧不能借墙钟回拨延长期限。turn 的 may-have-been-sent 标记在实际写出请求后设置。

## GREEN

运行：

```sh
node --test tests/contract/codex-lifecycle-resources.test.ts tests/contract/adapters.test.ts
npm run typecheck
node node_modules/prettier/bin/prettier.cjs --check packages/adapter-codex/src/index.ts tests/contract/codex-lifecycle-resources.test.ts
```

实际均 exit 0。22 tests / 22 pass / 0 fail / 0 skipped，其中新增 6 项、既有适配器 16 项；类型检查和本范围格式检查通过。

新增行为覆盖真实 fixture 的 initialize / turn-start 挂起后主动关闭、忽略 TERM 后 KILL 并确认退出、按 session 反映资源占用、墙钟回拨与持续噪声。无法退出路径使用本测试进程中 ChildProcess.kill 返回 false 的替身保持真实 fixture 存活：首次 close 明确失败且 hook 保持 true，恢复信号发送后再次 close 确认自有 PID 消失，hook 才为 false。

这是离线协议与进程生命周期验证，不是实际 Codex 模型业务验收。宿主 EOF 和引擎核对使用资源 hook 的接线由对应引擎证据记录。
