# 可复用对话与 Workflow 表面组件评审

## 结论

用户确认的目标是：先把 `http://10.37.126.170:18080/final.html` 中的 Workflow 时间线组件全部炼化为 reusable React 组件，暂不接入聊天页面；同时梳理聊天页已有组件，明确哪些已经是可复用原语，避免再造一套实现。

本次采用 Renderer 内的 `components/workflow/` 作为 owning boundary，组件只接收类型化的 Workflow/Phase/Agent 数据，不读取 Store、Runtime 或 Chat timeline。新增一个只读 `?agentmux-component-gallery=1` Gallery 作为真实生产调用者和视觉回归面；它展示目标页的运行中、完成、失败、终止、暂停、旧 daemon、窄屏和 dock 变体，但不改变聊天页数据或布局。

## 设计判断

- 目标页属于 mixed product/tool surface，优先级是状态可读、时间线密度、折叠可恢复、键盘/触屏可用，而非装饰性卡片。
- Workflow 卡片应保持在时间线的低干扰层：普通 tool 行、摘要头、阶段、Agent 行和明细面板共享一个状态/折叠语汇；dock 只是同一组件的密度变体。
- 运行中保持展开，终态默认摘要；失败项永不被尾部安静项折叠吞掉；旧 daemon 没有阶段事实时直接退化成普通 tool 行并说明原因。
- 现有聊天页中 `ConversationAxis`、`AgentMarkdown`、`AgentInteractionCard`、`ComposerTextarea`、`StatusDot`、`ServiceWindowNotice` 已满足可复用边界；`ActivityView` 中的 Row/Run/Turn/Ruler 是下一轮可按同一原则拆分的内部成员，本轮不把聊天数据接到 Workflow 组件。

## 范围与非目标

- 范围：类型化 Workflow 组件、状态与折叠行为、响应式密度、Gallery、定向测试、组件架构文档。
- 非目标：聊天时间线接入、Provider/Runtime 协议变化、Workflow 业务数据采集、多 Agent DAG 执行、脚本正文/结果预览、额外筛选器。

## 证据与批准

- 目标页语义快照与完整截图：`/tmp/agentmux-reference-final.png`（页面标题“Workflow 时间线卡片”）。
- 目标页源码事实：`.wf-card`、`.wf-head`、`.wf-phase`、`.wf-agent`、`.wf-detail`、`.wf-more`、`.wf-dock`、`.wf-card--flat` 以及 `running/completed/failed/killed/paused` 五种状态。
- 现有聊天实现核对：`ActivityView.tsx`、`ConversationAxis.tsx`、`AgentMarkdown.tsx`、`AgentInteractionCard.tsx`、`ComposerTextarea.tsx`、`StatusDot.tsx`、`ServiceWindowNotice.tsx`。
- 用户在 2026-09-15 的请求即本次范围与计划的批准；实现前已同步两份设计 SSOT。

## 聊天组件架构审计

| 组件 | 事实 owner | 当前生产调用者 | 结论 |
| --- | --- | --- | --- |
| `ConversationAxis` | `ActivityView` 持有 timeline 与 speaker resolver | `ActivityView.tsx` 的 human/agent 两条轴 | 已是可复用原语；保持受控、无 Store，不迁移到 Workflow 层 |
| `AgentMarkdown` | `ActivityView` 的对话正文宿主 | `ActivityView.tsx` 的 `Turn` | 可复用；文件/图片/链接能力由宿主注入，不能让组件自己查 workspace |
| `AgentInteractionCard` | `SessionPane` 持有 Core request 与 response handler | `SessionPane.tsx` | 可复用交互面；权限/问题判定继续由 `agent-interaction-plan` 负责 |
| `ComposerTextarea` | Renderer 输入壳持有 IME composition 状态 | `AgentComposer`、`NewTabSurface`、`PrLaunchSurface`、`BoardDiscussionCanvas`、`ChangesPanel`、`BrowserPane`、Settings | 已经完成跨表面复用，是当前最清晰的 reusable primitive |
| `StatusDot` | 共享状态 token 与 `SessionSnapshot.status` | SurfaceToolDock、QuickSwitcher、WorkbenchTabMarks、WorkspaceBoard | 已是共享状态显示；不复制 Workflow status glyph 到聊天状态点 |
| `ServiceWindowNotice` | `service-window-notice` 判定层 | ShellEnvironment、SessionPane、RuntimeOwnership、TerminalView、DisplacedAgent | 已是服务窗 owner；Workflow 旧 daemon 说明属于组件自身事实，不冒充服务窗 |
| `ActivityView` 内部 `Row/Run/Turn/Ruler` | `ActivityView` 的时间轴与滚动/选中状态 | `SessionPane -> ActivityView` | 暂不拆；它们共享 ruler、scroll、segment 和记忆状态，过早拆会制造第二套时间轴 owner。后续若拆，先以公共 props + 真实第二消费者为门槛 |
| Workflow 新组件 | `components/workflow` 的 typed props；Gallery 只做 fixture 宿主 | `WorkflowComponentGallery` | 本次只建立 reusable 组件，不接聊天；未来聊天适配必须在宿主层把事实转换成 `WorkflowSnapshot` |

### 架构结论

当前最成熟的边界不是“所有 JSX 都搬进 shared”，而是三层：

1. **无状态/受控原语**：`ComposerTextarea`、`StatusDot`、`ConversationAxis`、`AgentMarkdown`。
2. **带领域交互但由宿主持有事实**：`AgentInteractionCard`、`ServiceWindowNotice`。
3. **表面级复合组件**：`ActivityView` 与新的 `WorkflowCard`/`WorkflowDock`。

Workflow 组件已按第三层落位，没有把 Provider、Core Session、ctxmux Run 或聊天 Store 偷塞进组件。Gallery 只证明渲染和交互契约，不宣称聊天接入完成。
