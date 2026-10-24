# Mobile 与既有需求的对齐索引

手机端沿用既有行为与呈现专题，不另建一套产品规则。本页回答手机上哪些子能力复用原合同、哪些只覆盖一部分、哪些没有入口，以及哪些还缺核对；完整要求仍从[交互专题](agentmux-desktop-interaction.md)和[呈现专题](agentmux-surface-density.md)读取。

以下以手机浏览器中的 Web client 为对照面，依据列出的产品消费者描述源码接线范围。源码、发布资源、已安装 Host 和手机实际载入的网页是不同对象；本表不证明当前设备已更新或实机验收通过。原生 iOS／Android 包装的文件选择、前后台、键盘和存储行为另需设备验证，入口见 [Mobile 接入说明](../../apps/mobile/README.md)。

## 怎样读对齐程度

| 标记 | 本页的含义 |
| --- | --- |
| 基本一致 | 仅所列子能力共用原 owner、协议或呈现组件，未另造手机语义；不代表整个专题已完成。 |
| 部分对齐 | 已有具体产品入口，但列明的桌面能力、交互或呈现范围尚未覆盖。 |
| 未支持 | 所列手机入口或操作当前没有提供；不据此推断 Host／Core 缺少该能力。 |
| 待验证 | 还没有足够证据判断对应消费链、行为或设备结果；不能当作已支持或未支持。 |

