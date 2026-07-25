# AgentMux Run 与 Agent Session 领域模型

状态：长期领域合同；已同步 Desktop Composition 纵切

这份文档只说明长期成立的对象边界。`ctxmux` 已是唯一 Local Run Kernel，独占 PTY、进程和有序输入输出；AgentMux 的公共调用方只看到本文定义的领域对象，不接触 ctxmux wire、Electron IPC 或第三方 SDK 类型。

## 1. 四个对象不是四种叫法

| 对象 | 身份 | 持有的事实 | 明确不持有 |
| --- | --- | --- | --- |
| Run | CtxMux `runId` | 物理进程、工作目录、尺寸、UTF-8 byte cursor、退出事实 | 模型上下文、UI 布局 |
| Agent Session | `agentSessionId` | Provider、Workspace 关联、当前 Run 引用、Native Handle、Hook Receipt | PTY、Replay、进程所有权 |
| Attachment | 当前 Client 对一个 Run 的附着 | 有界 Replay、Gap、增量输出和控制入口 | Run 生命周期、Agent 上下文 |
| View | `viewId` | 一个 Consumer 对 Run 或 Agent Session 的展示投影 | 领域真相、进程或订阅所有权 |

`viewId`、`agentSessionId` 和 `runId` 必须属于不同身份空间。一个 Agent Session 可以同时投影到多个 View；View 关闭后再打开，不会创建或恢复模型上下文。同一 Desktop Client 的多个 View 共享 exact Run 的一个 retained Core Attachment，每个 View 只持有 Desktop-issued lease 与自己的 Replay 起点；最后一份 lease 释放时才释放底层 Attachment。多个 View 的 Output acknowledgement 只能单调推进 Agent Session cursor，较慢 View 的迟到 acknowledgement 不能把 cursor 回退。一个 Run 也可以先释放 Attachment，再由同一或另一个 Client 重新 Attach。

`AgentMuxRuntimeProjection` 与 `AgentMuxRuntimeSubject` 只是 Core 对 Run 和 Agent Session 的
宿主中立快照，不是 View，也没有 Pane/Tab/焦点语义。真实 View 类型定义在 Composition 域，
由具体 Client 从自己的展示状态构造；Core 不保存第二份 View Registry。

Raw Terminal 只有 Run，没有 Agent Session。Agent Run 必须引用恰好一个 Agent Session；两边的 Agent、Host、Workspace Path 和 exact Run ID 不一致时，投影必须失败关闭。

`agentSessionId` 是 AgentMux CLI、SDK 和 Desktop 的稳定公共主键。Provider native session ID、ACP handle 与 exact RunRef 是 AgentMux Core-owned Store 上的外部索引，不是替代主键：native session ID 必须与 Provider 身份组成查询键，RunRef 直接包含 CtxMux RunId。一个查询命中零个、多个、过期或互相冲突的绑定时必须失败关闭，不能猜测最近 Session，也不能从 Terminal 标题或输出反推身份。

Raw Terminal 的 Run 身份不伪装成 `agentSessionId`。Desktop 从 Renderer 的 Tab 与 Layout SSOT
构造当前 View 集合，再用 Core 的纯 `resolveAgentMuxView` 规则解析精确 `viewId` 或唯一
`agentSessionId`；Core 自身不拥有打开中的 View。零个、多个、过期或已关闭的 View 都失败关闭，
不能从当前焦点或列表顺序猜目标。

## 2. 六个动作必须分开

- **Reattach 原 Run**：exact Run ID 和 Agent Session ID 不变；从指定 byte cursor 获取 Replay/Gap 并建立新的 Attachment，不 Spawn。
- **Release Attachment**：按 exact RunRef 释放当前 Client 的输出附着；Desktop 的一个 View 只释放自己的 lease，最后一个 View 离开时才释放 retained Core Attachment。两者都不停止 Run、不删除 Agent Session，也不关闭其他 View。
- **Provider-native Resume**：可信 Native Handle 和 Provider Capability 同时成立时，保留 Agent Session ID，创建新的 CtxMux Run ID。
- **Respawn**：创建新的 Agent Session 和新的 Run；即使 Provider、Workspace 和 Prompt 相同，也不宣称继承模型上下文。
- **Open View**：相对唯一 caller View 或精确 View，以 `tab` 或四向 split 创建新的 View ID，引用已有 Agent Session；不创建或恢复模型上下文，也不替换 Run。
- **Focus View**：用精确 `viewId` 聚焦一个当前已打开的 Desktop View；不 Open、不 Attach、不 Resume、不 Launch，不改变 Run、Attachment 或 Agent Session 生命周期。
- **Composition Launch**：先由 Renderer 创建 owner-protected pending View，再由 Desktop 的长期 RuntimeController 创建 Agent Session/Run；成功后一起提交。Provider launch 失败、布局 owner 丢失、请求超时或 Desktop 关闭时立即回滚 View；已经晚到的 Run 必须停止。

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
`session output --follow` 对外顺序固定为 `attached → replay → live → end`。Attach 期间的 Live
事件必须等 Replay 完成后再发；Replay 已覆盖的 byte range 只发一次。

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

