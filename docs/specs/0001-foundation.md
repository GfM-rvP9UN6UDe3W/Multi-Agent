# SPEC-0001：双语言编排基础闭环

日期：2026-09-19。状态：第一增量已实现，验证记录见 docs/tdd/0001-evidence.md。依据：`AGENT_ORCHESTRATION_DESIGN.md` 第 3、4、6、10 节。开发方法：TDD；先提交到工作区的行为测试并实际观察失败，再实现，再记录通过结果。当前目录尚未初始化 Git；本次不发布、不提交代码。

后续 [SPEC-0003-A](./0003-a-lifecycle.md) 已在同一 wire 1.0 上增加持久期限、unknown 隔离和所有者人工核对；本文件保留基础增量的历史验收编号，新增结果见 [0003-A 证据](../tdd/0003-a-evidence.md)。

## 1. 本轮交付边界

实现本地可运行的第一增量：唯一 Node 引擎、SQLite WAL、TS 嵌入 SDK、stdio/Unix socket 宿主、Python 异步客户端、人工验收、持久事件和消息、有限并发、暂停/恢复/取消与保守重启。使用确定性 runtime 验证故障路径；两个厂商适配器单独用协议替身测试，并标明未进行付费真实模型验收。

第一增量内部 adapter 使用一次轮次的 `execute(input)` 异步事件流；它是完整设计的 open/submit/observe 生命周期下的临时内部接口，不对外承诺兼容。fork、compact、rotate、模型工具委派、MCP 回调桥、自动验证命令、金额预算、共享文件写入锁和自动上下文优化不在本轮实现范围；调用未实现能力必须明确拒绝，不能模拟成功。完整首版仍按主设计后续阶段推进。

运行要求先锁定 Node.js 22.18+（内建 TypeScript stripping 与 node:sqlite）、Python 3.11+。TypeScript 使用可擦除语法，开发期执行类型检查；Python 只用标准库和同一宿主，不实现第二套调度器。

## 2. 验收条款

- AC01：同一 stateDir 只允许一个持有 OS 文件锁的引擎；第二次启动报 HOST_ALREADY_RUNNING。workspace/stateDir 必须为真实绝对目录，stateDir 不得位于 workspace 内。数据库版本与 workspace 身份在启动时核对。
- AC02：创建任务和 operation、事件同事务持久化。同一 method+scope+idempotencyKey 与相同规范化载荷返回同一对象；不同载荷报 IDEMPOTENCY_CONFLICT。重启后仍成立。
- AC03：普通程序调度，maxActiveSessions 限制全局并发，同一 session 同时只有一个 dispatch。只允许明确配置的 provider/model。任务创建回执不代表执行完成。
- AC04：运行时结果先落盘并产生 task_acceptance 批准；任务保持 waiting_approval。人工批准需要有效 approvalId/revision，approve 后才 completed，deny 后 failed。重复、过期或跨目标批准拒绝；普通消息不能批准任务。
- AC05：日志 cursor 为有序十进制字符串，绑定 storeId。状态变化与对应事件原子提交。历史到实时通过有界 cursor 拉取衔接，不丢早到事件；未知 storeId/越界游标明确失败。
- AC06：等待超时/本地协程取消只停止等待，不取消已提交任务。显式 tasks.cancel 需确认当前 dispatch 终态；断线无终态时 blocked/outcome_unknown。
- AC07：close drain 停止新派发，等待当前轮次，未执行工作变 paused；超时抛 SHUTDOWN_INCOMPLETE，保留 client/operationId，可继续 drain 或 interrupt。socket 客户端断开不得关闭宿主，非所有者 shutdown 拒绝。
- AC08：重启时旧 queued 工作变 paused，旧 running/dispatching 工作变 blocked/outcome_unknown，不自动调用模型、不盲目重发。已验收终态与可核对事件保留。
- AC09：消息与 outbox 同事务保存，目标 task/session/generation 必须匹配；重复键不产生第二轮。paused/等待批准/unknown 接收方仅保存。空闲活动任务可投递一批消息，只有运行时受理证据推进 runtime_accepted，真实终态推进 completed。
- AC10：session 控制校验 expectedRevision/expectedGeneration/expectedDispatchId/expectedState；旧控制拒绝，不影响新轮次。pause(drain) 等当前轮完成，pause(interrupt) 等终态；unsupported 能力明确报错。
- AC11：JSON-RPC 2.0 单行 UTF-8；限制帧 1 MiB、每连接 64 个待处理请求；stdout 仅协议，stderr 日志独立消费。版本握手在业务请求前，未知方法/字段非法时报明确错误。慢事件消费者不在宿主积压无限推送。
- AC12：TS 嵌入、Python stdio、TS/Python Unix 连接用相同引擎通过创建→事件→人工验收→终态；Python 不读取 SQLite。四类模型计量字段缺失保留 null，不合成零或费用。

## 3. 第一增量 wire 契约（1.0）

方法参数为对象，所有消息为 `{jsonrpc:"2.0",id,method,params}`。成功 `{jsonrpc:"2.0",id,result}`；失败 `{jsonrpc:"2.0",id,error:{code:-32000,message,data:{code:<稳定错误码>,...}}}`。幂等键由客户端生成并保留或由调用者明确提供。可信本地业务客户端共用 `ownerScope=local`；不宣称多用户隔离。

