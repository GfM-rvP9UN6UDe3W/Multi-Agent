# SPEC-0003-A：Python SDK TDD 证据

日期：2026-09-19。范围：Python 的 `sessions.reconcile`、能力协商、公开请求类型、snake_case 映射和真实 Node 接线。Node 引擎和宿主由本轮其他变更提供；本文件不把协议 fixture 当作运行时验收。

## RED

先新增 `python/tests/test_reconcile.py` 和独立协议 fixture 的 lifecycle 模式，再运行：

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_reconcile.py -v
```

实际结果：`Ran 5 tests`、`FAILED (errors=10)`。六种能力缺失/不兼容子用例及其他调用因 `_Sessions` 没有 `reconcile` 抛出 `AttributeError`；公开类型用例因没有 `LifecycleTimeouts` / `ReconcileEvidence` 失败。这是接口缺失的运行期 RED，不是伪造的断言或编译错误。

## GREEN

实现后重复上述命令，5 项全部通过，覆盖：

- initialize 中 lifecycle 必须同时声明整数 `version=1`、`reconcile="owner-attestation"` 与布尔 `durableDeadlines=true`；旧宿主、错误版本、错误方法和类型不符都在发送变更前拒绝。
- `ReconcileEvidence` 及精确 target 从 snake_case 映射到 wire；返回 `OperationHandle`，生命周期字段和 resolution 可通过 snake_case 读取，操作的原始 result JSON 保留原键。
- 丢回执保留 `method=sessions.reconcile`、session scope 和幂等键；同键查询/重复调用可取得原操作。
- 本地 `OperationHandle.wait()` 超时不会重发操作或刷新持久 deadline。
- `LifecycleTimeouts` 公开毫秒字段和 SPEC 默认值；未提供的 evidence.result 不序列化为 null。

`Orchestrator.local` 没有新增 timeouts 参数，不读取或改写 `engine_command`。调用方通过 `agent_orch.types.to_wire(LifecycleTimeouts(...))` 写自己的临时 `--config` JSON；配置约束由宿主验证。

## 实际 Node stdio / socket 集成

新增 `python/tests/test_node_reconcile.py`，运行：

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_node_reconcile.py -v
```

- stdio 所有者从临时配置加载 40ms drain 期限；pause 到期成为 `outcome_unknown`，迟到结果只作证据，任务仍 blocked。
- 所有者显式核对 completed 后任务 paused；再次 resume 仅申请验收，人工批准后 completed。事件中 `dispatch.started` 精确为 1 次，证明这条路径没有重新调用 fake runtime。
- 同键 reconcile 返回原 ID；原 pause 操作仍保留 outcome_unknown 和 resolution；重启后 deadline、resolution、任务结果仍在。
- socket 非所有者通过同一公开 Python 方法收到 `UNAUTHORIZED`；断开不停止共享宿主。

第一次沙箱内运行 stdio 项通过、socket 项因本地 `listen EPERM` 失败；获得本地 socket 测试权限后重跑，2 项全部通过。这是环境权限调整，不记为接口 RED。

## 完整回归

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v
python3 -m compileall -q python/src/agent_orch python/tests
```

实际结果：32 项测试全部通过、无跳过；语法编译退出码 0。只使用独立 Python 协议 fixture、真实 Node 子进程、临时目录/数据库/socket 和显式 fake provider；没有读取登录凭据或调用付费模型。Claude/Codex 真实历史 inspection、实际外部副作用证明和模型业务验收不在这些测试的证明范围内。
