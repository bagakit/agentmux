# 设置目录

本文回答「有哪些设置、在哪里修改、CLI 能做到什么、继续开发该找谁」。目录按产品当前的设置分组组织；具体行为归[设置行为合同](design/behavior/settings-and-observation.md#设置页的信息架构)，视觉归[设置呈现合同](design/presentation/settings-and-observation.md#settings-控制工作面)，默认值和合法范围由字段源码及公开查询持有。

Settings 的 Overview 是导航和已保存摘要，不另存配置。侧栏、搜索、窄窗菜单与 Overview 都来自唯一 [Renderer 模块目录](../apps/desktop/src/renderer/src/components/settings/settings-modules.ts)；下面同时区分全局偏好、资源编辑、对象管理入口和只读信息。本文描述源码能力，不证明已安装版本包含它们。

## 查询与修改

CLI 先发现实际支持的键，再按精确键修改：

```sh
amux settings inspect
amux settings inspect notes
amux settings inspect continuity
amux settings set continuity.activeRecovery manual
amux settings inspect goals.defaultView
amux settings set goals.defaultView board
```

`settings inspect` 返回字段的当前有效值、默认值及适用的合法值，结果保持 `partial: true`：它是 scalar 偏好目录，不是整个 AppConfig 导出，也不包括全部资源或权限操作。表中的 **inspect / set** 均指这一对命令。领域前缀是否可查询由 [Main dispatcher](../apps/desktop/src/main/settings-control.ts) 明确接受；页面名称不能自动当作 CLI target，例如 Space 的密度键是 `projectRailDensity`，Prompts 使用资源命令。

GUI 偏好与 CLI 写入都经过唯一 [Main ConfigOwner](../apps/desktop/src/main/config-owner.ts)，字段类型在 [AppConfig](../apps/desktop/src/shared/contracts.ts)，持久化校验在 [ConfigStore](../apps/desktop/src/main/config-store.ts)。配置键及保存适配的源码入口见各表。资源命令的准确参数与结果查[公共能力来源导航](specs/public-capabilities.md)、实际 `--help` 和 [CLI 命令树](../packages/core/src/agentmux-cli-commands.ts)。

## Preferences

| 页面 | 可修改的内容或其他能力 | CLI 范围 | 字段与编辑入口 |
| --- | --- | --- | --- |
| My Profile | 本人称呼、头像、协作背景；是否分享给新 Agent。头像为界面资料，分享开关不代表访问隔离。 | inspect / set：`profile.displayName`、`profile.avatar`、`profile.about`、`profile.shareWithAgents` | [UI](../apps/desktop/src/renderer/src/components/settings/modules/profile.tsx)、[字段](../apps/desktop/src/shared/user-profile.ts)、[Main](../apps/desktop/src/main/settings/modules/profile.ts) |
| Appearance | App 主题身份与明暗、终端主题与字号、Source/Diff 编辑字号及继承选项；Notes 正文另设。 | inspect / set：`appearance.themeId`、`appearance.appAppearance`、`appearance.terminalTheme`、`appearance.terminalFontSize`、`appearance.editorFontSize` | [UI](../apps/desktop/src/renderer/src/components/settings/modules/appearance.tsx)、[Main](../apps/desktop/src/main/settings/modules/appearance.ts) |
| Notifications | 通知模式和声音。 | inspect / set：`notifications.mode`、`notifications.sound` | [UI](../apps/desktop/src/renderer/src/components/settings/modules/notifications.tsx)、[模式解析](../apps/desktop/src/shared/notification-presentation.ts)、[Main](../apps/desktop/src/main/settings/modules/notifications.ts) |
| General | 路径显示和复制使用绝对路径还是家目录缩写；本机数据与恢复说明为只读，崩溃日志按钮为诊断动作。Agent 可用性检查在后台继续，不作为工作面加载门禁。 | inspect / set：`copyPathsAsAbsolute`；`system crash-log inspect / reveal`。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/general.tsx)、[Main](../apps/desktop/src/main/settings/modules/general.ts) |
| Keyboard shortcuts | 查看快捷键、平台键位、命令和作用范围；当前只读。 | 没有自定义键位 setter。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/keyboard-shortcuts.tsx)、[快捷键注册表](../apps/desktop/src/renderer/src/lib/shortcut-registry.ts) |

