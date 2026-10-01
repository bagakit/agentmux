# 公共能力来源导航

本文按当前已提交源码帮助包消费者、CLI 维护者与客户端开发者定位公共入口、类型定义和消费链。它是一张来源地图；准确签名、参数、错误和导出范围由源码与 package exports 持有，不在这里维护第二份 API 或命令词典。源码合同、工作树、安装与运行事实分别核对；系统分工先读 [系统分层与事实归属](../architecture/system-ownership.md)。

## 选择接入入口

| 读者要做什么 | 从这里开始 | 继续核对 |
| --- | --- | --- |
| 在 Node 宿主接入本地 Agent／Terminal | [Core 接入说明](../../packages/core/README.md)，从 `@agentmux/core` 导入 `connectLocalAgentMux` 或 `AgentMuxClient` | [runtime-client.ts](../../packages/core/src/runtime-client.ts)、[client.ts](../../packages/core/src/client.ts) |
| 在现有宿主提供 Control 能力，或连接已运行的 Control owner | [`AgentMuxControlHost` 与请求／回执类型](../../packages/core/src/control.ts) | [`AgentMuxControlServer` / `requestAgentMuxControl`](../../packages/core/src/control-host.ts) |
| 在浏览器投影执行事实或 Session Timeline | Core [package exports](../../packages/core/package.json) 中的 `runtime`、`timeline` 等专项入口 | [runtime.ts](../../packages/core/src/runtime.ts)、[session-timeline.ts](../../packages/core/src/session-timeline.ts)；不导入加载 Node Runtime 的包根 |
| 在 React 客户端复用 Conversation／Composer 呈现 | [共享 UI 包说明](../../packages/client-ui/README.md)，从 `@agentmux/client-ui` 或已导出的 component 子路径导入 | [package exports](../../packages/client-ui/package.json)、[index.ts](../../packages/client-ui/src/index.ts)、[`ClientUiProvider` / `ClientUiPlatform`](../../packages/client-ui/src/platform.tsx)；宿主显式注入平台与业务 props |
| 复用分屏树计算 | [Layout 包说明](../../packages/layout/README.md)，只从 `@agentmux/layout` 入口导入 | [package exports](../../packages/layout/package.json)、[index.ts](../../packages/layout/src/index.ts)；当前源 TS 入口需要可转译 TS 的宿主 |
| 使用独立 Goal／Demand Store，或浏览器侧 Goal 规则 | [Demand 包说明](../../packages/demand/README.md)，`openDemandStore` / `@agentmux/demand/goals` | [package exports](../../packages/demand/package.json)、[demand-store.ts](../../packages/demand/src/demand-store.ts)、[goals.ts](../../packages/demand/src/goals.ts) |
| 用 AgentMux CLI 操作原工作面 | 当前执行版本的 `--help` / `--skill`；[对象操作指南](../guides/agentmux-cli-object-control.md) 给任务入口和失败处理 | [CLI parser](../../packages/core/src/agentmux.ts)、[help / skill 来源](../../packages/core/src/agentmux-cli-help.ts) |

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
| Session 身份、历史与事件 | [Session Registry](../../packages/core/src/agent-session-registry.ts)、[Session Store](../../packages/core/src/agent-session-store.ts)；`onEvent`、`sessionTimeline`、`sessionHistoryPage`、`observeSessionHistory` | [历史观察接线](../../apps/desktop/src/main/session-history-observation.ts)、[Session snapshot](../../apps/desktop/src/main/session-snapshot-payload.ts) |
| 共享 Conversation、结构化请求与 Composer 呈现 | [client-ui index](../../packages/client-ui/src/index.ts) 与 [platform.tsx](../../packages/client-ui/src/platform.tsx)；组件 typed props 注入文件、导航、消息和回答操作 | [DesktopClientUiProvider](../../apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx) → [Renderer main](../../apps/desktop/src/renderer/src/main.tsx)；宿主保有平台 IO、身份和工作面焦点 |
| 空间地址、展示导航与工作面回执 | [space-control.ts](../../packages/core/src/space-control.ts)、[desktop-focus-control.ts](../../packages/core/src/desktop-focus-control.ts)，由 [control.ts](../../packages/core/src/control.ts) 公开 | Main 的 [Control bridge](../../apps/desktop/src/main/control-ipc-bridge.ts) → Renderer [control-api.ts](../../apps/desktop/src/renderer/src/lib/control-api.ts) → [Store 的 `executeControl`](../../apps/desktop/src/renderer/src/store.ts)；布局记录仍归 client |
| 宿主配置、Browser、Toolkit 与诊断 | Control 的对应 typed request / result；[Toolkit](../../packages/core/src/toolkit-control.ts) 的订阅入口 | [Main IPC handlers](../../apps/desktop/src/main/ipc.ts)、[ConfigOwner](../../apps/desktop/src/main/config-owner.ts) 及各宿主 owner |
| Goal／Demand 内容、确认与接受 | [`openDemandStore`](../../packages/demand/src/demand-store.ts)、[Goal 类型与 readiness helpers](../../packages/demand/src/goals.ts) | Main IPC 的 Demand handlers 与 Renderer Goal 操作；Agent proposal 不代替人类确认／接受 |

输入应用、Prompt 投递、任务接受、Agent 状态和工作完成是不同事实，准确边界见 Core 接入说明与 owning 设计。初始 Prompt 的投递事实消费 `createAgentWithDelivery` 的同次返回；缺失回执不自行重启、重发或换目标。

## CLI 的当前来源和设计方向

当前 CLI 的参数解析与路由在 [agentmux.ts](../../packages/core/src/agentmux.ts)，help 与运行时技能在 [agentmux-cli-help.ts](../../packages/core/src/agentmux-cli-help.ts)。Control 的请求、回执、错误与宿主接口由 [control.ts](../../packages/core/src/control.ts) 定义，解析和 Unix socket 输送由 [control-host.ts](../../packages/core/src/control-host.ts) 承担；Main 在 [ipc.ts](../../apps/desktop/src/main/ipc.ts) 提供真实 handlers。

现有 Control 是自定义 NDJSON 协议；现有 CLI 仍有顶层跨域命令、本地 Session Store 解析和角色文件读写。已确认的 [对象优先 CLI 与统一公共业务服务](../design/behavior/public-control.md#对象优先-cli-与统一公共业务服务) 规定下一套公共方法、对象树和传输边界。完整目标树只在该设计处定义，本页不复制，也不把目标命令列为当前可执行入口。

核对能力按同一对象寻找业务类型、实际 owner、服务接线、CLI／Client 消费及验证证据；查看事实、修改状态与执行 Agent 的副作用须各自明确。CLI 与 GUI 是同一业务 owner 的消费面，不成为事实镜像。运行中的 help 只说明该执行版本公开什么；源码、构建、安装与当前实例的身份需分别核对。

## 维护这张地图

公开导出、业务 owner 或真实接线变化时，更新受影响的入口与 symbol 链接；参数或错误合同只改原定义，不向本页复制全集。新增专题需有独立读者问题和唯一 owner。遵循 [文档事实与维护规范](../guides/document-truth-and-maintenance.md)，只记录可核对的当前来源，不用本机过程资料代签能力完成。
