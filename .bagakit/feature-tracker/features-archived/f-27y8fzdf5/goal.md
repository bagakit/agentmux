# Feature Goal: 全局 Board 与原生 Topic 工作面成熟实现

Contract: `bagakit.feature-goal.v1`
Feature: `f-27y8fzdf5`
Convergence: `terminal`
Closure: `state`

This Goal contains durable direction and state-recovery rules only. Keep current and historical snapshots, query results, and execution evidence in Feature-owned surfaces.

## State Recovery
- Before acting, verify `owner-receipt.json`, then recover the current task, continuation, blockers, and evidence references from `state.json` and `tasks.json` in this Feature directory.
- Follow those evidence references and the reviewed tasks' verification procedures to establish acceptance status; consult authoritative sources again when freshness matters.
- Context may be stale or belong to another Feature. If owner state is missing or inconsistent, follow the owner repair or escalation path before resuming execution; do not infer state from chat or Goal prose.

## Prime Directive
交付一个成熟的 AgentMux 原生全局 Task Board：Board 保持全局任务上下文；选中 Task 后同一页面的右半边成为 Task 工作区，并以多个原生 Session Region 直接显示对应 Agent terminal；Default Session 直接加载默认 Topic 的 Tab/Region/composer；每个 Topic 支持可编辑 Wiki 注入，默认 Topic 自带 AgentMux 使用、项目路由、需求合并和追问知识。它必须复用现有 Agent Session、ctxmux Run/PTY、布局、Topic 和恢复机制，成为可维护的真实产品功能，而不是静态概念页。

## Convergence Contract
- Smallest sufficient closure: 一个可从 Board 选 Task、在右半边观察多 Session terminal、从 Default Topic 输入并写入 Task 的生产纵切，同时保留重启后的工作面和 Topic Wiki。
- Oracle or ratchet: Feature Tracker 的所有 reviewed Tasks 完成；定向测试、类型检查、真实浏览器回归、块级变异和定义文件外生产调用者检查均通过。
- Scope expansion: Provider 新增、独立知识库 Agent、第二套 Runtime 或与 Board 无关的视觉重构进入子 Feature/Backlog。
- Completion or cycle stop: 最终候选在真实 Desktop 中通过 Task/Session/Topic/Wiki/重启验收，并且没有未关闭的 reviewed Task。
- Requirement authority: user Goal and reviewed Feature Task truth; derived plans remain provisional.
- Re-plan boundary: re-plan only when a reviewed acceptance is falsified by a production seam, when the recovery oracle proves a second durable truth is required, or when the current vertical slice cannot reach a falsifiable browser/runtime proof within two focused implementation cycles; record the reason and one bounded replacement plan before widening scope.

## Protected Invariants
- ctxmux 继续拥有 Run、PTY、ordered bytes、Replay、Gap、Attachment 和生命周期事实；AgentMux 继续拥有 Provider、AgentSession、Topic/Wiki、Task 语义和投影编排。
- 右半边 Task 工作区和 Default Topic 都复用原生 Tab/Region/surface/composer，不通过路由换页、不启动第二个 Agent/Run、不复制终端事实。
- 面性设计使用 AgentMux 现有 token、留白和 hairline；状态色只表达语义，不引入多彩装饰线框、hero 页面或底部演示导航。
- Non-goal: 不在本 Feature 中重写 Provider、ctxmux 或建立独立的通用知识库产品。

## Acceptance And Stop Rules
- Acceptance: Board/Task/Session/Topic/Wiki 的生产调用链完整；Task 选中不换页，右半边多 Region terminal 使用同一 Session/Run/PTY；Default Topic 的 Wiki 注入可查看、可版本化、可恢复；默认确认策略和结构化决策记录可用；重启后 Board、Region、Topic 和 Wiki 仍可恢复；定向测试、typecheck/build、浏览器截图、变异和 zero-caller 检查有证据。
- Insufficient: 只有静态 demo、孤立组件测试、复制终端输出、只在定义文件内命中调用者、或重启后丢失布局/Topic/Wiki，均不算完成。
- Stop and ask before: 需要改变 ctxmux/AgentMux ownership、引入第二套持久化真相、修改用户已有 Topic/Wiki/Task 数据或扩大到 Provider 生态时。

## Authority And Orchestration
- Follow only this Feature's owner receipt, state, and reviewed tasks.
- Before substantial work and after every review, re-read this Goal and the current acceptance evidence.
- Take the smallest action that directly advances that evidence or removes a real blocker. Defer anything not required for the current closure; stop when acceptance and applicable mandatory gates are satisfied.
- Do not implement a chat-only requirement. First record each accepted new requirement in the appropriate reviewed Feature Task through Feature Tracker.
- Label new statements as user Goal, reviewed Feature Task, derived plan
  hypothesis, or environment observation. Do not promote a plan hypothesis to
  acceptance without the reviewed Feature path.
- Do not rewrite the plan after every local setback. Re-plan only on the
  declared trigger and record the reason, expected payoff, and remaining
  budget in Feature-owned state.
- Prove the cheapest representative user-visible vertical before broad horizontal infrastructure.
- For engineering work, satisfy acceptance first; among valid solutions minimize enduring states, owners, APIs, abstractions, duplicated truth, and temporary scaffolding.
- 先交付最小真实纵切，再扩展 Wiki/CUI 和恢复；独立的 UI surface、Runtime 投影和 Topic/Wiki 持久化可并行审计，但共享文件由当前任务 owner 串行合并。所有新抽象必须有两个生产消费者或被删除；优先复用 multica 已验证的 Board、Region 和 Topic 组合模式，并把 AgentMux 的 Session/ctxmux ownership 接在既有公开 API 上。

## Context References
- `docs/design/agentmux-desktop-interaction.md`: 产品行为与 ownership 约束；每次调整 Board/Topic/Session 流程前读取。
- `docs/design/agentmux-surface-density.md`: AgentMux 面性设计、token、密度与选中信号；每次视觉改动前读取。
- `docs/reviews/global-board-task-inspector-plan-2026-09-21.md`: reviewed Task 计划与验收边界。
- `packages/layout/src/workbench-view-layout.ts`: 既有 arrangement 原语；实现多 Region 前读取。
- `apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx`、`TerminalView.tsx`: 原生 Region/terminal owner；接线前读取。