### Appearance 的主题资源与观察

以下是 Appearance 复用的公开资源与观察能力，不是独立导航分区。

| 页面 | 可修改内容与只读事实 | CLI 范围 | 保存与事实 owner |
| --- | --- | --- | --- |
| Themes（Appearance） | 内置只读目录与完整自定义主题；坏记录保留并具名诊断，内置编辑另存副本。 | `settings themes ls / inspect / create / update / delete`；选择沿 `settings set appearance.themeId <ID>`。create/update 接受同 ID 完整主题文件或原 value；inspect 的 document 可由 `settings themes inspect <ID> --output FILE` 原子新建文件（不覆盖现有文件）。update 的 expected 为完整原值或同 ID 原文档；delete 的 expected 可为坏记录的原始 JSON，活动主题删除原子回默认。 | [共享 schema](../packages/client-ui/src/theme/schema.ts)、[目录](../packages/client-ui/src/theme/catalog.ts)、[资源 owner](../apps/desktop/src/main/settings-themes-control.ts)、[配置写入边界](../apps/desktop/src/main/theme-config.ts) |
| Appearance observation | 已提交的当前主题、明暗选择、显式终端配色与具名诊断的即时只读投影；手机使用本地系统明暗。 | `settings appearance watch` / `settings.appearance.watch` 沿现公开 stream 返回 initial 与有序 snapshot。取消只释放读者；断线保留最后已确认主题，重连重新取 initial。 | [通用 stream 合同](../packages/core/src/public-rpc-settings-observation.ts)、[原 Host owner 投影](../apps/host/src/theme-observation.ts)、[Mobile 消费](../apps/mobile/src/appearance/useHostAppearance.ts) |

## Agents

