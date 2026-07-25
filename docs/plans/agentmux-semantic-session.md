# AgentMux Run 与 Agent Session 领域模型

状态：长期领域合同；已同步 Desktop Control 与 Local Continuity 纵切

这份文档只说明长期成立的对象边界。`ctxmux` 已是唯一 Local Run Kernel，独占 PTY、进程和有序输入输出；AgentMux 的公共调用方只看到本文定义的领域对象，不接触 ctxmux wire、Electron IPC 或第三方 SDK 类型。

## 1. Core 对象与 Client 投影不是同一种身份

| 对象 | 身份 | 持有的事实 | 明确不持有 |
| --- | --- | --- | --- |
| Run | CtxMux `runId` | 物理进程、工作目录、尺寸、UTF-8 byte cursor、退出事实 | 模型上下文、UI 布局 |
| Agent Session | `agentSessionId` | Provider、Workspace 关联、当前 Run 引用、Native Handle、Hook Receipt、semantic status、待处理 typed interaction | PTY、Replay、进程所有权 |
| Attachment | 当前 Client 对一个 Run 的附着 | 有界 Replay、Gap、增量输出和控制入口 | Run 生命周期、Agent 上下文 |
| Tab / Region | `tabId` / `regionId` | Desktop 对 Run 或 Agent Session 的展示投影 | Core 领域真相、进程或订阅所有权 |

`regionId`、`agentSessionId` 和 `runId` 属于不同身份空间。一个 Agent Session 可以同时投影到
多个 Region；Region 关闭后再打开，不会创建或恢复模型上下文。同一 Desktop Client 的多个
Region 共享 exact Run 的一个 retained Core Attachment，每个 Region 只持有 Desktop-issued lease
与自己的 Replay 起点；最后一份 lease 释放时才释放底层 Attachment。多个 Region 的 Output
acknowledgement 只能单调推进 Agent Session cursor，较慢 Region 的迟到 acknowledgement 不能把
cursor 回退。一个 Run 也可以先释放 Attachment，再由同一或另一个 Client 重新 Attach。

`AgentMuxRuntimeProjection` 与 `AgentMuxRuntimeSubject` 只是 Core 对 Run 和 Agent Session 的
宿主中立快照，不是 Tab/Region，也没有布局或焦点语义。真实 Tab/Region 类型定义在 Desktop
布局域，由具体 Client 从自己的展示状态构造；Core 不保存第二份布局 Registry。

Raw Terminal 只有 Run，没有 Agent Session。Agent Run 必须引用恰好一个 Agent Session；两边的 Agent、Host、Workspace Path 和 exact Run ID 不一致时，投影必须失败关闭。

`agentSessionId` 是 AgentMux CLI、SDK 和 Desktop 的稳定公共主键。Provider native session ID、ACP handle 与 exact RunRef 是 AgentMux Core-owned Store 上的外部索引，不是替代主键：native session ID 必须与 Provider 身份组成查询键，RunRef 直接包含 CtxMux RunId。一个查询命中零个、多个、过期或互相冲突的绑定时必须失败关闭，不能猜测最近 Session，也不能从 Terminal 标题或输出反推身份。

Raw Terminal 的 Run 身份不伪装成 `agentSessionId`。Desktop 从 Renderer 的 Tab 与 Layout SSOT
构造当前 Control 投影；Core 自身不拥有打开中的 Tab/Region。Tab/Region selector 由 Desktop
Control Host 按精确 identity 和 caller identity 解析；零个、多个、过期或已关闭都失败关闭，
不能从当前焦点或列表顺序猜目标。

## 2. 生命周期与展示动作必须分开

- **Reattach 原 Run**：exact Run ID 和 Agent Session ID 不变；从指定 byte cursor 获取 Replay/Gap 并建立新的 Attachment，不 Spawn。
- **Release Attachment**：按 exact RunRef 释放当前 Client 的输出附着；Desktop 的一个 Region 只释放自己的 lease，最后一个 Region 离开时才释放 retained Core Attachment。两者都不停止 Run、不删除 Agent Session，也不关闭其他 Region。
- **Provider-native Resume**：可信 Native Handle 和 Provider Capability 同时成立时，保留 Agent Session ID，创建新的 CtxMux Run ID。恢复可以不带 Prompt；只有用户确实提交了非空 Prompt 时才把它加入 Provider argv 和 Session Timeline。
- **Respawn**：创建新的 Agent Session 和新的 Run；即使 Provider、Workspace 和 Prompt 相同，也不宣称继承模型上下文。
- **Open presentation**：相对精确 Tab/Region，以新 Tab、四向 split 或 Launcher replacement
  创建 Region 投影；引用已有 Agent Session 时不创建或恢复模型上下文，也不替换 Run。
