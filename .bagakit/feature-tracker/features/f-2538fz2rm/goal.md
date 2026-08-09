# Feature Goal: 完成 AgentMux 整合需求并安装验证

Contract: `bagakit.feature-goal.v1`
Feature: `f-2538fz2rm`
Convergence: `terminal`
Closure: `state`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive
彻底实现 f-2538fz2rm 当前 reviewed task plan 中的需求，包括已转正提案，完成行为验收、提交、打包、安装并重启验证。交付以真实产品行为与安装后会话恢复为准，不能以提案转正、编译成功或单轮测试通过替代。

## Convergence Contract
- Smallest sufficient closure: 当前 Feature reviewed plan 覆盖的整合版本全部可用并安全安装；相邻 Feature 的未纳入任务仅作背景。
- Oracle: 当前计划的可执行任务全部 done、对应 gate 有效，关键行为有变异红绿与排除定义文件后的生产调用者证据；最终候选通过打包验证，安装身份与候选一致，重启后 Session/Run 结果有回执，Feature 完成 closeout。
- Scope expansion: 新需求先更新设计 SSOT 和 reviewed task；当前计划没有覆盖的历史需求不得自动扩大本轮验收。
- Insufficient: 修改文件、typecheck、纯函数测试、安装命令返回成功或 Task done 未 closeout，均不能单独证明交付。

## Protected Invariants
- packages/core 与 Electron/React 无关；ctxmux 独占 PTY、Run、ordered bytes、Replay、Gap，AgentMux 持有 Provider、Session、Hook、Permission、readiness 与 semantic resume。
- 以 SSOT、DRY 和已有公开 API 为优先，不保留过时兼容路径，不创造第二套状态真值。
- 健康 Agent 不因我们的流程错误受阻；降级与未知如实可见，输入失败保留草稿和引用。
- 定时与 loop 不自动批准权限，不绕过用户问题，不把未知投递当成功，也不自动恢复用户主动停止的 Agent。
- 测试进程有明确归属和有界清理，遵守有限内存约束，不误杀正式应用或其他用户 Agent。

## Authority And Orchestration
- 用户已授权实现、合理提交、打包、安装与可恢复重启；若安装确实无法保持 Session 且会破坏其他工作现场，先说明具体影响并取得确认。
- 改变既有权限策略、向未明确绑定的目标投递、影响其他工作区或不可逆外部发布，需要对应授权。
- 可独立实现的任务并行推进，一个整合 owner 管理 tracker、共享文件、提交与最终候选验证；专家回报有界代码及证据，独立 review 检查正确性、架构与鲁棒性。
- 每次恢复读取当前任务和代码差异；每轮只推进能改变验收结果的实现或证据，不因单条失败停下所有独立工作。
- 完成须经 Tracker closeout；保留未通过的证据，不重写已执行任务来伪装成功。

## Context References
- `tasks.json` 与 `state.json`：当前范围、依赖、状态与 gate。
- `docs/reviews/continuous-progress-followup-2026-09-12.md`：整合与 proposal 转正决定。
- `docs/design/agentmux-desktop-interaction.md`：行为与生命周期约束。
- `docs/design/agentmux-surface-density.md`：视觉、密度与控件约束。
