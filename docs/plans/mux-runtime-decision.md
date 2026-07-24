# AgentMux mux Runtime 架构决策

状态：已确认
Feature：`f-2238fbdxh`
Task：`T-006`
确认日期：2026-08-10（Asia/Shanghai）

## 1. 决策

AgentMux 的长期唯一 mux Runtime 是 **Local/SSH 统一的持久 AgentMux Session Daemon**。

Daemon 持有 PTY 和进程，桌面 App、CLI 与其他宿主只是 Client。关闭桌面 App、Renderer/Main 崩溃或 SSH 网络暂时中断，都不能自动结束仍在运行的 Agent Session；Client 重连后必须 Attach 同一个 Session，并从有界 Replay 恢复可观察输出。

```text
Desktop / CLI / future client
              │
              ▼
      @agentmux/core Client API
              │
      Local socket / long-lived SSH transport
              │
              ▼
      AgentMux Session Daemon
      ├─ stable session identity
      ├─ PTY / process owner
      ├─ ordered input and output
      ├─ bounded replay / backpressure
      ├─ resize / signal / stop
      └─ attach / detach / recovery
              │
              ▼
           node-pty
```

Local 与 SSH 使用同一份 Session 合同。SSH Host 允许显式安装和升级轻量 AgentMux 远端组件；连接继续使用系统 SSH 与用户现有认证，不复制或保存 Private Key。

这个决定取代仓库中此前“`ctxmux` 作为唯一 Run Kernel”的提案。最终产品不保留 tmux、ctxmux、Main-owned PTY 或 Hybrid Runtime 作为兼容层、Fallback 或可选 Backend。

本 Task 只确认长期所有权和实施边界，不修改 mux 代码、配置或公共 API。真正替换由后续 `AgentMux Core Maturity` Feature 执行。

## 2. 为什么现在必须决定

当前真实链路是：

```text
Desktop Renderer
  -> Typed Preload IPC
  -> RuntimeController
  -> AgentMuxRuntime
  -> TmuxClient
  -> LocalExecutionHost | SshExecutionHost
  -> tmux command
```

它已经证明了 Local/SSH Agent 的启动、发现、输入、Resize、Capture、停止和恢复，也暴露了长期上限：

- tmux Server 是实际 PTY/Process Owner；Core 通过 Session Environment 恢复身份。
- 输入使用 `load-buffer -> paste-buffer -> Enter`，每个输入片段会启动多个 tmux 命令。
- 输出由 Runtime 定时 `inspect + capture-pane`，得到的是屏幕 Snapshot，不是带 Sequence 的持续字节流。
- Resize、Signal、Inspect 和 Stop 都是外部命令；SSH 延迟会直接叠加在交互路径上。
- Production T-024 的本地零间隔 44-key Burst 到真实 Snapshot 约为 4246ms。这个数据只证明当前本地路径的结构性上限，不外推为 SSH Benchmark。

因此，问题不是“tmux 能不能用”，而是 AgentMux 是否只做一个 tmux 控制器，还是成为其他宿主也能安全嵌入的 Agent Runtime。用户确认选择后者。

## 3. 源码证据与候选比较

a mature workbench 的成熟模式不是简单把 `node-pty` 塞进 Electron。它把 Session Owner 建成稳定边界：

- `spawn / attach` 明确区分创建和只附着，目标不存在时不能偷偷新建 Shell；
- 每个物理进程拥有 Incarnation，迟到 Exit 不能污染复用后的 Session ID；
- 输出采用增量 Data、Sequence、Snapshot、Replay、Ack 与 Producer Backpressure；
- Resize 可以读回实际尺寸，断线后能够校正尺寸漂移；
- Stop 区分 graceful 与 force，并清理 Agent 的后代进程；
- SSH 持久化依赖远端 Session Owner、认证租约、版本身份、Multiplexing、Flow Control 与恢复记录，不是简单 `ssh -tt`。

这些事实由 `docs/a mature workbench-agent-runtime-notes.md` 固定 a mature workbench Commit 和源码位置；当前 AgentMux 的所有权由 `packages/core/src/runtime.ts`、`daemon-session-manager.ts`、`client.ts`、`execution-host.ts` 及对应测试证明。

