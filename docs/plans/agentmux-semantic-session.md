# AgentMux Run 与 Agent Session 领域模型

状态：T-011 领域合同

这份文档只说明长期成立的对象边界。`ctxmux` 已是唯一 Local Run Kernel，独占 PTY、进程和有序输入输出；AgentMux 的公共调用方只看到本文定义的领域对象，不接触 ctxmux wire、Electron IPC 或第三方 SDK 类型。

## 1. 四个对象不是四种叫法

| 对象 | 身份 | 持有的事实 | 明确不持有 |
| --- | --- | --- | --- |
| Run | CtxMux `runId` | 物理进程、工作目录、尺寸、UTF-8 byte cursor、退出事实 | 模型上下文、UI 布局 |
| Agent Session | `agentSessionId` | Provider、Workspace 关联、当前 Run 引用、Native Handle、Hook Receipt | PTY、Replay、进程所有权 |
| Attachment | 当前 Client 对一个 Run 的附着 | 有界 Replay、Gap、增量输出和控制入口 | Run 生命周期、Agent 上下文 |
| View | `viewId` | 一个 Consumer 对 Run 或 Agent Session 的展示投影 | 领域真相、进程或订阅所有权 |

`viewId`、`agentSessionId` 和 `runId` 必须属于不同身份空间。一个 Agent Session 可以同时投影到多个 View；View 关闭后再打开，不会创建或恢复模型上下文。同一 Desktop Client 的多个 View 共享 exact Run 的一个 retained Core Attachment，每个 View 只持有 Desktop-issued lease 与自己的 Replay 起点；最后一份 lease 释放时才释放底层 Attachment。多个 View 的 Output acknowledgement 只能单调推进 Agent Session cursor，较慢 View 的迟到 acknowledgement 不能把 cursor 回退。一个 Run 也可以先释放 Attachment，再由同一或另一个 Client 重新 Attach。

Raw Terminal 只有 Run，没有 Agent Session。Agent Run 必须引用恰好一个 Agent Session；两边的 Agent、Host、Workspace Path 和 exact Run ID 不一致时，投影必须失败关闭。

`agentSessionId` 是 AgentMux CLI、SDK 和 Desktop 的稳定公共主键。Provider native session ID、ACP handle 与 exact RunRef 是 AgentMux Core-owned Store 上的外部索引，不是替代主键：native session ID 必须与 Provider 身份组成查询键，RunRef 直接包含 CtxMux RunId。一个查询命中零个、多个、过期或互相冲突的绑定时必须失败关闭，不能猜测最近 Session，也不能从 Terminal 标题或输出反推身份。

Raw Terminal 的 Client 路由身份是 runtime-issued Terminal/View ID，不伪装成 `agentSessionId`。Agent 的 `agentSessionId` 可以经同一 Core-owned View Resolver 唯一解析到当前已打开 View；零个、多个、过期或已关闭的 View 都不是可切换目标。CLI、SDK 和 Desktop 复用该 Resolver 与 typed Desktop control，Renderer 不维护第二份映射。

## 2. 六个动作必须分开

- **Reattach 原 Run**：exact Run ID 和 Agent Session ID 不变；从指定 byte cursor 获取 Replay/Gap 并建立新的 Attachment，不 Spawn。
- **Release Attachment**：按 exact RunRef 释放当前 Client 的输出附着；Desktop 的一个 View 只释放自己的 lease，最后一个 View 离开时才释放 retained Core Attachment。两者都不停止 Run、不删除 Agent Session，也不关闭其他 View。
- **Provider-native Resume**：可信 Native Handle 和 Provider Capability 同时成立时，保留 Agent Session ID，创建新的 CtxMux Run ID。
- **Respawn**：创建新的 Agent Session 和新的 Run；即使 Provider、Workspace 和 Prompt 相同，也不宣称继承模型上下文。
- **Open View**：创建新的 View ID，引用已有 Run 或 Agent Session；不创建进程、不 Attach 输出，也不改变 Agent Session。
- **Switch View**：使用已解析的 runtime-issued Terminal/View ID 聚焦一个当前已打开的 Desktop View；Agent 调用可先由 `agentSessionId` 唯一解析其当前 View。该动作不 Open、不 Attach、不 Resume、不 Spawn，不改变 Run、Attachment 或 Agent Session 生命周期。

原 Run 仍为 `running` 时禁止 provider-native Resume，避免一个 Agent Session 同时驱动两个物理 Agent。迟到的旧 Run 事件只能作为旧 Run 事实处理，不能更新已经指向新 Run 的 Agent Session。

## 3. Cursor 和输入输出

所有 public Run cursor 都以 UTF-8 byte 为单位，并在名字中显式带 `Byte` 或 `Bytes`：

