# Agent 注意力与结果审查闭环 review（对照参考项目）

Review: approved — 用户要求在 Feature `f-29f8f7krj` 中完善细节。本次确认的产品闭环是：从全局 Needs you 发现待处理 Session，使用已有 typed interaction 完成决定，在同一 Session/工作区附近查看 Diff、已确认的开发预览或继续追问，并在切换、重绘、重连和重启后保留工作面与 Session 身份。

## 范围

- 复用现有 Core AgentSession、typed interaction、通知/attention、Composer、Diff、Browser owner、Tab/Region 和恢复合同。
- 允许新增 Renderer 的组合组件和生产调用者，但不新增第二套 Inbox、Session Registry、Preview Registry、Run/PTY owner 或成功判定。
- 每个任务都必须有行为测试、块级变异证据和定义文件之外的零调用者检查。

## 非目标

- Remote/SSH、移动端、语音、Apple Watch、Push 服务和账户/计费。
- 站点专用分支、固定 URL 或厂商按钮文案；预览只依赖通用开发服务事实。
- 把进程退出、Diff 存在或 Preview 可用单独解释成任务成功。
- 把正常 Agent 因 attention、通知、握手或恢复流程失败而阻断。

## 计划决定

- T-001 是最小端到端 spine：先闭合“看到待处理请求并完成一次决定”。
- T-002 与 T-003 依赖 T-001，可在其完成后独立推进；前者负责结果动作，后者负责连续性与恢复。
- T-004 是唯一集成验收节点，消费两个分支的最终候选，不引入新产品行为。
- 任务中的测试文件名是实现时的最小行为 oracle；若仓库已有等价测试，执行时可在不改变 acceptance 的前提下复用并更新 command ref。

## 依据

- `docs/design/agentmux-desktop-interaction.md` 中记录的参考闭环。
- `docs/design/agentmux-surface-density.md` 的注意力与审查密度约束。
- 现有 `AgentInteractionCard`、`useAgentAttentionNotifications`、Context usage、Diff、Browser preview 和 Session recovery 测试。