| 候选 | 进程持有与持久化 | Local / SSH | 输入输出与监听 | 主要代价 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 继续真实 tmux | tmux Server 持有；App 退出和 SSH 断线后可继续 | 两端同构，但每次操作都是命令 | paste/capture/poll；恢复成熟，流式保真和延迟受限 | Core 长期泄漏 tmux 语义，难以提供 Sequence、Replay 与背压合同 | 不选 |
| Main-owned `node-pty` | Electron Main 持有；App 退出即丢失 Session | Local 简单；SSH 断线后没有持久 Owner | 原生字节流、低延迟 | 无法满足已确认的退出/断线恢复不变量 | 不选 |
| AgentMux Session Daemon | 独立 Daemon 持有；Client 可退出和重连 | Local/SSH 共用合同；SSH 需远端组件 | 持续字节流、Sequence、Replay、背压和事件 | AgentMux 必须负责协议、安全、发布、升级、资源边界与故障恢复 | **已选择** |
| `ctxmux` Run Kernel | `ctxmuxd` 持有；本地已有部分通用能力 | 远端、发布和若干恢复能力仍是外部能力门槛 | 通用 Run 字节流和 Replay | AgentMux 的核心交付受另一项目的能力、版本与发布边界控制；用户明确选择 AgentMux 自有 Owner | 被本决策取代 |
| 长期 Hybrid | 多个 Owner 各自持有 | 场景分叉 | 两套恢复、错误和测试语义 | 配置面、状态真相和维护组合数长期翻倍 | 禁止 |

## 4. 所有权边界

| 能力 | AgentMux Core / Integration | AgentMux Session Daemon | Desktop / Client |
| --- | --- | --- | --- |
| Agent Catalog、Provider、Launch Plan、Prompt Strategy | 权威 | 执行已确认的启动计划 | 提交意图并展示能力 |
| Semantic Session、ACP、Hook、Permission、Resume | 权威 | 传输关联所需的稳定身份，不解释 Agent 语义 | 展示并显式响应 |
| PTY、进程树、运行状态 | 投影统一领域事件 | 权威 | 不直接 Spawn 或 Kill |
| Ordered Output、Sequence、Bounded Replay、Gap、Backpressure | 定义公共语义并映射 | 持有原始事实并执行流控 | 按 Cursor 消费，不自建轮询真相 |
| Input、Resize、Signal、Stop、Attach/Detach | 发出类型安全请求 | 执行、确认并保证幂等边界 | 只调用公共 API |
| Workspace、Editor、Board、Pane 与 Tab | 提供 Session/Workspace 关联 | 不拥有产品布局 | 权威 UI 投影 |

Terminal Output、Process Liveness 与 Agent Semantic Event 必须保留来源差异。PTY 可证明“进程输出了什么”，不能伪造 Tool Call、Permission、模型私有 Chain-of-thought 或 Provider-native Session 恢复。

`packages/core` 继续不得依赖 Electron 或 React。Daemon 是 AgentMux 的 Headless Runtime Owner；具体 package/entrypoint 形态由后续 Feature 在依赖审计后一次确定，不先建立临时包装层。

## 5. 持久化合同

已确认的硬不变量：

- Desktop 完全退出后，仍在运行的 Local Session 继续运行；重开只 Attach，不重复 Spawn。
- Renderer 或 Electron Main 崩溃不能自动结束 Daemon Session。
- SSH 网络中断后，远端 Session 继续运行；重连必须验证 Host、协议版本、Session 与 Incarnation 后再 Attach。
- 丢失 Create Response 时，`createOperationId` 必须收敛到一个进程，不能用盲目重试复制 Agent。
- 同一 `sessionId` 的新进程拥有新 `incarnationId`；旧进程的迟到 Data/Exit 不得改变新 Session。
- Output Replay 必须有明确预算。超出窗口时报告 Gap/Truncated，并走明确的屏幕重建或不完整状态，不能把残缺输出伪装成完整终端。

Daemon 自身崩溃、主机重启和模型私有上下文恢复是不同问题。后续 Feature 必须分别定义并验证：

