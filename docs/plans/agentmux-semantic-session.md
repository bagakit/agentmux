# AgentMux Run 与 Agent Session 领域模型

状态：T-011 领域合同

这份文档只说明长期成立的对象边界。当前仓库中的自建 `agentmuxd` 是待删除的过渡 Run Kernel；最终由 `ctxmux` 独占 PTY、进程和有序输入输出。无论底层 Kernel 如何实现，AgentMux 的公共调用方只看到本文定义的领域对象，不接触 daemon/ctxmux wire、Electron IPC 或第三方 SDK 类型。

## 1. 四个对象不是四种叫法

| 对象 | 身份 | 持有的事实 | 明确不持有 |
| --- | --- | --- | --- |
| Run | `runId + incarnationId` | 物理进程、工作目录、尺寸、UTF-8 byte cursor、退出事实 | 模型上下文、UI 布局 |
| Agent Session | `agentSessionId` | Provider、Workspace 关联、当前 Run 引用、Native Handle、Hook Receipt | PTY、Replay、进程所有权 |
| Attachment | 当前 Client 对一个 Run incarnation 的附着 | 有界 Replay、Gap、增量输出和控制入口 | Run 生命周期、Agent 上下文 |
| View | `viewId` | 一个 Consumer 对 Run 或 Agent Session 的展示投影 | 领域真相、进程或订阅所有权 |

`viewId`、`agentSessionId` 和 `runId` 必须属于不同身份空间。一个 Agent Session 可以同时投影到多个 View；View 关闭后再打开，不会创建或恢复模型上下文。一个 Run incarnation 也可以先释放 Attachment，再由同一或另一个 Client 重新 Attach。

Raw Terminal 只有 Run，没有 Agent Session。Agent Run 必须引用恰好一个 Agent Session；两边的 Agent、Host、Workspace Path、Run ID 和 Incarnation 不一致时，投影必须失败关闭。

## 2. 五个动作必须分开

- **Reattach 原 Run**：Run ID、Incarnation 和 Agent Session ID 全部不变；从指定 byte cursor 获取 Replay/Gap 并建立新的 Attachment，不 Spawn。
- **Release Attachment**：只释放当前 Client 的输出附着；不停止 Run，不删除 Agent Session，也不关闭其他 View。
- **Provider-native Resume**：可信 Native Handle 和 Provider Capability 同时成立时，保留 Agent Session ID，创建新的 Run ID 与 Incarnation。
- **Respawn**：创建新的 Agent Session 和新的 Run；即使 Provider、Workspace 和 Prompt 相同，也不宣称继承模型上下文。
- **Open View**：创建新的 View ID，引用已有 Run 或 Agent Session；不创建进程、不 Attach 输出，也不改变 Agent Session。

原 Run 仍为 `running` 时禁止 provider-native Resume，避免一个 Agent Session 同时驱动两个物理 Agent。迟到的旧 Incarnation 事件只能作为旧 Run 事实处理，不能更新已经指向新 Run 的 Agent Session。

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

## 6. 持久化与资源边界

`AgentMuxAgentSessionStore` 只保存有界 Agent Session：Provider 身份、Workspace、当前 Run Ref、必要 Output Cursor、Native Handle 和最后一份 Hook Receipt。它不保存 PID、PTY、Terminal Snapshot、Replay、Activity 列表或第三方 wire state。

默认 Memory Store 与加载器最多保留 256 个 Agent Session。Run、Attachment、Replay、Client Queue、Hook Body 和日志都必须有硬上限；释放 Attachment、关闭 View 和停止 Run 后要有确定性的资源释放证据。

## 7. 当前验证面

- Runtime 投影测试验证 Run、Agent Session 与 View 身份独立，同一 Agent Session 可生成多个 View。
- Registry 测试验证 Agent Session 换 Run 后，迟到旧 Run 写入会被拒绝。
- Client 集成测试验证 Reattach、Release Attachment、Provider Resume 和 Respawn 是不同动作，并验证同步/异步 Consumer 订阅者异常不会破坏其他 Listener 或 Run 控制。
- Core 与 Desktop 类型检查验证 daemon wire 不再进入 Desktop 的共享合同。

T-012 收口 Provider/ACP/Hook/Permission/Resume 后，T-013 将现有可靠性资产提炼成 Kernel-neutral Conformance Kit；只有 ctxmux 能力审计通过后，T-016 才执行最终 Kernel 替换并删除自建 daemon。
