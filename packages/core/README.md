# @agentmux/core

`@agentmux/core` 是 AgentMux 的核心包：一个不依赖 Electron、React 或任何编辑器的 Node 24+ 包，用一套类型化 API 驱动本机和远端的 Coding Agent CLI。每家 CLI 的原生协议收在一个 Provider 里；Core 持有 AgentSession 身份、输入与回执、Hook 与权限、就绪判断、语义恢复，以及与前端无关的空间图（Space / Zone / Tab / Region）。Agent 进程跑在随包固定的 ctxmux Runtime 里，关闭或重启客户端不会停止它们。Desktop、手机端、`amux` CLI 和你自己的程序调用同一个公共 JSON-RPC 服务。

包里带四个可执行文件：

| 可执行文件 | 用途 |
| --- | --- |
| `amux` | 公共 CLI，25 个对象模块；`amux --skill` 输出模块目录，`amux MODULE --skill` 读取单个模块的指南 |
| `agentmux-runtime` | 无界面的语义 owner，供远端 Host 运行，见[远程 Runtime](#远程-runtime) |
| `ctxmux`、`ctxmuxd` | 随包固定的 ctxmux CLI 与 daemon，持有 PTY、进程和 Run |

常用入口：[Terminal 调用](#terminal-调用) · [Agent 调用与输入](#agent-调用与输入) · [原生对话读取](#原生对话读取) · [Agent 与工具分端执行](#agent-与工具分端执行) · [Runtime 边界](#runtime-边界) · [公共 JSON-RPC 服务](#公共-json-rpc-服务) · [远程 Runtime](#远程-runtime)

## 内置 Provider 与能力入口

13 个内置 Provider 的 id 是 `codex`、`claude`、`traex`、`hermes`、`pi`、`grok`、`gemini`、`antigravity`、`cursor`、`kimi`、`droid`、`copilot`、`opencode`；默认 Executor 的 `executorId` 与 Provider id 相同。id 清单唯一见 [`BUILT_IN_AGENT_PROVIDER_IDS`](src/agent-provider-id.ts)（也从 `@agentmux/core/provider-id` 导出），组合见 [`providers/index.ts`](src/providers/index.ts)；各 Provider 能否回答权限请求、是否支持原生恢复、fork 与历史，见[根 README 的 Provider 表](../../README.zh-CN.md#一套-api-驱动-13-种-agent-cli)。Provider 已注册不代表对应 CLI 已在本机安装和登录。自定义 Provider 通过 [`defineAgentProvider`](src/agent-provider.ts) 与 [plugins](src/agent-plugin.ts) 扩展。

下表列出主要能力的 SDK 入口和 `amux` 模块。子路径的完整清单以 [package.json](package.json) 的 `exports` 为准，命令参数以所运行版本的 `amux MODULE --help` 为准。

| 能力 | SDK 入口 | `amux` 模块 |
| --- | --- | --- |
| 创建 Agent、发送 Prompt、结构化回答、中断与恢复 | 根入口 `connectLocalAgentMux` 返回的 Client（`createAgentWithDelivery`、`submitAgentPrompt`、`respondAgentInteraction`）、`./agent-session-recovery`、`./prompt-condition`、`./agent-interaction-state` | [`agent`](guides/modules/agent.md) |
| 终端与 Run | `connectLocalAgentMuxRuntime`、`./runtime`、`./terminal-continuation` | [`terminal`](guides/modules/terminal.md)、[`runtime`](guides/modules/runtime.md) |
| 原生对话、历史与资源 | `./conversation`、`./session-history-content`、`./timeline` | `agent history`、`agent conversation` |
| Agent 间消息与收件 | `./agent-outbound-message`、`./agent-message-render`、`./agent-input-mailbox` | [`message`](guides/modules/message.md) |
| 空间图、布局与导航 | `./spatial-state`、`./spatial-graph`、`./spatial-layout`、`./control` | [`space`](guides/modules/space.md)、[`app`](guides/modules/app.md) |
| Goal、Supervisor 委派与 PMO 巡查 | `./goal-delegation`、`./goal-responsibility`、`./goal-patrol`、`./continuous-progress` | [`goal`](guides/modules/goal.md) |
| 定时 Prompt | `./schedule`、`./schedule-calendar` | [`schedule`](guides/modules/schedule.md) |
| Mote | `./mote-chat`、`./mote-dialogue`、`./mote-face`、`./mote-avatar-series` | [`mote`](guides/modules/mote.md) |
| Notebook、Note 与 Topic | `./notebook-store`、`./notebook-catalog`、`./note-merge`、`./note-history`、`./search` | [`notebook`](guides/modules/notebook.md)、[`topic`](guides/modules/topic.md) |
| 持久本地页面 | `./capsule` | [`capsule`](guides/modules/capsule.md) |
| 内嵌浏览器自动化 | `./browser-page-capability`、`./browser-input-context` | [`browser`](guides/modules/browser.md) |
| macOS 原生观察、截图、剪贴板与输入 | 由宿主注入 | [`native`](guides/modules/native.md) |
| 文件、Git 与图片 | `./files`、`./pasted-images` | [`file`](guides/modules/file.md)、[`git`](guides/modules/git.md)、[`image`](guides/modules/image.md) |
| 状态栏工具 | `./toolkit`、`./toolkit-result-document` | [`toolkit`](guides/modules/toolkit.md) |
| 外部聊天连接器 | `./connections`、`./mote-connections` | [`connection`](guides/modules/connection.md) |
| 公共服务、远程与手机连接 | `AgentMuxControlServer`、`connectAgentMuxRpc`、`./hosted`、`./headless-runtime`、`./public-rpc-relay` | [`system`](guides/modules/system.md)、[`device`](guides/modules/device.md) |
| 配置与调用者身份 | — | [`settings`](guides/modules/settings.md)、[`whoami`](guides/modules/whoami.md)、[`name`](guides/modules/name.md)、[`skill`](guides/modules/skill.md) |

系统用法的正文在 [guides](guides/README.md)，`amux --skill` 与 `amux MODULE --skill` 输出同源内容。修改指南后运行 `pnpm --filter @agentmux/core generate:guides`，再用 `pnpm --filter @agentmux/core check:guides` 核对生成结果；正文、共享片段和代码事实的维护边界见该目录说明。

## 分层与术语

术语以[《统一概念与空间寻址》](../../docs/design/behavior/spaces-and-layout.md#统一概念与空间寻址)为准。Space / Zone / Tab / Region 的稳定身份、关系与持久布局归 Core；Project / Workspace 是资源与工作目录；AgentSession 的语义事实归 Core，Run 归 ctxmux。公开 Control 表达空间目标与操作回执，client 持有可见表面与焦点。Core 的 RuntimeProjection 是执行事实的投影，Desktop View 是展示，两者都不等于 AgentSession、Run 或 Desktop Tab 身份。把 Agent 移到别的空间位置不改变 Session 的 cwd。空间 CLI 的寻址与落点确认见 [`space` 指南](guides/modules/space.md) 和[《Confirm the actual destination》](guides/shared/spatial.md#confirm-the-actual-destination)；命令与参数以所运行版本的 `amux --help` / `amux MODULE --skill` 为准（[Core 指南](guides/README.md)）。Desktop 组合自己的配置与 Git owner，消费 Core 的持久空间和公开 Agent API。

## 安装与随包 Runtime

Core 需要 Node 24+，包本身不限制操作系统，portable API 可以单独使用。随包原生 Runtime 支持 macOS arm64 与 Linux x64，由 [Darwin manifest](vendor/ctxmux/darwin-arm64/manifest.json) 和 [Linux manifest](vendor/ctxmux/linux-x64/manifest.json) 绑定到固定的 ctxmux 产物：包内带 exact-commit manifest、同一份 SDK tarball 和两个平台的二进制。开发时只从这份 tarball 取官方类型，构建时把同一 SDK 私有打包进唯一的 `CtxmuxRunAdapter`，没有手写的 wire 声明。公共 API 不导出 ctxmux SDK 或 wire 类型；发布后的包不需要相邻仓库、外部 `@ctxmux/sdk`、全局 `ctxmux` 或运行时下载。

`ctxmux` / `ctxmuxd` 的 npm bin 按宿主平台选择对应产物。正常 npm 安装时，`postinstall` 先按 manifest 校验字节数和 SHA-256，再恢复可执行位；校验所需的合同随包携带，源码依赖安装和独立包安装都不需要先构建 Core。安装脚本只处理包内产物，不访问网络、宿主配置或已有 Run。用 `--ignore-scripts` 安装会跳过这一步，Runtime 无法执行，需要启用 lifecycle scripts 重新安装。

`connectLocalAgentMux` 不接受逐次调用的 socket 或状态目录参数，进程级路径策略由 [runtime-paths.ts](src/runtime-paths.ts) 持有。默认 Endpoint 与持久状态使用稳定的宿主 namespace，持久状态放在用户目录；`AGENTMUX_RUNTIME_DIRECTORY` 与 `AGENTMUX_STATE_DIRECTORY` 可以指定绝对路径。随包产物升级不会另起一个 Runtime：

- Core 只启动 hash、文件 mode 和 `--version` 合同都核验通过的随包 `ctxmuxd`。
- 已在运行的服务按 Runtime identity、协议和所需 capability 核验。归属记录未知时只限制清理权限，兼容服务上的健康 Run 照常可用。
- 启动时读取 `runtimeInfo()`；之后每次业务调用都在承载该请求的同一连接上核对期望的 Runtime identity。身份变化时在发送前拒绝，不猜测请求是否已送达，也不自动重放。

`defaultLocalHostLabel(platform?)`（[execution-host.ts](src/execution-host.ts)）为新的本机 Host 提供显示名默认值，`LocalExecutionHost` 与宿主的新配置共用；已传入或已保存的 `label` 优先。它只生成名称，不探测能力，也不启动 Runtime；命名规则见[机器目录分区合同](../../docs/design/behavior/spaces-and-layout.md#跨设备关联项目组)。

`probeAgent`、`probeExecutorAvailability` 以及本机 Host 的 Executor 配置与发现都不需要 ctxmux 连接，它们读取该 Host 上的 Provider 和文件系统。对远端 Host 的调用在那个远端 owner 上执行，本地探测结果不能代表远端。Executor 注册表保留原 schema、Host 身份、逐项校验和持久 CAS 写入，不按条目数或文件大小拒绝合法增长；Control 回执消费完整清单，公开快照按调用方的分页 `limit` 返回。

## Terminal 调用

```ts
import { connectLocalAgentMuxRuntime, mintObjectId } from '@agentmux/core'

const client = await connectLocalAgentMuxRuntime()
const run = await client.createTerminal({ workspacePath: process.cwd() })
const attachment = await client.attachTerminal(run.runId, 0)
const secondViewReplay = await client.readRunReplay(run, 0)
if (run.acceptedInputBytes === null) throw new Error('The Run has not confirmed its input cursor')
await client.writeTerminal(run, {
  ownerInstanceId: client.runtimeIdentity().instanceId,
  operationId: mintObjectId(),
  expectedByte: run.acceptedInputBytes,
  data: 'pwd\n'
})
await client.releaseRunAttachment(attachment.run)
```

`connectLocalAgentMuxRuntime` 返回已连上 Runtime 的 Client，终端控制不等待 Session 清单、Hook 或 Provider 观察。需要完整语义时，在同一个 Client 上 `await client.connect()`：等待或失败期间终端能力照常可用，`runtimeDiagnostics()` 确认物理 Runtime 状态，`onEvent` 报告观察失败的阶段和之后的恢复，修正原因后可以再次 `connect()`。`connectLocalAgentMux` 等完整观察成功才返回，适合一开始就需要 Agent 语义的调用者。两个入口共用 Runtime、身份和生命周期，没有对应的额外 CLI 命令。

Run 的身份就是 `{ runId }`，关闭 Client 不会停止 Run。

- `attachTerminal(runId, afterByte)` 用累计原始输出字节游标建立一个保留的 Attachment；`readRunReplay(run, afterByte)` 为另一个视图读取有界 Replay，不新增保留 owner；`releaseRunAttachment(run)` 按准确的 RunRef 释放。
- 写入时，调用方在结果确定前保存 `ownerInstanceId + operationId + expectedByte + data`。新的 Client 可以重试同一个操作，ctxmux 返回实际应用的字节范围，不会重复写入 PTY。
- `signalTerminal(..., 'SIGINT')` 映射为 ctxmux 的可移植 Interrupt，其他信号直接失败。中断 Agent 用 `signalAgent(agentSessionId, expectedRun, 'SIGINT')`：Run 在等待连接或 Resume 后已经更换时，只拒绝这次针对旧 Run 的操作；历史或语义观察失败不影响对准确 Run 的中断。
- `refreshRunAttachment(run, afterByte, view, operationId?)` 沿同一个保留 owner 重开这个 Client 对 Run 的观察连接：先打开并核对 snapshot，再替换 live pump；打开失败时保留原 owner，不停止 Run，也不发送输入。刷新直接产生的状态投影带 `observationOrigin`（准确的 Run 与 operation），它是事实更新，不代表新的输入；独立的 Hook、重连和 live output 不带这个字段。新 attachment 建立只说明观察连接已建立，不是 Run 存活或输入送达的回执。
- Replay 和 `terminal-output` 的 `dataBytes: Uint8Array` 是终端消费者应写入的原始字节；`data` 是给语义观察者的流式文本，不能用来裁剪字节。CLI 的 `agent output` 与 `agent output --follow` 用 `dataBase64` 表达同一字节流，调用方解码后按范围去重。行为合同见[「ordered bytes 的公开传输边界」](../../docs/design/behavior/terminal-reading.md#ordered-bytes-的公开传输边界)。

如果要在另一个进程里继续一次结果未知的创建，先调用 `await client.prepareTerminal(input)` 并把返回值私下持久保存，再把同一个值传给 `createPreparedTerminal(prepared)`。准备步骤会等执行 Host 的完整启动环境就绪，读取默认 shell 并冻结请求，但不创建 Run；`inspectPreparedTerminal` 只核对已有的请求和回执，不等待新的环境准备。重复创建复用同一个操作 key 和完整的原生请求，不会按当前环境重新组合。返回值包含敏感环境变量，只能由可信 client 私下保管，不能写入配置、公开结果或日志。普通的 `createTerminal` 就是这两步的组合，启动规则相同。

远程 Client 使用相同的 API，连接方式见[远程 Runtime](#远程-runtime)。打包后 Shell 消费者的验证要求见[测试策略《Shell 与 Desktop 的验证义务》](../../docs/testing/strategy.md#shell-与-desktop-的验证义务)。

## Agent 调用与输入

### 创建与首个 Prompt

```ts
await client.connect() // Load Session and Provider observation on the same Runtime.
const session = await client.createAgent({
  providerId: 'codex',
  executorId: 'codex',
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

需要报告首个 Prompt 的投递结果时，使用同一次创建的公开 API：

```ts
const { session, creation } = await client.createAgentWithDelivery({
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  injectAgentMuxGuide: true,
  createOperationId: mintObjectId(),
  prompt: 'Inspect the failing test'
})
console.log(session.agentSessionId, creation.initialPrompt)
```

`createAgent` 返回同一次创建的 Session；`createAgentWithDelivery` 另外返回 `promptConfirmed` 和 `creation`。`creation.createOperationId` 是关联标识，不能凭它盲目重试创建。`initialPrompt` 取值 `not-requested`、`confirmed`、`unconfirmed` 或 `unknown`，不说明任务是否被接受或执行。Agent 已启动但保存投递结果失败时，这次调用仍返回实际回执、发出明确提醒并保留健康 Run；之后的持久查询如实保留 `unknown`，不会据此自动重发。

声明了初始化控制的受管启动，先确认原生对象再连接终端；初始输入在启动前持久保存，并通过同一个输入 owner 提交。`terminalFrontend.initialization` 分别报告准备、创建、就绪、失败和未知；后台进程仍在运行不等于这些步骤成功。`creation.initialInputKey` 是初始输入的安全引用，可以交给 `inspectAgentPromptSubmission(key)` 核对回执；正文只保存在私有 Store，不随 Session 投影输出，投递未知时不会自动重发。

启动与恢复的类型、策略和解析器从 `@agentmux/core/agent-session-recovery` 导入，Core 的创建、恢复与 continuity 方法沿用同一 Session 与 operation；模块边界见 [Agent Session Recovery](../../docs/architecture/agent-session-recovery.md)。

### Session 身份与生命周期

所有 Provider（包括 Codex）都通过同一个 ctxmux Adapter 运行。`AgentProvider` 在 Core 里生成 Launch / Resume Plan、归一化 Hook 与 Permission，并在 daemon 返回 RunId 后把每次 Hook binding 锁定到这个 Run。Core 的 File Store / Resolver 独占 `agentSessionId`、当前 RunId、Provider 原生 session id / ACP handle，以及全部退役 Run 与 Session 身份；旧 Run、未知的原生 id 和冲突的绑定一律拒绝。Desktop 与 CLI 共用这一个 Store。

Hook 的稳定 binding identity 和随机 bearer 只保存在权限为 `0600` 的 Session 记录里；`createAgent`、`agentSessions`、Resolver、Status、事件和 View 投影都会去掉这两个字段。

Agent 的生命周期通过公开 Core API 和 `amux agent` 对象命令操作。Provider 原生 Resume 保留 `agentSessionId`，创建新的 ctxmux RunId；旧 Run 的退役记录和恢复身份继续保留，不按数量裁剪，旧 Run 也不能再被操作或投影成 Raw Terminal。

空间命令从 `@agentmux/core/control` 使用类型化请求和报告。`agent open` 创建 Agent，或为已有 Session 增加一个投影；`space mv` 只移动指定的 Region。执行 cwd、AgentSession 与 Run 身份各自保持不变。

### 事件订阅

`client.onEvent` 只接受同步回调；异步消费者要先把事件复制到自己的有界队列，类型会拒绝返回 Promise 的回调。绕过类型返回了 Promise 的回调只会让这一个订阅退订：传了 `onEvent(callback, { onError })` 时诊断交给 `onError`，否则写到 console，其他观察者收到 `agent-error`。修好回调后重新订阅即可，Agent 和 Runtime 不受影响。监听数量随实际订阅增长，释放函数和 `dispose` 回收订阅，没有固定上限。完整的终端字节请用 Attachment / Replay。

还没有读取 Mailbox 的原生 Client 可以用 `onEvent(callback, { observeMessages: true })` 订阅之后的 A2A 消息日志：

- 每个这样的订阅取得自己的当前切点。某个订阅的切点读取失败只通知它自己；来源恢复后重新取当前切点，不补弹中断期间的旧消息。
- 不传该选项时，沿用 `listMessages` 之后才启用的懒观察；显式传 `false` 则不接收 A2A 事件，也不持有消息观察。
- 同一路径共享一个日志 watcher，最后一个选择观察消息的订阅释放后 watcher 随之释放，普通事件订阅不会让它留下。Hosted Client 的 `runtime.events` 租约包含这份观察，关闭租约即释放。
- `agent-message-changed` 的 `recordKind` 区分消息创建、投递和引用通知更新；`messageSequence` 是消息的位置，`sequence` 是这次变更的位置；`live: false` 表示初始化或恢复后的补读。事件不带正文，也不表示已读、Agent 已采用或任务完成。用户提醒只响应实时的消息创建，重连不补弹历史。

### 结构化回答

Provider / ACP 的语义状态和待处理的 Permission / Question 也是 Core 持有的 Session 事实。Client 通过 `interaction` 事件和 `session.pendingInteraction` 读到类型化请求，用 `respondAgentInteraction({ agentSessionId, expectedRun, operationId, expectedRequest, response })` 回答，并取得 `AgentMuxInteractionOperationReceipt`。`expectedRequest` 保存用户作答时看到的请求内容和证据。Core 核对 Session、Run、请求和选项后，ACP 回答交回 Adapter，原生回答交给 Provider 规划终端协议；消费者不自己生成厂商按键，也不从 `status.detail` 猜测交互。

- 需要两阶段 Prompt 的 Provider 必须同时声明真实传输的 `payload` 和 TUI 显示的 `renderedText`；bracketed paste 不是 Core 的默认行为。Prompt 上限 64 KiB，screen oracle 的有界 scrollback 覆盖同一范围。
- 有待处理交互时，Core 拒绝普通 Prompt；原生终端仍可以通过 `writeAgent({ agentSessionId, expectedRun, data, source })` 输入。`source` 只能是 `user` 或 `terminal-protocol`，自动协议回应不算用户回答。这类原生输入只记录这次请求的投递结果；`accepted` / `unknown` 不等于批准，也不会自动重放。
- 当前状态从 `session.pendingInteraction` 读取。结构化回答不可用时，用 `agentInteractionResponseUnavailableReason` 显示原因和原生入口。新请求、Working 或 Stop 都不能证明旧请求已完成。ACP 回答按 Adapter 的操作回执表达，原生回答按 ctxmux 可恢复输入的认领结果收敛。

`inspectAgentInteractionOperation({ agentSessionId, operationId })` 只读一次回答操作，问题完成或 Run 更换后仍可查询；SessionStore 保留操作索引，普通 Session 与事件投影不广播其内容。回执分别报告已保存、派发未知、PTY 已接收字节、Hook 连接已写入、ACP adapter 已确认和原生完成；原生采用没有协议事实时保持 `unknown`。

- 同一 `operationId` 不能改答案或目标，并发操作不能覆盖同一请求。
- 丢回执时先查询；查询不派发输入。用户明确用同一操作和内容重试时，PTY 输入加入原来的可恢复输入；可能首次生效的回答仍核对请求、Run 和当前原生目标，已生效的直接返回原去重回执。Hook 结果未知时不会重放到另一个回调。
- 查询失败或目标资格未知不会关闭原生终端输入，也不会关闭健康 Agent。

公共 RPC `agent.interaction.respond` / `agent.interaction.inspect` 与 CLI `agent interaction respond --input FILE|-` / `agent interaction inspect --session ID --operation-id ID` 使用同一个 owner。回答需要经传输批准的 user 或 device；正文里的身份声明和托管 Agent capability 都不能用来确认权限。同步请求与历史异步问题分别处理。

### 后续 Prompt

普通 Prompt 通过 `submitAgentPrompt` 投递。在第一次可能执行的调用之前，用 `agentPromptCondition(await client.refreshAgentSession(agentSessionId, expectedRun))` 读取该 Session 的准入条件，与 operationId、正文和 Run 一起存进调用方的发送意图。排队的消息到真正派发时才读取条件；重试和丢回执恢复复用存下的条件，不按最新状态重新绑定。

- `agentPromptNotApplied(session)` 依据 Core 的准入记录和分阶段回执，确认整个逻辑输入完全没有生效。这是该操作的稳定终局：用同一 ID 恢复会返回 `AGENT_PROMPT_INPUT_NOT_APPLIED` / `not_applied`，不会再次输入。用户下一次明确发送时，使用新的 operationId 和当前的 `agentPromptCondition`，原正文和拒绝记录保留。
- 以下情况都不构成整个操作的终局，`unknown` / `partial` 仍沿原请求继续：本次调用写入零字节、准备失败、单独的重绘被拒、正文已接受而提交未完成。
- `afterSubmissionId: null` 表示已确认没有前序准入，字段缺失表示未知。
- 后续消息已经替换了原准入、原记录不在时，旧消息返回 `AGENT_PROMPT_INPUT_UNCONFIRMED`；后续事实和原生终端输入保留，这不代表 Agent 失效。

### Timeline 与浏览器侧子路径

`client.sessionTimeline(agentSessionId)` 返回 `{ agentSessionId, revision, items }`。精确读取由 Store 的 `readHistorySource(agentSessionId)` 核对该 Session 的 active / retired 来源与 reopen 关联，不枚举无关 Session；`sessionHistorySources()` 只用于目录发现。Timeline 事件也带 revision，Core 总是先保存再发布事件。revision 由 Store 唯一持有，只有内容真的变化才加一；完全相同的重试不改文件，也不再发事件。消费者先读 snapshot，再按 revision 接事件；遇到断号就重新读 snapshot，不要自己补缺。流式更新提交当前完整内容，不提交字符串 delta。

浏览器侧只需要 View 投影和焦点解析时，从 `@agentmux/core/runtime` 导入；只需要合并 Timeline snapshot 与已提交 revision 时，从 `@agentmux/core/timeline` 导入；结构化回答的可用性判断从 `@agentmux/core/agent-interaction-state` 导入。这些子路径都不会加载 Agent Client、Hook Server、File Store 或 ctxmux Adapter 等仅限 Node 的模块。

Mote 输入的工作面 locator 从 `@agentmux/core/mote-input-source` 解析。已核验平台通知的只读呈现从 `@agentmux/core/mote-input-notice` 取得：`parseMoteInputNotice` 与观察记录匹配，解析成功不授予平台作者身份、输入资格或权限。完整的决定和结果仍通过 `inspectMoteInput` / `agent.input.observation` / `agent input observation` 读取，桌面和手机消费同一个 owner。记录的来源 Host 与读取路由分别保留，不能用当前选择或同名 Host 代替。

## 原生对话读取

对话读取的公共合同在[对话协议](../../docs/specs/conversation-protocol.md)；本节列出 Core 的入口。各内置 Provider 实际打开的原生文件、身份与变化观察见[《Provider 原生来源》](../../docs/architecture/conversation.md#provider-原生来源)，以该页为准。

`@agentmux/core/conversation` 不依赖 UI。`projectConversationStream` 直接消费已接受的 `ConversationSourceRecord`、来源范围与覆盖，保留记录身份、版本和顺序证据，统一生成事件与关系；`projectConversationTimeline` 把原生分页或 captured timeline 适配后交给同一条语义流。只需要内容、角色和来源摘要时，对同一输入调用 `projectConversationSummary`，它复用完整读取的语义图，但不生成事件版本、记录集合与输入实体；需要这些或要消费后续变更时，使用 `projectConversationReading` / `projectConversationRecords`。客户端通过 `readAgentConversation` / `readConversationChanges` 读取已接受的窗口，通知只用来唤醒读取。Desktop、Mobile 与外部连接器复用同一来源与内容，不另建历史缓存；模块边界见[语义流的模块边界](../../docs/architecture/conversation.md#语义流的模块边界)。

`sessionHistoryPage(agentSessionId, { limit, cursor?, signal? })` 读取 Session 的 Provider 原生记录；`observeSessionHistory(agentSessionId, onChange)` 在原生来源变化时通知消费者重读最新页。两者独立于 Hook timeline，读取不向 Agent 输入内容，也不改变 Run。历史 cursor 是 Provider 生成的不透明值，不能用数组下标、正文或时间重新构造。CLI 与 RPC 的历史分页沿用 `agent history` / `agent.history`。以下内容的合同都在对话协议中：原生 `metrics` 与 `turnUsage.cumulative`、`system-message` 记录、Codex 历史中的 `questionAnswers`、`AGENT_SESSION_HISTORY_SNAPSHOT_CHANGED` / `AGENT_SESSION_HISTORY_SOURCE_CHANGED`、资源读取（`agent.history.resource`、`representation`、Markdown 图片、文本片段续读），以及 `readSessionHistoryTextResource` 与 `readSessionHistoryImageBytes`。

各内置 Provider 是否提供原生读取与变化观察，以 [内置 Provider](src/providers/index.ts) 组合的各模块是否实现 `readSessionHistoryPage` / `observeSessionHistory` 为准（当前 11 个提供读取）；这说明源码能力，不代表任意厂商版本或安装都已验收。终端输入要等原生 CLI 保存为记录后才能从原生读取接口取得，尚未保存的终端编辑缓冲不是已提交的消息。原生 Resume 通过 Core 的 Session 生命周期完成。Hook、Permission、Usage 与问题回答是否随 history reader 一并接入，见上引《Provider 原生来源》。

## Agent 与工具分端执行

一个 Agent 可以把进程和模型访问放在一台 Host，把项目文件和工具执行放在另一台 Host。从项目启动、选择两端到继续原工作的步骤见[远程执行使用指南](guides/actions/remote-execution.md)，Settings 和 CLI 帮助使用同一份正文；本节说明实现与当前适配范围。

`agent.execution.create`、`agent.execution.binding`、`agent.execution.rejoin` 与 `agent.execution.inspect`（RPC 与同名 CLI）复用 [Core 执行协调器](src/agent-execution-coordinator.ts)。Provider 通过 `prepareToolExecutionLaunch`（改写 Agent 端的启动）和 `prepareExecutionHelper`（准备资源端 helper）贡献原生接法，客户端始终使用同一个绑定、Session 与操作回执；`rejoin` 重新接上原 reader，不重发结果未知的工具操作。内置 Provider 中只有 Claude Code 和 Codex 实现了这两个接口，其他 Provider 请求分端执行时返回 `EXECUTION_PROVIDER_UNSUPPORTED`。各 Provider 的原生协议与配置边界如下；分端操作失败不会退回 Agent 本机执行。

两家共同的边界：原生配置、Hooks 与 Skills 从 Agent 端加载，不自动同步资源端的同名项目配置；连接成功不等于所有扩展都与本机运行等价。每个绑定通过 notice 公开当前限制，用户不需要删除自己的 Hook 才能使用分端执行。工具侧的 `amux` 控制在每次启动时登记，原 Agent 路由尚未确认时，资源端 notice `AGENT_TOOL_CONTEXT_UNAVAILABLE` 说明这一点，资源工具照常可用。

### Claude Code

[Claude Provider](src/providers/claude.ts) 通过 [`resolveClaudeExecutionExecutable`](src/providers/claude-tool-execution-launch.ts) 按原启动目录与环境解析可执行文件，不额外运行 `--version` 作为创建门槛。启动时，Core 在用户已有的 `--mcp-config` 列表末尾追加本次绑定专用的 `amux_exec` MCP 服务（loopback WebSocket），用 `--plugin-dir` 挂载执行策略，并通过 `--append-system-prompt` 加入一段说明资源 Host 与目录的文字（用户已有的追加提示保留在其后）；用户已有的 MCP、插件、提示与原生会话配置继续由 Claude 加载。选择其他工具环境的参数（`--remote`、`--teleport`、`--worktree`），或停用路由插件的原生配置（如安全模式、`disableAllHooks`），会拒绝本次分端启动并解释冲突。设置的读取与优先级复用原 Hook 配置 owner；无法确认这次路由配置时保留原请求并说明未知，不以错误机器上的本地工具代替，也不自动改写用户设置或停止已有 Agent。

`Bash`、`Read`、`Write`、`Edit`、`NotebookEdit` 和资源任务的 `TaskStop` 经该 MCP 服务在资源端执行：文件校验与读取状态由资源端持有，`Bash` 与 `TaskStop` 使用 helper 自己的进程句柄。资源授权是绑定中明确给出的 `host-user`，不是操作系统沙箱。原工具池、主 Agent 的原生权限查询与资源 MCP 许可分别成立，不会整类自动批准工具，也不在 Agent 本机重放整条工具调用来探测权限。

实际 Hook 看到的是 MCP 工具名与调用 ID，审批发生在主循环；按原工具名匹配的 Hook、或按子 Agent 身份审批的配置需要核对这一差异。公开的权限查询目前不能指定子 Agent，因此子调用只放行原生工具确认 `isReadOnly` 且原查询已允许的操作，其余操作明确报告权限上下文未确认，主 Agent 和其他已确认的操作继续工作。直接调用替换后的工具名不能扩大子 Agent 的工具范围。这些边界由 notice `CLAUDE_RESOURCE_TOOL_CONTEXT_LIMITED` 公开。

### Codex

[Codex Provider](src/providers/codex.ts) 只接受 [`qualifyCodexExecutionExecutable`](src/providers/codex-execution-helper.ts) 核验的 `codex-cli 0.165.0`。[`prepareCodexToolExecutionLaunch`](src/providers/codex-tool-execution-launch.ts) 用 `--no-daemon -C <资源端项目目录>` 启动普通 Codex TUI，并通过 `CODEX_EXEC_SERVER_URL` 把原生工具执行接到本次绑定的 loopback exec-server；`-C` 只决定工具目录，Agent 进程自己的工作目录仍在 Agent 端。它只读取、不改写用户配置，以下情况拒绝本次启动：生效的 `CODEX_HOME` 下存在 `environments.toml`（原生 CLI 会用它覆盖上述环境变量）、启动参数指向 app-server（`--remote`）、或设置了 `CODEX_EXEC_SERVER_NOISE_*` 覆盖变量。资源端 helper 由 `prepareCodexExecutionHelper` 准备，绑定 notice 公开当前边界：Hooks 尚未核验（`CODEX_EXECUTION_HOOKS_UNQUALIFIED`），跨端 Skills 未验证（`CODEX_EXECUTION_SKILLS_UNVERIFIED`），资源端不支持 MCP 调用（`CODEX_EXECUTION_MCP_UNSUPPORTED`）。

## Runtime 边界

`@agentmux/core` 是 ctxmux 的 client，不是它的宿主。ctxmux 自己的 daemon、CLI、协议和 SDK 构成可独立使用的通用 Run Runtime；Core 随包固定一份产物，只是当前产品的供应链与 endpoint 策略。

Core 只消费 ctxmux 能够权威证明的 Run 事实：identity、capability、lifecycle、有序字节、replay、gap、输入、resize、interrupt、stop、revision 和时间。Provider、AgentSession、Provider 原生身份、Launch / Resume Plan、Hook、Permission、Prompt 就绪、Agent 状态与证据解释都归 Core。新增 Provider 不能要求 ctxmux 增加 Agent 专属的 Run 类型，也不能要求它解析 Provider 输出。

Provider 原生 Resume 由 Core 根据自己的 Session 与 provenance 生成新的通用 `RunSpec`，再请求 ctxmux 创建并记录 lineage。调用方请求 Level B（语义恢复同一 Session）而 provenance 不足时必须失败；Core 和 ctxmux 都不能暗中降为 Level A（只重启进程）。

Codex 的官方错误资料、原生暴露边界与适配核对见 [Codex Provider 错误说明](../../docs/guides/codex-provider-errors.md)；模型请求失败的通用行为由[交互合同](../../docs/design/behavior/agent-capabilities-and-messaging.md#模型请求失败与工作结果)持有。

## 公共 JSON-RPC 服务

CLI 是类型化的 RPC client：解析参数、调用服务、输出回执。`AgentMuxRpcService` 是统一的业务入口，复用 Core Client 和宿主提供的配置、布局、文件与 Toolkit owner；`AgentMuxControlServer` 把它暴露为 JSON-RPC 2.0。宿主没有注册的能力返回明确的 unavailable，服务不会另造桌面或 Runtime。

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

`amux --endpoint`（或环境变量 `AGENTMUX_RPC_ENDPOINT`）选择传输；SDK 用 `agentMuxRpcEndpoint(selector)` 解析同样的字符串，再传给 `connectAgentMuxRpc({ endpoint })`：

| Endpoint | 传输 |
| --- | --- |
| `unix:/绝对路径`（默认为运行时目录下的 `control.sock`） | 本机 Unix socket，逐行 JSON |
| `http://host:port/` 或 `https://host:port/` | HTTP，持续观察使用 SSE。服务端默认关闭，需显式提供 `http: { host, port, token }`；客户端从 `AGENTMUX_RPC_HTTP_TOKEN` 读取 token |
| `ssh://[user@]host[:port]/` | 系统 SSH 调用远端 `amux system endpoint --stdio`，转发到远端已有的本地服务，不另起 Agent Run；`?socket=` 与 `?command=` 可覆盖远端 socket 和命令 |
| `tailcat:地址?key=密钥文件` | Tailcat stdio |
| Relay 连接邀请 URL | 端到端加密 Relay，手机端也用这条通道 |

HTTP 的每次请求都校验 token；托管 Agent 的 Session capability 在所有传输上按同一业务合同校验，HTTP token 不能代替 Agent 身份。

JSON-RPC 的 `id` 只用于匹配通信，`operationId` 才记录业务操作；没有完整回执时先查询原操作。订阅断开只释放对应的 reader，Agent、Run 和桌面的观察连接保持不变。命令、参数与远程选项以所运行版本的 `amux --help` / `amux MODULE --skill` 为准（[Core 指南](guides/README.md)）。

外部聊天连接器（`connection.*`）的方法、调用者授权与操作回执见 [Connection 公共协议](../../docs/specs/connection-protocol.md)。宿主通过 `AgentMuxRpcServiceOptions.connections` 注入 `ConnectionPort`，纯类型与严格解析从 `@agentmux/core/connections` 导入，Host 侧实现见 [`@agentmux/connectors`](../connectors/README.md)。

## Diagnostic Evidence

通用的强类型机制在 `@agentmux/diagnostic-evidence`，Core 的领域类型从 `@agentmux/core/diagnostic-evidence` 导入。公共 RPC `system.diagnostics.inspect` 与 CLI `amux system diagnostics inspect --list` 列出本服务组装的 reader，再按准确的 Host / logId、Toolkit executionId 等目标查询。默认返回安全摘要，`--include-raw` 显式读取保留的原件；查询不启动采样，也不触发恢复。

当前可读的域取决于宿主注入了哪些端口：Agent 启动、阅读生命周期、Client 与 Core 投递、Toolkit 性能失败、性能场景、Mote 上下文、客户端事故与客户端通知；Native recorder 失败的来源目前未暴露，列表中显示为 `not-exposed`。能力清单由 [`inspectDiagnosticEvidence`](src/diagnostic-evidence-service.ts) 组装。接口语义见[协议](../../docs/specs/diagnostic-evidence-protocol.md)，接入步骤见[指南](../../docs/guides/diagnostic-evidence-integration.md)。

## 持久空间图

`@agentmux/core/spatial-state` 导出文件系统空间 owner 和类型化的空间图：Space / Zone / Tab / Region 的稳定身份、全部绑定、Group / Region 拓扑和选择，不需要 Electron 或图形前端。`@agentmux/core/spatial-layout` 导出与 UI 无关的分割树代数，`@agentmux/layout` 重导出同一实现。

数据存放在 Core 状态目录下的 `spatial-state.json`，或 `AGENTMUX_SPATIAL_STATE_STORE` 指定的绝对路径。写入在进程退出时由操作系统释放的文件锁下比较准确修订，fsync 文件与父目录，并保留上一份有效文档。读到损坏的文件，或观察结果缺少实体时，拒绝破坏性写入并保留原字节。显式删除实体需要 `allowEntityRemoval`；解除位置绑定会保留实体和执行引用。

公开 CLI 可以通过 Unix、HTTP 或 SSH 传输对无界面的 Core RPC Host 执行：

```sh
amux space state
amux space commit --revision 0 < graph.json
amux space ls --zone ZONE_ID
amux space resolve --tab TAB_ID --region REGION_ID --direction left
amux space unbind --zone ZONE_ID --space SPACE_ID
```

`space commit` 接收完整的图和最后读到的修订，修订 `0` 用于创建尚不存在的存储。冲突时需要重新读取并合并，服务不会自动重试。client 的资源元数据按 JSON 原样保留，由原宿主解释。保存或查询位置不会创建 Run，也不表示原生页面已挂载。Desktop 通过可信 preload 端口消费同一个 owner，界面偏好和草稿留在 client。当前消费者合同见[持久空间状态](../../docs/architecture/spatial-state.md)。

## 远程 Runtime

远端运行同一个 Core 包的 `agentmux-runtime serve`，它持有 Provider、Session Store、Hook、Permission 与语义 Resume；本地 Client 只持有连接和可恢复的观察。远端需要 Node 24+、包内支持的原生产物（macOS arm64 或 Linux x64）和目标 Agent CLI；Linux x64 也可以使用下面自带 Node 的发布包。

### 免装 Node 的 Linux x64 发布包

`node scripts/linux-release/build.mjs --out DIR` 在已构建的 Core 上产出 `agentmux-core-<version>-linux-x64.tar.gz` 及其 `.sha256`。CLI 的单份 JSON 结果在 `artifacts` 字段提供共享仓库分发归档与收尾回执；直接交付其中准确路径，留存规则见[产物的自动收尾](../../docs/guides/macos-packaging.md#产物的自动收尾)。导出的 `buildLinuxRelease()` 仍只写调用者指定输出，不触发公共归档留存。包里是校验过的官方 Node 24、与 Desktop 远端升级相同的可移植 Core 产物，以及 `install.sh`。目标机只需要 Linux x64 与 glibc 2.34 以上，不需要 Node、npm、编译器或外网。可移植产物只带各依赖声明的发布文件，不含 TypeScript 源码、测试、源映射、类型声明和其他平台的原生产物；发出的 JavaScript 仍然可读，不能当作代码保密手段。

```sh
tar -xzf agentmux-core-<version>-linux-x64.tar.gz
./agentmux-core-<version>-linux-x64/install.sh   # 默认装到 ~/.agentmux/server
```

安装器把 Core 放进与远端升级相同的 `state/core-releases/<digest>/` 发行目录（含 `deployment.json` 与 `launcher/amux`），只用升级可以重建的环境启动 `serve`，最后打印要填入 Host「Connection options」的 Service command 与 Service socket path。已有 Core 在服务时不再启动第二个 owner；重复安装不删除状态、Session 或 Run。机器重启后执行打印出的 `start.sh`，之后的版本更新使用 Desktop 的 Core 升级。Agent CLI 必须在启动 Core 的用户 `PATH` 上。

### 连接远端

`connectHostedAgentMux` 是统一的公共 Runtime SDK，本地服务、SSH 与宿主 HTTP 连接使用同一服务合同；`connectSshAgentMux` 在它之上组合系统 SSH，客户端不会复制 Provider、Session Store 或 Run owner。独立的 Core Headless 服务和宿主服务共用同一个语义 owner，宿主额外注入私网、设备与 Desktop 能力。每次调用分别核验传输授权、持久 owner 和当前进程代次；托管 Agent 的 capability 不授予完整的 Runtime SDK 权限。Tailcat 与 Relay 端点通过 `connectAgentMuxRpc` 和 `amux --endpoint` 使用，见[公共 JSON-RPC 服务](#公共-json-rpc-服务)。

`connectOnDemand: true` 跳过初始整机 Session 观察，准确 Run／控制读取仅连接各自原作用域；显式调用 `connect()` 仍打开一般观察。它不改变权限、Session 或 Run 的 owner，默认连接行为保持不变。

```sh
# 在远端启动语义 owner；健康 Run 不随它退出而终止。
agentmux-runtime serve
# 在另一个终端读取稳定的 runtimeId 与当前 ownerInstanceId。
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

`hostname` 可以使用已有 SSH config 中的 Host 别名；`user`、`port`、`identityFile`、`remoteCommand` 与 `remoteSocketPath` 按需覆盖默认值。连接使用非交互 SSH。Desktop 的 Hosts 设置保存这些连接参数，并展示已绑定的稳定 Runtime ID。

`readAgentSession(完整 SID)` 从持久 metadata owner 读取一个准确的 Session，保留 owner 已确认的 started-unconfirmed Run 观察：确知不存在时返回 `null`，读取失败时保持未知；它不探测、不接管、也不启动 Run。Hosted 客户端复用有限的 `runtime.invoke`，只返回这次读取，不更新会话缓存。

`connectHostedAgentMux({ rpc, waitForReady: false })` 在后台观察完整目录，准确读取不等待目录；`connectRelayHostedClient({ ...options, waitForReady: false })` 还会先完成原加密 hello、Host 核对与控制 owner 确认，再返回同一个 client。省略该选项时仍等待完整目录。`sessionObservation()` 返回 `state: 'unconfirmed' | 'ready' | 'unavailable'`、`hasSnapshot` 及失败时的 `diagnostic`；`onStatusEvent` / `onEvent` 的 `session-observation-state` 是本地 SDK 观察，不是新的 RPC 或 Run 状态。尚无完整快照时，`agentSessions()`、`catalog()` 与 `providers.catalog()` 抛出 `HOSTED_SESSION_OBSERVATION_UNCONFIRMED`，不能把它当作空目录；已有快照丢流则保留原缓存。`connect()` 可重试目录观察，目录失败不撤销准确控制能力，也不会重放输入。

连接中断时，Session、Tab、Region、布局和未发出的输入保持原身份。缓存只代表最后一次观察，服务窗说明失败的步骤与恢复动作；只有 Core 明确确认 Session 已终结，才允许移除对应的投影，观察结果为 unknown / unavailable 时保留原工作面。Owner 重启时用原持久目录恢复 Session，再附着到同一个 ctxmux Run；Provider 原生 Resume 保持 Session ID，并创建带 provenance 的新 Run。

## Notebook 目录 API 与 CLI

知识目录不需要 App。`@agentmux/core/notebook-store` 的 `AgentMuxNotebookStore` 负责 `notebooks.root.json` 及相邻的 `notebooks.root.json.files/`，位置跟随 NotesStorage owner 的实际 Notes 目录，默认是 `~/.agentmux/notes/notebooks.root.json`；`AGENTMUX_STATE_DIRECTORY` 决定 locator 与旧目录导入入口，Desktop 消费同一个目录 owner。旧的 SQLite / JSON 目录只作一次导入输入，并保留备份。`@agentmux/core/notebook-catalog` 导出 `NotebookState`、`NotebookWrite`、`NotebookChange` 和严格读取类型。正文由资源 Host / Workspace 的文件能力持有，目录保存准确引用、页面层级、网页来源和真实的变化轨迹。归属和关闭语义由 [Notebook 行为合同](../../docs/design/behavior/knowledge-workflows.md#recallnotebook-与块知识)定义；这里列出公开调用方式。

Note 正文是文件 owner 持有的 `.note.md`，格式与稳定块、引用标记见 [Note Markdown 与元数据](../../docs/specs/note-markdown.md)。`notebook inspect --note ID --content` 返回已保存的 Markdown、revision、块及同一 revision 的 `noteProvenance`；`file read/write` 按资源与 CAS 读改正文。作者由可信调用者确认，正文中的身份声明不构成归因。`notebook graph` / `notebook resolve` 读取同一正文派生的关系，不需要打开页面。

```sh
amux notebook ls
amux notebook inspect --notebook quick-notes
amux notebook inspect --note NOTE_ID
amux notebook inspect --operation-id ORIGINAL_OPERATION_ID
amux notebook apply --revision CURRENT_REVISION --operation-id NEW_OPERATION_ID \
  --change-json '{"kind":"create","notebookId":"research","name":"Research wiki"}'
```

`notebook.ls`、`notebook.inspect`、`notebook.apply` 是同一个公共 RPC 的方法。`notebook.apply` 的输入是 `{ expectedRevision, operationId, change }`，返回完整确认后的目录。读写都走已有 Endpoint；写入者由可信传输或 AgentSession 确认，不能在 `change` 中自报身份。

| `change.kind` | 字段（除 kind） | 结果 |
| --- | --- | --- |
| `create` | `notebookId, name, workface?` | 新建 Notebook；默认 `quick-notes` 的名称是“随手记” |
| `rename` | `notebookId, name` | 改 Notebook 名；默认 Notebook 的名称固定 |
| `bind` | `notebookId, workface` | 绑定工作面 `{ zoneId, workspaceId }` |
| `register` | `noteId, title, resource, notebookId?, parentNoteId?, workface?, source?` | 登记一篇已保存的 Note；未指定 Notebook 时放进随手记 |
| `move` | `noteId, notebookId, parentNoteId` | 移动页面及子树；根级用 `null`，形成循环时拒绝 |
| `rename-page` | `noteId, title` | 改页面标题，Note、Block 与文件不变 |
| `source` | `noteId, source` | 追加来源，不覆盖已有来源身份 |
| `organize` | `noteId, topic` | 记录已确认的 Topic 整理，不创建空间关系 |
| `relocate` | `noteId, resource, from?` | 记录文件能力已确认的新位置，不移动文件 |
| `follow` / `unfollow` | `noteId` | 关注 / 取消关注，身份来自可信调用者 |

`resource` 为 `{ hostId, workspaceId, workspacePath, path }`，`path` 相对于 Workspace。`source` 为 `{ sourceId, url, title, recordedAt, operator?, position? }`，标题未知时用 `null`；可选的展示位置为 `{ zoneId, tabId, regionId }`，来源 URL 不依赖这个位置仍然存在。`topic` 为 `{ spaceId, topicId? }`。`inspect --note` 返回页面及其完整事件轨迹。

丢回执时先查询原 `operationId`，再用同一个 ID、同一 payload 和同一操作者重试，成功不会重复。新的意图使用新 ID 和最新 revision；并发冲突时先重新读目录。读取损坏或未确认时保留原字节与页面，不用空知识库覆盖。与当前事实相同的改名、位置或资源操作不会产生虚假的变化事件。

确认过的文件移动可以给 `relocate` 带上可选的 `from: NoteResource`：目录拒绝过时的原位置，不会用它覆盖之后的位置；同一个操作 ID 仍按原样重放。Desktop 只记录已确认的 File / Zone 结果，把未决的历史写入保留在既有的展示恢复回执里；这些回执不含 Note 正文，也不替代 Core 目录。

## Browser PNG from the public SDK

The SDK keeps the original Browser operation and page owner. Discover an exact Browser first, then call the existing program method:

```ts
import { connectBrowserSdk } from '@agentmux/core/browser-sdk'
const browser = await connectBrowserSdk({ endpoint })
try {
  const report = await browser.call('browser.run', {
    browserId, operationId,
    code: "await waitForLoad(); return await captureScreenshot({within:'#report',pixelRatio:2})"
  })
  // Inspect report.outcome, result.source and the actual PNG before delivery.
} finally {
  await browser.dispose()
}
```

For a caller-local new PNG without decoding the result manually, use `amux browser capture --browser ID --operation-id ID --within '#report' --pixel-ratio 2 --output report.png`. Parameters, readiness, host-overlay and recovery boundaries are defined once in the [page screenshot guide](guides/actions/browser-run.md#page-png-and-visible-region-export); the executable `browser capture --help` describes the installed version. SDK completion, PNG export and website business success remain separate results.
