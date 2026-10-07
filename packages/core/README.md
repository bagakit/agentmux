# @agentmux/core

无 Electron、React 依赖的 AgentMux Runtime Core。

产品术语只引用 [交互合同《统一概念与空间寻址》](../../docs/design/behavior/spaces-and-layout.md#统一概念与空间寻址)：Space/Zone/Tab/Region 的稳定身份、关系与持久布局归 Core，Project/Workspace 是资源来源上下文；Core 持有 AgentSession 语义事实，ctxmux 持有 Run；公开 Control 表达空间目标和回执，client 持有可见表面与焦点。Core RuntimeProjection 是执行事实投影，Desktop View 是展示；两者分开，不能与 AgentSession/Run 或 Desktop Tab 身份混同。空间移动不改 Session cwd。空间 CLI 的精确寻址、失败保留和丢回执查询遵循[空间 CLI 使用合同](../../docs/guides/agentmux-cli-object-control.md)。Desktop Client 组合自己的配置与 Git owner，并消费 Core 的持久空间和公开 Agent API。

常用入口：[Terminal 调用](#terminal-调用) · [Agent 调用与输入](#agent-调用与输入) · [原生对话读取](#原生对话读取) · [Runtime 边界](#runtime-边界)。

当前 Local Run 只由随包 [Darwin manifest](vendor/ctxmux/darwin-arm64/manifest.json) 与 [Linux manifest](vendor/ctxmux/linux-x64/manifest.json) 绑定的固定 CtxMux 产物持有。包内携带 exact-commit manifest、同一 SDK tarball 和 darwin-arm64 / linux-x64 binaries；开发期依赖只从这份 tarball 取得官方类型，构建再把同一 SDK 私有 bundle 进唯一 `CtxmuxRunAdapter`，不保留手写 wire 声明。公共 API 不导出 CtxMux SDK/wire 类型，发布后的 runtime 也不需要相邻仓库、外部 `@ctxmux/sdk`、全局 `ctxmux` 或运行时下载。

Core 使用 Node 24+，包不设 OS 安装门，portable API 可独立使用；随包原生 Runtime 支持 macOS arm64 与 Linux x64。`ctxmux` / `ctxmuxd` 的 npm bin 按宿主选择固定原生产物；正常 npm 安装的 `postinstall` 先校验 manifest、字节数与 SHA-256，再恢复原生文件的执行位。`--ignore-scripts` 会跳过这个必要安装步骤，Runtime 无法执行；请启用 lifecycle scripts 重新安装。安装脚本只处理包内固定产物，不访问网络、宿主配置或已有 Run。

`connectLocalAgentMux` 不提供逐调用 socket/state 参数。[runtime-paths.ts](src/runtime-paths.ts) 持有进程级路径策略：默认 Endpoint 与持久状态使用稳定宿主 namespace，持久状态在用户目录；`AGENTMUX_RUNTIME_DIRECTORY` 与 `AGENTMUX_STATE_DIRECTORY` 可指定绝对路径。产物身份变化不另建 Runtime。只启动经过 hash、mode 和公开 `--version` 合同验证的随包 `ctxmuxd`。已有服务按公开 Runtime identity、协议与所需 capability 核验；归属记录未知只限制清理权限，兼容服务上的健康 Run 继续可用。bootstrap 读取原始 `runtimeInfo()`，随后每次业务 dispatch 都在承载该业务帧的同一连接上匹配 expected Runtime identity；身份变化在发送前明确拒绝，不猜已经送达或自动重放。

`defaultLocalHostLabel(platform?)` 为新本机 Host 提供显示默认值，`LocalExecutionHost` 与宿主的新配置共同消费；传入或保存的 `label` 继续优先。该函数沿 [execution-host.ts](src/execution-host.ts) 导出，只处理名称，不探测能力或启动 Runtime；默认名称的系统规则见[机器目录分区合同](../../docs/design/behavior/spaces-and-layout.md#跨设备关联项目组)。

`probeAgent`、`probeExecutorAvailability` 与本地 Host Executor owner 的配置／发现不要求 ctxmux 连接；它们读取该语义 Host 的 Provider 与文件系统。Hosted 调用仍在准确远端 owner 上执行，本地探测不代签远端。Executor 注册表保留原 schema、Host 身份、逐项校验与 durable CAS 写入，不以累计条数或文件字节预算拒绝合法增长；Control 回执消费完整清单，公开快照仍按调用方的分页 limit 返回。


## 原生对话读取

共同记录投影与公开有界读取见[对话协议](../../docs/specs/conversation-protocol.md)。`@agentmux/core/conversation` 不依赖 UI；既有 Desktop/Mobile 消息面与外部接入复用原来源与内容，不另建历史缓存。

`sessionHistoryPage(agentSessionId, { limit, cursor?, signal? })` 读取原 Session 的 Provider 原生记录；`observeSessionHistory(agentSessionId, onChange)` 观察该原生来源的变化，消费者据此重读最新页。两者独立于 Hook timeline，读取不向 Agent 输入内容或改变 Run。历史 cursor 是 Provider 生成的 opaque 值，不能用数组下标、正文或时间重新生成。

原生记录可携带 `metrics`：`scope: 'turn'` 归属该记录准确的 `turnId`，`scope: 'response'` 归属原记录 ID；可选的 `durationMs`、`usage` 和 `status` 都是只读原生报告。缺值不补零，累计快照不相加，`metricsDiagnostic` 只说明读数不可确认，原内容与 Agent 能力保留。原历史页、conversation changes、context 和 CLI 读取同一字段，不能把最新 Hook 用量贴到历史回合。既有 `turnUsage.scope: 'response'` 表示最近响应样本，旧样本缺 scope 时范围未知；上下文观测独立。

| Provider | 原生来源与身份 | 更新观察 | Native Resume |
| --- | --- | --- | --- |
| Grok | `chat_history.jsonl`；原 Session ID、Workspace 与 `summary.info` 一致 | 同一经过核验的 JSONL，包含第一次落盘 | Session ID |
| Pi | 原 `session_file` 的分支 JSONL；身份来自原生 session header 与受信 Hook binding | 同一 JSONL | 原 session file |
| Antigravity | 主 CLI 持有的 `presence/<UUID>.lock`；同 UUID 的 compact/full transcript | 两个精确 transcript，共同清理 | Conversation UUID |
| Cursor | 当前 Run 打开的原 `store.db` 与 native metadata；canonical conversation protobuf | DB/WAL/journal 原生 commit 的实际 revision | Conversation UUID |
| TraeX | 当前 Run 打开的 rollout 与 `session_meta`；由原生 app-server 解释 indexed history | 同一 rollout | Session ID |

上述是源码能力，不代表任意厂商版本、当前安装或所有真实运行场景已验收。Client 共同消费 `AgentSessionHistoryPage`，不按 Provider 另建阅读界面、轮询或消息账本。保存的用户输入、Agent 回复与过程记录保留各自原顺序、ID 和 content parts；未提供的作者、渠道、设备、时间与状态保持未知。终端输入须等原生 CLI 保存为记录后才能由原生读取接口取得，不能把尚未保存的终端编辑缓冲当成已提交消息。

Provider 明确标记的运行时上下文或系统指令使用 `AgentSessionHistoryItem.kind = 'system-message'`，与 `user-message`、`assistant-message` 和 `activity` 区分，仍保留原 source、记录 ID、title 与完整 content parts。此类型是只读历史语义，不授予指令优先级或控制权限；用户正文中的标签不改变分类。原 `sessionHistoryPage`、RPC 和 `agent history --source native` 直接传递该类型，客户端可复用系统卡片，不把它加入用户输入历史。

Codex 保存的 JSONL 历史与原生 indexed history 复用同一完整问题回复协议：明确的用户文本回复附带 `questionAnswers`，保留完整 wire、原记录和未知作者；引用、混合正文、残缺或未知数据继续按原文阅读。可选答案字段挤出既有页预算时，仅撤回必要的附加字段并以 `questionDiagnostic` 说明原文仍完整；连诊断也无法装入时，保原页并由 Provider stderr 报告投影边界。该字段仅用于历史答案阅读与既有历史查询，不建立待回答状态、权限或发送资格。

同一 SQLite 身份的写入竞争返回 `AGENT_SESSION_HISTORY_SNAPSHOT_CHANGED`，本次页不发布；观察保留，后续原生提交可恢复。主来源被替换或 native identity 不一致返回 `AGENT_SESSION_HISTORY_SOURCE_CHANGED`，只停止这个来源的观察。两种情况都不删除已有正文、原 Session 或健康 Run；调用者保留旧阅读窗口并显示明确的读取状态。无 WAL 的已关闭数据库沿同一只读 VFS 读取，不创建 native WAL/SHM。JSONL 来源替换按原来源边界处理，不能以相同路径或新 mtime 推断仍是原会话。

`sessionHistoryResource(agentSessionId, request)` 读取原生记录中准确声明的资源。request 包含原 source、turnId（存在时）、recordId、partIndex 和 required expectedReference；错 Session／source／record／part／reference 拒绝本次操作。图片保持 `read`（MIME/base64/byteLength）、固定 16 MiB 原图上限及既有 Provider 准确 record 核验；opaque／HTTP 不自动抓取。JSONL 的巨大合法正文以 `resourceType: 'text'` 与 `content` 的原 semantic kind／总字节／SHA-256 标记，在准确原文件范围内按 `offsetBytes` 和 `maxBytes`（最多 128 KiB）返回 `fragment`。大项以内部显式文本值保留原物理来源，由 Provider 选择正文截取、JSON 格式化和 Base64 编码，大小字段遵循相同的语义规则；通用 Reader 不把占位字符串当正文。格式化后的内容通过有限物理块索引读取，每块以原字节 digest 校验，中间原地改写拒绝受影响的片读，合法末尾追加保留原引用；累计 IO 随该原记录增长，页内 materialization 仍有界，旧消息可用原 cursor 继续读取。

浏览器可直接从 `@agentmux/core/session-history-content` 使用 `readSessionHistoryTextResource(part, partIndex, record, reader, signal?)`：它显式读取完整内容，校验每片身份、偏移、总字节与 SHA-256，并返回原 text／reasoning／tool 等 semantic part；不缓存或控制 Run。公共 RPC `agent.history.resource` 与 CLI `agent history resource --input FILE|-` 使用同一请求和准确回执，hostId／agentSessionId 指向原语义 Host。活跃 Session 沿既有持久凭据签名，Core 重启不使引用失效；凭据已退休／轮换时，首次读取由原 Provider 重证准确原记录与内容范围，fragment 的可选 `continuationReference` 发布本代次的只读续读授权；顶层 `reference` 仍准确回显本次请求。SDK helper 验证原身份、内容元数据与片段后，后续请求沿用该授权，不重复扫描原记录；每片仍验证实际贡献块的原字节 digest。Core 再次重启或凭据再次轮换时重新续证一次，合法尾部追加不使旧准确内容失效。自行逐片读取的 client 同样以续读授权作为下一次 `expectedReference`；不承接它仍可读取，但会重复重证。不新增长期秘密或内容缓存，也不控制 Run。

CLI/RPC 历史分页复用原 `agent history` / `agent.history`；Native Resume 仍通过 Core Session 生命周期完成。Hook、Permission、Usage 和问题回答是各自独立声明的能力，不能因 history reader 可用而冒充已接入。

## Runtime 边界

`@agentmux/core` 是 ctxmux 的 Client，不是 ctxmux 的宿主。ctxmux 自己的 daemon、CLI、
协议和 SDK 构成可独立使用的通用 Run Runtime；Core 随包固定 artifact 只是当前产品的
供应链和 endpoint policy。

Core 只消费 ctxmux 能权威证明的 Run 事实：identity、capability、lifecycle、ordered
bytes、replay、gap、input、resize、interrupt、stop、revision 和时间。Core 自己持有
Provider、AgentSession、provider-native identity、Launch/Resume Plan、Hook、Permission、
Prompt readiness、Agent status 和 Evidence 解释。新增 Provider 不得要求 ctxmux 增加
Agent-specific Run 类型或解析 Provider 输出。

Codex 的官方错误资料、原生暴露边界与适配核对见[Codex Provider 错误说明](../../docs/guides/codex-provider-errors.md)。模型请求失败的通用行为由[交互合同](../../docs/design/behavior/agent-capabilities-and-messaging.md#模型请求失败与工作结果)持有；说明中的覆盖范围不代称当前候选已经实现或安装。

Provider-native Resume 由 Core 从自己的 Session/provenance 物化新的通用 `RunSpec`，再
请求 ctxmux 创建并记录相应 lineage。调用方请求 Level B 而 provenance 不足时必须失败；
Core 和 ctxmux 都不能把它暗中降为 Level A restart。

## Terminal 调用

```ts
import { connectLocalAgentMuxRuntime } from '@agentmux/core'

const client = await connectLocalAgentMuxRuntime()
const run = await client.createTerminal({ workspacePath: process.cwd() })
const attachment = await client.attachTerminal(run.runId, 0)
const secondViewReplay = await client.readRunReplay(run, 0)
await client.writeTerminal(run, {
  ownerInstanceId: client.runtimeIdentity().instanceId,
  operationId: crypto.randomUUID(),
  expectedByte: run.acceptedInputBytes,
  data: 'pwd\n'
})
await client.releaseRunAttachment(attachment.run)
```

`connectLocalAgentMuxRuntime` 返回已连接原 Runtime 的 Client，终端控制不等待 Session 清单、Hook 或 Provider 观察。需要完整语义时，在同一 Client 上显式 `await client.connect()`；等待或失败期间仍保留终端能力，`runtimeDiagnostics()` 确认物理 Runtime，`onEvent` 提供观察失败阶段及后续恢复事实，修正原因后可再次 `connect()`。`connectLocalAgentMux` 仍等待完整观察成功才返回，适合直接需要 Agent 语义的调用者；两入口共用 Runtime、身份和生命周期。连接组合不新增同义 CLI，现有终端／Agent 命令继续使用原公开控制能力。

Run identity 就是 `{ runId }`。关闭 Client 不会停止 Run；`attachTerminal(runId, afterByte)` 用累计 raw-output byte cursor 建立 retained Attachment，`readRunReplay(run, afterByte)` 在不新增 retained owner 的前提下为另一个 View 读取有界 Replay，`releaseRunAttachment(run)` 按 exact RunRef 释放。Input 调用方在 disposition 确定前保留 `ownerInstanceId + operationId + expectedByte + data`，新 Client 可以重试同一 operation，CtxMux 返回精确 applied byte range 且不会重复写 PTY。`signalTerminal(..., 'SIGINT')` 映射 CtxMux portable Interrupt，其他信号失败关闭。 Agent 中断使用 `signalAgent(agentSessionId, expectedRun, 'SIGINT')`，原 Run 在连接等待或 Resume 后改变时只拒绝该旧目标操作；历史、语义观察失败不阻断准确 Run 的中断。远程 Client 使用相同 API，连接方式见下文。

`refreshRunAttachment(run, afterByte, view, operationId?)` 沿同一个 retained owner 重开该 Client 对原 Run 的观察连接：先打开并核对 snapshot，再替换 live pump；打开失败保原 owner，不停止 Run，也不发送 Input。它与只读 `readRunReplay` 的结果范围不同。刷新直接产生的状态投影携带通用 `observationOrigin`（精确 Run 与 operation），仍是事实更新，不构成新的输入执行意图；独立 Hook、重连及 live output 不带该来源。实际新 attachment 只确认观察连接建立，不是 Run 活性或 Input 送达回执。

Replay 和 `terminal-output` 的 `dataBytes: Uint8Array` 是终端消费者应写入的原始字节；`data` 是给语义观察者的流式文本，不用于字节裁剪。CLI `agent output` 与 `agent output --follow` 使用 `dataBase64` 表达同一字节流，调用方用 base64 解码后按范围去重。行为合同见设计 SSOT 的「ordered bytes 的公开传输边界」。

Shell packed consumer 的验证义务包括 same Run/PID reconnect、fragmented UTF-8、interior byte replay、lost-receipt Input dedup、resize、interrupt-still-live 和 complete stubborn-tree Stop。源码与历史通过记录不代签当前候选；oracle 和证据范围见[测试策略](../../docs/testing/strategy.md)。

## Agent 调用与输入

Codex 代表纵切现在也走同一个 Adapter。`AgentProvider` 仍在 Core 生成 Launch/Resume Plan、归一化 Hook/Permission，并在 daemon-issued RunId 返回后把每次 Hook binding 锁定到 exact Run。Core File Store/Resolver 独占 `agentSessionId`、当前 RunId、Provider native session id/ACP handle 与完整退役 Run／Session 身份事实；旧 Run、未知 native id 和冲突绑定失败关闭。Desktop 与 CLI 共用该 Store，不再维护第二份身份文件。

Hook 的 stable binding identity 与随机 bearer 只存在于权限为 `0600` 的 Stored Session；`createAgent`、`agentSessions`、Resolver、Status、事件和 View 投影都会删除这两个控制字段。`client.onEvent` 只接受同步观察 callback；异步 Consumer 必须先复制到自己的有界队列，类型会拒绝返回 Promise 的 callback。绕过类型的调用若返回 Promise，仅该 Consumer 会退订；可用 `onEvent(callback, { onError })` 接收诊断，未提供时写入 console，其他观察者收到 `agent-error`。修正 callback 后显式重新订阅，原 Agent 与 Runtime 能力保留。监听数量随实际订阅增长，释放函数与 `dispose` 回收订阅，不以固定对象数阻断。完整终端字节使用 Attachment/Replay。

Provider/ACP semantic status 与 pending Permission/Question 也是 Core-owned Session 事实。Client
通过 `interaction` 事件和 `session.pendingInteraction` 公开 typed request；Consumer 用
`respondAgentInteraction({ agentSessionId, expectedRun, operationId, expectedRequest, response })` 回答并取得
`AgentMuxInteractionOperationReceipt`；`expectedRequest` 保留用户作答时的原 typed 内容与 evidence。Core 会验证 exact Session、
Run、request 与选项，ACP response 回到 Adapter，Native response 交给 Provider 规划终端协议。
结构化回答的 Consumer 不生成厂商按键，也不从 `status.detail` 猜交互。需要两阶段 Prompt 的 Provider 必须同时
声明真实 transport `payload` 与 TUI `renderedText`；bracketed paste 不是 Core 默认行为。Prompt 采用
64 KiB 上限，screen oracle 的有界 scrollback 覆盖同一范围。pending interaction 期间，普通 Prompt
被 Core 拒绝；原生终端仍通过 `writeAgent({ agentSessionId, expectedRun, data, source })`
可用。`source` 必须为 `user` 或 `terminal-protocol`，自动协议回应不视为用户回答。原生输入
只记录调用时精确请求的投递事实；accepted/unknown 不等于批准，不自动重放。Consumer 从
`session.pendingInteraction` 读取当前事实，用 `agentInteractionResponseUnavailableReason` 显示
结构化回答不可用的原因与原生入口；新请求、Working 或 Stop 不证明旧请求已完成。ACP response
按原 Adapter 的操作回执表达，Native response 按原 ctxmux
recoverable Input claim 收敛。

`inspectAgentInteractionOperation({ agentSessionId, operationId })` 只读原操作，问题完成或 Run 更换后仍可查询。
原 SessionStore 保留操作索引，普通 Session／事件投影不广播其累计内容。回执分别报告保存、派发未知、
PTY 字节接受、Hook connection written、ACP adapter acknowledgement 和准确原生完成；Native adoption
没有协议事实时保持 `unknown`。相同 operationId 不允许更改答案或原目标，竞争操作不能覆盖同一原请求。
丢回执先查询；查询不派发输入。用户明确重试同一操作与内容时，PTY 沿原 recoverable Input join；
可能首次施效时仍核对原 request、Run 与当前 native target，已经施效则消费原去重回执。Hook unknown
不能重放到另一回调。原生终端输入与健康 Agent 不因查询或目标资格未知而关闭。

公共 RPC `agent.interaction.respond`／`agent.interaction.inspect` 与 CLI
`agent interaction respond --input FILE|-`／`agent interaction inspect --session ID --operation-id ID`
复用同一 owner。响应需要传输批准的 user／device；正文中的身份声明和 managed Agent capability
不能取得权限确认。同步原请求与历史异步问题继续分别处理。

普通 Prompt 通过 `submitAgentPrompt` 投递。首次可能执行的调用前，用
`agentPromptCondition(await client.refreshAgentSession(agentSessionId, expectedRun))`
读取精确 Session 的 admission 条件，并与 operationId、正文和 Run 一起保存到调用方已有的发送意图。
队列尾部到真正派发时才读取；重试和丢回执恢复复用原条件，不按最新状态重新绑定。
`agentPromptNotApplied(session)` 从原 Core admission 与分阶段受据确认整个逻辑输入完全未应用；
该原 operation 是稳定终局，同 ID 的恢复返回 `AGENT_PROMPT_INPUT_NOT_APPLIED`／`not_applied`，不会再次输入。
用户下一次明确发送使用新 operationId 和当前 `agentPromptCondition`，保留原正文与拒绝记录。
仅本次调用零字节、准备失败、独立重绘拒绝或正文已接受而提交未完成均不构成整操作终局；unknown／partial 仍续原请求。
`afterSubmissionId: null` 表示已确认没有前序 admission，缺少该字段表示未知。
如果后续消息已经替换原 admission 且原 tuple 不在，旧消息返回
`AGENT_PROMPT_INPUT_UNCONFIRMED`，保留后续事实与原生终端输入；这不代表 Agent 失效。

```ts
await client.connect() // Load Session and Provider observation on the same Runtime.
const session = await client.createAgent({
  providerId: 'codex',
  executorId: 'codex-full-auto',
  workspacePath: process.cwd(),
  injectAgentMuxGuide: true,
  prompt: 'Inspect the failing test'
})
const status = await client.statusAgent(session.agentSessionId)
const nativeHandle = status.session.nativeHandle
if (nativeHandle?.kind !== 'provider') throw new Error('Codex native session is not ready')
const byNative = client.resolveAgentSession({
  kind: 'provider-native',
  providerId: nativeHandle.providerId,
  sessionId: nativeHandle.sessionId
})
```

需要报告首次 Prompt 的投递事实时，用同一次创建的公开 API：

```ts
const { session, creation } = await client.createAgentWithDelivery({
  providerId: 'codex',
  executorId: 'codex-full-auto',
  workspacePath: process.cwd(),
  createOperationId: crypto.randomUUID(),
  prompt: 'Inspect the failing test'
})
console.log(session.agentSessionId, creation.initialPrompt)
```

`createAgent` 仍返回同一次创建的 Session；`createAgentWithDelivery` 同时返回 `promptConfirmed` 和 `creation`。`creation.createOperationId` 是关联标识，不能据此盲重试创建。`initialPrompt` 分别表达 `not-requested/confirmed/unconfirmed/unknown`，不证明任务被接受或执行。Agent 已启动而保存投递事实失败时，当前调用返回实际回执、发出明确提醒并保留健康 Run；后续持久查询仍如实保留 unknown，不能据此自动重发。

空间命令从 `@agentmux/core/control` 消费类型化请求和报告。`agent open` 创建 Agent 或增加既有 Session 的投影，`space mv` 只移动确切 Region。Space/Zone/Tab/Region 的稳定身份与持久布局由 Core 的 Spatial owner 持有，client 持有可见表面与焦点；实际执行 cwd、AgentSession 和 Run identity 由各自原 owner 保持。

Agent 生命周期通过公开 Core API 和 `amux agent` 对象命令操作。Provider-native Resume 保留 `agentSessionId`，创建新的 CtxMux RunId；旧 Run 的退役事实与原恢复身份继续保留，不能因累计数量裁剪，也不能把旧 Run 再操作或投影成 Raw Terminal。

浏览器侧只需要 View 投影和 focus resolver 时，从 `@agentmux/core/runtime` 导入。只需要合并 Session Timeline snapshot 与 committed revision 时，从 `@agentmux/core/timeline` 导入。结构化回答的可用性判断从 `@agentmux/core/agent-interaction-state` 导入。这些子路径都不会加载 Agent Client、Hook Server、File Store 或 CtxMux Adapter 等 Node-only Runtime 模块。

`client.sessionTimeline(agentSessionId)` 返回 `{ agentSessionId, revision, items }`。 精确读取由 Store 的 `readHistorySource(agentSessionId)` 核对该 Session 的 active/retired 来源与原 reopen correlation，不枚举无关 Session；`sessionHistorySources()` 仅作目录发现。Timeline 事件也带 revision；Core 一定先保存，再发布事件。Store 是 revision 的唯一 owner，只有内容真的变化才加一，完全相同的重试不会改文件，也不会再次发事件。消费者先读取 snapshot，再按 revision 接事件；遇到断号就重新读取 snapshot，不要自己猜缺失内容。流式更新提交当前完整 content，不提交字符串 delta。

## 公共 JSON-RPC 服务

CLI 是 typed RPC client：解析参数、调用服务、输出回执。`AgentMuxRpcService` 持有统一的业务入口，复用 Core Client 与宿主提供的配置、布局、文件和 Toolkit owner。`AgentMuxControlServer` 将同一个入口暴露为 JSON-RPC 2.0；Unix socket 和 SSH stdio 使用逐行 JSON，HTTP 请求可用 SSE 承载持续观察。宿主未注册的能力返回明确的 unavailable，不另造桌面或 Runtime。

```ts
import { AgentMuxControlServer, connectAgentMuxRpc, connectLocalAgentMux } from '@agentmux/core'

const core = await connectLocalAgentMux()
const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client: core }] })
await server.start()
const rpc = await connectAgentMuxRpc()
const sessions = await rpc.call('agent.ls', {})
await rpc.dispose()
await server.stop()
await core.dispose()
```

HTTP 默认关闭；启动服务时显式提供 `http: { host, port, token }`，每次 HTTP 请求都验证这个 token。Agent 的 Session capability 在所有传输中继续按同一业务合同验证，HTTP token不替代 Agent 身份。SSH 通过远端 `amux system endpoint --stdio` 转发到已有本地服务，不另起 Agent Run。

JSON-RPC `id` 只匹配通信。`operationId` 记录原业务操作；没有完整回执时先查询原操作。订阅断开只释放对应 reader，保持 Agent、Run 与桌面的原观察连接。完整命令、资源与展示分离和远程参数见[公开 CLI 指南](../../docs/guides/agentmux-cli-object-control.md)。

### 外部建群与原操作查询

`@agentmux/core/connections` 导出纯建群类型与严格解析；宿主通过原
`AgentMuxRpcServiceOptions.connections.rooms` 注入 `RoomProvisioningPort`。
typed SDK 的 `call('connection.room.create', input)` 与实际 CLI 消费同一 owner：

```sh
amux connection room create --input room.json
amux connection room inspect --operation-id create-team-room
```

输入冻结原 Connection 修订、准确 Host／Session／Region、群名及 typed 成员 ID；
应用身份来自已配置 Connection，当前 user／device 权限来自可信传输。
建群、成员加入与原 `connection bind` 分别保留回执，建群本身不授予分享或输入权限。
未知或已派发的操作只查原 ID，不按群名匹配、不换 ID 重投。
原 pending 且尚无 attempt 的阶段只允许准确原请求显式继续；inspect 永不施效。
未注入端口只使本能力不可用，保留原连接与健康 Agent。
字段与结果以[建群合同](src/room-provisioning-contract.ts)及
[严格解析](src/room-provisioning-codec.ts)为准；Host 接入见
[connectors 指南](../connectors/README.md#durable-room-creation)。

### 外部投递观察与原操作重试

`@agentmux/core/connections` 导出纯 `ConnectionDelivery` 合同与严格解析器。
宿主通过原 `AgentMuxRpcServiceOptions.connections.delivery` 注入
`ConnectionDeliveryPort`，公共 CLI 与 `connectAgentMuxRpc` 所得 Client 的 typed `call()` 共同消费该 owner。
未注入时仅这个入口明确不可用，不创建连接器、传输或新的 Agent Runtime。
准确字段与结果见 [delivery 合同](src/connection-delivery-contract.ts)及
[严格解析](src/connection-delivery-codec.ts)。

```sh
amux connection delivery inspect --operation-id original-delivery
amux connection delivery ls --connection original-connection --binding original-binding --binding-revision 3 --limit 30
amux connection delivery retry --operation-id original-delivery
```

查询只读原 operation、受众、来源引用、fragment、队列状态和安全平台回执，
不暴露正文、prepared wire、凭证或原始诊断。列表返回 `next` 原 operation ID；
续页保同一 Connection 与 Binding 修订并传 `--after`，不按 ID 字面顺序猜位置。
queue 的 superseded／cancelled 与原平台 receipt 分开，不能把未知当未执行。
列表可附当前 Binding 范围的 worker `observation`，没有 delivery 时也可查 source Gap；
它是当前进程服务窗，不代表平台 ACK、送达、原生采用或 Agent 健康结论。

retry 是准确 Host 对已确认 not-applied 的原 operation 执行一次明确重试，
保原身份和受众；未知先 inspect，不换 ID 重放。当前授权由原 Host owner 复核，
操作者及其有效性来自可信 user／device 运输上下文，不能在参数中冒充。
这份公共接缝不实现平台发送或另存投递事实；实际传输仍由宿主接入并独立验收。

## Diagnostic Evidence

通用强类型机制为 `@agentmux/diagnostic-evidence`，Core 领域类型从 `@agentmux/core/diagnostic-evidence` 导入。沿既有公共 RPC 调用 `system.diagnostics.inspect`，CLI 使用 `amux system diagnostics inspect --list` 发现本服务组装的 reader，再以准确 Host/logId 或原 Toolkit executionId 查询。默认安全摘要，`--include-raw` 显式读取实际保留原件；查询不启采样或恢复执行。

接口与证据语义见[唯一协议](../../docs/specs/diagnostic-evidence-protocol.md)，模块接入见[指南](../../docs/guides/diagnostic-evidence-integration.md)。Client/Core 投递及 Toolkit 原失败已接入；Native 内部来源当前 not-exposed，历史、artifact 和采样由对应 owner 按真实能力另行贡献。

## Durable spatial graph

`@agentmux/core/spatial-state` exports the filesystem spatial owner and its typed graph. Stable Space/Zone/Tab/Region identities, all bindings, Group/Region topology and selection are available without Electron or a graphical frontend. `@agentmux/core/spatial-layout` exports the existing UI-independent split-tree algebra; `@agentmux/layout` consumes this same implementation.

The store uses `spatial-state.json` under the Core state directory, or the absolute `AGENTMUX_SPATIAL_STATE_STORE` path. Writes compare an exact revision under an OS-released filesystem lock, fsync the document and parent directory, and retain the previous valid document. Corrupt reads and missing entities in an observation refuse destructive writes and keep original bytes. Explicit entity deletion requires `allowEntityRemoval`; unbinding a location preserves the entity and execution references.

The public CLI can run against a headless Core RPC host using the existing Unix, HTTP or SSH transport:

```sh
amux space state
amux space commit --revision 0 < graph.json
amux space ls --zone ZONE_ID
amux space resolve --tab TAB_ID --region REGION_ID --direction left
amux space unbind --zone ZONE_ID --space SPACE_ID
```

`space commit` takes a complete graph and its last observed revision. Revision `0` creates an absent store. A conflict requires reading and reconciling edits; it is never automatically retried. Client resource metadata is preserved as JSON and interpreted by its original host. Saving or querying a location does not create a Run or claim a Native page is mounted. Desktop consumes this same owner through its trusted preload port; UI preferences and drafts remain client concerns. See [Durable spatial state](../../docs/architecture/spatial-state.md) for the current consumer contract.

## 远程 Runtime

远端运行同一 Core 包的 `agentmux-runtime serve`，持有 Provider、Session Store、Hook、Permission 与 semantic Resume。本地 Client 持有连接和可恢复的观察。远端需要 Node 24+、包内支持的原生产物与目标 Agent CLI。

`connectHostedAgentMux` 是统一的公共 Runtime SDK；本地服务、SSH 与宿主 HTTP 连接使用同一服务合同。`connectSshAgentMux` 组合系统 SSH 与该 SDK，客户端不会复制 Provider、Session Store 或 Run owner。独立 Core Headless 服务与宿主服务共用同一个语义 owner，宿主额外注入私网、设备及 Desktop 能力。调用的传输授权、durable owner 和当前进程代次分别验证；managed Agent capability 不授予完整 Runtime SDK 权限。

```sh
# 在远端启动语义 Owner；健康 Run 不随该 Owner 退出而终止。
agentmux-runtime serve
# 独立终端读取稳定 runtimeId 与当前 ownerInstanceId。
agentmux-runtime status
```

```ts
import { connectSshAgentMux } from '@agentmux/core'

const client = await connectSshAgentMux({
  target: { hostId: 'build-host', hostname: 'build-host' }
})
const session = await client.createAgent({
  providerId: 'codex', executorId: 'codex', workspacePath: process.env.REMOTE_WORKSPACE!,
  injectAgentMuxGuide: true, prompt: 'Inspect this repository'
})
await client.reattachAgent(session.agentSessionId, 0)
// 保存稳定身份后，后续连接可传 expectedRuntimeId，防止接到另一台语义 Owner。
const runtimeId = client.runtimeOwnerIdentity()?.runtimeId
await client.dispose()
```

`hostname` 可以使用已有 SSH config 的 Host 别名；`user`、`port`、`identityFile`、`remoteCommand` 与 `remoteSocketPath` 按需覆盖默认值。连接采用非交互 SSH。Desktop 的 Hosts 设置保存这些连接参数，并展示已绑定的稳定 Runtime ID。

连接中断时，原 Session、Tab、Region、布局和未发出的输入保持原身份。缓存只表示最后一次观察，服务窗说明失败步骤与恢复动作；只有 Core 明确确认原 Session 的终局事实才允许移除对应投影，观测 unknown / unavailable 保留原工作面。Owner 重启使用原持久目录恢复 Session，再附着同一 ctxmux Run。Provider-native Resume 保持 Session ID，并创建有 provenance 的新 Run。

## Notebook 目录 API 与 CLI

知识目录不需要 App。`@agentmux/core/notebook-store` 的 `AgentMuxNotebookStore` 负责
`notebooks.sqlite`，位置跟随原 NotesStorage owner 的实际 Notes 目录，默认是
`~/.agentmux/notes/notebooks.sqlite`。`AGENTMUX_STATE_DIRECTORY` 决定 locator 与旧目录导入入口，
Desktop 消费同一目录 owner。旧 JSON 目录只作一次导入输入并保留备份。
`@agentmux/core/notebook-catalog` 导出 `NotebookState`、`NotebookWrite`、`NotebookChange`
和严格读取类型。正文由原资源 Host/Workspace 的文件能力持有，目录保存准确引用、
页面层级、网页来源和真实变化轨迹。[Notebook 行为合同](../../docs/design/behavior/knowledge-workflows.md#recallnotebook-与块知识)
定义归属和关闭语义；这里列出实际公开调用方式。

Note 正文是原文件 owner 持有的 `.note.md`，格式与稳定块／引用标记见
[Note Markdown 与元数据](../../docs/specs/note-markdown.md)。`notebook inspect --note ID --content`
返回已保存 Markdown、revision、块及同 revision 的 `noteProvenance`；`file read/write`
沿原资源与 CAS 读改正文。作者由可信调用者确认，正文中的身份声明不构成归因。
`notebook graph`／`notebook resolve` 读同一正文派生关系，不要求打开页面。

```sh
amux notebook ls
amux notebook inspect --notebook quick-notes
amux notebook inspect --note NOTE_ID
amux notebook inspect --operation-id ORIGINAL_OPERATION_ID
amux notebook apply --revision CURRENT_REVISION --operation-id NEW_OPERATION_ID \
  --change-json '{"kind":"create","notebookId":"research","name":"Research wiki"}'
```

`notebook.ls`、`notebook.inspect`、`notebook.apply` 是同一公共 RPC 的方法。
`notebook.apply` 输入 `{ expectedRevision, operationId, change }`，返回完整确认目录。
读写走已有 Endpoint；写入者由可信运输或 AgentSession 确认，不能在 `change` 中自报身份。

| `change.kind` | 字段（除 kind） | 结果 |
| --- | --- | --- |
| `create` | `notebookId, name, workface?` | 新建 Notebook；默认 `quick-notes` 名称为“随手记” |
| `rename` | `notebookId, name` | 改 Notebook 名；默认名称固定 |
| `bind` | `notebookId, workface` | 绑定原工作面 `{ zoneId, workspaceId }` |
| `register` | `noteId, title, resource, notebookId?, parentNoteId?, workface?, source?` | 登记已保存的原 Note；未指定 Notebook 时进入随手记 |
| `move` | `noteId, notebookId, parentNoteId` | 移动页面及子树；根级用 `null`，循环明确拒绝 |
| `rename-page` | `noteId, title` | 改页面标题，保原 Note/Block 与文件 |
| `source` | `noteId, source` | 追加来源；不覆盖已有来源身份 |
| `organize` | `noteId, topic` | 记录已确认的 Topic 整理；不是空间关系创建命令 |
| `relocate` | `noteId, resource` | 记录原文件能力已确认的真实新位置；不是文件移动命令 |
| `follow` / `unfollow` | `noteId` | 持久关注／取消关注自己；身份来自可信调用者 |

`resource` 为 `{ hostId, workspaceId, workspacePath, path }`，`path` 相对原 Workspace。
`source` 为 `{ sourceId, url, title, recordedAt, operator?, position? }`；标题未知用 `null`，
原展示可选地址为 `{ zoneId, tabId, regionId }`。来源 URL 不依赖该展示仍然存在。
`topic` 为 `{ spaceId, topicId? }`。`inspect --note` 返回原页面与完整事件轨迹。

丢回执时查询原 `operationId`，再以同一个 ID、原 payload 和同一操作者重试；成功不会重复。
新意图使用新 ID 和最新 revision；并发冲突先读目录。损坏或未确认读取保原字节与页面，
不创建空知识库覆盖它。与当前事实相同的改名、位置或资源操作不添加虚假的变化事件。

For a confirmed file move, `relocate` accepts optional `from: NoteResource`. The catalog rejects a stale original resource rather than replacing a later location; the same operation ID still replays exactly. Desktop records only confirmed File/Zone outcomes and retains unresolved history writes in its existing presentation recovery receipts. These receipts contain no Note body and do not replace this Core catalog.