| 页面 | 可修改内容与只读事实 | CLI 范围 | 保存与事实 owner |
| --- | --- | --- | --- |
| Agent CLIs | Executor 名称、命令、参数、环境变量、AgentMux guide、头像颜色和徽标；创建时选择 Provider，已有 Executor 的 Provider 与身份不随编辑改变。Provider 能力目录和每个 Host 的命令可用性是观测事实。 | `settings executors ls / inspect / create / update / delete / refresh`；完整字段由资源 schema 校验，`args` 与 `env` 整体替换。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/agents.tsx)、[Core Executor 类型](../packages/core/src/types.ts)、[Desktop 头像字段](../apps/desktop/src/shared/contracts.ts)、[资源 owner](../apps/desktop/src/main/settings-resources-control.ts)、[可用性刷新](../apps/desktop/src/main/settings-executor-refresh-control.ts) |
| Session recovery | 原会话恢复时机、等待、自动恢复时间窗、确证退出后 resume、同操作复查与失败重试。恢复后的续行独立归 Automation；两页仍使用原 continuity 政策，各自保存所编辑字段。 | `settings inspect continuity`；本页 inspect / set：`continuity.activeRecovery`、`continuity.activeRecoveryDelayMs`、`continuity.confirmedIdleWindowMs`、`continuity.resumeAfterExit`、`continuity.recheckIntervalMs`、`continuity.recheckMaxAttempts`、`continuity.retryInitialDelayMs`、`continuity.retryMaxDelayMs`、`continuity.retryMaxAttempts`。时长键使用毫秒，GUI 使用秒并支持毫秒精度。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/continuity.tsx)、[Core 政策与默认](../packages/core/src/agent-session-recovery/continuity-contract.ts)、[Main](../apps/desktop/src/main/settings/modules/continuity.ts)、[行为](design/behavior/settings-and-observation.md#会话连续性设置) |

## Browser use

| 页面 | 可修改的内容或其他能力 | CLI 范围 | 字段与编辑入口 |
| --- | --- | --- | --- |
| Capsule | 独立服务状态与明确启停、新建默认、受管根及页面目录；导入静态／构建／SPA 内容，打开同一 Browser、复制对象链接与修改准确页面。停服务保留内容和草稿；更改默认或新建根不迁移旧页或改其权限。 | 同一 Core 的 `capsule runtime inspect / start / stop`、`capsule config inspect / update` 及原页面／操作命令；不新增 AppConfig scalar。 | [设置模块](../apps/desktop/src/renderer/src/components/settings/modules/capsule.tsx)、[服务管理](../apps/desktop/src/renderer/src/components/settings/CapsuleRuntimeSettings.tsx)、[页面编辑](../apps/desktop/src/renderer/src/components/settings/CapsuleSettingsPane.tsx)、[领域合同](design/behavior/local-page-hosting.md#settings-与页面级配置) |
| Browser | Agent 页面自动化总开关、安全自动释放后台页面；查看并忘记应用链接的记住选择。显式启用总开关不替代其他人工批准。 | inspect / set：`browser.agentAutomation`、`browser.automaticMemoryRelease`；`settings browser-links ls / forget` 只查看或忘记选择，没有 allow/deny setter。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/browser.tsx)、[scalar](../apps/desktop/src/main/settings/modules/browser.ts)、[链接 owner](../apps/desktop/src/main/settings-browser-control.ts) |
| Browser：资源目录 | 查看原 Browser 的冷描述、存活页面、释放或未知状态和保留原因；安全释放原页面或恢复原身份，不关闭 Region、不清除网站数据。部分观察不冒充完整资源结果。 | `browser targets`、`browser release`、`browser restore`，使用准确 Browser／navigation 身份及原操作回执。 | [目录 UI](../apps/desktop/src/renderer/src/components/settings/BrowserResources.tsx)、[资源 owner](../apps/desktop/src/main/browser-resource-directory.ts)、[公共能力](specs/public-capabilities.md) |
| Browser：连接与文件管理 | 连接外部浏览器扩展、停止共享准确页面；查看与丢弃保留的上传文件快照。这些是管理动作，不是偏好开关。 | `browser targets` 可发现已明确共享的目标；扩展配对及设置页的文件快照回收为 GUI 操作。 | [外部连接](../apps/desktop/src/renderer/src/components/settings/ExternalBrowserConnections.tsx)、[文件快照](../apps/desktop/src/renderer/src/components/settings/RetainedBrowserUploads.tsx)、[Browser 合同](design/behavior/browser-workface.md) |
| Agent takeover | 鼠标、头像标题、讨论框显示；tween 与点击波纹；内发光颜色、叠加、动画、宽度、强度、柔化及动画时长。内嵌模拟即时消费未保存草稿，明确保存后持久化；外观不授予或撤销操作资格。 | `settings inspect browser.agentControl`；inspect / set：`browser.agentControl.*` 的 16 个明确 scalar，不支持任意 CSS／脚本。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/browser-agent-control.tsx)、[默认与范围／共用效果](../apps/desktop/src/shared/browser-agent-control.ts)、[scalar](../apps/desktop/src/main/settings/modules/browser-agent-control.ts) |

`browser.agentControl` 的开关是 `showCursor`、`showCursorLabel`、`showDiscussion`、`pointerTween`、`clickRipple`、`glowEnabled`。`glowColor` 为六位 hex；`glowBlend` 为 normal／screen／multiply／overlay；`glowAnimation` 为 none／breathe／pulse。数字为 `pointerDurationMs`（0–1000 ms）、`clickDurationMs`（100–1500 ms）、`clickRadius`（8–64 px）、`glowWidth`（2–80 px）、`glowSoftness`（0–64 px）、`glowOpacity`（0.05–1）与 `glowDurationMs`（600–8000 ms）；除强度外均为整数。缺省值由共用字段源码与实际 inspect 回执持有，旧配置缺席不触发重置。讨论框开关控制自动显示，手动消息入口与原草稿保留；实时模拟不连接真实 Browser／Agent／Run。