- **Focus presentation**：用精确 `tabId` 或 `regionId` 聚焦已打开的 Desktop 投影；不 Open、
  Attach、Resume 或 Spawn，不改变 Run、Attachment 或 Agent Session 生命周期。
- **Open owned content**：Control Host 先由 Renderer 创建 owner-protected pending Region，再让
  Desktop 的 RuntimeController 创建 Agent/Terminal，或让 Main Browser owner 创建 Browser；成功后
  一起提交。owner 创建失败、布局 owner 丢失、请求超时或 Desktop 关闭时回滚本次 Region；
  已经晚到的资源必须清理。

原 Run 仍为 `running` 时禁止 provider-native Resume，避免一个 Agent Session 同时驱动两个物理 Agent。迟到的旧 Run 事件只能作为旧 Run 事实处理，不能更新已经指向新 Run 的 Agent Session。

Core 的 `ensureAgentContinuity` 是 Reattachable、Provider Resume、Unavailable、Retired 与 Conflict
的唯一决策入口。调用方必须同时提交 `agentSessionId` 与自己持有的 exact `expectedRun`；Core
先用 Store binding 和权威 Run 状态做 fence。live exact Run 只保持同一 Run，ended/missing Run
只有在可信 Provider handle 与当前 Host capability 同时成立时才无 Prompt Resume；传输断开本身
不能证明 Run 丢失，也不授权 Resume。用户 Stop 后由同一 Store 原子退休 exact Run；旧调用方再
请求 Continuity 时得到 `retired`，不会复活 Session。Desktop 只投影这个结果，不得自行拼恢复
条件、注入 `"resume"` 或其他假 Prompt，也不得保留 retry、fallback 或第二份恢复状态机。
持有现有 Agent Hook ingress 的 Core Client 在 lifecycle reservation 前接受 Resume；其他 Client
得到 `conflict`，不能先占用 reservation 再以 Hook owner 冲突中断这次 Continuity。
`reattachable` 只表示 exact Run 已被权威验证为 live；它不虚构 Attachment。Desktop 保留持久
Region 时会从 Core-owned missing-Run recovery candidate 调用该入口，成功后再走既有 Attachment
owner；`unavailable`/`conflict` 保留可见错误，`retired` 删除对应投影，后台 Session 不会被擅自
展开成新 Tab。

## 3. Cursor 和输入输出

所有 public Run cursor 都以 UTF-8 byte 为单位，并在名字中显式带 `Byte` 或 `Bytes`：

- `latestOutputBytes`
- `acceptedInputBytes`
- `startByte` / `endByte`
- `requestedAfterByte` / `firstAvailableByte`
- `acceptedThroughByte` / `acknowledgedThroughByte`
- `outputCursorBytes`

调用方不能把 JavaScript 字符数、终端列数或 wire sequence 混入这些字段。Kernel 私有 sequence 只允许在 Adapter 内映射。
`agentmux output --session <session-id> --follow` 对外顺序固定为 `attached → replay → live → end`。Attach 期间的 Live
事件必须等 Replay 完成后再发；Replay 已覆盖的 byte range 只发一次。

Provider 必须明确区分 Prompt 的传输字节和 TUI 最终渲染的逻辑文本。以 Codex 为例，多行输入的
`payload` 可以包含 bracketed-paste 控制序列，但 screen oracle 只能比较 Provider 声明的
`renderedText`；不能要求终端屏幕显示传输控制字节，也不能把 bracketed paste 变成所有 Provider
的默认行为。两阶段 Provider 先提交 payload，在 exact active composer 显示完整逻辑文本后再提交
Enter；单阶段 Provider 仍使用自己的明确输入计划。Core 对所有 Agent Prompt 采用 64 KiB 硬上限，
screen oracle 使用覆盖同一上限的有界 scrollback，必须能在 Prompt 超出当前 viewport 后继续找到
active composer；超过上限直接拒绝，不能接受输入后等待一个永远无法成立的 screen 条件。

