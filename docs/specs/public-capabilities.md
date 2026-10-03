# 公共能力来源导航

本文按当前已提交源码帮助包消费者、CLI 维护者与客户端开发者定位公共入口、类型定义和消费链。它是一张来源地图；准确签名、参数、错误和导出范围由源码与 package exports 持有，不在这里维护第二份 API 或命令词典。源码合同、工作树、安装与运行事实分别核对；系统分工先读 [系统分层与事实归属](../architecture/system-ownership.md)。

新增功能的作者先按[公共能力贡献约定](../guides/public-capability-contributions.md)判断 RPC／CLI 影响，再用本页找到原定义与实际消费入口。

## 选择接入入口

| 读者要做什么 | 从这里开始 | 继续核对 |
| --- | --- | --- |
| 在 Node 宿主接入本地 Agent／Terminal | [Core 接入说明](../../packages/core/README.md)，从 `@agentmux/core` 导入 `connectLocalAgentMux` 或 `AgentMuxClient` | [runtime-client.ts](../../packages/core/src/runtime-client.ts)、[client.ts](../../packages/core/src/client.ts) |
| 提供共享业务服务，或连接已运行的服务 owner | [公共 RPC 类型](../../packages/core/src/public-rpc.ts) 与 [`AgentMuxRpcServiceOptions`](../../packages/core/src/public-rpc-service.ts) | [`AgentMuxControlServer`](../../packages/core/src/public-rpc-server.ts)、[`connectAgentMuxRpc`](../../packages/core/src/public-rpc-client.ts)；经 [control-host.ts](../../packages/core/src/control-host.ts) 从包根导出 |
| 无 UI 管理本机或远端语义 Runtime | [Core 远程接入](../../packages/core/README.md#远程-runtime)、[`connectHostedAgentMux`](../../packages/core/src/hosted-client.ts) 与 [`connectSshAgentMux`](../../packages/core/src/runtime-client.ts) | [唯一 Hosted 合同](../../packages/core/src/hosted-client-contract.ts)、[Headless owner](../../packages/core/src/headless-runtime.ts)、[Desktop Host connector](../../apps/desktop/src/main/desktop-host.ts) |
| 在浏览器投影执行事实或 Session Timeline | Core [package exports](../../packages/core/package.json) 中的 `runtime`、`timeline` 等专项入口 | [runtime.ts](../../packages/core/src/runtime.ts)、[session-timeline.ts](../../packages/core/src/session-timeline.ts)；不导入加载 Node Runtime 的包根 |
| 在 React 客户端复用 Conversation／Composer 呈现 | [共享 UI 包说明](../../packages/client-ui/README.md)，从 `@agentmux/client-ui` 或已导出的 component 子路径导入 | [package exports](../../packages/client-ui/package.json)、[index.ts](../../packages/client-ui/src/index.ts)、[`ClientUiProvider` / `ClientUiPlatform`](../../packages/client-ui/src/platform.tsx)；宿主显式注入平台与业务 props |
| 复用分屏树计算 | [Layout 包说明](../../packages/layout/README.md)，只从 `@agentmux/layout` 入口导入 | [package exports](../../packages/layout/package.json)、[index.ts](../../packages/layout/src/index.ts)；当前源 TS 入口需要可转译 TS 的宿主 |
| 使用独立 Goal／Demand Store，或浏览器侧 Goal 规则 | [Demand 包说明](../../packages/demand/README.md)，`openDemandStore` / `@agentmux/demand/goals` | [package exports](../../packages/demand/package.json)、[demand-store.ts](../../packages/demand/src/demand-store.ts)、[goals.ts](../../packages/demand/src/goals.ts) |
| 用 AgentMux CLI 操作原工作面 | 当前执行版本的 `--help` / `--skill`；[对象操作指南](../guides/agentmux-cli-object-control.md) 给任务入口和失败处理 | [命令注册与 parser](../../packages/core/src/agentmux-cli-commands.ts)、[help / skill 来源](../../packages/core/src/agentmux-cli-help.ts)、[CLI 接线](../../packages/core/src/agentmux.ts) |

[Core package exports](../../packages/core/package.json) 决定可导入子路径；[index.ts](../../packages/core/src/index.ts) 决定包根重导出。出现在 exports 中只证明当前包入口，不单独证明接口成熟度、稳定性或运行验收。包内实现文件链接用于阅读源码，不授权消费者绕开公共入口深入导入。

`client-ui` 的 [exports](../../packages/client-ui/package.json) 为浏览器 bundler 提供源 TS，为 Node import 提供 ESM 产物；宿主按包说明加载样式及主题。Main 只需图片规则或路径识别时，使用 `pasted-images`／`terminal-path-link` 等纯叶入口，避免加载 React／Tiptap／DOM。UI 包消费 Core 的类型与纯公开子路径，Core 不增加 UI 依赖；共享组件并不持有 Agent 或 Run 事实。

## 按能力找到定义与消费者

下表列代表入口，完整类型与实现仍由来源文件定义。读到一个 symbol 后，应沿实际消费者核对它怎样接到产品，而不是以声明存在认定能力交付。

| 能力与当前 owner | 定义入口 | 第一方消费链 |
| --- | --- | --- |
| 连接、Provider 发现和扩展 | [`connectLocalAgentMux`](../../packages/core/src/runtime-client.ts)、[`AgentProvider` / `defineAgentProvider` / `AgentProviderRegistry`](../../packages/core/src/agent-provider.ts) | [Desktop RuntimeController](../../apps/desktop/src/main/runtime-controller.ts) 的 `prepareHost` 与探测／启动入口 |
| 创建、接回、语义恢复与停止 AgentSession | [`AgentMuxClient`](../../packages/core/src/client.ts) 的 `createAgentWithDelivery`、`reattachAgent`、`ensureAgentContinuity`、`resumeAgent`、`stopAgent` | [Desktop IPC](../../apps/desktop/src/main/ipc.ts) → [RuntimeController](../../apps/desktop/src/main/runtime-controller.ts) |
| Terminal 输入、Attachment 与 Replay | `AgentMuxClient` 的 `createTerminal`、`attachTerminal`、`readRunReplay`、`writeTerminal`；[相关类型](../../packages/core/src/types.ts) | RuntimeController 的 attach／replay／input 入口；字节到画面见 [Terminal Runtime](../architecture/terminal-runtime.md) |
| Prompt、权限／问题与 Agent 状态 | `submitAgentPrompt`、`respondAgentInteraction`、`statusAgent`；[结构化交互判断](../../packages/core/src/agent-interaction-state.ts)、[Prompt condition](../../packages/core/src/agent-prompt-condition.ts) | RuntimeController 与 Desktop IPC 的 Session 操作；client 读取 typed facts，不拼厂商按键 |
| Native asynchronous questions and exact answers | `AgentMuxClient.replySessionQuestion` and [history question types](../../packages/core/src/types.ts); the Provider owns native wire interpretation | Existing `sessionHistoryPage` / `agent history` read facts, public RPC / `agent question reply` submit ordinary user input; `submitted` is not an observed answer and does not create Hook waiting |
| 单次 Prompt 的执行意图与原生准备 | [公共 Prompt／Message input](../../packages/core/src/client.ts)、[execution 与 Provider plan 类型](../../packages/core/src/types.ts)、[Provider 接口](../../packages/core/src/agent-provider.ts) | [CLI 注册](../../packages/core/src/agentmux-cli-commands.ts) → 公共 RPC／原 message owner；Desktop Store → IPC → RuntimeController → Core [Prompt admission](../../packages/core/src/prompt-submission.ts)；原生差异由 Provider 解释 |
| Client 原待发草稿的查询、编辑和明确发送 | [公共 RPC](../../packages/core/src/public-rpc.ts)引用的 [pending 控制类型](../../packages/core/src/control.ts)、[严格解析](../../packages/core/src/control-codec.ts) | `message pending` CLI → 公共服务 → 原 Client [Store](../../apps/desktop/src/renderer/src/store.ts) 与 [Composer](../../apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx)共用队列；它与 Core 的消息 envelope journal 分属原 owner，正文修改／发送需要可信用户或设备来源，managed Agent 不能冒充用户改写草稿 |
| Session 身份、历史与事件 | [Session Registry](../../packages/core/src/agent-session-registry.ts)、[Session Store](../../packages/core/src/agent-session-store.ts)；`onEvent`、`sessionTimeline`、`sessionHistoryPage`、`observeSessionHistory` | [历史观察接线](../../apps/desktop/src/main/session-history-observation.ts)、[Session snapshot](../../apps/desktop/src/main/session-snapshot-payload.ts) |
| 原 Agent 的完整可读上下文 | [agent-context.ts](../../packages/core/src/agent-context.ts)组合原 Store 与 Provider reader；[公共服务](../../packages/core/src/public-rpc-service.ts)提供 `agent.context` | `agent context --host local --session SID` 联合读取所有可用来源、完整记录和诊断，沿绑定原来源的 `nextCursor` 连续分页；接手创建复用 `agent.open`，原会话保留 |
| 共享 Conversation、结构化请求与 Composer 呈现 | [client-ui index](../../packages/client-ui/src/index.ts) 与 [platform.tsx](../../packages/client-ui/src/platform.tsx)；组件 typed props 注入文件、导航、消息和回答操作 | [DesktopClientUiProvider](../../apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx) → [Renderer main](../../apps/desktop/src/renderer/src/main.tsx)；宿主保有平台 IO、身份和工作面焦点 |
| 持久空间事实、展示导航与工作面回执 | Core 的 [spatial-state.ts](../../packages/core/src/spatial-state.ts)、[space-control.ts](../../packages/core/src/space-control.ts)与 [desktop-focus-control.ts](../../packages/core/src/desktop-focus-control.ts) | 公共服务读取／提交同一 Core 空间图；Desktop 经 Main [Control bridge](../../apps/desktop/src/main/control-ipc-bridge.ts) → Renderer [control-api.ts](../../apps/desktop/src/renderer/src/lib/control-api.ts) → [Store](../../apps/desktop/src/renderer/src/store.ts)消费原事实并操作呈现／输入，持久归属见[空间状态](../architecture/spatial-state.md) |
| 宿主配置、Browser、Toolkit 与诊断 | [公共 RPC](../../packages/core/src/public-rpc.ts) 的 typed params / result / stream；[业务服务](../../packages/core/src/public-rpc-service.ts) 委托原 owner | [Main IPC handlers](../../apps/desktop/src/main/ipc.ts)、[ConfigOwner](../../apps/desktop/src/main/config-owner.ts) 及各宿主 owner |
| Topics 分类内容、主题发现与归属转移 | [Topic 公共类型与严格 codec](../../packages/core/src/public-rpc-topics.ts)；分类内容由 [Host 内容 owner](../../apps/desktop/src/main/topic-knowledge.ts)持有，分类关系由 [Topic 空间适配器](../../apps/desktop/src/main/topic-spatial-owner.ts)提交同一 Core 图 | Main 注入 `AgentMuxRpcServiceOptions.topics`；GUI 经 trusted IPC／preload 的 `topics.call` 消费同一 owner。默认语义 Host 将 CLI 的 typed `topic` 调用经已绑定的 Desktop business transport 转发至原内容 owner，沿同一参数、调用身份与结果校验；没有本地 owner 或已绑定转发端口时如实未知。创建与转移不隐式启动 Agent |
| Goal／Demand 内容、确认与接受 | [`openDemandStore`](../../packages/demand/src/demand-store.ts)、[Goal 类型与 readiness helpers](../../packages/demand/src/goals.ts) | Main IPC 的 Demand handlers 与 Renderer Goal 操作；Agent proposal 不代替人类确认／接受 |

原 Zone 文件的已保存正文沿[文件读取类型与严格 codec](../../packages/core/src/public-rpc-files.ts)公开。`file read` CLI → 公共服务 → Main 注入的 [FileReadOwner](../../apps/desktop/src/main/file-read-owner.ts) 解析准确 Zone／资源，再委托原 [WorkspaceFiles](../../apps/desktop/src/main/workspace-files.ts)；GUI 经 trusted `files:readPublic`／preload 消费同一 owner。结果保留完整原 revision、Host／Workspace／Zone 与原读取状态；观察未知不冒文件不存在，也不另建 Memory 存储。

原日历提醒沿 [`schedule.*` 类型与严格 codec](../../packages/core/src/public-rpc-schedules.ts) 公开。真实 `schedule list|inspect|create|pause|resume|cancel` CLI、GUI trusted IPC 和公共服务消费同一 [ContinuousProgressLoopManager](../../apps/desktop/src/main/continuous-progress-loop-manager.ts) 与原持久化调度器；Core 在原 Session 提交锁下保存并准入同一未来消息，Main 只持日历资格。创建和变更按真实 caller 授权，回执带准确目标、版本、原 operation、磁盘持久化与 `connected-host` 执行范围；连着宿主才执行，不声称后台云定时。未知投递保留原 operation 并检查，不盲目重发；人工输入始终消费原 Core 通路。

可选的安静跟进沿同一 `schedule.create.checkIn` 保存[显式策略](../../packages/core/src/agent-schedule.ts)，默认不启用；只接受已鉴权用户／设备的 opt-in，Agent caller 不能冒人开启。GUI 默认安静窗口从当地日界前两小时至日界后八小时、18 小时无人工交互、20 小时最小尝试间隔及每天一次；公共参数可明确设置 5 分钟至 30 天的两个间隔和每天 1–3 次预算，检查回执显示实际保存值。只有原 Core 的完整、可信人工消息及[严格当前 Native 读取](../design/behavior/agent-capabilities-and-messaging.md)才能确认静默与新答复；分页截断、较晚未知作者输入或来源观察失败仅抑制本次自动跟进并显示原因，不消耗到期安排，不关闭手动输入。预算按持久 claim 计，最终明确跳过且未送出的尝试不冒已问出问题。原静态指令请同一 Agent 依据本会话已确认上下文只问一个具体问题；输入回执不代签模型语言质量。

输入应用、Prompt 投递、任务接受、Agent 状态和工作完成是不同事实，准确边界见 Core 接入说明与 owning 设计。初始 Prompt 的投递事实消费 `createAgentWithDelivery` 的同次返回；缺失回执不自行重启、重发或换目标。

## CLI 与服务的当前来源

[`AGENTMUX_CLI_COMMANDS`](../../packages/core/src/agentmux-cli-commands.ts) 是对象命令的共同注册来源，`parseAgentMuxCliInvocation` 从它解析参数，[help 与运行时技能](../../packages/core/src/agentmux-cli-help.ts) 从它生成说明。[agentmux.ts](../../packages/core/src/agentmux.ts) 处理 endpoint、调用与流输出，业务查询、角色绑定和消息编排进入 [`AgentMuxRpcService`](../../packages/core/src/public-rpc-service.ts)，不在 CLI 直接读写本地业务事实。公共方法、参数、结果与订阅类型归 [public-rpc.ts](../../packages/core/src/public-rpc.ts)；Main 在 [ipc.ts](../../apps/desktop/src/main/ipc.ts) 注入原 owner 的真实能力。

当前 [Server](../../packages/core/src/public-rpc-server.ts) 与 [Client](../../packages/core/src/public-rpc-client.ts) 使用同一 JSON-RPC 2.0 合同，支持默认 Unix socket、显式启用的 HTTP／SSE，以及 SSH stdio 转发到既有 Unix 服务。Hosted SDK 通过该服务管理远端 Core Session；它与 ctxmux 的原生 Remote Run 协议是不同接入层，连接条件和分层边界见 [系统接入边界](../architecture/system-ownership.md#当前接入边界)。[对象优先 CLI 与统一公共业务服务](../design/behavior/public-control.md#对象优先-cli-与统一公共业务服务) 持有行为约束；本页不复制对象树，也不以服务入口存在代签所有宿主能力或安装后的可用性。

核对能力按同一对象寻找业务类型、实际 owner、服务接线、CLI／Client 消费及验证证据；查看事实、修改状态与执行 Agent 的副作用须各自明确。CLI 与 GUI 是同一业务 owner 的消费面，不成为事实镜像。运行中的 help 只说明该执行版本公开什么；源码、构建、安装与当前实例的身份需分别核对。

## 维护这张地图

公开导出、业务 owner 或真实接线变化时，更新受影响的入口与 symbol 链接；参数或错误合同只改原定义，不向本页复制全集。新增专题需有独立读者问题和唯一 owner。遵循 [文档事实与维护规范](../guides/document-truth-and-maintenance.md)，只记录可核对的当前来源，不用本机过程资料代签能力完成。
