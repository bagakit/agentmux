# 设置目录

本文回答「有哪些设置、在哪里修改、CLI 能做到什么、继续开发该找谁」。目录按产品当前的设置分组组织；具体行为归[设置行为合同](design/behavior/settings-and-observation.md#设置页的信息架构)，视觉归[设置呈现合同](design/presentation/settings-and-observation.md#settings-控制工作面)，默认值和合法范围由字段源码及公开查询持有。

Settings 的 Overview 是导航和已保存摘要，不另存配置。侧栏、搜索、窄窗菜单与 Overview 都来自唯一 [Renderer 模块目录](../apps/desktop/src/renderer/src/components/settings/settings-modules.ts)；下面同时区分全局偏好、资源编辑、对象管理入口和只读信息。本文描述源码能力，不证明已安装版本包含它们。

## 查询与修改

CLI 先发现实际支持的键，再按精确键修改：

```sh
amux settings inspect
amux settings inspect notes
amux settings inspect goals.defaultView
amux settings set goals.defaultView board
```

`settings inspect` 返回字段的当前有效值、默认值及适用的合法值，结果保持 `partial: true`：它是 scalar 偏好目录，不是整个 AppConfig 导出，也不包括全部资源或权限操作。表中的 **inspect / set** 均指这一对命令。领域前缀是否可查询由 [Main dispatcher](../apps/desktop/src/main/settings-control.ts) 明确接受；页面名称不能自动当作 CLI target，例如 Space 的密度键是 `projectRailDensity`，Prompts 使用资源命令。

GUI 偏好与 CLI 写入都经过唯一 [Main ConfigOwner](../apps/desktop/src/main/config-owner.ts)，字段类型在 [AppConfig](../apps/desktop/src/shared/contracts.ts)，持久化校验在 [ConfigStore](../apps/desktop/src/main/config-store.ts)。配置键及保存适配的源码入口见各表。资源命令的准确参数与结果查[公共能力来源导航](specs/public-capabilities.md)、实际 `--help` 和 [CLI 命令树](../packages/core/src/agentmux-cli-commands.ts)。

## Preferences

| 页面 | 可修改的内容或其他能力 | CLI 范围 | 字段与编辑入口 |
| --- | --- | --- | --- |
| My Profile | 本人称呼、头像、协作背景；是否分享给新 Agent。头像为界面资料，分享开关不代表访问隔离。 | inspect / set：`profile.displayName`、`profile.avatar`、`profile.about`、`profile.shareWithAgents` | [UI](../apps/desktop/src/renderer/src/components/settings/modules/profile.tsx)、[字段](../apps/desktop/src/shared/user-profile.ts)、[Main](../apps/desktop/src/main/settings/modules/profile.ts) |
| Appearance | App 外观、终端主题与字号、Source/Diff 编辑字号及继承选项；Notes 正文另设。 | inspect / set：`appearance.appAppearance`、`appearance.terminalTheme`、`appearance.terminalFontSize`、`appearance.editorFontSize` | [UI](../apps/desktop/src/renderer/src/components/settings/modules/appearance.tsx)、[Main](../apps/desktop/src/main/settings/modules/appearance.ts) |
| Notifications | 通知模式和声音。 | inspect / set：`notifications.mode`、`notifications.sound` | [UI](../apps/desktop/src/renderer/src/components/settings/modules/notifications.tsx)、[模式解析](../apps/desktop/src/shared/notification-presentation.ts)、[Main](../apps/desktop/src/main/settings/modules/notifications.ts) |
| Browser | Agent 页面自动化总开关；查看并忘记应用链接的记住选择。显式启用总开关不替代其他人工批准。 | inspect / set：`browser.agentAutomation`；`settings browser-links ls / forget` 只查看或忘记选择，没有 allow/deny setter。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/browser.tsx)、[scalar](../apps/desktop/src/main/settings/modules/browser.ts)、[链接 owner](../apps/desktop/src/main/settings-browser-control.ts) |
| Browser：连接与文件管理 | 连接外部浏览器扩展、停止共享准确页面；查看与丢弃保留的上传文件快照。这些是管理动作，不是偏好开关。 | `browser targets` 可发现已明确共享的目标；扩展配对及设置页的文件快照回收为 GUI 操作。 | [外部连接](../apps/desktop/src/renderer/src/components/settings/ExternalBrowserConnections.tsx)、[文件快照](../apps/desktop/src/renderer/src/components/settings/RetainedBrowserUploads.tsx)、[Browser 合同](design/behavior/browser-workface.md) |
| General | 路径显示和复制使用绝对路径还是家目录缩写；新挂载的 Message Tool 初始为一行或两行，默认一行；本机数据与恢复说明为只读，崩溃日志按钮为诊断动作。 | inspect / set：`copyPathsAsAbsolute`、`messageToolInitialLayout`（`one-line` / `two-line`）；`system crash-log inspect / reveal`。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/general.tsx)、[Main](../apps/desktop/src/main/settings/modules/general.ts) |
| Keyboard shortcuts | 查看快捷键、平台键位、命令和作用范围；当前只读。 | 没有自定义键位 setter。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/keyboard-shortcuts.tsx)、[快捷键注册表](../apps/desktop/src/renderer/src/lib/shortcut-registry.ts) |