- Daemon 崩溃后 Session 是由可重连 Worker 继续持有，还是诚实进入 `lost`；不得无证据宣称恢复。
- 主机重启后是否恢复 OS Process、Provider-native Session 或只恢复历史元数据；这些状态不能混为同一个“running”。
- 只有 ACP Handle 或 Provider-native Resume 能证明模型上下文连续；终端 Replay 不能代替它。

## 6. 后续实施边界

后续 `AgentMux Core Maturity` Feature 按可运行 Vertical Slice 推进，但最终只交付一条 Runtime：

1. 冻结最小 Session/Transport 合同与 Contract Tests：create/attach、write、resize、signal、stop、incremental data、exit、bounded replay、applied size。
2. 建立 `sessionId + incarnationId + createOperationId`，先解决重复创建、迟到事件和 Attach-only 的事务语义。
3. 使用维护中的 `node-pty` 跑通 Local Daemon Vertical Slice；Daemon 与 Desktop 生命周期分离。
4. 接入 Desktop 与干净外部 Consumer，所有 Agent/Terminal 生命周期只经过 `packages/core` 公共 API。
5. 通过系统 SSH 建立长期 Transport，显式安装/启动版本匹配的 Remote Daemon；不复制 Private Key，不静默联网下载。
6. Local/SSH Gate、故障恢复、安全、资源与发布 Gate 全部通过后，直接删除 `TmuxClient`、tmux Environment Discovery、Capture Polling 与 tmux-only 类型和测试。
7. ACP、Native Hook 与 Provider Resume 作为独立 Semantic Backend 推进，不下沉到 PTY Daemon。

实现期间可以在 Feature 工作树中逐步形成竖切，但产品与公共配置不得暴露双 Runtime。不存在 Session Migration、Compatibility Alias 或 tmux Fallback；切换后旧 tmux Session 不会被伪装成 Daemon Session。

## 7. 后续验收条件

- 1000 个有序 Input Chunk 不丢失、不重排；失败重试不重复已确认输入。
- Output Sequence 单调，Replay 有界，Gap 可见；慢 Client 不导致 Daemon 或 Client 无界增长。
- Resize 可读回 Applied Size；断连重连后能检测并修正尺寸漂移。
- Desktop 退出、Main/Renderer Crash、SSH Partition 与 Lost Create Response 均不重复 Spawn。
- Stop 先 graceful、后 force，并证明 Shell、Agent、MCP 与工具后代没有成为孤儿进程。
- Local Endpoint 只允许当前用户访问；Remote Transport 使用系统 SSH、版本匹配与认证，不暴露未授权监听端口。
- Daemon、每 Session、Replay 与 Client Buffer 都有可重复的 RSS/CPU 基线和硬上限；关闭 Session/Client 后资源确定性释放。
- 不为每个 Tab 或 Pane 启动 Daemon；每个 Execution Host 复用一个轻量 Owner，按实际 Session 惰性分配资源。
- `pnpm pack` 可在干净外部 Consumer 中安装并运行最小 Local/SSH 示例，不依赖 Electron、React 或开发仓库路径。
- 最终仓库不存在 ctxmux/tmux Runtime、公共别名、Migration、Fallback Route 或隐藏双 Owner。

## 8. 非目标

- 本 T-006 不实施 mux 替换，也不安装远端组件、修改 SSH Credential 或用户全局 Agent Hook。
- 不复制 a mature workbench Account、Mobile、AI Vault、WSL、Emulator、Hosted Issue Integration 或历史兼容代码。
- 不把 AHP、ACP、tmux、ctxmux 或某个 Agent CLI 的 State Shape 作为 AgentMux Core Domain。
- 不用 Terminal Replay 冒充 Provider-native Resume 或模型私有上下文恢复。
- 不为尚未出现的 Transport、平台或多租户场景建立预防性插件层。

## 9. 用户确认

- 选择：Local/SSH 统一的持久 AgentMux Session Daemon。
- 硬要求：App 完全退出、UI 崩溃或 SSH 网络中断后，Agent Session 继续运行并可恢复。
- 接受的代价：SSH Host 显式安装和升级轻量 AgentMux 远端组件。
- 排除：Main-owned 非持久 PTY、继续真实 tmux、`ctxmux` 唯一 Kernel、长期 Hybrid 或任何 Fallback。
- 用户确认：2026-08-10，回复“1”。
