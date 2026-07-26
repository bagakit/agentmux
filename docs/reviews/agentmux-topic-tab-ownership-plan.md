# Task Plan Review — Topic-owned Tab creation

日期：2026-08-29
设计 SSOT：`docs/design/agentmux-desktop-interaction.md`（Topic 与 Tab 绑定）

## 结论

**approved.** 这是一个独立于“切 Topic 时过滤既有 Tab”的执行闭环：新建 Tab 必须把当前工作线的 Topic 绑定带过来。实现复用现有 `WorkbenchTab.topicId`，不增加 Topic Registry、全局 current-topic 字段或每 Topic 一份 layout。

## 根因与边界

`openLauncher(groupId)`、若干无 Launcher 的创建路径，以及 Control/HTTP 链接的新 Tab 分支直接调用 `newLauncherTab`/`createWorkbenchTab`，没有从当前活动 View 复制 `topicId`。Scratch 的投影把未绑定 Tab 视为全局可见，因此新 Tab 会出现在当前 Topic 之外。

修复必须覆盖所有“新建 View/Tab”的入口；同一 Tab 内 split 不需要复制，因为它已经由父 Tab 持有绑定。未选中 Topic、普通 Git Workspace、显式已有 Session/Topic 目标的行为不变。

## Task 核

| Task | 独立可验收 | 备注 |
|---|---|---|
| T-001 创建边界继承 Topic 并验证 | 是 | 统一的当前工作线读取与 Tab 创建绑定，覆盖 Tabbar `+`、无 Launcher 的 Agent/Terminal/Browser、Control new-tab、HTTP 链接 new-tab；测试证明绑定、未绑定与显式目标三类行为。 |

## 不做

- 不新增高于 Branch/Topic 的持久层级；Branch 仍由 Workspace 自然隔离，Topic 仍由 Tab 绑定表达。
- 不为兼容旧未绑定 Tab 做迁移或 fallback；既有 Tab 保持其真实绑定，只有新建边界改变。
