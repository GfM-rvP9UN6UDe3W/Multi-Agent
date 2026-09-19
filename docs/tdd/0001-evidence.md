# SPEC-0001 TDD 证据

日期：2026-09-19。本文件记录实际运行结果，不替代真实模型端到端验收。

## 环境

- macOS；Node.js v24.14.0；Python 3.14.6；TypeScript 5.9.3。
- Node 内建 SQLite 发出 experimental warning，保留在 stderr；stdlib SQLite 是当前持久化实现。
- 工作区此前只有两份 Markdown 和两张 PNG，没有源码或 Git 仓库。开发未覆盖既有业务代码，未初始化 Git、发布包或调用付费模型。

## RED → GREEN

| 范围 | RED 实证 | 实现后的结果 |
| --- | --- | --- |
| engine foundation | `node --test tests/engine/foundation.test.ts`：exit 1，ERR_MODULE_NOT_FOUND，index.ts 尚不存在 | 首轮 15/15 通过 |
| host + TS SDK | `node --test tests/contract/host.test.ts tests/contract/sdk.test.ts`：exit 1，2 文件缺失错误，host.ts / SDK index.ts 尚不存在 | 实现后在全量测试验证 |
| Python SDK | `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_sdk.py' -v`：exit 1，ModuleNotFoundError agent_orch | 首轮 15 项通过，后续补充恢复回归 |
| Claude/Codex adapters | `node --test tests/contract/adapters.test.ts`：exit 1，Claude 模块不存在 | 首轮 10/10 离线协议测试通过 |
| 有界关闭、结果会话 ID、控制竞争 | foundation 扩展后 15 pass / 3 fail：adapter cleanup hung、原生 session ID 为 null、cancel 后旧 pause 被误报 completed | 修复后 18/18 通过 |
| Python 丢回执恢复键 | 两个失败请求共用异常导致结果为 `[lost-second, lost-second]` | 修复独立异常对象并回归通过 |
| TS 慢宿主 wait 超时 | 状态读取延迟 200ms 导致本地 10ms 等待超时未及时返回 | 修复由相应契约测试验证 |

## 独立审查与补充行为回归

- 暂停被批准解除、过期批准从 session resume 重跑、`..state` 名称绕过目录判断：新增测试先 **18 pass / 3 fail**，修复后全绿。
- 上游 native session ID 在终态变化导致 pause operation 永久 persisted：定向测试 **0/1 → 1/1**；异常兜底现同事务标记 dispatch、mail/outbox 和控制操作为 outcome_unknown。
- 独立审查者再次运行上述四项定向回归，**4/4 PASS**。没有将重新审查代替主代理的全量回归。
- 大量中文结果与大事件页：新增定向测试 **0/2 → 2/2**；全文保存在内容寻址产物，内联预览限制 64 KiB，事件页按编码字节限制并保留正确游标。
- 宿主/TS 收尾的错误码、配置白名单、socket 私有目录/路径长度与数值范围先失败，再验证 **15/15 GREEN**。
- 适配器补充独立 CODEX_HOME、受管配置、请求/终态时限、队列上限和实际退出核对；先 RED 后 **16/16 GREEN**。本机 Codex 0.153.4 仅执行隔离配置的 initialize 握手，未发送模型轮次。
- Python 独立审查发现启动/关闭竞争和畸形 JSON 杀死 reader，修复记录见 [Python TDD](../../python/TDD.md)。

## 真实子进程与崩溃边界

`node --test tests/engine/recovery.test.ts`：通过。启动自有 fixture Node 进程，创建 running 和 queued 任务，SIGKILL 后重开同一 SQLite：锁释放；running → blocked/outcome_unknown；queued → paused；没有自动模型调用；显式恢复未执行的 queued 工作后只执行一轮。该测试是在已有恢复实现上补充的验收，未伪造独立 RED。

Python 的 `test_node_e2e.py` 使用本项目实际 Node CLI 和 fake runtime，验证 stdio 创建/验收/重启幂等、两个 Unix 客户端共享状态和独立关闭、关闭超时续等/中断。这里验证本地进程接线，未验证厂商模型。

`tests/contract/cross-language.test.ts` 补充真正混合语言链路：TypeScript 提交 → Python 连接同一 Unix 宿主、重放批准事件并核对 fixture 后批准 → TypeScript 等到同一任务 completed；确认同 storeId、同 taskId，Python 断开后宿主仍存活。定向运行 1/1 通过。

## 最终验证

主代理在所有修复合入工作区后重新执行：

| 命令 | 最终结果 |
| --- | --- |
| `npm test` | **57/57 PASS**，0 fail、0 skip；1.441 秒 |
| `npm run test:python` | **25/25 PASS**，0 skip；1.588 秒 |
| `npm run typecheck` | exit 0 |
| `npm run format:check` | exit 0，所有目标源码格式通过 |
| `python3 -m compileall -q python/src python/tests examples/python` | exit 0 |
| `PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py` | completed，fake，model_calls=none |
| TypeScript local 示例实际子进程 | 输入已知 fixture 的 approve，completed，进程 exit 0 |

合计 82 个自动化测试，包含实际混合语言、子进程、socket、数据库和崩溃边界。Python socket 测试初次受沙盒 EPERM 限制；在获准本机 IPC 的执行环境下重跑并通过，未跳过失败用例。

最终没有运行厂商模型任务，没有据此认定完整首版已经交付。

## 未验收

实际 Claude/Codex 模型任务、官方账户登录、完整 MCP 工具桥、网关、真实 cache/usage 费用、长驻 Claude streaming input、fork/compact/rotate、跨语言发布安装、Node 最低版本和 Python 最低版本矩阵，均不得由本次离线测试推定通过。
