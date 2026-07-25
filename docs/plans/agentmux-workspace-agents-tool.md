# Workspace Agents 工具

## 问题

关闭最后一个 Agent Tab 时，默认停止底层 Agent Run 并释放资源；确认弹窗同时提供“仅关闭
Tab、保留 Session 在后台运行”的明确选项。只有用户选择保留的后台 Agent，才需要从 Agents
工具重新找到并打开。

二级菜单里的 `Terminal Shortcuts` 目前只有一个“打开终端”按钮，快捷方式本身尚不可用。
新建 Tab、创建页和文件夹右键都已经能打开 Terminal，因此这个入口重复了。

## 目标

- Workspace 二级菜单固定为 `Files + Branches / Agents / Browser Favorites`。
- Agents 展示当前 Workspace 的 Agent Session，包括运行中、需要用户处理和已结束的记录。
- 点击 Agent 使用现有 `selectSession()`：已经打开就聚焦，Tab 已关闭就重新创建 View；不创建或 Resume Run。
- Raw Terminal 不进入 Agents。Agent 状态继续来自全局 Session Snapshot，不保存第二份列表。
- 删除 `Terminal Shortcuts` 二级工具；Terminal 继续从现有创建入口打开。
- 关闭最后一个 Terminal Tab 直接停止底层 Run，不弹出保留选项；仍有其他 View 展示同一 Run
  时只关闭当前 View。
- 关闭最后一个 Agent Tab 必须二次确认；默认主操作是停止 Run 并关闭，次操作才是保留 Session
  在后台运行。仍有其他 View 展示同一 Session 时只关闭当前 View。
- Workbench 重启只恢复持久化保存的 View，不得把未被 View 表示的后台 Session 自动重新展开成
  Tab。后台 Agent 通过 Agents 工具显式重新打开。

## Scratch

Scratch 的内容槽使用 `Files + Topics` 并默认打开该槽；Agents 仍是独立的进程监控视角。
具体合同见 `agentmux-wiki-first-scratch.md`。普通项目继续使用
`Files + Branches / Agents / Browser Favorites`。

## 列表

- 按 `Working / Needs You / Recent` 分组，组内最近更新的在前。
- 每一项显示 Agent 图标、名称、状态和最近更新时间。
- 没有 Agent 时只引导用户从新 Tab 创建 Agent，不暗示关闭 Tab 会默认保留后台进程。

## 不做

- 不把 Agents 做成第二个 Board；这里不展示 Branch 矩阵、Inbox 或筛选器。
- 不新增 Session Registry、后台进程或 Core API。
- 不把 Raw Terminal、浏览器或文件混进 Agent 列表。
- 不因为打开 Agents 工具而启动、停止或恢复 Agent。
- 不因 Scratch 的 `Files + Topics` 改写普通项目的 `workspaceTool` 状态或工具集合。

## 验收

- 二级菜单不再出现 Terminal，出现 Agents。
- 只有当前 Workspace 的 Agent Session 会显示，其他 Workspace 和 Raw Terminal 不显示。
- 列表状态分组与 Board 使用同一个 `sessionBoardColumn()` 规则。
- 点击列表项调用现有 Session 选择动作，可重新打开已经关闭的 Agent Tab。
- Terminal 最后一个 View 关闭后 Run 已停止，重启 Desktop 不会复活对应 Tab。
- Agent 最后一个 View 关闭时出现“停止并关闭 / 保留 Session 并关闭 / 取消”三种明确结果；只有
  保留分支继续占用后台资源，且重启 Desktop 不会自动重开它。
- Scratch 默认落在 `Files + Topics`；普通项目仍是完整三项；在两者之间切换时普通项目保持原来的工具选择。
- 需求文档、类型检查、聚焦测试和仓库统一检查通过。