Permission 与 Question 是 Agent Session 的 typed interaction，不是普通 Prompt。完整路径固定为：

`Provider/ACP typed request → Core 持久化 → public Client event/API → Desktop typed IPC/UI → Core/Provider semantic response`

Native Hook request 必须绑定 exact `agentSessionId + RunRef + Hook Receipt`；ACP request 必须绑定 exact
Adapter/ACP Session evidence。Core 在公开 request 前先保存它，且同一 Agent Session 同时只允许一个
待处理 interaction。响应先由 Core 对照原 request 校验，再由 Provider 映射到自己的终端协议；
Renderer 不解析 `status.detail`，不发送裸 ESC、数字选项或 raw PTY fallback。Native terminal response
在写入前持久化完整 semantic response、digest、确定性 operation id 与 byte-range claim；进程在 receipt
前崩溃时，新 Client 即使发现 Run 已退出或中断，也必须按持久化 range、CtxMux Input cursor 与同一
recoverable operation 收敛已应用、明确未应用或非法状态，不能留下可点击的死卡，也不能重复注入。
待处理 interaction 是该 Agent Session 唯一用户输入面；Core 同时拒绝普通 Prompt 和 raw Agent Input，
Desktop 也停用 xterm 键盘与粘贴。ACP typed response 只有在 Adapter delivery 与 Core semantic settlement
都完成后才返回成功；delivery timeout 必须通过 AbortSignal 取消 Adapter 操作并向调用方失败关闭。
ACP pending 只在原 live binding 内可回答；Core 重启后没有同一 pending binding 的旧 request 会被结算，
不能恢复成无法响应的卡片。当前 Question 纵切只声明 Provider 已验证的单题单选，不伪造
multi-select、custom answer 或多题协议。

## 4. Evidence 不互相冒充

| Source | 能证明 | 不能证明 |
| --- | --- | --- |
| `terminal-output` | 某个 Run 输出了哪些有序字节 | Tool、Permission、Reply、模型私有思考 |
| `run-process` | 物理进程正在运行、退出或丢失 | Agent 已完成语义任务 |
| `native-hook` | Provider Hook 报告的状态、活动或 Native Handle | 没有 Hook 覆盖的历史语义 |
| `acp` | ACP Adapter 报告的结构化事件和权限请求 | PTY 或进程仍存活 |
| `user` | 用户提交 Prompt、Signal、Stop 等明确动作 | Agent 已处理该动作 |

Terminal Output 和 Replay 永远不能被包装成 Tool、Reply、Permission、Chain-of-thought 或模型上下文连续。Hook 与 ACP 事件必须携带 Agent Session 身份以及当时的 Run Evidence；它们不拥有 Run。

## 5. Provider 与 Kernel 的所有权

AgentMux 持有 Provider Catalog、能力探测、Launch/Resume Intent、Agent Session、ACP、Hook、Permission、Evidence 和 Client 投影。新增 Agent 只新增 Provider/Integration，不修改 Run 生命周期。每个 Provider 必须显式声明 Reply correlation；未具备稳定 Turn ID 的 Provider 必须声明 `none`，不能拿时间邻近或 Assistant 文本冒充关联证据。

Run Kernel 持有 Local/SSH 的 PTY、Process、Ordered I/O、Replay、Gap、Backpressure、Attachment、Resize、Signal 和 Stop。最终只有 `ctxmux` 实现这一层；AgentMux 不保留自建 daemon fallback，也不提供兼容 API。

Adapter 只做两件事：把 AgentMux 的 Run Intent 翻译给 Kernel，把 Kernel Run Fact 翻译成 AgentMux 自有类型。Kernel 的 Frame、Snapshot、Error、SDK Object 和连接状态不能穿过 Adapter。

CLI、SDK 与 Desktop 共用 Core 的 Agent Session Resolver；空间操作则共用宿主中立的 Control
request/receipt 合同。Desktop Main 是唯一外部 Control 事务入口，Renderer 是唯一 Layout Owner；
这些操作都不进入 Run Adapter。公共命令、typed selector、`self` 和 receipt 语义只由
`docs/plans/agentmux-ai-native-desktop-composition-cli.md` 定义，本文不复制第二套命令树。
Provider native ID、ACP handle 或 RunRef 的反查只能返回 AgentMux 身份，不得让 ctxmux 持有
Agent 索引，或让 CLI/Renderer 另建 Session Registry。unsupported、unknown、ambiguous、stale、
not-open 都失败关闭，不能降级成字符串注入、UI automation、猜测最近 Tab 或旧 CLI 路径。

