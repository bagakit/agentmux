# Demand 完整业务流程评审

日期：2026-09-23

## 用户确认的问题

当前 Demand 管理只有原始卡片：没有描述编辑、Project 归属、Session 分配、删除和可重放的 Leader 协商闭环。Leader Topic 应该承担提出需求和澄清，Board 与 CUI 共同承担管理和审计。

## 验收流程

1. 提出需求：New Demand 打开中央 Leader Topic，注入上下文；Agent 与人澄清标题、描述、Project、优先级和风险，确认后才创建 Demand。
2. 分配执行上下文：从 Project 与活跃 Agent 摘要中选择目标 Project，并关联零个、一个或多个 Session。
3. 管理推进：UI/CUI 编辑描述、状态、优先级、Project、Executor 和 Session 关联；查看 Activity/Decision receipt；确认删除。
4. 恢复审计：跨进程或重启后读取同一 Demand 文件事实，失败时保留已有内容并提示恢复动作。

## 决定

状态：approved。新增 UI Inspector、CUI 动作和跨流程集成任务，沿用同一个 filesystem Demand Feature，UI 与 CUI 必须共享语义动作和 receipt。
