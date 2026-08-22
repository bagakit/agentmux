# Default Session 浮窗 review

日期：2026-09-22

## Reviewed goal

Default Session 必须像 a mature workbench 的 floating workspace 一样作为当前工作面的浮窗打开：入口只负责打开或聚焦唯一的 `launcher:default` Topic；浮窗有独立 chrome、可拖动标题栏、关闭/最小化和焦点返还；关闭后保留 Topic、Tab、Region、Session 与恢复事实，不创建第二个 Agent 或第二份终端。

## Protected invariants

- `SessionPane`、ctxmux Run、PTY、ordered bytes、Replay、Gap 与生命周期事实仍只有既有工作台持有；浮窗只是同一 Topic 工作面的附着投影。
- Board、Agents、Project 工作面保持可见并保留当前上下文；打开浮窗不把主路由切到 Scratch，也不丢失原焦点。
- 浮窗打开、关闭、重启后的 Tab/Topic 状态可恢复；健康 Agent 不因浮窗握手或渲染流程被阻断。
- 不保留顶栏/Board 的第二套聊天控件；所有输入继续使用现有 Topic 的原生 composer。

## Accepted scope

1. 将 Default Session 入口改为 a mature workbench 风格的单一浮窗 launcher。
2. 浮窗复用 Scratch workspace 的 `WorkspaceWorkbench` 投影，显示既有 Topic Tab/Region/composer。
3. 增加拖动、最小化、焦点返还、持久化打开状态与回归测试；入口仍可从 Board、Agents 与 Session 顶栏触发。

## Decision

本 review 已由当前用户需求明确确认，状态为 **approved**。实现按 `default-session-floating-task-plan-2026-09-22.json` 执行；不把第二个聊天页面或新的 Session 生命周期引入本 Feature。