## 6. 持久化与资源边界

`AgentMuxAgentSessionStore` 只保存有界 Agent Session：Provider 身份、Workspace、当前 Run Ref、必要 Output Cursor、Native Handle、Hook binding、最后一份 Hook Receipt、最近的 Provider/ACP semantic status、待处理 typed interaction，以及最多 16 个同 Session retired exact Run tombstone。Resume 原子退休旧 Run，并删除旧 Run 的 semantic status 与 interaction。用户 Stop 在删除 Session 的同一 lifecycle commit 中写入两类不同事实：所有历史 Run 进入有界 unbound retired Run 集合，另有一条以 `agentSessionId + hostId + exact current Run + user + observedAt` 为键的有界 Semantic Session retirement。只有后一条能返回 `retired`；Resume 旧 Run、abandoned lifecycle 或其他 Session 的 tombstone 绝不能冒充用户退休。当前 Store 文档版本是 5；旧版本直接拒绝，不提供 migration、兼容读取或 fallback。Store 不保存 PID、PTY、Terminal Snapshot、Replay、Activity 列表、Tab/Region 或第三方 wire state。

默认 File Store 是 CLI 与 Desktop 共用的唯一身份文件，使用 `0600` 原子替换与进程间锁；Memory Store 只用于显式嵌入和测试。加载器最多保留 256 个 Agent Session。Run、Attachment、Replay、Client Queue、Hook Body 和日志都必须有硬上限；释放 Attachment、关闭 Region 和停止 Run 后要有确定性的资源释放证据。

## 7. 当前验证面

- Runtime 投影测试验证 Run、Agent Session 与 Runtime Subject 的身份独立，且投影不携带 Pane/Tab 语义。
- Registry 测试验证 Agent Session 换 Run 后，迟到旧 Run 写入会被拒绝。
- packed Client 集成测试已验证 CtxMux Run 的 Reattach、exact RunRef Release、retained Attachment 存在时的第二 View byte replay、Resize、Interrupt 和 Stop，以及 Codex create、Hook/Permission、native-id 反查、跨 Client reconnect、分组 CLI、显式 Prompt Resume、并发 promptless Continuity 与用户 Stop 后的 retired 结果。Continuity 证明只创建一个新 Run，且不会向 Timeline 写入伪用户消息。
- Desktop attachment broker 测试验证并发 Region 只建立一个 retained Core Attachment，每个 Region 获得独立 lease，释放非末位 lease 不影响其他 Region。
- Runtime configuration transaction 测试验证 changed Host 从 prepare 到 commit 期间拒绝新 Launch，并在既有 lifecycle/Attachment tail 收敛后才允许替换 Client。
- Core Control Host 测试验证单一版本化 endpoint、receipt、closed/unavailable 错误；Desktop owner 测试验证 Tab/Region、三类 typed open、精确 focus、send 歧义、arrange 与 owner-loss rollback。
- checkout-external packed consumer 从真实打包 CLI 验证受管 caller、Control intents、版本化 JSON receipt、option-looking payload、UTF-8 分片与 peer early-close。
- Core 与 Desktop 类型检查验证 daemon wire 不再进入 Desktop 的共享合同。
- Core interaction tests 验证 Hook request 的有界归一化、单题单选能力边界、typed response 校验与 Provider-owned 终端映射；Store tests 验证 semantic status、完整 recoverable response claim、digest 与旧版本拒绝。
- Desktop owner tests 验证刷新时恢复 semantic status 与 pending interaction、Run `running` 不覆盖 Provider/ACP status，且 Approval/Question 只经 typed IPC 返回 Core。

当前 Local implementation candidate 固定消费 CtxMux `a089708` / Protocol 13，删除旧 Run Kernel，并完成
Codex、Local Desktop Control、Workbench 布局持久化与 Tab/Region move/close。
多 Desktop、Remote/SSH 和 headless Control Host 仍未交付，不能从 Local 证明外推。
