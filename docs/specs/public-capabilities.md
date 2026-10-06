# 公共能力来源导航

本文按当前已提交源码帮助包消费者、CLI 维护者与客户端开发者定位公共入口、类型定义和消费链。它是一张来源地图；准确签名、参数、错误和导出范围由源码与 package exports 持有，不在这里维护第二份 API 或命令词典。源码合同、工作树、安装与运行事实分别核对；系统分工先读 [系统分层与事实归属](../architecture/system-ownership.md)。

新增功能的作者先按[公共能力贡献约定](../guides/public-capability-contributions.md)判断 RPC／CLI 影响，再用本页找到原定义与实际消费入口。

## 选择接入入口

| 读者要做什么 | 从这里开始 | 继续核对 |
| --- | --- | --- |
| 在 Node 宿主接入本地 Agent／Terminal | [Core 接入说明](../../packages/core/README.md)，从 `@agentmux/core` 导入 `connectLocalAgentMux` 或 `AgentMuxClient` | [runtime-client.ts](../../packages/core/src/runtime-client.ts)、[client.ts](../../packages/core/src/client.ts) |
| 接入跨模块证据与 Agent 诊断 | [Diagnostic Evidence 协议](diagnostic-evidence-protocol.md)与[模块指南](../guides/diagnostic-evidence-integration.md) | [portable SDK](../../packages/diagnostic-evidence/src/index.ts)、[Core 领域合同](../../packages/core/src/diagnostic-evidence.ts)、RPC `system.diagnostics.inspect` / CLI `system diagnostics inspect`；原业务 owner 仍持有事实与原件 |
| 提供共享业务服务，或连接已运行的服务 owner | [公共 RPC 类型](../../packages/core/src/public-rpc.ts) 与 [`AgentMuxRpcServiceOptions`](../../packages/core/src/public-rpc-service.ts) | [`AgentMuxControlServer`](../../packages/core/src/public-rpc-server.ts)、[`connectAgentMuxRpc`](../../packages/core/src/public-rpc-client.ts)；经 [control-host.ts](../../packages/core/src/control-host.ts) 从包根导出 |
| 无 UI 管理本机或远端语义 Runtime | [Core 远程接入](../../packages/core/README.md#远程-runtime)、[`connectHostedAgentMux`](../../packages/core/src/hosted-client.ts) 与 [`connectSshAgentMux`](../../packages/core/src/runtime-client.ts) | [唯一 Hosted 合同](../../packages/core/src/hosted-client-contract.ts)、[Headless owner](../../packages/core/src/headless-runtime.ts)、[Desktop Host connector](../../apps/desktop/src/main/desktop-host.ts) |
| 查看原语义 owner 的入口发布与恢复观测 | [`AgentMuxControlEndpointState`](../../packages/core/src/control-endpoint-state.ts)、[`AgentMuxClientEvent`](../../packages/core/src/types.ts)、RPC `system.endpoint` | [Control Server](../../packages/core/src/public-rpc-server.ts) → [Hosted service](../../packages/core/src/hosted-runtime-service.ts) → [Hosted client](../../packages/core/src/hosted-client.ts) 与 RuntimeController；CLI `system endpoint --inspect` 只读同一事实 |
| 在浏览器投影执行事实或 Session Timeline | Core [package exports](../../packages/core/package.json) 中的 `runtime`、`timeline` 等专项入口 | [runtime.ts](../../packages/core/src/runtime.ts)、[session-timeline.ts](../../packages/core/src/session-timeline.ts)；不导入加载 Node Runtime 的包根 |
| 在 React 客户端复用 Conversation／Composer 呈现 | [共享 UI 包说明](../../packages/client-ui/README.md)，从 `@agentmux/client-ui` 或已导出的 component 子路径导入 | [package exports](../../packages/client-ui/package.json)、[index.ts](../../packages/client-ui/src/index.ts)、[`ClientUiProvider` / `ClientUiPlatform`](../../packages/client-ui/src/platform.tsx)；宿主显式注入平台与业务 props |
| 复用分屏树计算 | [Layout 包说明](../../packages/layout/README.md)，只从 `@agentmux/layout` 入口导入 | [package exports](../../packages/layout/package.json)、[index.ts](../../packages/layout/src/index.ts)；当前源 TS 入口需要支持该源文件及模块解析的宿主 |
| 使用独立 Goal／Demand Store，或浏览器侧 Goal 规则 | [Demand 包说明](../../packages/demand/README.md)，`openDemandStore` / `@agentmux/demand/goals` | [package exports](../../packages/demand/package.json)、[demand-store.ts](../../packages/demand/src/demand-store.ts)、[goals.ts](../../packages/demand/src/goals.ts) |
| 用 AgentMux CLI 操作原工作面 | 当前执行版本的 `--help` / `--skill`；[对象操作指南](../guides/agentmux-cli-object-control.md) 给任务入口和失败处理 | [命令注册与 parser](../../packages/core/src/agentmux-cli-commands.ts)、[help / skill 来源](../../packages/core/src/agentmux-cli-help.ts)、[CLI 接线](../../packages/core/src/agentmux.ts) |

[Core package exports](../../packages/core/package.json) 决定可导入子路径；[index.ts](../../packages/core/src/index.ts) 决定包根重导出。出现在 exports 中只证明当前包入口，不单独证明接口成熟度、稳定性或运行验收。包内实现文件链接用于阅读源码，不授权消费者绕开公共入口深入导入。

`client-ui` 的 [exports](../../packages/client-ui/package.json) 为浏览器 bundler 提供源 TS，为 Node import 提供 ESM 产物；宿主按包说明加载样式及主题。Main 只需图片规则或路径识别时，使用 `pasted-images`／`terminal-path-link` 等纯叶入口，避免加载 React／Tiptap／DOM。UI 包消费 Core 的类型与纯公开子路径，Core 不增加 UI 依赖；共享组件并不持有 Agent 或 Run 事实。

## 按能力找到定义与消费者

下表列代表入口，完整类型与实现仍由来源文件定义。读到一个 symbol 后，应沿实际消费者核对它怎样接到产品，而不是以声明存在认定能力交付。

| 能力与当前 owner | 定义入口 | 第一方消费链 |
| --- | --- | --- |
| 连接、Provider 发现和扩展 | [`connectLocalAgentMux`](../../packages/core/src/runtime-client.ts)、[`AgentProvider` / `defineAgentProvider` / `AgentProviderRegistry`](../../packages/core/src/agent-provider.ts) | [Desktop RuntimeController](../../apps/desktop/src/main/runtime-controller.ts) 的 `prepareHost` 与探测／启动入口 |
| 外部应用连接配置与状态 | [纯 Connection 合同](../../packages/core/src/connections-contract.ts)、[严格解析](../../packages/core/src/connections-codec.ts)、[可选 Host 包](../../packages/connectors/README.md) | `connection` CLI → 公共 RPC → 注入的 [ConnectionHost](../../packages/connectors/src/connection-host.ts)；Desktop [Connections Settings](../../apps/desktop/src/renderer/src/components/settings/ExternalConnectionsSettings.tsx) → [可信 IPC](../../apps/desktop/src/main/connector-ipc.ts) → 同一服务；秘密仅由执行 Host 的 [凭证端口](../../apps/desktop/src/main/connector-secrets.ts) 处理 |
| 外部群与准确 Session 绑定及 actor 授权 | [纯 Binding 合同](../../packages/core/src/room-binding-contract.ts)、[严格解析](../../packages/core/src/room-binding-codec.ts)、[组合与用法](../../packages/connectors/README.md#room-bindings) | `connection` CLI／SDK → 原公共服务 → [RoomBindingHost](../../packages/connectors/src/room-binding.ts)；[原 Host 组合](../../apps/desktop/src/main/connector-host.ts)借原空间读取、准确 Core checkpoint 与同一连接器数据库，保留不可变修订及原操作回执 |
| 创建、接回、语义恢复与停止 AgentSession | [`AgentMuxClient`](../../packages/core/src/client.ts) 的 `createAgentWithDelivery`、`reattachAgent`、`ensureAgentContinuity`、`resumeAgent`、`stopAgent` | [Desktop IPC](../../apps/desktop/src/main/ipc.ts) → [RuntimeController](../../apps/desktop/src/main/runtime-controller.ts) |
| Terminal 输入、Attachment 与 Replay | `AgentMuxClient` 的 `createTerminal`、`attachTerminal`、`readRunReplay`、`writeTerminal`；[相关类型](../../packages/core/src/types.ts) | RuntimeController 的 attach／replay／input 入口；字节到画面见 [Terminal Runtime](../architecture/terminal-runtime.md) |
| Prompt、权限／问题与 Agent 状态 | `submitAgentPrompt`、`respondAgentInteraction`、`inspectAgentInteractionOperation`、`statusAgent`；[结构化交互判断](../../packages/core/src/agent-interaction-state.ts)、[Prompt condition](../../packages/core/src/agent-prompt-condition.ts) | RuntimeController 与 Desktop IPC 的 Session 操作；RPC `agent.interaction.respond`／`agent.interaction.inspect` 和同名对象 CLI 复用原 owner，client 读取 typed facts，不拼厂商按键 |
| 单次 Prompt 的执行意图与原生准备 | [公共 Prompt／Message input](../../packages/core/src/client.ts)、[execution 与 Provider plan 类型](../../packages/core/src/types.ts)、[Provider 接口](../../packages/core/src/agent-provider.ts) | [CLI 注册](../../packages/core/src/agentmux-cli-commands.ts) → 公共 RPC／原 message owner；Desktop Store → IPC → RuntimeController → Core [Prompt admission](../../packages/core/src/prompt-submission.ts)；原生差异由 Provider 解释 |
| Client 原待发草稿的查询、编辑和明确发送 | [公共 RPC](../../packages/core/src/public-rpc.ts)引用的 [pending 控制类型](../../packages/core/src/control.ts)、[严格解析](../../packages/core/src/control-codec.ts) | `message pending` CLI → 公共服务 → 原 Client [Store](../../apps/desktop/src/renderer/src/store.ts) 与 [Composer](../../apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx)共用队列；它与 Core 的消息 envelope journal 分属原 owner，正文修改／发送需要可信用户或设备来源，managed Agent 不能冒充用户改写草稿 |
| Session 身份、历史与事件 | [Session Registry](../../packages/core/src/agent-session-registry.ts)、[Session Store](../../packages/core/src/agent-session-store.ts)；`onEvent`、`sessionTimeline`、`sessionHistoryPage`、`observeSessionHistory` | [历史观察接线](../../apps/desktop/src/main/session-history-observation.ts)、[Session snapshot](../../apps/desktop/src/main/session-snapshot-payload.ts) |
| 原 Agent 的完整可读上下文 | [agent-context.ts](../../packages/core/src/agent-context.ts)组合原 Store 与 Provider reader；[公共服务](../../packages/core/src/public-rpc-service.ts)提供 `agent.context` | `agent context --host local --session SID` 联合读取所有可用来源、完整记录和诊断，沿绑定原来源的 `nextCursor` 连续分页；接手创建复用 `agent.open`，原会话保留 |
| 共享 Conversation、结构化请求与 Composer 呈现 | [client-ui index](../../packages/client-ui/src/index.ts) 与 [platform.tsx](../../packages/client-ui/src/platform.tsx)；组件 typed props 注入文件、导航、消息和回答操作 | [DesktopClientUiProvider](../../apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx) → [Renderer main](../../apps/desktop/src/renderer/src/main.tsx)；宿主保有平台 IO、身份和工作面焦点 |
| 持久空间事实、展示导航与工作面回执 | Core 的 [spatial-state.ts](../../packages/core/src/spatial-state.ts)、[space-control.ts](../../packages/core/src/space-control.ts)与 [desktop-focus-control.ts](../../packages/core/src/desktop-focus-control.ts) | 公共服务读取／提交同一 Core 空间图；Desktop 经 Main [Control bridge](../../apps/desktop/src/main/control-ipc-bridge.ts) → Renderer [control-api.ts](../../apps/desktop/src/renderer/src/lib/control-api.ts) → [Store](../../apps/desktop/src/renderer/src/store.ts)消费原事实并操作呈现／输入，持久归属见[空间状态](../architecture/spatial-state.md) |
| 宿主配置、Browser、Toolkit 与诊断 | [公共 RPC](../../packages/core/src/public-rpc.ts) 的 typed params / result / stream；[业务服务](../../packages/core/src/public-rpc-service.ts) 委托原 owner | [Main IPC handlers](../../apps/desktop/src/main/ipc.ts)、[ConfigOwner](../../apps/desktop/src/main/config-owner.ts) 及各宿主 owner |
| Topics 分类内容、主题发现与归属转移 | [Topic 公共类型与严格 codec](../../packages/core/src/public-rpc-topics.ts)；分类内容由 [Host 内容 owner](../../apps/desktop/src/main/topic-knowledge.ts)持有，分类关系由 [Topic 空间适配器](../../apps/desktop/src/main/topic-spatial-owner.ts)提交同一 Core 图 | Main 注入 `AgentMuxRpcServiceOptions.topics`；GUI 经 trusted IPC／preload 的 `topics.call` 消费同一 owner。默认语义 Host 将 CLI 的 typed `topic` 调用经已绑定的 Desktop business transport 转发至原内容 owner，沿同一参数、调用身份与结果校验；没有本地 owner 或已绑定转发端口时如实未知。创建与转移不隐式启动 Agent |
| Git 历史、固定提交与只读比较 | [中立 Git 包](../../packages/git/src/index.ts)持有对象与仓库事实；[公共 Git 类型与 codec](../../packages/core/src/public-rpc-git.ts)定义准确原资源与回执 | `git history/commit/diff` CLI → 公共服务 → Main [GitPublicControl](../../apps/desktop/src/main/git-public-control.ts) → [GitService](../../apps/desktop/src/main/git-service.ts) → 中立包；GUI 经原 IPC／preload 消费同一只读 owner。Core 只消费协议类型与委托端口 |
| Git 提交详情与仓库历史的呈现 | [公共 RPC 映射](../../packages/core/src/public-rpc.ts)将 `git.open` 委托给 `open.git`；参数与读取／呈现回执沿原 [Git 类型](../../packages/core/src/public-rpc-git.ts) | `git open` CLI → 既有 [Desktop Control bridge](../../apps/desktop/src/main/control-ipc-bridge.ts) → Renderer [Store](../../apps/desktop/src/renderer/src/store.ts)；带 `--oid` 时 Store 经原 Git IPC 读取准确提交并打开独立详情，省略 `--oid` 时确认原仓库并打开历史；两者由 [Git 工作面](../../apps/desktop/src/renderer/src/features/git/GitWorkbenchPane.tsx)组合，共用固定提交详情与原位只读 Diff。读取结果和精确呈现分别回执，不签出或改索引 |
| Goal／Demand 内容、确认与接受 | [`openDemandStore`](../../packages/demand/src/demand-store.ts)、[Goal 类型与 readiness helpers](../../packages/demand/src/goals.ts) | 原 Main IPC／Renderer owner；公共 `goal.create` 的可选 `goalId`、`goal.discuss`／`goal.confirm`／`goal.accept` 同由 [typed RPC](../../packages/core/src/public-rpc.ts) 与 [对象 CLI](../../packages/core/src/agentmux-cli-commands.ts) 消费，手机沿同 ID；Agent proposal 不代替人类确认／接受 |

### 文件资源的读取、修改与发现

原 Zone 文件的已保存正文与原修订保存沿[文件类型与严格 codec](../../packages/core/src/public-rpc-files.ts)公开。`file read`／`file write` CLI → 公共服务 → Main 注入的 [FileReadOwner](../../apps/desktop/src/main/file-read-owner.ts) 解析准确 Zone／资源，再委托原 [WorkspaceFiles](../../apps/desktop/src/main/workspace-files.ts)；结果保留完整原 revision、Host／Workspace／Zone 与原读取状态；观察未知不冒文件不存在，也不另建 Memory 存储。`file.write` 只保存已有文本文件，要求完整原 revision；`written`／`conflict`／`error`／`unknown` 保真，未知先读同一文件核对，不自动再写。

缺失目标的正文创建沿同一文件 owner 提供 `file.create`，CLI 为 `file create --input FILE|-`；先由 `file.read` 确认目标映射，提交完整原资源、Zone 相对路径、正文与明确的 `expectedRevision:null`。Main 确认映射后委托 `WorkspaceFiles.write` 的排他创建，不覆盖已存在文件；普通文本和 Note 使用同一通用能力，不新增正文 owner。结果沿原 `written`／`conflict`／`error`／`unknown` 与完整资源／revision 表达，未知先读同一准确目标对账，不自动换名或重发。既有 `file.write` 的完整 revision 要求保持。

项目文件名发现沿同一 Files owner：`file ls` CLI → `file.list` → `WorkspaceFiles.listFiles`；结果只含名称、原资源与 complete／partial 原因，应用 Git 忽略规则且不递归目录链接，不读正文或改变焦点。名称相对请求的目录；使用 `file open --zone` 继续时，将原 `file ls --path` 的目录前缀与名称拼接为 Zone 相对路径（默认 `.` 可省略）。未知观察保留原精确打开能力。

编辑器当前草稿的动作由 [`space-control` 类型](../../packages/core/src/space-control.ts)和[严格 parser](../../packages/core/src/space-control-parser.ts)定义。`file.view` 沿原 FileRegion 模式 owner；`file.format` 从 [Renderer control 消费](../../apps/desktop/src/renderer/src/store.ts)进入 [`format-file-region`](../../apps/desktop/src/renderer/src/lib/file-formats/format-file-region.ts)，与 File 动作共享同一可撤销草稿编辑。`file.build`／`file.build.inspect`／`file.build.cancel` 进入 [`build-file-region`](../../apps/desktop/src/renderer/src/lib/file-formats/build-file-region.ts) 与 Main [`FileBuilds`](../../apps/desktop/src/main/file-builds.ts)，准确绑定原 Region、build ID、Host 与草稿版本；公开回执含日志和产物元数据，PDF bytes 留在宿主。以上动作不隐式保存、切焦点或因打开 Preview 自动启动编译器。

### 文件上传与输入边界

设备选择的图片与普通文件沿同一[公共文件类型与 codec](../../packages/core/src/public-rpc-files.ts)提供 `file.upload`／`file.upload.inspect`，CLI 为 `file upload [inspect] --input FILE|-`。公共服务先确认准确原 Host／Session／Run，再委托 Main 注入的 [FileUploadOwner](../../apps/desktop/src/main/file-upload-owner.ts)保存至 Host 指定私有位置并读回；原操作不可覆盖，未知核对不重传。手机 [MobileAttachments](../../apps/mobile/src/conversation/MobileAttachments.tsx) 消费同一回执，再借[共享文件引用插入](../../packages/client-ui/src/lib/composer-file-reference.ts)进入原 Composer；上传本身不发送消息，Core 输入与 Runtime 仍归原 owner。

输入应用、Prompt 投递、任务接受、Agent 状态和工作完成是不同事实，准确边界见 Core 接入说明与 owning 设计。初始 Prompt 的投递事实消费 `createAgentWithDelivery` 的同次返回；缺失回执不自行重启、重发或换目标。

## CLI 与服务的当前来源

### 命令注册与业务 owner

[`AGENTMUX_CLI_COMMANDS`](../../packages/core/src/agentmux-cli-commands.ts) 是对象命令的共同注册来源，`parseAgentMuxCliInvocation` 从它解析参数，[help 与运行时技能](../../packages/core/src/agentmux-cli-help.ts) 从它生成说明。[agentmux.ts](../../packages/core/src/agentmux.ts) 处理 endpoint、调用与流输出，业务查询、角色绑定和消息编排进入 [`AgentMuxRpcService`](../../packages/core/src/public-rpc-service.ts)，不在 CLI 直接读写本地业务事实。公共方法、参数、结果与订阅类型归 [public-rpc.ts](../../packages/core/src/public-rpc.ts)；Main 在 [ipc.ts](../../apps/desktop/src/main/ipc.ts) 注入原 owner 的真实能力。

### 服务传输与接入层

当前 [Server](../../packages/core/src/public-rpc-server.ts) 与 [Client](../../packages/core/src/public-rpc-client.ts) 使用同一 JSON-RPC 2.0 合同，支持默认 Unix socket、显式启用的 HTTP／SSE，SSH stdio 转发到既有 Unix 服务，以及端到端加密 Relay 帧传输。Hosted SDK 通过该服务管理远端 Core Session；它与 ctxmux 的原生 Remote Run 协议是不同接入层，连接条件和分层边界见 [系统接入边界](../architecture/system-ownership.md#当前接入边界)。[对象优先 CLI 与统一公共业务服务](../design/behavior/public-control.md#对象优先-cli-与统一公共业务服务) 持有行为约束；本页不复制对象树，也不以服务入口存在代签所有宿主能力或安装后的可用性。

### 帧、回压与观察成本

JSON-lines 单帧编解码和字节上限由 [public-rpc-frame.ts](../../packages/core/src/public-rpc-frame.ts) 持有；官方 [Performance 脚本](../../apps/desktop/resources/toolkit/performance.mjs) 复用该实现，顺序等待 stdout drain。CLI 的同步订阅回调由 [agentmux.ts](../../packages/core/src/agentmux.ts) 限制实际待发送字节，正常 highWaterMark 回压仍接纳合法帧，积压超限才报告并释放本读取者。

显式取消或积压失败在释放订阅后丢弃自身待发送输出；普通结束完整 flush。

typed Metrics 由 [metrics.ts](../../packages/core/src/metrics.ts) 校验，Settings 不透明叶子由 [settings-resource-json.ts](../../packages/core/src/settings-resource-json.ts) 校验；[control-codec.ts](../../packages/core/src/control-codec.ts) 的 Host Test/list、Executor Refresh 外层不再次按整个回执限深。

行为边界沿 [Toolkit 与官方 Performance](../design/behavior/settings-and-observation.md#toolkit-与官方-performance-工具)，实际脚本、公开 CLI／Unix 往返及变异验证入口为 [verify-performance-protocol-boundaries.mjs](../../apps/desktop/scripts/verify-performance-protocol-boundaries.mjs)。

### 设备与移动连接

手机连接的来源为 [Relay framing](../../packages/core/src/public-rpc-relay.ts)、[有限浏览器 Hosted adapter](../../packages/core/src/relay-hosted.ts)、[设备领域类型及严格解析](../../packages/core/src/public-rpc-device.ts)和 [Host 原 Authority 组合](../../apps/host/src/host.ts)。`amux device link` 返回当前完整公有 offer 链接，`device ls` 回读连接与设备事实，`device revoke --device ID` 撤销精确设备；设备命名只沿已认证的 `device hello --name NAME`。GUI 复用原服务，Relay 与手机页面由本机 Host 提供。接入、身份、重连与权限约束唯一沿[《手机版 Relay 连接》](../design/behavior/public-control.md#手机版-relay-连接)，构建成功不代替真机验收。

核对能力按同一对象寻找业务类型、实际 owner、服务接线、CLI／Client 消费及验证证据；查看事实、修改状态与执行 Agent 的副作用须各自明确。CLI 与 GUI 是同一业务 owner 的消费面，不成为事实镜像。运行中的 help 只说明该执行版本公开什么；源码、构建、安装与当前实例的身份需分别核对。

## 维护这张地图

公开导出、业务 owner 或真实接线变化时，更新受影响的入口与 symbol 链接；参数或错误合同只改原定义，不向本页复制全集。新增专题需有独立读者问题和唯一 owner。遵循 [文档事实与维护规范](../guides/document-truth-and-maintenance.md)，只记录可核对的当前来源，不用本机过程资料代签能力完成。