Browser 工具栏的显隐在原 Browser 工作面的[工具栏偏好](../apps/desktop/src/renderer/src/components/BrowserToolbarPreferences.tsx)调整，不在 Settings Browser 页：CLI 支持 `browser.toolbar.selectElement`、`browser.toolbar.screenshot`、`browser.toolbar.devTools`、`browser.toolbar.viewport`、`browser.toolbar.saveBookmark`、`browser.toolbar.more` 的 inspect / set，也支持 `settings inspect browser.toolbar`。名称和顺序归 [Browser 工具栏字段表](../apps/desktop/src/shared/browser-toolbar.ts)，公开键归上表的 Browser scalar。

## Mote

| 页面 | 内容与作用范围 | CLI 范围 | 原 owner |
| --- | --- | --- | --- |
| Mote Club | 打开原 Club，管理准确 Mote 的名称、头像、角色、Profile 与 SOUL；不是本人 My Profile，也不是新增全局偏好。 | 不通过 scalar `settings set` 管理 Mote 内容。 | [设置入口](../apps/desktop/src/renderer/src/components/settings/modules/mote.tsx)、[Mote 身份与协作合同](design/behavior/motes-and-coordination.md) |

## Work

| 页面 | 可修改的偏好与管理入口 | CLI 范围 | 字段与原 owner |
| --- | --- | --- | --- |
| Space | 项目栏密度；Topics 打开原 Space，Projects 转到 Environments。Topic/Project 内容仍就地管理。 | inspect / set：`projectRailDensity`；Topic 管理另走 `topic` 命令。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/space.tsx)、[Main](../apps/desktop/src/main/settings/modules/general.ts)、[空间合同](design/behavior/spaces-and-layout.md) |
| Focus | 近期活动窗口与链接打开位置。当前时间尺、时区、筛选与布局留在 Focus 工作面。 | inspect / set：`focus.recentActivityHours`、`focus.linkDestination` | [UI](../apps/desktop/src/renderer/src/components/settings/modules/focus.tsx)、[字段](../apps/desktop/src/shared/focus-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/focus.ts)、[Focus 合同](design/behavior/focus-context.md) |
| Goals | 新打开工作面的默认列表/看板、已完成目标显隐；常用操作默认折叠；新需求首次让准确提需 Agent 担任 Supervisor（默认开启，保存不开始 Loop）。已打开工作面仍保留自己的临时视图选择。 | inspect / set：`goals.defaultView`、`goals.showFinished`、`goals.requesterAsSupervisor`、`goalsCommonActions.collapsed`；Goal 内容与执行另走 `goal` 命令。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/goals.tsx)、[字段](../apps/desktop/src/shared/goals-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/goals.ts)、[Goals 合同](design/behavior/goals-and-demand.md) |
| Survey | 打开原研究工作面，浏览、探索和来源在原流程中管理；当前没有独立的全局 Survey 偏好。 | 不提供 `settings set survey.*`；浏览能力走原 `browser` 命令。 | [设置入口](../apps/desktop/src/renderer/src/components/settings/modules/survey.tsx)、[Browser 工作面](design/behavior/browser-workface.md) |
| Notes | Note 正文字号与阅读宽度；保留打开 Notes 的入口，Notebook、页面、来源与历史继续由原目录管理。 | inspect / set：`notes.fontSize`、`notes.contentWidth`；目录读写另走 `notebook ls / inspect / apply`。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/notes.tsx)、[字段](../apps/desktop/src/shared/notes-preferences.ts)、[Main](../apps/desktop/src/main/settings/modules/notes.ts)、[阅读偏好合同](design/behavior/settings-and-observation.md#设置页的信息架构) |

Goals 的常用操作引用、顺序与显隐在原 Goals 面管理，正文复用 Prompts 库，不另建指令副本。它们由 `goalsCommonActions.items` 持有，当前没有 scalar 或独立 CLI 目录 setter；[原配置写入](../apps/desktop/src/renderer/src/lib/goals-common-actions-config.ts) 与[常用操作界面](../apps/desktop/src/renderer/src/components/GoalsCommonActions.tsx)是入口。

## Mods

| Toolkit Library 内的对象 | 可修改内容 | CLI 范围 | 字段与执行 owner |
| --- | --- | --- | --- |
| 官方 Performance | 状态栏显示开关与显示样式；资源结果为只读观测，官方脚本不可编辑。 | inspect / set：`toolkit.performance.enabled`、`toolkit.performance.statusBar`；`system metrics get / watch` 提供原观测事实，`toolkit` 提供工具读取与操作。 | [UI](../apps/desktop/src/renderer/src/components/settings/BuiltinPerformanceSettings.tsx)、[偏好字段](../apps/desktop/src/shared/toolkit-preferences.ts)、[Main scalar](../apps/desktop/src/main/settings/modules/toolkit.ts)、[执行 owner](../apps/desktop/src/main/toolkit-owner.ts) |
| 官方 Phone connection | 状态栏显示开关与显示样式；隐藏工具不撤销设备接入。官方脚本只读，设备管理转到 Connections。 | inspect / set：`toolkit.mobileConnection.enabled`、`toolkit.mobileConnection.statusBar`；设备操作见下表。 | [UI](../apps/desktop/src/renderer/src/components/settings/BuiltinMobileConnectionSettings.tsx)、[偏好字段](../apps/desktop/src/shared/toolkit-preferences.ts)、[Main scalar](../apps/desktop/src/main/settings/modules/toolkit.ts) |
| 自定义 inline 工具 | 名称、图标、显示开关和样式、固定执行目录、主脚本及参数、动作按钮名称/脚本/参数；工具结果不作为偏好保存。 | `toolkit ls / inspect / create / update / delete / script / run / stop / action / watch`；资源写入支持各自的 expected 合同，不能用 scalar 任意路径修改。 | [工具编辑器](../apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx)、[公共 Toolkit 类型](../packages/core/src/toolkit.ts)、[自定义执行 owner](../apps/desktop/src/main/toolkit-custom-owner.ts) |
| 自定义本地扩展包 | 安装本地包目录，配置启用、显示样式、固定执行目录与参数；名称、图标、脚本和动作由可编辑的包文件提供。 | `toolkit install <id> --path <directory>`，以及原 Toolkit 查询、更新和执行命令；不是一次性复制脚本。 | [包编辑器](../apps/desktop/src/renderer/src/components/settings/ToolkitPackageEditor.tsx)、[包读取](../apps/desktop/src/main/toolkit-package.ts)、[本地扩展包合同](design/behavior/settings-and-observation.md#toolkit-本地扩展包) |

Toolkit Library 的唯一[设置模块](../apps/desktop/src/renderer/src/components/settings/modules/toolkit.tsx)组合这些入口。Auth 用量工具属于可编辑的本地用户包，业务逻辑在包文件中；AgentMux 提供通用加载、配置、执行与结果能力，不把特定账户业务实现为固定设置。官方工具与自定义工具的边界见[Toolkit 行为合同](design/behavior/settings-and-observation.md#toolkit-与官方-performance-工具)。

## Resources

| 页面 | 可修改内容与只读事实 | CLI 范围 | 保存与事实 owner |
| --- | --- | --- | --- |
| Agents | Executor 名称、命令、参数、环境变量、AgentMux guide、头像颜色和徽标；创建时选择 Provider，已有 Executor 的 Provider 与身份不随编辑改变。Provider 能力目录和每个 Host 的命令可用性是观测事实。 | `settings executors ls / inspect / create / update / delete / refresh`；完整字段由资源 schema 校验，`args` 与 `env` 整体替换。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/agents.tsx)、[Core Executor 类型](../packages/core/src/types.ts)、[Desktop 头像字段](../apps/desktop/src/shared/contracts.ts)、[资源 owner](../apps/desktop/src/main/settings-resources-control.ts)、[可用性刷新](../apps/desktop/src/main/settings-executor-refresh-control.ts) |
| Prompts | 名称、正文、关键字、Provider 绑定、状态可用范围与快捷回复图标；引用继续指向同一条保存的 Prompt。 | `settings prompts ls / inspect / create / update / delete`；inspect 可用精确 ID 或 `--keyword`。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/prompts.tsx)、[ComposerShortcut 字段](../apps/desktop/src/shared/contracts.ts)、[资源 owner](../apps/desktop/src/main/settings-resources-control.ts)、[Prompt 合同](design/behavior/settings-and-observation.md#设置页的信息架构) |

## Connections

| 页面 | 可修改内容与管理动作 | CLI 范围 | 原 owner |
| --- | --- | --- | --- |
| Environments | SSH 环境名称、hostname/alias、用户、端口、密钥路径、服务命令和 socket 路径；Runtime ID 为可信连接所得的只读身份。按准确 Host 管理已有 Project folder/worktree，并可显式登记目录、测试连接及检查/升级 Core。 | `settings hosts ls / test / upgrade-check / upgrade / upgrade-inspect`；`settings workspaces register` 登记已有目录。当前没有 Host 配置的 create/update/delete CLI。登记不自动运行 Git、聚焦或启动 Agent。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/hosts.tsx)、[Host/Workspace 字段](../apps/desktop/src/shared/contracts.ts)、[测试与读取](../apps/desktop/src/main/settings-hosts-control.ts)、[目录登记](../apps/desktop/src/main/settings-workspace-add-control.ts)、[升级事务](../apps/desktop/src/main/settings-hosts-upgrade.ts) |
| Phone & Devices | 获取连接链接、查看设备与近期活动、撤销准确设备的访问；在线状态为观测，不是保存的偏好。 | `device ls / link / hello / revoke`；状态栏样式在 Toolkit Library 的官方 Phone connection 中配置。 | [UI](../apps/desktop/src/renderer/src/components/settings/modules/devices.tsx)、[设备界面](../apps/desktop/src/renderer/src/components/settings/DeviceManagementSettings.tsx)、[公共设备合同](../packages/core/src/public-rpc-device.ts)、[Desktop 接线](../apps/desktop/src/main/device-management-ipc.ts) |

## 维护与新增

新增或删除真实设置时，在同一改动更新本目录相应行；默认值、范围和保存规则留在已有 owner，不在表格再定义一份。新增源码模块、字段、Main scalar 与实际 GUI/CLI 消费的操作方式见[给功能追加设置](settings-module-contributions.md)。跨环境和权限相关能力遵循[公共能力贡献约定](guides/public-capability-contributions.md)，管理入口不自动创造配置字段或 CLI。

核对时分别读取 Renderer 的 `settingsModules`、Main 的 `scalarSettings`、资源/连接 owner 与 CLI 命令树：页面出现不等于字段可写，公开资源命令存在不等于所有 GUI 管理动作都有 CLI，源码存在也不等于用户已经安装。