CLI、SDK 与 Desktop 共用 Core 的 Agent Session Resolver；空间操作则共用宿主中立的
Composition request/receipt 合同。调用方可以用 `agentSessionId` 对不同 Provider 统一执行
`session list/resolve/status/send/interrupt/output/resume/stop`。受管 Agent 通过 `context` 解析
自己的唯一 Desktop View，通过 `view open/focus` 与 `launch` 提交空间意图。Desktop Main 是唯一
外部 Composition 事务入口，Renderer 是唯一 Layout Owner；这些操作都不进入 Run Adapter。
Provider native ID、ACP handle 或 RunRef 的反查只能返回 AgentMux 身份，不得让 ctxmux 持有
Agent 索引，或让 CLI/Renderer 另建 Session Registry。unsupported、unknown、ambiguous、stale、
not-open 都失败关闭，不能降级成字符串注入、UI automation、猜测最近 View 或旧 CLI 路径。

## 6. 持久化与资源边界

`AgentMuxAgentSessionStore` 只保存有界 Agent Session：Provider 身份、Workspace、当前 Run Ref、必要 Output Cursor、Native Handle、Hook binding、最后一份 Hook Receipt，以及最多 16 个 retired exact Run tombstone。Tombstone 只防止自然退出的旧 Agent Run 在 Resume 后被当作 Raw Terminal 或 current binding；它不保存 PID、PTY、Terminal Snapshot、Replay、Activity 列表或第三方 wire state。

默认 File Store 是 CLI 与 Desktop 共用的唯一身份文件，使用 `0600` 原子替换与进程间锁；Memory Store 只用于显式嵌入和测试。加载器最多保留 256 个 Agent Session。Run、Attachment、Replay、Client Queue、Hook Body 和日志都必须有硬上限；释放 Attachment、关闭 View 和停止 Run 后要有确定性的资源释放证据。

## 7. 当前验证面

- Runtime 投影测试验证 Run、Agent Session 与 Runtime Subject 的身份独立，且投影不携带 Pane/Tab 语义。
- Registry 测试验证 Agent Session 换 Run 后，迟到旧 Run 写入会被拒绝。
- packed Client 集成测试已验证 CtxMux Run 的 Reattach、exact RunRef Release、retained Attachment 存在时的第二 View byte replay、Resize、Interrupt 和 Stop，以及 Codex create、Hook/Permission、native-id 反查、跨 Client reconnect、分组 CLI、provider-native Resume 和 Stop。
- Desktop attachment broker 测试验证并发 View 只建立一个 retained Core Attachment，每个 View 获得独立 lease，释放非末位 lease 不影响其他 View。
- Runtime configuration transaction 测试验证 changed Host 从 prepare 到 commit 期间拒绝新 Launch，并在既有 lifecycle/Attachment tail 收敛后才允许替换 Client。
- Core Composition Control 测试验证单一版本化 endpoint、receipt、closed/unavailable 错误；Desktop owner 测试验证 context、Tab、四向 split、精确 focus、歧义、launch 与 owner-loss rollback。
- checkout-external packed consumer 从真实打包 CLI 验证受管 caller、context/launch/open/focus、版本化 JSON receipt、option-looking prompt、JSON Lines output 与已删除 flat 命令面。
- Core 与 Desktop 类型检查验证 daemon wire 不再进入 Desktop 的共享合同。

当前 Local implementation candidate 固定消费 CtxMux `f89dabe`，删除旧 Run Kernel，并完成
Codex、分组 Session CLI、Local Desktop Composition、Workbench 布局持久化与 View move/close。
多 Desktop、Remote/SSH 和 headless Composition Owner 仍未交付，不能从 Local 证明外推。
