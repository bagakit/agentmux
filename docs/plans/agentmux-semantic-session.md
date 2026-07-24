# AgentMux Semantic Session 设计

状态：T-004 实现基线

## 1. 边界

AgentMux 把一次 Agent 工作拆成两个有意不同的对象：

- **Daemon Run**：`sessionId + incarnationId`，只证明 PTY、进程、输入输出、尺寸和退出事实；
- **Semantic Session**：`semanticSessionId`，保存 Agent、Workspace、Daemon Run 引用、必要 Output Cursor、Provider/ACP Native Handle 和最后一份 Hook Receipt。

两者不能互相冒充。Terminal Replay 只能恢复可见终端，不能证明模型上下文连续；Native Hook 或 ACP 提供的 Session Handle 才能成为 Provider-native Resume 的依据。

公共事件固定携带下列 Evidence Source：

| Source | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| `terminal-output` | Daemon 收到了哪些有序字节 | Tool、Permission、模型思考 |
| `daemon-process` | 进程退出及对应 Incarnation | Agent 已完成语义任务 |
| `native-hook` | Provider 原生 Hook 报告的状态、活动和 Handle | 没有 Hook 的历史活动 |
| `acp` | ACP Adapter 报告的结构化事件和 Session | 终端进程仍存活 |
| `user` | 用户提交、Interrupt 等明确动作 | Agent 已处理动作 |

Raw Terminal 没有 `semanticSessionId`，也不会生成 Agent Activity。

## 2. Catalog 与 Provider

每个 Provider 同时声明：

- executable 与 expected process；
- Prompt Delivery 与 Ready Signal；
- Native Hook、Provider Resume、ACP 和 Permission Capability；
- Launch Plan、Resume Plan、Capability Probe 与 Hook Normalizer。

当前内置能力如下：

| Agent | Prompt | Hook | Permission | Provider Resume | ACP |
| --- | --- | --- | --- | --- | --- |
| Codex | positional argv | native / explicit managed | observe | session id | 无 |
| Claude | positional argv | native / explicit managed | observe | session id | 无 |
| TraeX | positional argv | 无 | 无 | 无 | 无 |
| Hermes | native query + TUI | native / explicit managed | observe | 无 | 无 |
| Pi | positional argv | native / explicit managed | observe | hook-reported session file | 无 |

新增 Agent 只增加 Provider/Integration；Hook 的事件规则和 Native Handle 提取也属于 Provider，不再修改全局 `switch(agentId)`。

Capability Probe 由实际 Execution Host 的 Daemon 执行。因此 SSH Client 不会拿本机的 `PATH` 误判远端 Agent 是否可用。

## 3. 三种恢复动作

- **Reattach**：Semantic ID、Daemon Session ID 和 Incarnation 全部不变，只从已确认 Cursor Attach；不存在时不 Spawn。
- **Provider-native Resume**：必须已有匹配 Provider 的 Native Handle；Semantic ID 保持不变，新建 Daemon Run 和 Incarnation。
- **Respawn**：明确创建新 Semantic ID 和新 Daemon Run；即使 Agent、Workspace 和 Prompt 相同，也不宣称继承模型上下文。

原 Daemon Run 仍在 `running` 时禁止 Resume，避免一个 Semantic Session 同时驱动两个物理 Agent。

## 4. Hook 传输与安装

每个 `agentmuxd` 在所在 Host 的 `127.0.0.1` 启动带随机 Bearer Token 的 Hook Ingress，并把 URL、Token、Semantic ID、Daemon Session ID 和 Incarnation 注入 Agent 环境。Daemon 只校验并转发完全匹配的原始 Hook；Provider 在 Client 侧归一化语义。伪造或迟到 Incarnation 的 Hook 会被静默丢弃，观察失败不阻断 Agent。

全局 Agent 配置不自动修改。`AgentManagedHookInstaller` 只能经过 `preview -> install` 两步显式调用：

- Preview 固定目标文件当前 Hash 与下一版 Hash；
- Install 前再次检查 Generation，避免覆盖用户刚保存的配置；
- 被替换内容备份到 AgentMux State Directory，Receipt 记录恢复所需 Hash、Mode 和 Backup；
- Uninstall 只在目标仍等于已安装版本时恢复，用户安装后自行编辑则 Fail Closed。

Provider-specific 配置合并由对应 Integration 生成 Mutation Plan，通用 Installer 不猜测 Claude/Codex/Pi/Hermes 的私有配置结构。

## 5. ACP 与 Permission

T-004 没有把某个 ACP SDK 变成公共类型，也没有手写 JSON-RPC Framing。Core 提供 AgentMux 自有的 `AgentMuxAcpBinding` 边界，具体 SDK/Process Adapter 留在 Integration 内部。

实施时核验了 `@agentclientprotocol/sdk@1.3.0`：Apache-2.0、2026-07-21 发布、解包约 5.3 MB，并带 `zod` Peer Dependency。当前五个内置 Agent 都不使用 ACP，直接引入只会增加包体、依赖面和空闲代码，因此本 Task 不采用。未来第一个真实 ACP Integration 采用 SDK 时必须精确锁版本，并在 Adapter 内完成类型翻译。

ACP Permission 只有显式且属于当前 Options 的选择才会转发。Handler 缺失、抛错、返回 `undefined`、30 秒内没有返回或返回未知 Option 时，Core 选择 Provider 提供的 Reject Option；若没有 Reject Option，则返回 Cancelled。拒绝响应本身无法送达时关闭 ACP Binding，不存在默认允许或无界等待路径。

## 6. 持久化与资源

`AgentMuxSemanticStore` 是可注入边界。Core 在读取时重新选择并验证字段，额外的 PID、Terminal Snapshot、Replay 或 Output Bytes 不会进入运行真相。

默认 Memory Store 与加载器最多保留 256 个 Semantic Session；Hook Body、ACP Event、Provider Handle、Transcript Path 和 Managed Hook 文件都有固定字节上限。Client 不缓存 Terminal Output 或 Activity 列表，终端历史继续由 Daemon 有界 Replay 和上层 xterm 投影负责。

创建 Agent 后若 Store 写入失败，Client 会停止刚创建的 Daemon Run；若停止也失败，则用 `AggregateError` 同时暴露主失败和清理失败，不留下伪造的成功 Session。