Browser 工具栏的显隐在原 Browser 工作面的[工具栏偏好](../apps/desktop/src/renderer/src/components/BrowserToolbarPreferences.tsx)调整，不在 Settings Browser 页：CLI 支持 `browser.toolbar.selectElement`、`browser.toolbar.screenshot`、`browser.toolbar.devTools`、`browser.toolbar.viewport`、`browser.toolbar.saveBookmark`、`browser.toolbar.more` 的 inspect / set，也支持 `settings inspect browser.toolbar`。名称和顺序归 [Browser 工具栏字段表](../apps/desktop/src/shared/browser-toolbar.ts)，公开键归上表的 Browser scalar。

## Mote

| 页面 | 内容与作用范围 | CLI 范围 | 原 owner |
| --- | --- | --- | --- |
| Mote Club | 打开原 Club，管理准确 Mote 的名称、头像、角色、Profile 与 SOUL；不是本人 My Profile，也不是新增全局偏好。 | 不通过 scalar `settings set` 管理 Mote 内容。 | [设置入口](../apps/desktop/src/renderer/src/components/settings/modules/mote.tsx)、[Mote 身份与协作合同](design/behavior/motes-and-coordination.md) |

## Work

| 页面 | 可修改的偏好与管理入口 | CLI 范围 | 字段与原 owner |
| --- | --- | --- | --- |
| Space | 项目栏密度、Git History 提交行时间（默认显示）；Topics 打开原 Space，Projects 转到 Environments。Topic/Project 内容仍就地管理。 | inspect / set：`projectRailDensity`、`gitHistoryShowTime`；Topic 管理另走 `topic` 命令。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/space.tsx)、[Main](../apps/desktop/src/main/settings/modules/general.ts)、[空间合同](design/behavior/spaces-and-layout.md) |
| Focus | 近期活动窗口、回复摘要、Agent 预览、近期输入、链接打开位置，以及 Map 边界、逐级 LOD 与动态效果。当前时间尺、时区、筛选与布局留在 Focus 工作面。 | inspect / set：`focus.recentActivityHours`、`focus.replyLines`、`focus.previewTrigger`、`focus.recentInputs`、`focus.linkDestination`、`focus.mapMotion`、`focus.map.boundary`、`focus.map.levels.count`、当前各级 `focus.map.levels.N.form` / `information`，以及非首级的 `from` / `to`（N 从 1 编号）。级数由数组派生，合法范围与保存语义沿 owning 合同。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/focus.tsx)、[字段](../apps/desktop/src/shared/focus-map-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/focus-map.ts)、[Focus 合同](design/behavior/focus-context.md)、[Map 偏好合同](design/behavior/collaboration-map.md#地图呈现偏好) |
| Goals | 新打开工作面的默认列表/看板、已完成目标显隐；常用操作默认折叠；新需求首次让准确提需 Agent 担任 Supervisor（默认开启，保存不开始 Loop）。已打开工作面仍保留自己的临时视图选择。 | inspect / set：`goals.defaultView`、`goals.showFinished`、`goals.requesterAsSupervisor`、`goalsCommonActions.collapsed`；Goal 内容与执行另走 `goal` 命令。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/goals.tsx)、[字段](../apps/host/src/goals-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/goals.ts)、[Goals 合同](design/behavior/goals-and-demand.md) |
| Survey | 起始页标题、副标题、图标、本地／URL 背景图、交互背景开关、历史显隐与首屏卡片数量；查看系统当前 HTTP(S) 默认处理应用，显式请求系统设置选择 AgentMux。数量仅改变首屏呈现，可继续展开原记录；浏览、探索和来源仍由原工作面管理。 | inspect / set：`browser.startPage.title`、`browser.startPage.subtitle`、`browser.startPage.icon`、`browser.startPage.backgroundImage`、`browser.startPage.showHistory`、`browser.startPage.historyLimit`、`browser.startPage.interactiveBackground`；`settings browser-default inspect / open-settings` 查询系统事实或请求设置，不提供自动切换默认应用的 setter。 | [设置入口](../apps/desktop/src/renderer/src/components/settings/modules/survey.tsx)、[起始页字段](../apps/desktop/src/main/settings/modules/browser.ts)、[系统事实与动作](../apps/desktop/src/main/browser-default.ts)、[Browser 工作面](design/behavior/browser-workface.md) |
| Notes | Note 正文字号与阅读宽度；保留打开 Notes 的入口，Notebook、页面、来源与历史继续由原目录管理。 | inspect / set：`notes.fontSize`、`notes.contentWidth`；目录读写另走 `notebook ls / inspect / apply`。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/notes.tsx)、[字段](../apps/desktop/src/shared/notes-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/notes.ts)、[阅读偏好合同](design/behavior/settings-and-observation.md#设置页的信息架构) |

Goals 的常用操作引用、顺序与显隐在原 Goals 面管理，正文复用 Prompts 库，不另建指令副本。它们由 `goalsCommonActions.items` 持有，当前没有 scalar 或独立 CLI 目录 setter；[原配置写入](../apps/desktop/src/renderer/src/lib/goals-common-actions-config.ts) 与[常用操作界面](../apps/desktop/src/renderer/src/components/GoalsCommonActions.tsx)是入口。

## Mods

| 页面或 Toolkit Library 内的对象 | 可修改内容 | CLI 范围 | 字段与执行 owner |
| --- | --- | --- | --- |
| 官方 Performance | 状态栏显示开关与显示样式；资源结果为只读观测，官方脚本不可编辑。 | inspect / set：`toolkit.performance.enabled`、`toolkit.performance.statusBar`；`system metrics get / watch` 提供原观测事实，`toolkit` 提供工具读取与操作。 | [UI](../apps/desktop/src/renderer/src/components/settings/BuiltinPerformanceSettings.tsx)、[偏好字段](../apps/desktop/src/shared/toolkit-preferences.ts)、[Main scalar](../apps/desktop/src/main/settings/modules/toolkit.ts)、[执行 owner](../apps/desktop/src/main/toolkit-owner.ts) |
| 官方 Phone connection | 状态栏显示开关与显示样式；隐藏工具不撤销设备接入。官方脚本只读，设备管理转到 Remote 的 Mobile。 | inspect / set：`toolkit.mobileConnection.enabled`、`toolkit.mobileConnection.statusBar`；设备操作见下表。 | [UI](../apps/desktop/src/renderer/src/components/settings/BuiltinMobileConnectionSettings.tsx)、[偏好字段](../apps/desktop/src/shared/toolkit-preferences.ts)、[Main scalar](../apps/desktop/src/main/settings/modules/toolkit.ts) |
| 自定义 inline 工具 | 名称、图标、显示开关和样式、固定执行目录、主脚本及参数、动作按钮名称/脚本/参数；工具结果不作为偏好保存。 | `toolkit ls / inspect / create / update / delete / script / run / stop / action / watch`；资源写入支持各自的 expected 合同，不能用 scalar 任意路径修改。 | [工具编辑器](../apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx)、[公共 Toolkit 类型](../packages/core/src/toolkit.ts)、[自定义执行 owner](../apps/desktop/src/main/toolkit-custom-owner.ts) |
| 自定义本地扩展包 | 安装本地包目录，配置启用、显示样式、固定执行目录与参数；名称、图标、脚本和动作由可编辑的包文件提供。 | `toolkit install <id> --path <directory>`，以及原 Toolkit 查询、更新和执行命令；不是一次性复制脚本。 | [包编辑器](../apps/desktop/src/renderer/src/components/settings/ToolkitPackageEditor.tsx)、[包读取](../apps/desktop/src/main/toolkit-package.ts)、[本地扩展包合同](design/behavior/settings-and-observation.md#toolkit-本地扩展包) |

Toolkit Library 的唯一[设置模块](../apps/desktop/src/renderer/src/components/settings/modules/toolkit.tsx)组合表中的工具入口。Auth 用量工具属于可编辑的本地用户包，业务逻辑在包文件中；AgentMux 提供通用加载、配置、执行与结果能力，不把特定账户业务实现为固定设置。官方工具与自定义工具的边界见[Toolkit 行为合同](design/behavior/settings-and-observation.md#toolkit-与官方-performance-工具)。

## Message Tool

| 页面 | 可修改内容与管理动作 | CLI 范围 | 原 owner |
| --- | --- | --- | --- |
| User Input | 新挂载的 Message Tool 初始一行／两行，默认一行；快捷输入可分别配置 commands（默认 `/`）、skills（默认 `$`）、Agents／files（默认 `@`）前缀和 prompt keyword 候选。空前缀关闭该快捷输入但保留工具按钮。发送、steer、换行、历史和候选键盘操作沿只读手册。 | inspect / set：`messageToolInitialLayout`（`one-line` / `two-line`）、`messageToolCompletion.command`／`.skill`／`.reference`（literal 符号前缀，空字符串关闭）及 `.keywords`（`true`／`false`）；支持 `settings inspect messageToolCompletion`。前缀互不相同且不互为前缀。按键沿原 `help.shortcuts`，无自定义键位 setter；复用原 settings RPC／CLI。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/message-tool.tsx)、[共享按键声明](../packages/client-ui/src/lib/composer-keyboard.ts)、[Main 原字段](../apps/desktop/src/main/settings/modules/general.ts) |
| A2A | 后台收件 Agent 的新来信面向用户的系统提醒：跟随全局、静默、提示。提示在全局关闭时使用默认时长；声音始终沿全局 Notifications。不改 Agent 的入箱、空闲引用通知或主动取信，不以提醒代签已读。 | `settings inspect a2a`；inspect / set：`a2a.notifications`（`follow-global`／`silent`／`notify`）。真实来信事实沿同一 Core journal 与 `runtime.events` 观察，投递和通知回执不重复弹窗，初始与断线补读不回放旧信。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/a2a.tsx)、[默认与解析](../apps/desktop/src/shared/a2a-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/a2a.ts) |
| Automation | 恢复后续行与 Provider 不支持中断识别时的 active 兜底；持续推进新任务默认周期／Prompt，日历安排默认时区、quiet follow-up 默认策略。保存不创建、启停或改写任务，不改已有草稿／在途操作；当前 Agent 任务操作仍在 Progress。 | 续行复用 `continuity.continuationEnabled`、`continuity.activeInterruptionFallback`；新默认用 `settings inspect automation` 与 inspect / set：`automation.progressIntervalMs`、`.progressPrompt`、`.calendarTimezone`、`.checkInSilenceMs`、`.checkInMinIntervalMs`、`.checkInDailyBudget`、`.checkInQuietStart`、`.checkInQuietEnd`。时长键用毫秒，空时区在新表单打开时解析系统时区。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/automation.tsx)、[默认与校验](../apps/desktop/src/shared/automation-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/automation.ts)、[Core quiet policy](../packages/core/src/agent-schedule.ts) |
| Prompts | 名称、正文、关键字、Provider 绑定、状态可用范围与快捷回复图标；引用继续指向同一条保存的 Prompt。 | `settings prompts ls / inspect / create / update / delete`；inspect 可用精确 ID 或 `--keyword`。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/prompts.tsx)、[ComposerShortcut 字段](../apps/desktop/src/shared/contracts.ts)、[资源 owner](../apps/desktop/src/main/settings-resources-control.ts)、[Prompt 合同](design/behavior/settings-and-observation.md#设置页的信息架构) |
| amux Protocols | 本版本可读协议的用途、语法、原始 wire 示例及共享消息卡预览；只读目录、搜索和摘要直接消费同一 Core 定义，展开后才挂载预览，不读取用户历史或执行协议提示。 | 本地 `settings --skill` 提供同源目录；没有新 RPC、配置键或保存动作，不声明远端 Runtime 或旧安装支持。 | [设置模块](../apps/desktop/src/renderer/src/components/settings/modules/amux-protocols.tsx)、[Core 目录](../packages/core/src/agent-message-render.ts)、[格式合同](specs/amux-protocol.md#通用命名协议与阅读目录) |

五项各自独立，Prompts 与 amux Protocols 用途不同，不合并页面。Prompt 仍是同一可复用资源库；Goals、快捷回复及状态动作保留原 ID 引用，分组不建立新库。全局 Keyboard shortcuts 也显示同源 Message Tool 按键；Notifications 保留在 Preferences。

## Remote

远程管理的目标、拓扑、监控与维护需求由 [Remote 管理 PRD](design/behavior/remote-management.md) 持有。下表只记录当前设置与 CLI 的实际入口，不表示目标拓扑或新增监控已经实现。

| 页面 | 可修改内容与管理动作 | CLI 范围 | 原 owner |
| --- | --- | --- | --- |
| Hosts | SSH 环境名称、hostname/alias、用户、端口、密钥路径、服务命令和 socket 路径；Runtime ID 为可信连接所得的只读身份。拓扑 / 列表按准确 Host 管理已有 Project、原 Session、执行器、连接与维护；运行观察不新增配置字段。 | `settings hosts ls / inspect / test / upgrade-check / upgrade / upgrade-inspect`；`settings workspaces register` 登记已有目录。当前没有 Host 配置的 create/update/delete CLI。登记不自动运行 Git、聚焦或启动 Agent。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/hosts.tsx)、[Host/Workspace 字段](../apps/desktop/src/shared/contracts.ts)、[测试与读取](../apps/desktop/src/main/settings-hosts-control.ts)、[分源运行观察](../packages/core/src/host-runtime-observation.ts)、[目录登记](../apps/desktop/src/main/settings-workspace-add-control.ts)、[升级事务](../apps/desktop/src/main/settings-hosts-upgrade.ts) |
| Remote execution | 选择工具项目并进入原 Launcher，按需展开同源操作指南；按当前客户端保留的 Session 查找双端绑定，打开原工作面，读取工具连接与 Provider notices。无新增配置字段。 | `agent open --execution-workspace B --tool-workspace A` 复用原空间与创建参数；`agent execution --help` 读取同一使用指南；`binding` 读取准确绑定，`inspect` 仅查询原工具操作。 | [使用指南](../packages/core/guides/actions/remote-execution.md)、[UI](../apps/desktop/src/renderer/src/components/settings/modules/remote-execution.tsx)、[绑定 owner](../packages/core/src/agent-execution-coordinator.ts)、[原观察](../apps/desktop/src/renderer/src/components/AgentToolExecutionNotice.tsx) |
| Mobile | 原手机／浏览器连接链接、设备身份、活动与撤销。接入权限不限于聊天；移动端通信与展示复用共同对话语义。 | `device ls / link / revoke`；已认证设备沿 `device hello` 命名自身。 | [原设备页](../apps/desktop/src/renderer/src/components/settings/DeviceManagementSettings.tsx)、[公共设备合同](../packages/core/src/public-rpc-device.ts)、[Desktop 接线](../apps/desktop/src/main/device-management-ipc.ts)、[原 Host Authority](design/behavior/public-control.md#手机版-relay-连接) |

## Conversation Channels

本节按[已确认的分类](design/behavior/settings-and-observation.md#设置页的信息架构)列出入口范围：InApp 是 App 内对话模式，Mobile 设备管理归 Remote。可编辑偏好与只读参考分别沿下表的原 owner，不由导航名称产生新字段或控制资格。

| 页面 | 可修改的内容与管理入口 | CLI 范围 | 原 owner |
| --- | --- | --- | --- |
| InApp | App 内对话模式说明与原配置入口：User Input、Appearance 可编辑共享偏好，Keyboard shortcuts 与 amux Protocols 是只读参考。Show Activity／Show Terminal 仍在原 Agent 输入工具栏，作用于准确 Session；没有独立的全局 InApp 偏好。 | 逐会话查询与切换沿 `agent view`；共享偏好沿原 settings scalar，参考目录没有 setter，不新增 InApp RPC／CLI。 | [同一 Session 的对话模式](design/behavior/conversation-mode.md#范围与唯一归属)、[原工具栏](../apps/desktop/src/renderer/src/components/AgentComposerTools.tsx)、[有效显示偏好](../apps/desktop/src/renderer/src/lib/session-presentation.ts)、[公共显示操作](../apps/desktop/src/renderer/src/lib/workface-agent-view.ts) |
| Lark | 整个服务的自动双向收发开关、每个机器人应用的配置与原请求查询；原 Region 与 Agent 更多菜单消费同一 service policy。 | `connection service get / configure --input FILE\|- / inspect --operation-id ID`；原应用与接入管理沿 `connection`、`connection enrollment`。 | [设置模块](../apps/desktop/src/renderer/src/components/settings/modules/lark.tsx)、[总开关](../apps/desktop/src/renderer/src/components/settings/ConnectorServiceControl.tsx)、[原 ConnectionHost](../packages/connectors/src/connection-host.ts)、[服务合同](../packages/core/src/connection-service-contract.ts) |
| Discord | 原安全凭据入口保存 Bot token 的 opaque 引用、准确 Application ID、当前连接检查、平台接入说明与本地 Channel metadata 管理；与其它平台共享原自动同步服务。 | 原 `connection ls/inspect/test`、`connection service` 与 `connection metadata`；不新增 Discord 业务命令。 | [平台模块](../apps/desktop/src/renderer/src/components/settings/modules/discord.tsx)、[原连接设置](../apps/desktop/src/renderer/src/components/settings/ExternalConnectionsSettings.tsx)、[Channel metadata](../packages/core/src/channel-metadata-contract.ts) |

UI 导航为 `inapp-conversation`、`lark`、`discord` 和 Remote 的 `mobile`；目录与全部真实入口同步更新，不提供旧 UI 路由 aliases。产品分组不合并 Session 显示偏好、设备与应用的身份、权限或持久化；公共 `agent.view`、`device.*`、`connection.*`、原操作与配置键保持各自合同。Lark 页的外部自动收发开关不关闭 App 内或手机对话，页内继续准确辨认 Feishu／Lark 平台。

## 维护与新增

新增或删除真实设置时，在同一改动更新本目录相应行；默认值、范围和保存规则留在已有 owner，不在表格再定义一份。新增源码模块、字段、Main scalar 与实际 GUI/CLI 消费的操作方式见[给功能追加设置](settings-module-contributions.md)。跨环境和权限相关能力遵循[公共能力贡献约定](guides/public-capability-contributions.md)，管理入口不自动创造配置字段或 CLI。

核对时分别读取 Renderer 的 `settingsModules`、Main 的 `scalarSettings`、资源/连接 owner 与 CLI 命令树：页面出现不等于字段可写，公开资源命令存在不等于所有 GUI 管理动作都有 CLI，源码存在也不等于用户已经安装。