| 方法 | params | result |
| --- | --- | --- |
| initialize | protocolVersion:"1.0", sdkVersion:string | protocolVersion,engineVersion,schemaVersion,instanceId,storeId,capabilities |
| tasks.create | spec:TaskSpec, idempotencyKey:string | TaskSnapshot |
| tasks.get | taskId | TaskSnapshot |
| tasks.resume / tasks.cancel | taskId,idempotencyKey | OperationSnapshot |
| sessions.get | sessionId | SessionSnapshot |
| sessions.control | target,command,idempotencyKey | OperationSnapshot |
| sessions.reconcile（0003-A 扩展） | target,evidence:ReconcileEvidence,idempotencyKey；仅宿主所有者 | OperationSnapshot |
| messages.send | spec:MessageSpec,idempotencyKey | MessageSnapshot |
| messages.get | messageId | MessageSnapshot |
| operations.get | operationId | OperationSnapshot |
| operations.lookup | method,scope,idempotencyKey | OperationSnapshot 或 NOT_FOUND |
| approvals.get | approvalId | ApprovalRequest |
| approvals.decide | approvalId,decision:{choice,expectedRevision},idempotencyKey | OperationSnapshot |
| events.read | afterCursor?:string,storeId?:string,taskId?:string,limit?:number | {events:EventEnvelope[],cursor:string,storeId:string} |
| usage.get | taskId | {records:UsageRecord[],completeness:"unknown"或"reported"} |
| capabilities.get | provider?:string | 能力对象 |
| host.shutdown / host.shutdown.continue | mode:"drain"或"interrupt",timeoutMs:number,operationId?:string | {status:"closed",operationId} |

第一增量 SDK 的 events 异步迭代器用 `events.read` 有界游标拉取（默认 50ms 空闲等待）；只查询数据库，不请求模型。后续订阅推送不能改变 cursor/storeId 语义。wait 同样只读任务/操作状态；超时返回 TIMEOUT，不执行远端取消。首次 afterCursor 默认为 "0"；0 表示当前 store 的初始位置；显式续传非零 cursor 必须带 storeId。

TaskSpec：`{goal,runtime:{provider,model},acceptance:{mode:"human",criteria:string[]}}`。运行结果全文保存到 `stateDir/artifacts/<sha256>.txt`，result 与批准 summary 超过 64 KiB UTF-8 时提供明确标记的预览及 artifactRefs；人工验收需按需检查完整产物。events.read 同时按条数和 768 KiB 编码字节分页，cursor 不跨过尚未返回的记录。TaskSnapshot 至少含 `id,status,revision,sessionId,spec,artifactRefs,result:null|string,reason:null|string,approvalId:null|string,createdAt,updatedAt`。SessionSnapshot 至少含 `id,taskId,provider,model,providerSessionId:null|string,generation,revision,status,activeDispatchId:null|string`。

MessageSpec：`{taskId,toSessionId,expectedGeneration,kind,summary,artifactRefs?:string[]}`，from 由宿主身份推导。OperationSnapshot：`{id,method,scope,idempotencyKey,status,targetId,result,error}`。ApprovalRequest：`{approvalId,taskId,purpose:"task_acceptance",revision,status,target,summary,evidenceRefs,expiresAt}`。EventEnvelope：`{eventId,cursor,storeId,schemaVersion:1,type,taskId,sessionId,operationId,occurredAt,data}`。

SessionControlTarget 必须包含 `sessionId,expectedGeneration,expectedRevision,expectedDispatchId:null|string,expectedState`。command：`{action:"pause"|"resume",mode?:"drain"|"interrupt"}`；其它 action 报 UNSUPPORTED_CAPABILITY。终态 task 不允许再发消息或恢复。已暂停的 session 不会因批准旧结果而自动投递邮箱。批准过期后的 task/session resume 只重新申请验收，不重复执行已有成果。blocked/outcome_unknown 不接受直接 resume；0003-A 已提供所有者 `sessions.reconcile`，核对目标必须包含仍被隔离的非空 dispatch ID。

0003-A 通过 `initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true}` 协商；旧客户端可忽略新增可选字段，新 SDK 对缺失能力的宿主不发送 reconcile。OperationSnapshot 可含 `lifecycle` 和 `resolution`。宿主配置 `timeouts` 默认 `acceptanceMs=30000,turnMs=300000,drainMs=300000,interruptMs=30000,reconcileMs=60000`，每项为 1..86400000 整数毫秒。超时保留 unknown 和并发隔离，迟到证据不会自动恢复；人工核对的字段、权限及分支以 SPEC-0003-A 为准，不代表上游自动 inspection。

Python 已知协议 envelope 字段转为 snake_case；自定义 `data` 内容按定义的已知字段处理，不修改任意用户对象的键。SDK 提供 TaskSpec、RuntimeSpec、AcceptanceSpec、ReconcileEvidence、LifecycleTimeouts 及 attr 访问快照和 handle。Python 的 timeouts 由调用方写入宿主 JSON，通过既有 `engine_command` 的 `--config` 参数传递，不新增 local 参数。

## 4. 测试及证据

测试命名引用 AC。先创建测试并运行 RED，再实现，最后运行 GREEN、类型检查、双语言真实子进程集成。常规测试只使用 fake runtime、临时 workspace/stateDir 和本机 socket，不读取登录凭据、不运行付费模型。厂商协议测试使用可控子进程/SDK 替身，不等于真实厂商验收。

按测试输出记录到 `docs/tdd/0001-evidence.md`，必须区分单元/契约/实际子进程接线/未验证的真实模型。README 提供可执行本地示例和验收命令。设计与使用说明更新状态及链接，未实现的未来接口仍明确标注。
