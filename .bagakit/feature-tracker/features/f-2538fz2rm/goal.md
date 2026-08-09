# Feature Goal: 彻底实现内置持续推进闭环

Contract: `bagakit.feature-goal.v1`
Feature: `f-2538fz2rm`
Convergence: `frontier`
Closure: `state`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive
交付一个独立于模型会话的 AgentMux 内置持续推进闭环：用户为精确 Agent Session 开启定时检查后，系统能安全判断、保序续行、跨重启恢复并让用户看懂每次决定。输入失败不丢失，健康 Agent 不因 AgentMux 流程错误被阻断。

## Convergence Contract
- Smallest sufficient closure: T-001 至 T-013 全部完成，形成条件投递、持久 loop、观察面板、Tracker 只读适配、Provider 验收、全局 Message Tools、Context 语义和 Session/Run 重启恢复的一个可验证闭环。
- Oracle or ratchet: Feature Tracker 当前 reviewed task DAG 的所有任务为 done；每个任务有通过的 executable gate、变异红绿证据和排除定义文件后的生产调用者证据；最终受授权 Provider 测试有分阶段回执。
- Scope expansion: 其他历史需求只有在现有 reviewed task 明确覆盖时推进；新的独立 Closure 建 child Feature，不扩大本 Goal。维护者角色发现和定向交接继续使用 `f-23d8fwq4z`。
- Completion or cycle stop: 当全部当前计划任务、closeout review、文档与学习/晋升检查完成并由 Tracker closeout；任何单轮测试通过、模型总结或外置 loop 运行都不算完成。

## Protected Invariants
- loopId 绑定精确 Session、Host、Provider、workspace；Run 是可替换实例，旧 Run 的 tick/readiness/回执不能作用于新 Run。
- 自动检查不批准权限、不绕过用户问题、不隐式 resume、不修改业务任务真值；未知回执不自动重发。
- 最终投递边界复核 running、交互门、就绪信号、用户输入占用和 tick 去重；人工输入失败或启动失败时草稿与引用保留。
- ctxmux 继续独占 PTY、Run、ordered bytes、Replay 和 Gap；AgentMux 持有 Session、Provider、调度、权限和语义状态。
- Non-goal: 自动批准权限、多 Agent DAG、模型切换、部署、成本优化器，以及把所有历史产品需求塞进本 Feature。

## Acceptance And Stop Rules
- Acceptance: Tracker T-001..T-013 全部 done 且 gates 通过；变异测试能证明关键保护失效时变红；生产调用者审计命中；受授权 Claude 测试验证结束→到期→单次接收→新一轮开始和 Session 重启恢复；UI 显示执行/循环/恢复三态、活动、回执、原因和下次检查。
- Insufficient: 仅有 Renderer timer、外置 cron、纯 decision 单测、命令返回成功、一个 Provider 的 working 状态、全部 Task done 未 closeout，均不构成闭环完成。
- Stop and ask before: 改变既有权限策略、向未明确绑定的 Agent 投递、影响其他 workspace/session、自动恢复用户主动停止的 Agent、部署或发布不可逆外部变更。

## Authority And Orchestration
- Follow only this Feature's owner receipt, state, and reviewed tasks.
- Before substantial work and after every review, re-read this Goal and the current acceptance evidence.
- 先完成最小用户可见纵切，再扩展 scheduler/UI；保持独立任务可并行，但最终验收使用同一候选版本。
- 维护者 Agent 通过显式角色/capability 目录解析；目标未知返回未解析并保留草稿，绝不按 Provider、布局或最近活动猜测。
- 每次变更先更新 reviewed task truth；完成后运行 gate、变异检查、零调用者检查并同步 Tracker。不要在聊天里维护第二份进度真值。
- 复用现有 typed Control、Core input serialization、readiness 和 Feature Tracker；删除被替代的临时路径，不增加平行 runtime 或兼容层。

## Context References
- `docs/reviews/continuous-progress-2026-09-12.md`: 需求证据、代码现状、范围与验收建议。
- `docs/design/agentmux-desktop-interaction.md`: 持续推进、输入保留和 Session 重启交互约束。
- `docs/design/agentmux-surface-density.md`: 观察面板与 Context 视觉约束。
- `.bagakit/feature-tracker/features/f-23d8fwq4z/`: 维护者发现与定向交接的相邻 Feature。