同一专题可有多个标记。差异应落到具体能力，不能用整行“已对齐”掩盖子能力缺口；任务进度、验收与安装结果仍沿[原事实来源](../README.md#当前事实从哪里读取)，不在本页维护第二份交付状态。

## 行为与呈现专题覆盖

| 需求 owner | 呈现 owner | 手机端的具体范围与差异 | 产品消费者来源 |
| --- | --- | --- | --- |
| [共同原则与 Owner](behavior/shared-rules.md) | [共同视觉与样式](presentation/shared-rules.md) | **基本一致：**语义图标与 Host 主题来源共用。**部分对齐：**窄屏布局有专用样式；全局审美、触控与低资源结果不能由共用组件推定。 | [Host 外观读取](../../apps/mobile/src/appearance/useHostAppearance.ts)、[主导航](../../apps/mobile/src/navigation/MobilePrimaryNavigation.tsx)、[手机样式](../../apps/mobile/src/mobile.css) |
| [空间、导航与工作面](behavior/spaces-and-layout.md) | [空间与布局](presentation/spaces-and-layout.md) | **部分对齐：**手机按[聊天优先顺序](behavior/public-control.md#手机对象身份与工作面)恢复原对话，Mote／Focus／Space、Topics、Goals 保留原位置与设备阅读路由；项目和对象外观消费原目录。手机没有照搬桌面的同时多栏布局与全部空间编排入口。 | [根工作面](../../apps/mobile/src/MobileApp.tsx)、[空间目录](../../apps/mobile/src/navigation/MobileSpatialNavigation.tsx)、[设备路由](../../apps/mobile/src/recovery/presentation-route.ts) |
| [Launcher 工作起点](behavior/workface-launcher.md) | [空间与布局](presentation/spaces-and-layout.md) | **部分对齐：**可选原 Space、Zone、Executor 和初始指令创建 Agent；唯一展示位置的 Launcher 可在原空 Region 创建，并核对原操作。**未支持：**完整桌面 Launcher 的环境编辑、工具开合和多种工作面创建入口；同一 Tab／Region 的多个展示位置尚无手机选择入口，原服务明确拒绝歧义，不改投其他空位。 | [新建 Agent](../../apps/mobile/src/navigation/MobileAgentCreate.tsx)、[空间目录](../../apps/mobile/src/navigation/MobileSpatialNavigation.tsx) |
| [知识工作流](behavior/knowledge-workflows.md) | [Survey／Recall 呈现](presentation/spaces-and-layout.md) | **部分对齐：**Survey 列表和原 Zone 工作面、Topic 成果与来源、原 Note 文件阅读／编辑已有消费者。独立 Recall／Notebook 导航、完整知识收集与协同编辑流程的手机覆盖仍需逐项核对。 | [Survey](../../apps/mobile/src/survey/MobileSurveySurface.tsx)、[原内容](../../apps/mobile/src/navigation/MobileRegionContent.tsx)、[Note](../../apps/mobile/src/navigation/MobileNoteFile.tsx)、[Topic 知识](../../apps/mobile/src/topics/MobileTopicKnowledge.tsx) |
| [Mote 与协调](behavior/motes-and-coordination.md) | [Mote 呈现](presentation/motes-and-coordination.md)、[手机目录呈现](presentation/public-control.md#手机版-relay-连接的呈现) | **部分对齐：**[手机目录](behavior/public-control.md#手机对象身份与工作面)以横排切换 Mote，当前 Mote 直接提供 Profile、主 Agent 与 Agents；主 Agent 入口常驻，Profile 不作为树子项；已保存主会话显式点击后沿原 Core 恢复，配置未确认时保原引用及核对路径。原资料、快捷配置与文件编辑沿同一资源。**未支持：**无默认主会话时的一键创建并保存绑定；可先明确创建，再在 Profile 选择原 Agent 并保存。日历、合作评估、主动点子等完整覆盖仍待核对。 | [手机 Mote 目录](../../apps/mobile/src/navigation/MobileSpatialNavigation.tsx)、[Mote 资料](../../apps/mobile/src/navigation/MobileMoteProfile.tsx)、[快捷编辑](../../apps/mobile/src/navigation/MobileMoteQuickEditor.tsx)、[资料文件编辑](../../apps/mobile/src/navigation/MobileMoteFileEditor.tsx) |
| [Goals 与 Demand](behavior/goals-and-demand.md) | [Goals 与需求面](presentation/goals-and-demand.md) | **部分对齐：**Goals 列表、讨论、创建／编辑、对齐确认、结果接受、关联会话与证据调用原公共能力。完整 Demand／Board／Task 工作流没有因 Goals 入口存在而自动对齐。 | [Goals](../../apps/mobile/src/goals/MobileGoalsSurface.tsx)、[对齐与接受](../../apps/mobile/src/goals/MobileGoalAlignment.tsx)、[目标操作](../../apps/mobile/src/goals/MobileGoalActions.tsx) |
| [Focus 执行上下文](behavior/focus-context.md) | [Focus 执行台](presentation/focus-context.md) | **部分对齐：**按原 Host／Project 呈现分组与 Agent 名称、recap、状态，可打开原对话及对象菜单。完整焦点历史、时间音轨、个性化与多工作面预览不在现有手机列表范围内。 | [Focus 与项目分组](../../apps/mobile/src/navigation/MobileSpatialNavigation.tsx)、[Agent 行](../../apps/mobile/src/navigation/MobileAgentRow.tsx) |
| [Focus Map](behavior/collaboration-map.md) | [Focus Map 呈现](presentation/collaboration-map.md) | **未支持：**手机根导航没有提供空间地形与协作关系地图入口。普通项目列表不等于 Map，也不替代其稳定阅读与层级要求。 | [根导航入口](../../apps/mobile/src/MobileApp.tsx)、[主导航](../../apps/mobile/src/navigation/MobilePrimaryNavigation.tsx) |
| [Session 与恢复](behavior/session-recovery.md) | [Session 与恢复呈现](presentation/session-recovery.md) | **部分对齐：**保留设备工作面与草稿，提供原 Agent 的显式恢复及未确认操作核对。**待验证：**当前安装与真实手机跨 Host 重启、设备重开后的完整恢复结果；不能用路由已保存代签 Durable Runtime 健康。 | [设备工作面](../../apps/mobile/src/recovery/device-workface.ts)、[恢复面板](../../apps/mobile/src/recovery/MobileRecoveryPanel.tsx)、[原 Agent 操作](../../apps/mobile/src/conversation/MobileAgentActions.tsx) |
| [对话视图](behavior/conversation-mode.md) | [对话呈现](presentation/conversation-mode.md) | **基本一致：**共同消息、原生记录与资源阅读消费共享组件和原记录协议。**部分对齐：**手机顶部直接切换 Terminal，Goal 与 History 采用阅读区浮动入口；专用容器、阅读导航与可见内容有独立接线，全部原生内容和真实设备连续阅读仍需按原验收场景核对。 | [手机对话](../../apps/mobile/src/conversation/MobileConversationSurface.tsx)、[原对话读取](../../apps/mobile/src/conversation/use-hosted-conversation.ts)、[共享 Client UI](../../packages/client-ui/README.md) |
| [输入与邮箱](behavior/conversation-input.md) | [输入与邮箱呈现](presentation/conversation-input.md) | **部分对齐：**原 Composer、草稿、附件发送、问题答复、通信记录、输入历史与 Skills 已接入。Commands 的配置来源和历史入口差异见下表；投递未知不因界面关闭或重开而变成可重发。 | [对话与 Composer](../../apps/mobile/src/conversation/MobileConversationSurface.tsx)、[输入控制器](../../apps/mobile/src/conversation/use-mobile-prompt-controller.ts)、[通信记录](../../apps/mobile/src/conversation/MobileMailbox.tsx) |
| [Provider、身份与输入能力](behavior/agent-capabilities-and-messaging.md) | [身份与消息呈现](presentation/agent-capabilities-and-messaging.md) | **部分对齐：**Agent 行／菜单可复制原身份链接、查看用量，状态和原生输入能力消费原事实。完整 Provider 设置、注入上下文管理与 Activity 详情不在现有手机菜单覆盖内。 | [原 Agent 菜单](../../apps/mobile/src/conversation/MobileAgentActions.tsx)、[用量](../../apps/mobile/src/conversation/MobileAgentUsage.tsx)、[输入交互控制器](../../apps/mobile/src/conversation/use-mobile-interaction-controller.ts) |
| [A2A 协作](behavior/a2a-collaboration.md) | [身份与消息呈现](presentation/agent-capabilities-and-messaging.md)、[输入与邮箱](presentation/conversation-input.md) | **部分对齐：**可在原会话阅读共享来源、消息和信箱回执。手机查看输入记录不等于具备完整广播、spawn、派发等待和协作图管理入口；A2A 与人工输入的来源仍由原协议区分。 | [通信记录](../../apps/mobile/src/conversation/MobileMailbox.tsx)、[对话消费者](../../apps/mobile/src/conversation/MobileConversationSurface.tsx) |
| [Terminal 阅读与成本](behavior/terminal-reading.md) | [Terminal 呈现](presentation/terminal-reading.md) | **部分对齐：**终端观看、历史 reader、手势、明确接管输入／尺寸和原回执已有手机消费者。**待验证：**实际活跃会话的连续向上阅读、手机性能和前后台恢复，不以静态内容或普通对话阅读代签。 | [终端 Viewer](../../apps/mobile/src/terminal/MobileTerminalViewer.tsx)、[reader](../../apps/mobile/src/terminal/reader.ts)、[控制](../../apps/mobile/src/terminal/control.ts)、[手势](../../apps/mobile/src/terminal/gestures.ts) |
| [Browser 工作面](behavior/browser-workface.md) | [Browser 呈现](presentation/browser-workface.md) | **部分对齐：**按原 browserId 查询当前网址，并可在手机打开 HTTP(S) 地址。**未支持：**手机上呈现同一 Native Browser viewport 及桌面控制权／框选交互；打开同一网址不等于接管原 Browser。 | [原 Browser 地址读取](../../apps/mobile/src/navigation/MobileRegionContent.tsx)、[手机外部链接](../../apps/mobile/src/platform/browser.tsx) |
| [Capsule 持久页面](behavior/local-page-hosting.md) | [Capsule 呈现](presentation/local-page-hosting.md) | **待验证：**手机浏览普通 URL 的入口不足以证明原 Capsule 身份、模式、HITL 请求和答复回执链路；本页暂不将普通链接阅读算作 Capsule 对齐。 | [原内容入口](../../apps/mobile/src/navigation/MobileRegionContent.tsx)、[根工作面](../../apps/mobile/src/MobileApp.tsx) |
| [文件、编辑与 Git](behavior/files-and-git.md) | [文件与 Git 呈现](presentation/files-and-git.md) | **部分对齐：**可读原资源与 Markdown，Note 编辑沿原修订和文件公共能力。**未支持：**手机完整 Explorer／代码编辑器、分支／diff／提交及 worktree 收尾操作入口。 | [原内容](../../apps/mobile/src/navigation/MobileRegionContent.tsx)、[Note 编辑](../../apps/mobile/src/navigation/MobileNoteFile.tsx)、[目录树](../../apps/mobile/src/navigation/MobileSpaceDirectory.tsx) |
| [设置与观测](behavior/settings-and-observation.md) | [设置与观测呈现](presentation/settings-and-observation.md) | **部分对齐：**设备主页、连接、提醒收起／恢复、网页版本与诊断有菜单入口。完整 Desktop Settings、Activity、资源面板与 Toolkit 工作流未整体移植，菜单中没有的设置不能假定手机可改。 | [设置菜单](../../apps/mobile/src/MobileApp.tsx)、[提醒](../../apps/mobile/src/notices/MobileNotice.tsx)、[网页诊断](../../apps/mobile/src/mobile-web/MobileWebDiagnostics.tsx) |
| [原生层](behavior/native-desktop.md) | [共同控件与层级](presentation/shared-rules.md) | **未支持：**手机 Web client 没有本机 Mac 应用／窗口、辅助功能、键鼠及系统截图控制面。手机文件选择、复制与链接消费浏览器平台适配；不能冒称原 Host 的原生动作完成。 | [浏览器平台适配](../../apps/mobile/src/platform/browser.tsx)、[根菜单](../../apps/mobile/src/MobileApp.tsx) |
| [Remote 管理](behavior/remote-management.md) | [Remote 管理呈现](presentation/settings-and-observation.md#remote-管理拓扑) | **部分对齐：**手机具备连接原 Host 的入口与连接状态。**未支持：**完整 Remote 拓扑、环境监控和维护工作台；连接页不等于 Remote 管理页。 | [连接入口](../../apps/mobile/src/connection/MobileConnectionRoot.tsx)、[根菜单](../../apps/mobile/src/MobileApp.tsx) |
| [Remote 应用授权同步](behavior/remote-application-access.md) | 沿 [Remote／设置呈现](presentation/settings-and-observation.md) | **待验证：**手机连接成功只证明该连接，不证明指定应用的授权差异、同步、验真与未知恢复；尚未核到对应手机产品消费链。 | [现有连接面范围](../../apps/mobile/src/connection/MobileConnectionRoot.tsx) |
| [公共控制与跨客户端](behavior/public-control.md) | [公共控制呈现](presentation/public-control.md) | **部分对齐：**手机通过 Hosted Client／原公共 RPC 消费对象、创建、恢复和业务回执，不另持有 Runtime。完整对象 CLI 覆盖并不自动等于手机 GUI 覆盖；手机专属边界以原专题的手机版章节为准。 | [Mobile 接入说明](../../apps/mobile/README.md)、[根工作面 RPC 消费](../../apps/mobile/src/MobileApp.tsx)、[Hosted Client](../../packages/core/src/hosted.ts) |

## 输入区的可发现性与具体差异

这里列用户在手机输入区最容易遇到的差异，行为与呈现要求仍分别归[输入与邮箱](behavior/conversation-input.md)和[输入工具与邮箱呈现](presentation/conversation-input.md)，手机接入归[公共控制](behavior/public-control.md#手机版-relay-连接)。

| 子能力 | 对齐情况与准确边界 | 当前消费来源 |
| --- | --- | --- |
| Provider 命令与自定义 Commands | **基本一致（候选与插入）：**Provider 命令与原 Desktop 保存的自定义 Prompt 共用候选、Provider 绑定、来源分组和语义正文，显式选择只填原草稿。手机按需读取原配置，不另存提示词；手机编辑配置不在本项范围。 | [手机工具](../../apps/mobile/src/conversation/MobileMessageTools.tsx)、[手机候选接线](../../apps/mobile/src/conversation/MobileConversationSurface.tsx)、[Desktop 候选来源](../../apps/desktop/src/renderer/src/lib/use-composer-candidates.tsx) |
| 历史发送／输入记录 | **部分对齐：**现有通信记录内已接原 Agent 输入历史、搜索、复制与回填；这不是 A2A 已发信箱的同义词。入口已具名标识“历史”，与通信记录共用一处；桌面输入框的方向键历史快捷召回尚未接入手机。回填消费原记录，不代表重新发送，也不能把本机待确认项说成已送达历史。 | [MobileMailbox](../../apps/mobile/src/conversation/MobileMailbox.tsx)、[历史回填](../../apps/mobile/src/conversation/MobileConversationSurface.tsx)、[共享历史列表](../../packages/client-ui/src/components/InputHistoryList.tsx)、[Desktop 召回](../../apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx) |
| 图片与待上传附件 | **部分对齐：**发送时会提交本次捕获的待上传附件，沿原目标、正文与操作回执保留未知结果。**待验证：**当前手机／Host 版本、浏览器文件选择与网络环境的实机上传结果。 | [附件](../../apps/mobile/src/conversation/MobileAttachments.tsx)、[输入控制器](../../apps/mobile/src/conversation/use-mobile-prompt-controller.ts)、[附件事务](../../apps/mobile/src/conversation/attachments.ts) |
| Warning 的退出与恢复入口 | **基本一致：**手机提醒组件提供收起，固定菜单入口恢复显示。这里只改变提醒呈现，不取消原操作、不改写健康状态或重试结果；是否每个新提醒都实际接入仍需从消费者核对。 | [提醒组件与恢复](../../apps/mobile/src/notices/MobileNotice.tsx)、[菜单消费](../../apps/mobile/src/MobileApp.tsx) |

## 相邻协议与诊断来源

这些文档同样约束手机消费，但不在本页重写接口或增设独立手机版协议：

| 读者问题 | 原 owner 与手机对照范围 |
| --- | --- |
| 跨模块证据、错误码、诊断与采样 | [Diagnostic Evidence 设计](diagnostic-evidence.md)、[协议](../specs/diagnostic-evidence-protocol.md)。手机网页已有[诊断报送](../../apps/mobile/src/mobile-web/reporter.ts)与[版本观察](../../apps/mobile/src/mobile-web/use-mobile-web-observation.ts)；完整历史／采样覆盖仍沿原 owner 核对。 |
| 对话来源、原记录、答复和资源 | [对话架构](../architecture/conversation.md)、[对话协议](../specs/conversation-protocol.md)、[客户端架构](conversation-client-architecture.md)。共同协议不自动证明每个手机阅读交互已验收。 |
| 对象身份链接、信封与分享格式 | [amux 可读协议](../specs/amux-protocol.md)。复制原 Agent 身份链接与导航到某次空间呈现是不同能力。 |
| 公共方法与 CLI 的准确合同 | [公共能力源码入口](../specs/public-capabilities.md)、[贡献约定](../guides/public-capability-contributions.md)。已有 RPC 能复用时，不为手机再造同名控制链。 |
| 设置项目与管理范围 | [设置目录](../settings-catalog.md)。目录包含某设置不代表手机已有对应编辑入口。 |

新增或修正手机需求时，先在对应行为／呈现 owner 原位表达结果，再更新本页的引用与差异。没有证据的项保留“待验证”；候选验收、main 集成、资源发布和用户设备载入分别向各自事实来源核对。
