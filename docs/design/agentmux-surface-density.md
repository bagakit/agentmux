# AgentMux Surface 与密度合同

本页是视觉与密度约束的 canonical 入口，正文按稳定对象与读者问题组织。行为、身份和动作资格归交互合同；这里不复制另一层的规则。

已确认约束、当前实现、历史证据与待确认方案分别表达；专题正文定义要求，不自动证明实现或产品运行已经验收。

[文档导航](../README.md) · [文档事实与维护规范](../guides/document-truth-and-maintenance.md) · [交互合同](agentmux-desktop-interaction.md)

**改手机界面先读[手机客户端的呈现](presentation/mobile-client.md)**：手机的尺度、控件、文案、状态、动效与采图验收都在那一页。手机复用哪些桌面专题及其差异见 [Mobile 对齐索引](agentmux-mobile-alignment.md)。

## 按主题阅读

| 读者问题 | 唯一正文 |
| --- | --- |
| 主题 token、尺度、控件、样式归属及视觉验收 | [全局视觉、尺度与样式 Owner](presentation/shared-rules.md) |
| 品牌：龙的五个境、大图与题款、共用工坊、IP 形象与品牌出现的位置 | [品牌架构](presentation/brand-identity.md) |
| Mote／Work／Know 导航分组、对象层次、Tab／Region 几何和 Launcher 密度 | [空间与布局的呈现](presentation/spaces-and-layout.md) |
| Survey 浏览起点与 Zone 工作面 | [Survey 的 Zone 工作面与液体玻璃](presentation/knowledge-workflows.md#survey-的-zone-工作面与液体玻璃) |
| Recall 目录、书写、Note 图谱和来源层级 | [Recall 的目录、阅读与来源](presentation/knowledge-workflows.md#recall-的目录阅读与来源) |
| Topics 分类与主题树、讨论和知识内容层级 | [Topics 知识库的导航与内容层级](presentation/spaces-and-layout.md#topics-知识库的导航与内容层级) |
| Mote 身份、快捷面、浮窗及协调控件 | [Mote 与协调面的呈现](presentation/motes-and-coordination.md) |
| 伙伴诞生的三幕用户故事板与设置教程 Banner | [伙伴故事板](presentation/motes-and-coordination.md#伙伴从哪里来用户故事板与教程-banner) |
| 目标正文、需求卡片、详情和 Board 密度 | [Goals 与需求面的呈现](presentation/goals-and-demand.md) |
| 执行台、焦点历史、泳道和底部音轨 | [Focus 执行台的呈现](presentation/focus-context.md) |
| Map 层级轮廓、关系绘制、连续 LOD 与交互动效 | [Focus Map 的呈现](presentation/collaboration-map.md) |
| 连接、恢复、启动、服务窗和版本边界 | [Session 与恢复的呈现](presentation/session-recovery.md) |
| 对话消息、身份、正文／资源、过程与请求卡密度 | [对话模式的呈现](presentation/conversation-mode.md) |
| 输入工具、队列、Mailbox 容器与持续推进密度 | [输入工具与邮箱的呈现](presentation/conversation-input.md) |
| 系统截图选区、来源选择、贴图与共享图片编辑的控件层级 | [截图与录制的呈现](presentation/capture-and-recording.md) · [共享标记呈现](presentation/browser-workface.md#browser-任务工具与证据的紧凑呈现)；行为归[截图与录制](behavior/capture-and-recording.md) |
| 身份、能力、Agent 状态、注入上下文与消息队列 | [Agent 身份与消息的呈现](presentation/agent-capabilities-and-messaging.md) |
| 终端字形、历史、恢复阅读和链接提示 | [Terminal 阅读的呈现](presentation/terminal-reading.md) |
| Browser 工具、证据、控制权和确认层次 | [Browser 工作面的呈现](presentation/browser-workface.md) |
| Capsule 设置、页面身份、待答状态与 Toolkit 成果入口 | [Capsule 的设置、页面与工具结果呈现](presentation/local-page-hosting.md) |
| Explorer、编辑、分支、差异和留存提示 | [文件与 Git 的呈现](presentation/files-and-git.md) |
| Settings、状态栏、Activity、通知和工具密度 | [设置与观测的呈现](presentation/settings-and-observation.md) |
| Mesh 网络画布、节点、链路与 Remote 工作详情 | [Mesh 网络工作面](presentation/settings-and-observation.md#mesh-网络工作面) · [Remote 工作详情](presentation/settings-and-observation.md#remote-管理拓扑) |
| 手机 Web client 的尺度、控件、文案、状态、动效与采图验收 | [手机客户端的呈现](presentation/mobile-client.md) |
| 公共控制的原表面 | [公共控制与客户端的呈现](presentation/public-control.md) |

## 按控件开始贡献

先定位所属表面的行为与呈现专题，再沿下表复用现有入口。源码链接用于核对当前实现与真实调用，不证明整页已经符合规范；几何与手机差异仍由原专题持有。

公共用法、模式与路线由[组件库入口](../../packages/client-ui/README.md)维护。AgentMux 的业务映射和真实消费者由本项目维护。对话与资源阅读见[阅读调用链](../architecture/conversation.md)，弹层与窗口适配见[实现归属](../architecture/ui-layering.md)。

| 要做什么 | 规格 | 源码 Owner | 真实消费者示例 |
| --- | --- | --- | --- |
| 找到 Agent 已打开的工作面 | [通用位置模式](../../packages/client-ui/docs/patterns/agent-work-location.md)与[AgentMux 空间寻址](behavior/spaces-and-layout.md#统一概念与空间寻址) | [Desktop 位置与导航](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts)、[Mobile 位置核对](../../apps/mobile/src/navigation/mobile-agent-locations.ts) | [Desktop 详情](../../apps/desktop/src/renderer/src/components/AgentLocationsButton.tsx)、[Mobile 选择面板](../../apps/mobile/src/navigation/MobileAgentLocations.tsx) |
| 文字或图标动作 | [控件语言与逐态职责](presentation/shared-rules.md#控件语言) | [Button](../../packages/client-ui/src/components/Button.tsx)、[IconButton](../../packages/client-ui/src/components/IconButton.tsx)、[共享按钮样式](../../packages/client-ui/src/styles/buttons.css) | [SettingsSaveBar](../../apps/desktop/src/renderer/src/components/settings/SettingsSaveBar.tsx) |
| 单字段或组合输入 | [输入与焦点规格](presentation/shared-rules.md#控件语言) | [TextInput](../../packages/client-ui/src/input/TextInput.tsx)、[InputGroup](../../packages/client-ui/src/input/InputGroup.tsx)、[输入样式](../../packages/client-ui/src/input/input.css) | [MoteRenameDialog](../../apps/desktop/src/renderer/src/components/MoteRenameDialog.tsx)、[MoteFirstCooperation](../../apps/desktop/src/renderer/src/components/MoteFirstCooperation.tsx) |
| 紧凑多行编辑 | [正文与底栏](presentation/shared-rules.md#控件语言) | [ComposerTextarea](../../packages/client-ui/src/input/ComposerTextarea.tsx)、[ComposerEditFooter](../../packages/client-ui/src/components/ComposerEditFooter.tsx)、[用法示例](../../packages/client-ui/README.md#compact-editors) | [待发消息编辑](../../apps/desktop/src/renderer/src/components/ComposerQueuedMessageEditor.tsx)、[对话批注](../../apps/desktop/src/renderer/src/components/ConversationAnnotationNote.tsx) |
| 富文本消息输入 | [Composer 密度](presentation/conversation-input.md#composer-状态与队列密度) | [AgentComposer](../../packages/client-ui/src/components/AgentComposer.tsx)、[ComposerHost](../../packages/client-ui/src/components/ComposerHost.tsx) | [Desktop](../../apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx)、[Mobile](../../apps/mobile/src/conversation/mote-composer.tsx) |
| 标签、说明与原生设置项 | [控件语言](presentation/shared-rules.md#控件语言) · [Settings 呈现](presentation/settings-and-observation.md#settings-控制工作面) | [FormRow](../../packages/client-ui/src/components/FormRow.tsx)、[原生控件绘制](../../packages/client-ui/src/styles/native-controls.css) | [GeneralSettingsPane](../../apps/desktop/src/renderer/src/components/settings/GeneralSettingsPane.tsx)、[NotificationSettingsPane](../../apps/desktop/src/renderer/src/components/settings/NotificationSettingsPane.tsx) |
| 单选字段或动作菜单 | [控件语言](presentation/shared-rules.md#控件语言) · [键盘与可访问性](presentation/shared-rules.md#响应式与可访问性) | [SelectionField](../../packages/client-ui/src/components/SelectionField.tsx)、[共享 HoverDropdownMenu](../../packages/client-ui/src/components/HoverDropdownMenu.tsx) 与 [Desktop 窗口适配](../../apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx)、[菜单样式](../../apps/desktop/src/renderer/src/styles/context-menu.css) | [AgentExecutorPicker](../../apps/desktop/src/renderer/src/components/AgentExecutorPicker.tsx)、[WorkbenchTabContextMenu](../../apps/desktop/src/renderer/src/components/WorkbenchTabContextMenu.tsx)（原 Radix ContextMenu） |
| 模态或确认弹层 | [弹层作用域与层级](presentation/shared-rules.md#弹层作用域与层级) · [恢复确认的验收](../guides/agent-visual-e2e-review.md#各表面的场景要求) | [共享 Modal](../../packages/client-ui/src/components/Modal.tsx)、[窗口 Portal](../../apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx)、[ConfirmationDialog](../../apps/desktop/src/renderer/src/components/ConfirmationDialog.tsx) | [useWorkbenchTabsClose](../../apps/desktop/src/renderer/src/hooks/useWorkbenchTabsClose.tsx) |
| 流式更新时留在原阅读位置 | [共同阅读行为](behavior/conversation-mode.md#共同阅读组件与完整原生内容)、[成本测量](../testing/strategy.md#对话阅读的验证与性能测量) | [跟随状态](../../packages/client-ui/src/lib/activity-autoscroll.ts)、[阅读提交](../../packages/client-ui/src/lib/use-conversation-record-layout.ts) | [Desktop Activity](../../apps/desktop/src/renderer/src/components/ActivityView.tsx)、[手机对话](../../apps/mobile/src/conversation/MobileConversationSurface.tsx) |
| 显示原操作的结果与未知状态 | [输入与回执的调用链](../architecture/conversation.md#输入与-mailbox) | [输入回执投影](../../packages/client-ui/src/lib/input-receipt-projection.ts)、[交互请求卡](../../packages/client-ui/src/components/AgentInteractionCard.tsx) | [Desktop Mote 输入回执](../../apps/desktop/src/renderer/src/components/MoteInputReceipt.tsx)、[Mobile 输入控制](../../apps/mobile/src/conversation/use-mobile-prompt-controller.ts)、[Mobile 邮箱](../../apps/mobile/src/conversation/MobileMailbox.tsx) |
| 排版、主题或图标 | [排版角色](presentation/shared-rules.md#排版角色与来源) · [主题与样式](presentation/shared-rules.md#主题与样式-ssot-规范) | [主题目录与解析](../../packages/client-ui/src/theme/catalog.ts)、[语义 CSS 投影](../../packages/client-ui/src/theme/css-variables.ts)、[Desktop 尺度](../../apps/desktop/src/renderer/src/styles/tokens.css) | [AppearanceSettingsPane](../../apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPane.tsx)；手机沿[手机尺度与 token](presentation/mobile-client.md#尺度与-token) |

组件负责原生控件、呈现与公共交互；值、校验、动作资格、保存及恢复仍由调用者和原业务 Owner 决定。改值从原来源与真实消费者核对，不在文档或局部样式再维护一份数值；检查方法沿[界面规则与真实行为](../testing/strategy.md#界面规则与真实行为)，实图验收沿[独立看图流程](../guides/agent-visual-e2e-review.md)。

## 更新与保全

新约束原位合入所属专题，同一事实只定义一次，其他正文链接到 owner。入口只维护主题导航，不按日期、Task 或聊天轮次追加完整需求。修改步骤与检查见[完成一次文档修改](../guides/document-truth-and-maintenance.md#完成一次文档修改)，过程资料的留存边界见[过程目录](../process-directories.md)。
