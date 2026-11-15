# Terminal 运行时：字节通路、附着与输入

本文说明终端从 PTY 字节到 xterm 像素、从按键回到 PTY 的当前源码链路，以及每一段由谁持有事实。终端外观（palette、OSC 10/11 颜色回复与主题边界）见 [Terminal 外观](terminal-appearance.md)，宿主、xterm 与 Agent 的交互分层见[终端交互分层](terminal-interaction-layers.md)。本文描述源码机制，不声明某个安装或运行实例已通过验证。

产品对象沿用[《统一概念与空间寻址》](../design/behavior/spaces-and-layout.md#统一概念与空间寻址)：Space、Zone、Tab、Region 是 Core 持有的持久空间实体，Project／Workspace 是来源与目录事实；空间移动不改变 Session、Run 或执行 cwd。ctxmux 与 Core 的分层见 [Core 接入说明](../../packages/core/README.md#runtime-边界)。随包 ctxmux 的身份只取自 [manifest](../../packages/core/vendor/ctxmux/darwin-arm64/manifest.json)，不能据此推断正在服务的 daemon 已经更新。

## 1. 端到端链路

Agent 与 Run 由独立 Host 进程里的 Core 持有，Desktop Main 是这个 Host 的 Hosted 客户端。一次终端输出跨过以下边界：

```text
Agent CLI / shell（PTY 子进程）
        │ raw bytes
        ▼
ctxmuxd                                    ← Run 生命周期唯一 owner
        │ Unix socket（ctxmux.sock）/ @ctxmux/sdk
        ▼
独立 Host 进程                              apps/host/src/host.ts
  CtxmuxRunAdapter                         packages/core/src/ctxmux-run-adapter.ts
        │ CtxmuxAdapter* 事件（data / exit / gap）
  AgentMuxClient                           packages/core/src/client.ts
        │ AgentMuxClientEvent（terminal-output / process-state / agent-session …）
  Hosted Runtime service + AgentMuxControlServer（监听 control.sock）
        │ Hosted RPC（调用与订阅）
        ▼
Desktop Main
  Desktop Host connector → connectHostedAgentMux   apps/desktop/src/main/desktop-host.ts
  RuntimeController                        apps/desktop/src/main/runtime-controller.ts
        │ IPC SESSION_EVENT_CHANNEL（'agentmux:session-event'）→ RuntimeEvent
        ▼
Renderer
  TerminalView（xterm）                    apps/desktop/src/renderer/src/components/TerminalView.tsx
        │ terminal.write(bytes) → WebGL / DOM 渲染
        ▼
像素
```

输入方向：[TerminalView](../../apps/desktop/src/renderer/src/components/TerminalView.tsx) 的 xterm `onData` → preload 的 `api.sessions.write` → [RuntimeController](../../apps/desktop/src/main/runtime-controller.ts) 的 `write` → Hosted 调用 Host 上 [AgentMuxClient](../../packages/core/src/client.ts) 的 `writeTerminalBytes`（普通 Terminal）或 `writeAgent`（Agent）→ [CtxmuxRunAdapter](../../packages/core/src/ctxmux-run-adapter.ts) 的 input-only 通道 → ctxmux writer 的有序字节与本条回执 → PTY。

物理终端通路只传输字节、尺寸与生命周期，不承载 Desktop 主题：`client.ts` 的 `AgentMuxTerminalCreateInput` 与 `ctxmux-run-adapter.ts` 的 `CtxmuxAdapterRun` 都没有颜色或主题字段。主题归 Desktop，见 [Terminal 外观](terminal-appearance.md)；Core 在字节之上另持有 Provider、AgentSession 等 Agent 语义。

空间操作走另一条路径。Core 在启动托管 Agent 时注入 `AGENTMUX_RPC_ENDPOINT=unix:<control.sock>`，因此托管 Agent 的 CLI 先到达 Host：

```text
托管 Agent → amux CLI
        │ JSON-RPC over unix:control.sock
        ▼
独立 Host 的 AgentMuxControlServer（control.sock）
        │ Desktop 原生方法经 forwardControl／forwardSubscription 转发（携带原调用者凭据）
        ▼
Desktop Main 的 AgentMuxControlServer（control.sock.desktop）
        │ DesktopControlIpcBridge：typed IPC request / receipt
        ▼
Renderer control-api → Store.executeControl → Layout Store / reducer
        │ Agent / Terminal 创建
        ▼
RuntimeController → Hosted RPC → Host 的 Core → ctxmuxd
```

`control.sock` 的路径来自 `defaultAgentMuxControlSocketPath`（[runtime-paths.ts](../../packages/core/src/runtime-paths.ts)），`control.sock.desktop` 来自 `desktopBusinessSocketPath`（[desktop-host.ts](../../apps/desktop/src/main/desktop-host.ts)）；两者的接入与转发关系见[系统接入边界](system-ownership.md#当前接入边界)。[Control 合同](../../packages/core/src/control.ts)只表达类型化请求与回执，DTO 不持有空间图。持久实体、绑定和 split tree 由 [Core 空间 owner](spatial-state.md#唯一事实-owner) 持有；Renderer 的 Workbench／layout reducer 消费同一张图，维护屏幕投影与本地操作意图。

Desktop Main 通过公开 Core API 执行 Agent lifecycle：Agent 与 Terminal 的创建经常驻的 RuntimeController，Browser 创建经 Main 的 Browser owner。空间创建先保存意图，再调用 Main 的 Git／config 能力与公开 Core 创建能力，Core 记录同一次 Agent 创建的首次投递事实。展示归属不改变执行 cwd；Session 续接沿[冷启动恢复合同](../design/behavior/session-recovery.md#冷启动按需恢复p0-末位)。

创建之后的投影或保存失败时，回执为 partial 或 unknown，健康 Session 仍可被发现。以同一 request 查询不会重启、重发或重新执行 Git。

布局变化后，viewport synchronizer 把稳定后的 cols／rows 提交给 ctxmux（见第 5 节）。ctxmux 不接收 Tab、Region 或 split direction；PTY 的实际尺寸与客户端测量值分别表达。

### 1.1 原终端附着与 Hosted 准入

接回已有 Run 的物理终端通路与全局语义恢复使用不同前提，行为要求见 [Durable Runtime 健康](../design/behavior/session-recovery.md#durable-runtime-健康)。每个 Hosted 方法的前提由 [hosted-client-contract.ts](../../packages/core/src/hosted-client-contract.ts) 中 `AGENTMUX_HOSTED_PREPARATION` 声明的分类决定，[Hosted Runtime service](../../packages/core/src/hosted-runtime-service.ts) 按分类分派：

| 分类 | 适用场景 | 分派机制 |
| --- | --- | --- |
| `runtime` | 需要 Native 的操作：终端附着、物理事实投影、Agent 创建与 Stop | 先调用 `connectRuntime()`；每个方法仍检查自己的业务前提 |
| `owner` | 不以 Native 或全局恢复完成为前提，例如 `sessionTimeline` 从持久来源读取 | 分派层不预先连接；业务 owner 仍检查自身的目标、权限、连接与存储合同。该分类不表示缓存成功或事实已知 |
| `session-observation` | 明确需要 Session 观察准备 | 调用 `connect()`；只描述传输层准备，不代表业务授权或成功 |
| `input-admission` | 准备方式由本次输入意图决定 | Host service 按人工输入、原生对话准入或引用消息 intake 的合同处理；传输分类不改变输入资格 |

这张表解释前提，完整方法与例外以源码为准，不构成第二份方法白名单。`AGENTMUX_HOSTED_PREPARATION` 以 `satisfies Record<AgentMuxHostedMethod, AgentMuxHostedPreparation>` 声明，有限 SDK 的方法缺少分类时无法通过类型检查，新增方法不会默认落入全局恢复；Hosted Runtime service 的分派 `switch` 以 `satisfies never` 穷尽所有分类，目标、权限、fence、持久事务与回执仍由各业务 owner 核对。默认 Desktop connector 使用 [Hosted client](../../packages/core/src/hosted-client.ts)，Desktop 内不另建语义 Core。Main 的 Stop 使用已有的 Runtime scope；冷 Stop 只经 Core 的 metadata owner 采用目标 Session 的持久记录，不加载无关 Session。

同一个 Hosted consumer 中，重叠的显式 `connectRuntime()` 共享尚未完成的那一次准备（包括前后两次 owner discovery 与 Host 准备）。准备成功或失败后立即释放共享 Promise，后续调用重新准备；disconnect／dispose 清除该 consumer 的共享引用，旧调用的收尾不能清掉新的准备。这里不缓存 readiness、不合并输入，独立的 metadata reader 也不等待 Native 准备；每次输入保留自己的顺序、目标、byte cursor 与回执。

Hosted 的 raw 输入（`writeAgent`、`pasteAgent`、`writeTerminalBytes`）由方法自身先发现 semantic Host，再在同一次 Host invocation 中准备 Native：

- Main 不额外调用显式 `connectRuntime()`。每条串行输入只有一次 Host discovery 和一次业务 invocation，重叠的 discovery 复用在途请求。
- Host 保留准备前后的 owner fence；Core 保留 Session／Run、授权、FIFO 与回执。discovery 失败后，新输入重新观察，未知结果的输入不会重发。
- 普通 Terminal 的输入游标不由 Main 持有；直接使用 Core client 时保留其连接前提。
- Main 在输入入口、任何异步准备之前，把在途事实登记进已有的 Host 操作集合；配置切换等待这些操作结算。Main 不维护第二份 raw 完成队列。

discovery 的等待计入 Main 的 `host-call` 与总输入耗时，parent 关联不变。Main 不用旧的 Native 投影标记 Hosted 输入的执行 owner，实际 owner 由 Host 诊断提供，观察缺项保持未知。输入错误保留在 Renderer 的通知与历史中。SDK 的 Host 发现失败使观察变为未确认时，Main 把这个错误保留在已有的连接服务窗里；下一次成功输入只清除这一步的提醒。已确认 Host 上的业务拒绝不被推断为连接失败，也不因此追加探测。

本机 Host 的启动探测属于物理连接建立。[Desktop connector](../../apps/desktop/src/main/desktop-host.ts) 把服务准备注入 [RPC client](../../packages/core/src/public-rpc-client.ts) 的 `prepareUnixConnection`；同一 Unix 通道的 `ready` 同时覆盖准备与连接，后续请求、订阅和显式 owner discovery 复用该通道，不重复探测 socket。通道关闭后，新通道重新准备；没有健康状态缓存或定时探测。这个本地 SDK 注入点不进入 wire，也不替代上表的 Native 准入和每次操作的身份检查。

取消单个 reader 只结束它自己的等待；共享通道的准备由通道生命周期持有，RPC client 释放后，迟到的准备不能再打开 socket。需要设备授权的 forwarding 使用独立认证连接，每条物理连接单独准备，不混入普通共享通道。准备或连接失败不自动重发请求，已派发而结果未知的请求保持原身份。平台服务的启动由 Desktop 的服务 owner 管理，释放 reader 不停止健康 Host。

一次 GUI 终端附着的实际链路：

1. `TerminalView` 经 [preload](../../apps/desktop/src/preload/index.ts) 的 `api.sessions.attach` 或 `refreshAttachment`，进入 [Main IPC](../../apps/desktop/src/main/ipc.ts) 与 `RuntimeController.attachSession`。
2. Main 通过默认 [Desktop Host connector](../../apps/desktop/src/main/desktop-host.ts) 确认 Host 与 Runtime。首次附着由 Hosted `runtime.attachment-watch` 取得目标 Agent 或 raw Terminal 的初始切面与输出 reader，Core 消费 ctxmux 的 Run、terminal continuation、Replay 与 Gap。已有共享 Attachment 时，Main 读取该 Run 的 Replay；刷新沿已有 Attachment 续接，不为每个 View 重建 Run。
3. Main 核对请求与实际 Attachment 是同一个 Run，再由 `sessionByTarget` 调用 `runtimeSubject(target, attached.run)` 生成本次回执的 Session 投影。已知 Run 来自该 Attachment，不为这一个目标枚举全部 Run；`runtimeSubject` 使用 shared Runtime 准入，不等待全局语义恢复。
4. Main 返回 `attachmentId`、Session、terminal continuation 与 Replay；Renderer 先应用初始切面，再接续 reader 的有序输出。显示、解析完成和输入资格分别由各自的事实确认。

冷 Host 上附着某个 Agent 时，先经 Core 的 `resolveRawAgentSession`（metadata owner）解析该 Session，再取得它的 Run。单独调用 `runtimeSubject` 时，如果活动 registry 还没有该 Agent 的绑定，仍可能得到 `UNKNOWN_AGENT_SESSION`：Runtime 准入不自动加载全部元数据，也不猜造 Session。owner fence、Session／Run 匹配与 reader lease 由各自 owner 核对；释放 reader 不停止 Run。

Main 新建 Agent 经 `launchAdmittedAgent` → Hosted `createAgentWithDelivery`，远端目标使用 `createHostAgentWithDelivery`；SDK 的 `createAgent` 复用同一个 Core 创建 owner。三者都走 shared Runtime 准入，Core 保留 SID 与 operation、意图摘要、prepared seed、Provider／Executor、授权、原生启动与首次投递回执的合同。新的 fork 核对来源 Session 时只通过 `resolveRawAgentSession` 采用其绑定，后续的 Store、Run、native witness 与最终来源检查照常执行；已有回执与 prepared 操作先于新的来源采用处理。

`inspectAgentCreation` 与 `attestAgentCreation` 使用 `owner` 分类，分别消费创建记录与来源授权事实：

- inspect 读到持久回执即可返回；已确认和待确认的结果如实保留，既没有结果也没有 prepared 关联时明确报告未知。只有需要对账 prepared 创建时，inspect 才调用 `connectRuntime()` 并核对 Native 列表，不执行新的启动或输入。
- attest 由 Store、来源能力与签名 owner 判定，Runtime 连通性不授予权限。
- `owner` 分类不免除业务的必要条件，也不表示成功。

恢复消费者 `ensureAgentContinuity`、`resumeAgent` 与 `statusAgent` 同样使用 Runtime 准入，各自在 Core 中采用目标 Session 的元数据与退休事实。`readRetiredAgentSession(id)` 由 Memory／File Store 按严格 codec 读取单个目标，不为一个目标扫描全部退休记录。活动与退休冲突、Host 不符或读取失败都不能冒充不存在，退休记录也不授予恢复执行。Run 仍存活时可先返回 reattachable；需要新 Run 的 Level B 恢复仍按 Provider-native 目标、权限与 lifecycle prepare/commit 执行。

Desktop 的 `RuntimeController.resumeSession` 与 `performRecovery` 在上述两条链路上选择 Runtime 连接。Main 的事件缓存缺项时，Core 的 continuity 回执可经 `sessionByTarget` 交付真实的 Session 投影，并核对 Core 确认的 Run；缓存缺口不会重新要求完整的 `connect()`。批量打开时的辅助观察按 Session 分别保留失败，物理状态读取不等待该 Session 的语义观察完成，当前上下文未知时如实呈现。managed Hook 配置 helper 的无 Session 事件诊断有范围限制：listener／binding 的 `hookIngressObservation` 不能当成配置修复的回执。

### 1.2 输入顺序与等待成本

输入顺序与等待成本的行为要求（包括哪些手段不能用来降低输入成本）见[连续阅读与输入响应](../design/behavior/terminal-reading.md#terminal-连续向上阅读历史)；本节说明当前实现怎样保证字节、目标、授权与写入顺序。

Agent 的 `writeAgent`／`pasteAgent` 与普通 Terminal 的 `writeTerminalBytes` 都消费 `CtxmuxRunAdapter.openInput`，经 ctxmux 公开的 input-only connection 顺序发送：

- 每个实际使用的 Run 懒开一个物理连接。同一次 opening 得到的 RunInfo 与 daemon 身份，供 Core 在首次副作用前核对 Session／Run／cwd；每次派发仍重新核对当前绑定与授权。
- ctxmux writer 决定可写状态与本条 applied range；Core 不维护第二份 cursor，也不逐笔查询状态。
- 同一个 Core 的两个 raw 入口共享目标 Run 的短接纳边界：容量等待、最终授权与目标核对、同步写入 wire 是一个连续责任，写入 wire 后立即释放，各调用分别等待自己的 ACK。SDK 的可写通知不预留容量，因此不能在两个方法里各自排队后再争用同一个物理窗口。

| 等待或约束 | 当前处理 |
| --- | --- |
| 授权准备与 Session／Run／daemon 身份 | Core 持有；异步准备的完成顺序不能打乱已接纳的同源输入 |
| PTY 字节顺序、写入背压与本条 applied range | ctxmux writer 唯一持有；接纳与完成回执分开，背压不能伪装成功 |
| 语义输入的操作身份、cursor 条件与未知恢复 | Core 与 ctxmux 的 recoverable 合同持有；raw 输入的优化不取消防重复写入 |
| raw 输入的字节范围 | 取 writer 为本条返回的 applied range；写入前不为获取 cursor 查询 Run，也不从上次 ACK 或较晚的 Run 快照倒推 |
| 相邻两条 raw 的派发 | 前一条进入有序 wire 即释放接纳顺序，后一条不等前一条的完整 ACK；各调用分别等待自己的回执 |
| SDK 在途窗口已满 | 只有队首等待容量通知，之后重新核对授权再发送；不定时攒批、不丢弃未发送的输入、不自动重试已派发的输入 |
| 历史投影、可选的屏幕确认、无关 Session 的工作 | 不作为 raw 输入的前置条件；相关成本由各自消费者缩小范围，不另建调度层 |

事务边界：

- 程序化的 `writeTerminal` 服务 execution bridge 等可恢复操作，保留 `operationId`、daemon 身份与 `expectedByte`；它是独立的可恢复接口，不是实时按键接口的兼容分支。
- Desktop 的按键、粘贴与 Main 发出的原生颜色协议回复，共用 `RuntimeController.write`／`paste` 的 Host 在途 owner；协议回复不另开连接准备。
- `writeTerminalBytes` 是 SDK／客户端组合方法，由 `runtime.invoke` 与 GUI 的 `sessions:write`／`sessions:paste` 消费，没有单独的 CLI 按键命令。空字节不发送，无法确认的字节范围保持空值。
- Core 分开表达接纳顺序与尚未完成的交易。raw 接纳只随调用增长；完成集合只保留真实在途项（必要的协议后处理也计入本次完成），回执缺失时不积累已完成历史的 Promise 尾链。
- 同一 Agent 语义 lane 的输入，在入队时等待之前的交易完整结束，并保留 recoverableInput 的 cursor 与 operationId 合同。这条 lane 不是跨 Client 或全部 Run 的全局屏障：通用 Run bytes、其他 Core 与 Native Client 的交错写入仍由原生 CAS 核对字节范围，不能凭局部排队推定没有外部输入。
- posture、handshake、typed response、prompt 恢复与空载荷不随 raw 改道。用户的 raw 输入遇到当前的 native-hook 请求时，先等前一笔交易，再重新读取目标 Session／Run 与 pending request，在 CAS 事务中把本次结果保存为 unknown；晚到的回执只更新这次捕获的请求与操作，不会改到后来的请求。

寿命与失败：输入通道复用 ctxmux 的 FIFO 接纳、命令关联、预算与结果机制，独立于输出 Attachment；detach、换 View 或观察失败不关闭健康输入。Run 终局、真实连接关闭或 adapter 连接被替换时，释放对应的 handle 与 opening，晚到的 opening 不得覆盖新 owner。Native 复用 Run 终局通知收束没有输出 reader 的通道，不新增轮询。SDK 只保留未完成的命令，Core 只保留未完成的交易。未发送即取消为 `not_applied`；已发送但结果丢失保持 unknown，不自动回放，也不关闭健康 Run。下一次独立输入可以打开新连接，但它不是对旧 unknown 的重试。

输入诊断的阶段定义在 [performance-diagnostics.ts](../../packages/core/src/performance-diagnostics.ts) 的 `INPUT_PERFORMANCE_STAGES`，区分准备、`input-order`、`input-capacity`、原生写入与 `input-completion-order`。Hosted discovery、Host 事件循环与呈现分别归属各自的消费者；入队时刻的 `blockedBy` 快照只描述那一刻，不能用来解释整段等待。

## 2. 所有权矩阵

ctxmux 是完整、独立的 Runtime 产品。它的 daemon、CLI、协议和 SDK 不依赖 AgentMux，单独安装时可以运行任意命令并完成完整的 Run 生命周期。AgentMux 是 ctxmux 的高级 Client：消费 Runtime 事实并增加 Agent 语义，不成为 ctxmux 的启动宿主、Provider 容器或生命周期 Owner。包内固定的 ctxmux artifact 只是 AgentMux 的一项供应链策略。

分层按两条标准判断：对 shell、server、test、script 和 Agent 都成立、且只能由 PTY、process、Backend 或 daemon owner 证明的事实，属于 ctxmux；必须理解 Provider、AgentSession、Permission、消息、任务或 UI 才成立的判断，属于 AgentMux 或 Desktop。

这条边界也约束证据的提升：writer 确认字节已应用不等于 Prompt 已提交，Output byte range 不等于完整的 Agent message，Run `exited` 不等于 Agent task succeeded，transport unreachable 也不等于远端 Run 已退出。AgentMux 的 semantic event 可以引用 ctxmux 的 Run revision、byte range 与 lineage，但只有 AgentMux Provider 可以解释这些证据。

| 关注点 | Owner | 源码入口 |
| --- | --- | --- |
| PTY raw bytes（stdout／stdin） | ctxmux daemon，经 `CtxmuxRunAdapter` 投影 | [ctxmux-run-adapter.ts](../../packages/core/src/ctxmux-run-adapter.ts) 的 `decodeChunk` / `emitRunEvent` |
| Run lifecycle（start／stop／interrupt／resize） | ctxmux，经 adapter 暴露稳定投影 | 同一 adapter 的 `start` / `stop` / `interrupt` / `resize` |
| Desktop 工作面控制事务 | Desktop Main 把公共业务服务的工作面请求委托给 Renderer；公共 RPC 与无 UI 的语义服务归 Core | [ipc.ts](../../apps/desktop/src/main/ipc.ts)、[系统接入边界](system-ownership.md#当前接入边界) |
| Tab／Region 持久布局与绑定 | Core 空间 owner；Renderer reducer 消费同一张图并投影屏幕 | [空间状态机制](spatial-state.md)、[store.ts](../../apps/desktop/src/renderer/src/store.ts)、[Layout 代数入口](../../packages/layout/README.md) |
| Tab 关闭与后台保留决策 | Desktop Renderer 决定，停止动作经 Core public API 下达；关闭规则见 [Session、Run 与 View](../design/behavior/session-recovery.md#sessionrun-与-view) | 第 2.1 节的关闭事务；[store.ts](../../apps/desktop/src/renderer/src/store.ts) |
| Viewport grid（何时 fit、向 PTY 提交哪个尺寸） | Desktop Renderer 决定 grid；Desktop Main 用 Region 的 Attachment capability 绑定目标 Run；ctxmux 只应用最终提交的 PTY 尺寸。UI 测得的 cols／rows 是请求，ctxmux 应用后的 `current_size` 才是已生效尺寸 | [terminal-viewport-sync.ts](../../apps/desktop/src/renderer/src/lib/terminal-viewport-sync.ts)、TerminalView、RuntimeController |
| owner 确认的 live PTY 尺寸 | ctxmux 的 `RunInfo.current_size` 与 `RunEvent::Resized`。AgentMux 不用 `RunSpec.size` 冒充当前尺寸，未知保持 `null`：`null` 表示没有 owner 能确认，不是回退到启动尺寸；跨客户端 resize 按公开事件投影 | adapter 的 `snapshotCurrentSize` / `liveResizedSize`、[screen-evidence.ts](../../packages/core/src/screen-evidence.ts) |
| Replay 与 terminal continuation | ctxmux 持有 raw bytes、Gap、checkpoint 与 Resize 的顺序；Core 映射公开事实，不生成第二份 Runtime 真相 | adapter 的 `attach` / `observeOutput`；[terminal-continuation.ts](../../packages/core/src/terminal-continuation.ts) 的 `terminalContinuationSteps` |
| 带累计 cursor 的可恢复写入 | ctxmux 公共 SDK 的 `recoverableInput` 持有 recoverable operation；adapter 只映射 receipt，不另写次数循环，unknown 时不盲目重发 | `CtxmuxRunAdapter.input` |
| Provider 终端能力握手 | `AgentMuxClient` | `ensureTerminalHandshake` |
| 主题、palette 与 OSC 10/11 颜色回复 | Desktop（Renderer 与 Main 各负责一种场景） | 见 [Terminal 外观](terminal-appearance.md#外观所有权) |

Session Store、Timeline 与快照观察的持久事实见[系统职责地图《持久事实与观察投影》](system-ownership.md#持久事实与观察投影)。

Provider-specific 的 executable probe、session id、native resume argv、semantic replay、working／waiting／done、Permission、Hook 和 A2A 都不进入 ctxmux。Provider-native Resume 由 AgentMux 物化通用 `RunSpec` 后交给 ctxmux；Level B 的 provenance 不足时失败关闭，不能自动改成 Level A restart。反过来，daemon activation、Run wait、权威生命周期时间与 revision 等不理解 Agent 也成立的能力，由 ctxmux 公共 SDK 提供，AgentMux 不长期维护第二份实现。

本地 Native 激活复用 SDK 的 `activateRuntime` 与 pending／selected 共享观察 owner：SDK 持有 child、fd3 readiness、匹配的 Hello、退出与单 reader 取消；Core 只持有已验证的 artifact、SDK handle 和产品 owner receipt。公开 Hello 的有界观察失败不证明 daemon 死亡：已有的兼容 listener 可以先以 unverified 身份使用，等对应 child 的 readiness 与 Hello 完成后才记录产品归属。晚到的证明通过 SDK 订阅接回原观察；释放 Core consumer 只退订并取消它的 reader，不撤销激活。单次观察错误不是 owner 终局；恢复成功后清除当前失败，未解除的 receipt 与诊断通道服务说明继续保留。产品 receipt 的寻址规则见 [Desktop 与远端 Core 的更新《Native handoff》](desktop-updates.md#native-handoff)。

### 2.1 Tab 关闭事务

关闭 Tab 时，Desktop 只持有工作面的关闭计划与准入（[workbench-view-close.ts](../../apps/desktop/src/renderer/src/lib/workbench-view-close.ts) 的 `planWorkbenchViewClose`），不接管 Core／ctxmux 的 Stop 事实：

- 关闭请求同步冻结该 Tab 当时每个 Surface 的 owner。Browser 与需要停止的 Session 是互不从属的资源，cleanup 同时发出；一个长期 pending 的 Browser 不能阻塞 Session Stop。
- Session Stop 的 owner 同时冻结 RunRef。只关闭展示、共享 Session 或用户确认保留的 Agent Session，不绑定 Run epoch。
- cleanup 按 owner 逐个收到回执：成功或已被权威事件移除的 owner 从 Tab 消失，失败且仍在的 owner 保持可见，下一次关闭只重试剩余的失败项。一个资源失败不回滚整个 Tab，也不以整个 Tab 相等为条件覆盖关闭期间新增的 Region 或 owner。
- 关闭期间，针对同一 Tab 的 move、split、Region close、launch，以及针对待 Stop Session 的 attach、refresh、recover、manual stop，都经过同一个 admission；已在途的异步操作在提交时再次核对 owner 与 Run epoch。Recover 已经创建新 Run 但失去 owner 时，用 Core Stop 清理；清理失败时保留一个可发现、可再次关闭的 Tab。

Renderer 不保存第二份 Run 状态，也没有 Stop ledger、重试 tail 或 fallback。`reconcileWorkbenchViewClose` 逐个比较冻结的 owner 与当前 Region（`sameSurfaceOwner`）：权威的 `run-removed` 先于 API 回执到达而已移除的 Region 不计为失败；同一 Agent Session 已换成新 Run 时，冻结的 RunRef 与当前 Run 不再相等，该 Region 保留并记为关闭期间已变化。只有 owner 仍相等且其资源回执全部成功的 Region 才被移除。行为要求见 [Session、Run 与 View](../design/behavior/session-recovery.md#sessionrun-与-view)。

Viewport Resize 是保留的 Attachment 的能力，不是仅凭 `SessionControl` 就能调用的命令。Renderer 只在 Attach 成功后，用 Desktop 发出的 `attachmentId` 提交尺寸；Main 从 lease 解析权威的 Run，Attach、Resize 与 Detach 由同一个 per-Run Attachment 串行器协调。[`RuntimeController.stopSession`](../../apps/desktop/src/main/runtime-controller.ts) 不进入这个队列：决定停止时立即撤销 lease，再通过 Core 停止目标 Run。前一次 Stop 未回执不会挡住再次停止；迟到或排队中的 Resize 因 capability 已失效而结束，不会触达 ctxmux。Agent 的 resize 与 stop 的 Core API 同时要求 `agentSessionId` 与 `expectedRun`，旧 View 不能在 provider-native Resume 之后控制同一 Agent Session 的新 Run。关闭与重试的行为要求见 [Session、Run 与 View](../design/behavior/session-recovery.md#sessionrun-与-view)。

## 3. 本地 Shell 与 Run 环境

登录 shell 环境的读取由 Core 的 [`prepareProcessEnvironmentFromLoginShell`](../../packages/core/src/login-shell-environment.ts) 实现，Desktop Main（[index.ts](../../apps/desktop/src/main/index.ts)）与独立 Host（[apps/host/src/index.ts](../../apps/host/src/index.ts)）在各自进程启动时调用。Agent Run 由 Host 的 Core 创建，因此 Run 的环境基线来自 Host 进程读到的环境。

- 用户 `SHELL`（缺省时 macOS 为 `/bin/zsh`、Linux 为 `/bin/bash`）以交互式登录（`-ilc`）与非交互式登录（`-lc`）两种模式同时启动，共享一个 30 秒总预算，超时以 SIGKILL 结束子进程。交互式结果有效时优先采用，即使非交互式结果先返回。
- 输出用随机 marker 与 `/usr/bin/env -0` 的 NUL 分隔帧定界，启动 banner 留在帧外，空值、换行与等号原样保留。配置文件由 shell 自己选择，不手工 source 某个 dotfile；非导出变量、alias 与 function 不传递。`_`、`SHLVL`、`PWD`、`OLDPWD` 被丢弃；只采用非交互式结果时，PATH 与继承的 PATH 合并去重。
- 读到的值不覆盖 `AGENTMUX_*`、`CTXMUX_*`、`HOME` 与 `TMPDIR`／`TMP`／`TEMP`，因为这些变量参与 Core 默认命名空间路径的计算；shell 配置不能把进程改指到另一个状态目录。
- 只得到非交互式结果时，持续显示部分读取的告示；两种都失败时保留继承的环境并告知用户（`loginShellEnvironmentWarning`）。

Core 的 `localProcessEnvironment()` 在 daemon 启动及每次本地 Run 创建时读取当前进程环境，Run 显式传入的 env 覆盖这份基线。SDK 的 `RunSpec.env` 是 additive 的：client 删除某个 key，不会清掉常驻 daemon 已持有的同名变量。`terminalEnvironment()` 与 `agentEnvironment()` 负责终端能力、CLI 路径与 Agent 身份的注入，Desktop 不复制这些语义。

基线声明 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=AgentMux`、`TERM_PROGRAM_VERSION`（取自经 manifest 校验的 `CTXMUX_VERSION`）与 `FORCE_HYPERLINK=1`。[terminal-environment-policy.ts](../../packages/core/src/terminal-environment-policy.ts) 再移除描述宿主 shell 而非新 CLI 的信号：

- 颜色：`NO_COLOR`，以及值为 `0` 的 `FORCE_COLOR`／`CLICOLOR`；非零的颜色设置保留。
- 宿主会话：`CI`、`CODEX_CI`、`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`。AgentMux 自身可能从某个 Agent 或 CI shell 启动，这些标记描述的是那个宿主；Claude 会把它们当作子会话或 CI 会话，从而关闭 transcript 与 UI 行为。

Run 显式传入的值在基线之后合并，调用方仍可以有意设置这些变量。由于 `RunSpec.env` 是 additive 的，`CtxmuxRunAdapter` 的 launch 用 `/usr/bin/env -u … -- program args…` 在 exec 边界显式 unset 合并后仍缺省的策略 key（`missingHostEnvironmentKeys`），再 exec 原程序；PID、PTY、cwd、literal argv 与退出／信号语义不变。新建与 semantic resume 都经过这个边界；已启动进程的环境不能在线改写。这一机制的来由见事故案例[恢复后终端颜色丢失](../casestudy/terminal-colors-lost-after-resume.md)。

## 4. 隐藏工作面与冷停（cold-park）

保活与冷停的产品约束见[《Tabbar 与切换保活》](../design/behavior/spaces-and-layout.md#tabbar-与切换保活)；本节只说明当前实现。

Tab 切换不卸载工作面。[WorkspaceWorkbench](../../apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx) 把一个 Tab Group 的每个 Tab 都留在 DOM 里，非活动 Tab 的 `.pane-body__region` 以 `data-active="false"` 隐藏（[workbench.css](../../apps/desktop/src/renderer/src/styles/workbench.css)：`visibility: hidden`、`pointer-events: none`，并设 `inert`）。

- 不用 `display: none`：被 `display: none` 的子树量不到尺寸，切回时要先重新 fit 一次才能显示正确的行列数。
- 每个 region 都是 `position: absolute; inset: 0`：隐藏格不占文档流，不会把活动格挤变形。
- xterm 实例保持存活，切回时没有需要重放的内容，也就不会出现恢复态。
- `inert` 让隐藏格退出可交互树：Tab 键走不到，页内搜索也不会命中。
- 切换显示 Workspace 同样只隐藏不卸载：[App.tsx](../../apps/desktop/src/renderer/src/App.tsx) 给非当前的工作面槽加 `.workspace-workbench-slot--parked`（整个工作面区域不可见时给外层加 `.workspace-workbench-registry--parked`），并设 `aria-hidden` 与 `inert`；[workbench-tabs.css](../../apps/desktop/src/renderer/src/styles/workbench-tabs.css) 让它们 `visibility: hidden` 并绝对定位叠放。这些停放槽与非活动 Region 一起使用 `clip-path: inset(50%)` 与 `content-visibility: hidden`（workbench.css），保留 DOM 与可测量的盒子，浏览器可跳过其后代的布局与绘制，后代动画暂停。

隐藏终端保留同一个 xterm、Attachment 和读位，继续按序消费原 Run 的字节。[TerminalView](../../apps/desktop/src/renderer/src/components/TerminalView.tsx) 在隐藏时释放 WebGL，重新显示时装回，切换不触发终端重放。搜索资源的生命周期见[《Terminal 连续向上阅读历史》](../design/behavior/terminal-reading.md#terminal-连续向上阅读历史)。有界回放能恢复的内容见本页 [Attachment 回放](#5-attachment-回放历史只读与尺寸同步)。

[Surface memory budget](../../apps/desktop/src/renderer/src/lib/surface-memory-budget.ts) 只管理 Monaco 与 Browser 各自可重建的资源。两者各自计额，释放时保留 Region 及其内容身份。

| 策略 | 释放延迟 | 热保留 | 资格条件 |
| --- | --- | --- | --- |
| Monaco | 60 秒 | 5 分钟内最多 4 个 | 不可见、属于当前导航上下文、native owner 存在、可重建、没有未保存或待处理的原生工作 |
| Browser | 90 秒 | 5 分钟内最多 3 个 | 不可见、native owner 存在、可重建且未受保护，覆盖全部导航位置，受 `browser.automaticMemoryRelease` 控制。见[闲置回收覆盖全部导航位置](../design/behavior/browser-workface.md#browser-工作面-1) |

- 隐藏时长从 Region 隐藏时起算。Monaco 回到当前导航上下文时重新计时，Browser 继续原计时。
- 符合释放资格且超过热保留时长的资源可以释放。热保留期内按最近隐藏、最近激活排序，超出数量上限的资源也可以释放。
- 资源测量暂停释放，结束后有 30 秒冷却期，工作面重新可见时清除冷却期。[SurfaceMemoryBudgetCoordinator](../../apps/desktop/src/renderer/src/lib/surface-memory-budget-coordinator.tsx) 只在下一个截止时刻唤醒。

## 5. Attachment 回放、历史只读与尺寸同步

首次 fit 后画面错乱或静止时单列抖动，可按[终端交互分层的重排判别](terminal-interaction-layers.md#5-重排与-replay)定位。

### 5.1 历史 Run 只读

`TerminalView` 以 `canControlRun = session.processState === 'running'` 作为总闸：键盘输入、OSC 回复的 `sendInput` 与 viewport 的 live 尺寸同步，都只在 `canControlRun` 时发生。因此已退出的历史 Run 在 UI 上是只读回放，不会向已结束的进程写入按键、尺寸或 OSC 回复。多个 Renderer View 同时附着同一个 Run 时，Main 复用同一个 ctxmux Attachment，后续 View 走 `readRunReplay`（`runtime-controller.ts`）。

### 5.2 continuation 的恢复与揭示

Attach continuation 是状态恢复，不是历史动画。`TerminalView.applyContinuation` 先验证公开步骤的顺序，再恢复 checkpoint、应用有序的 Resize 与 Output；合并写入与有界排空只改变消费方式，不改变字节顺序。恢复期间由揭示 owner 隐藏画布，避免把历史重绘帧播放成"终端自己在 resize"。

隐藏画布只为这一个目的服务，所以揭示的前提只有 replay 字节写完。live 视口同步（`startLiveSynchronization`）与 gap redraw 在揭示之后继续：它们改善画面，但不决定画面是否可看；而且它们经 resize 与 attach 争用同一个按 Run 串行的锁，如果排在揭示之前，该 Run 上任何一个卡住的操作都会让揭示永远不到来。

揭示另有兜底时限 `TERMINAL_REVEAL_DEADLINE_MS`（6 秒，[terminal-reveal.ts](../../apps/desktop/src/renderer/src/lib/terminal-reveal.ts) 的 `terminalRevealDecision`）。到点仍未揭示时强制揭示，把画布交还用户，同时记录 `terminal-reveal-deadline` 事件并显示服务窗。服务窗由 `terminalRevealServiceOutcome` 给出未完成的步骤、当前状态（live 输出已就绪时说明 scrollback 可能不完整，否则说明输出仍在追赶）和恢复动作（重新打开或 resume 该 Session 以重新 replay）；分类复用服务窗的 `agentViabilityFromProcessState`：Run 为 running 时放行并提醒，exited 时交给既有恢复横幅，interrupted 时如实标为无法判断。揭示与输入资格无关：输入只由 `terminalAcceptsInput`（Run 可控且视图未设为只读）决定，不等待输出 Attachment 或揭示。晚到的成功附着会收起这条告示；已经正常揭示时兜底不再发言，慢但成功的恢复不会被补贴一条失败告示。分类与告示的行为边界见[我们的流程坏了，不等于 Agent 坏了](../design/behavior/session-recovery.md#我们的流程坏了不等于-agent-坏了)。

ctxmux 的 Replay 有界。Gap 表示请求 cursor 与 `firstAvailableByte` 之间的字节已被淘汰，保留下来的后缀不能宣称为完整的终端屏幕。Core 与 Renderer 经 `terminalContinuationSteps` 消费公开 continuation：`basic-vt` 的 checkpoint、restore bytes 及之后的有序 output／Resize，或者没有 checkpoint 时的原始字节恢复。restore bytes 是恢复材料，不计为新的 PTY output；checkpoint 能恢复当前画面，不代表缺失的 scrollback 已经补全。

缺失提示放在 xterm 字节流之外。仍在运行的 Run 确需重绘时，`TerminalViewportSynchronizer.requestContentRedraw()` 经唯一的 Resize owner 临时减少一行再恢复最终网格，促使该 Run 重新输出当前画面；历史 Run 不发送 Resize 或 Input。这只是恢复当前画面的动作，不能作为恢复原始历史或活跃终端连续向上阅读的通过证据，后者按[设计 SSOT](../design/behavior/terminal-reading.md#terminal-连续向上阅读历史) 验收。

### 5.3 Resize 只提交稳定、最新的网格

DOM 的 `ResizeObserver` 只说明容器几何变了，不代表 xterm 的字符网格已经稳定。`TerminalViewportSynchronizer` 先比较连续帧的 `FitAddon.proposeDimensions()`（`terminal-viewport-sync.ts` 的 `observeViewport`／`continueStableFit`，`MAX_STABILITY_FRAMES = 8`）：网格稳定或达到 8 帧上限后才 fit；xterm 已经等于 proposal 时不做无效 fit。因此拖动分隔条不会把每一帧都变成 Codex 的整屏重排。

稳定帧门控挡不住一种静止态抖动：拖动已停、容器像素固定，但 WebGL renderer 的 cell metrics 短暂偏离 DOM renderer，使 `proposeDimensions()` 在同一像素几何下于 N 与 N±1 列之间跳动。照此 fit 会让 xterm 先 reflow 一列再弹回，而 wrap→unwrap 不是完美的逆运算，Codex、grok 这类按 diff 绘制的 TUI 会被画花并持续闪烁。`fitAndSynchronize` 因此在网格与 xterm 不一致时，用 `measureViewport()` 读容器的 CSS 像素，与上次成功 fit 的基线 `lastFittedPixels` 比较（`samePixels`，差异小于 1 CSS 像素视为同一几何）：像素未变即判为 cell-metric 抖动，跳过 fit 与 PTY resize；像素确有变化才 fit 并 resize。基线保存副本，调用方复用同一可变对象时不会连带改掉基线。`measureViewport` 由 `TerminalView` 用宿主 div 的 `getBoundingClientRect()` 提供；Synchronizer 要求调用方提供像素 owner，没有纯网格的兼容路径。

xterm 的 `onRender` 只用来证明首帧已经可测量：`TerminalView` 收到首个 render 时先注销监听，再请求一次 viewport 同步。普通 TUI 输出不是 geometry 事件，不能持续进入 fit 链路，否则 Codex 重绘与一列宽度波动会形成 render → fit → PTY resize → render 的反馈环。

PTY resize 可能慢于 UI 拖动，所以 synchronizer 只保留一个 in-flight 请求和一个可替换的 pending size（`requestResize`／`drainPendingResizes`）：新尺寸覆盖尚未发送的旧尺寸，最终由 `api.sessions.resize` → Core → ctxmux 应用。历史 Run 因 `live=false` 只在本地 fit 回放画面，不向 PTY 发 resize。

## 6. Runtime 持久化故障与容量观察

ctxmux 是 WAL、SQLite durable state 与 persistence actor 的唯一 owner；AgentMux 只消费它公开的可用性与故障结果，不在 Desktop 另建 checkpoint、截断或修复逻辑。用户可见的约束（不冒充 Agent 死亡、完整性故障 fail closed、故障类别可分辨）见 [Durable Runtime 健康](../design/behavior/session-recovery.md#durable-runtime-健康)。

Core 把 ctxmux 协议错误投影为结构化 [`AgentMuxStorageFailure`](../../packages/core/src/errors.ts)（`stage`、`sqlitePrimaryCode`／`sqliteExtendedCode`、`systemErrno`、`transactionOutcome`），并挂在 [`AgentMuxError.storageFailure`](../../packages/core/src/errors.ts) 上，经公共 RPC／CLI 原样传出。按 Run 的可选观察入口是 [`CtxmuxRunAdapter.observeStorage`](../../packages/core/src/ctxmux-run-adapter.ts)：有能力时返回 [`projectRunStorageFacts`](../../packages/core/src/run-storage-observation.ts) 投影的 memory 水位、persistence owner 水印（`firstFailure`、`storageFailure`、`actorStopped`、queued／offered／confirmed 字节）与 policy 预算；客户端或 Runtime 未声明该能力时返回 `unsupported`，已有 Run 与输入仍可用，容量细节保持未知。[Doctor](../../packages/core/src/doctor.ts) 的 `observeStorage` 路径复用同一诊断。

结果分类按阶段、事务结果与错误码区分可恢复争用、容量压力与真正的完整性／权限／I/O 故障；SDK 并不以固定枚举名（如 recovered／busy-retry-exhausted／disk-full／corruption）作为公共合同，具体分类以随包 ctxmux 版本为准。Desktop 的 Terminal／Resume 入口沿用这些结构化事实，不把全部底层错误折叠成“Agent resume unavailable”。

## 7. 前台物理观察（`observeForeground`）

Runtime 的公开单次接口是随包 `@ctxmux/sdk` 的 `observeForeground({ runId })`：只选择原 Run；同一次连接的 Hello 身份带出 `runtime`（RuntimeIdentity）与 `observation`（`RunForegroundObservation`）。观察结果分 `observed`（根进程／SID／PTY 作用域、采样区间、opaque incarnation／exec 世代与进程表）、`unknown` 与 `unsupported`；完整物理执行事实归 Runtime。单次采样不冒连续前台通知。

Core 当前经 [`CtxmuxRunAdapter.readRuntimeEndpoint`](../../packages/core/src/ctxmux-run-adapter.ts) 用一次性 diagnostic client 调用该接口，以重核端点的 Runtime 身份（`reobserveConnection` 路径）；超时由 `foregroundObservationTimeoutMs` 限定。用户可见的 Focus／手动启动 Agent 身份约束见 [Focus 行为](../design/behavior/focus-context.md)；Desktop Focus 目前不直接调用 `observeForeground`（实现缺口另登记）。

## 8. 防回归测试

| 故障／风险 | 防回归测试 | 断言要点 |
| --- | --- | --- |
| 历史 Run 被误写输入 | `TerminalView.tsx` 的 `canControlRun` 门控（第 5.1 节） | 非 running 时输入、OSC 回复与 Resize 均不写回 |
| 拖动后 Codex 因陈旧的 PTY 尺寸队列持续闪烁 | `apps/desktop/test/terminal-viewport-sync.test.ts` | proposal 稳定后才 fit；in-flight 期间 `110×30` 被更新的 `120×30` 取代，未发送的中间尺寸被最新网格替换 |
| 静止态 WebGL／DOM cell-metric 抖动使网格反复 reflow，画花 Codex | `apps/desktop/test/terminal-viewport-sync.test.ts`（"skips a one-column grid wobble…"、"fits and resizes when container pixels actually change"） | 容器 CSS 像素未变时跳过 fit 与 resize；像素确有变化才 fit |
| 首帧 render 监听未注销导致 TUI 自发 resize | `TerminalView.tsx` 的一次性 `terminal.onRender` | 首个 render 先 dispose，后续输出不再触发 viewport 同步 |
| Attach 逐条写入数千个 replay event，历史 TUI 帧看起来像持续 resize | `apps/desktop/test/terminal-replay.test.ts` | replay 合并为一次 parser write；恢复完成前隐藏画布 |
| 已取得 Attachment，回执投影却等待无关 Session 恢复 | [真实冷 Host／Main 附着测试](../../apps/desktop/test/runtime-membership-cold-host.integration.test.ts) | 恢复 pending 与确认失败两个阶段下，Agent 与 raw Terminal 都返回目标 Run／PID、已知初始内容与连续的 live byte range；没有输入重放或新 Run，reader 清理与错误 owner／换 Run 的拒绝仍成立 |
| 终端可附着，新 Agent 创建仍等待无关恢复 | [同一真实 Main 的独立创建测试](../../apps/desktop/test/runtime-membership-cold-host.integration.test.ts)、[Hosted 创建与来源授权](../../packages/core/test/remote-initial-creation.test.ts)、[创建检查](../../packages/core/test/remote-creation-exact-read.test.ts)、[冷 fork 来源](../../packages/core/test/current-fork-lifecycle.test.ts) | 创建、读取与来源授权各自消费自己的准入；分别验证目标 Run／输出、重复操作、未知的首次投递、prepared 对账、来源变化时的拒绝与权限边界，不以 attach 通过代表创建通过 |

外观与 OSC 相关的测试见 [Terminal 外观《防回归测试》](terminal-appearance.md#防回归测试)。[测试策略](../testing/strategy.md)记录整体 oracle 与证据范围；本表列出回归意图，测试存在不代表本轮候选已通过。

## 9. 交叉引用

- [Core 接入说明](../../packages/core/README.md) —— 公共 API 与唯一 Run owner。
- [终端交互分层](terminal-interaction-layers.md) —— 宿主、xterm 与 Agent 的职责。
- [Terminal 外观](terminal-appearance.md) —— palette、OSC 颜色回复与主题边界。
- [文档导航](../README.md) —— 产品约束、运行时与验证的阅读入口。