- `latestOutputBytes`
- `acceptedInputBytes`
- `startByte` / `endByte`
- `requestedAfterByte` / `firstAvailableByte`
- `acceptedThroughByte` / `acknowledgedThroughByte`
- `outputCursorBytes`

调用方不能把 JavaScript 字符数、终端列数或 wire sequence 混入这些字段。Kernel 私有 sequence 只允许在 Adapter 内映射。

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

AgentMux 持有 Provider Catalog、能力探测、Launch/Resume Intent、Agent Session、ACP、Hook、Permission、Evidence 和 Client 投影。新增 Agent 只新增 Provider/Integration，不修改 Run 生命周期。每个 Provider 必须显式声明 Reply correlation；当前五个内置 Provider 都是 `none`，因为现有 Hook 没有稳定 Turn ID，不能拿时间邻近或 Assistant 文本冒充关联证据。

Run Kernel 持有 Local/SSH 的 PTY、Process、Ordered I/O、Replay、Gap、Backpressure、Attachment、Resize、Signal 和 Stop。最终只有 `ctxmux` 实现这一层；AgentMux 不保留自建 daemon fallback，也不提供兼容 API。

Adapter 只做两件事：把 AgentMux 的 Run Intent 翻译给 Kernel，把 Kernel Run Fact 翻译成 AgentMux 自有类型。Kernel 的 Frame、Snapshot、Error、SDK Object 和连接状态不能穿过 Adapter。

CLI、SDK 与 Desktop 共用同一 Agent Session Resolver、View Resolver 和操作合同。调用方可以用 `agentSessionId` 对不同 Provider 统一执行 list、status、send、interrupt、attach、resume 与 stop，也可以将它唯一解析成当前 View 后执行 Desktop `switch`；Raw Terminal 则直接使用 runtime-issued Terminal/View ID。Resolver 先核对 Agent Session、Provider capability 和 exact current RunRef，再把纯 Run 动作交给 Adapter；`switch` 只交给 typed Desktop control，不进入 Adapter。Provider native ID、ACP handle 或 RunRef 的反查也只能返回 AgentMux 身份，不得让 ctxmux 持有 Agent 索引，或让 CLI/Renderer 另建一份映射。某个 Provider 不支持某项语义动作时返回明确 unsupported，而 unknown、ambiguous、stale、not-open 的 switch 目标失败关闭，不能降级成字符串注入、隐式 Open/Attach/Resume、猜测最近 View 或旧 CLI 路径。

## 6. 持久化与资源边界

`AgentMuxAgentSessionStore` 只保存有界 Agent Session：Provider 身份、Workspace、当前 Run Ref、必要 Output Cursor、Native Handle、Hook binding、最后一份 Hook Receipt，以及最多 16 个 retired exact Run tombstone。Tombstone 只防止自然退出的旧 Agent Run 在 Resume 后被当作 Raw Terminal 或 current binding；它不保存 PID、PTY、Terminal Snapshot、Replay、Activity 列表或第三方 wire state。

默认 File Store 是 CLI 与 Desktop 共用的唯一身份文件，使用 `0600` 原子替换与进程间锁；Memory Store 只用于显式嵌入和测试。加载器最多保留 256 个 Agent Session。Run、Attachment、Replay、Client Queue、Hook Body 和日志都必须有硬上限；释放 Attachment、关闭 View 和停止 Run 后要有确定性的资源释放证据。

## 7. 当前验证面

- Runtime 投影测试验证 Run、Agent Session 与 View 身份独立，同一 Agent Session 可生成多个 View。
- Registry 测试验证 Agent Session 换 Run 后，迟到旧 Run 写入会被拒绝。
- packed Client 集成测试已验证 CtxMux Run 的 Reattach、exact RunRef Release、retained Attachment 存在时的第二 View byte replay、Resize、Interrupt 和 Stop，以及 Codex create、Hook/Permission、native-id 反查、跨 Client reconnect、CLI send/interrupt/attach、provider-native Resume 和 Stop。
- Desktop attachment broker 测试验证并发 View 只建立一个 retained Core Attachment，每个 View 获得独立 lease，释放非末位 lease 不影响其他 View。
- Runtime configuration transaction 测试验证 changed Host 从 prepare 到 commit 期间拒绝新 Launch，并在既有 lifecycle/Attachment tail 收敛后才允许替换 Client。
- View Resolver 与 Desktop 测试验证只聚焦当前已打开的 Terminal View 或唯一 Agent View；closed、stale、ambiguous 目标不改变布局，也不调用任何 Run lifecycle API。
- Core 与 Desktop 类型检查验证 daemon wire 不再进入 Desktop 的共享合同。

T-020 的 Local implementation candidate 已固定并消费 CtxMux `2e32a9d`，删除旧 Run Kernel，并完成 Codex、统一 CLI 与 typed View focus。Tracker 完成仍以 independent review 与 exact clean-checkpoint `pnpm check` 为准，不能从局部测试外推。
