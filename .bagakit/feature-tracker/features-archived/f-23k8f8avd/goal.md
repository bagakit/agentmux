# Feature Goal: AgentMux Surface Memory Budget and Cold Parking

Contract: `bagakit.feature-goal.v1`
Feature: `f-23k8f8avd`
Convergence: `terminal`
Closure: `state`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive
让 AgentMux 的重资源工作面在真实同条件证据下可解释、可控制：先建立 idle、隐藏 Workspace/Tab、Terminal、Monaco、Browser 的分阶段内存与 owner 基线，再以有限、可回访的 hot-retain/cold-park 降低长期隐藏 surface 的成本，最终让不同 surface 的责任和预算各自清楚。结果必须保住 Agent 的连续工作体验，并让后续维护者能从报告和测试判断“谁在占用、谁可以释放、释放后如何恢复”。

## Convergence Contract
- Smallest sufficient closure: T-001、T-002、T-003 三个 reviewed task 全部完成，形成一份带身份和 owner 归因的基线、可验证的 Terminal 冷停竖切，以及 Browser/Monaco 独立预算与审计；不扩展为新的 Runtime 或全局缓存框架。
- Oracle or ratchet: `Closure: state`；Feature Tracker 中三个任务均为 `done`，每个任务的 command gate 通过，基线/after 测量和 review artifact 均存在且能复现，Feature owner receipt 与 evidence hashes 一致。
- Scope expansion: 改变 Core/ctxmux 协议、Session/Run/Replay/Attachment 真相、增加新的 surface 类型，或需要独立生命周期/发布边界的工作，转为 child Feature 或 backlog；只有当前 state closure 必需的任务修订才回到本 Feature 的 reviewed plan。
- Completion or cycle stop: 当三个任务的 acceptance、变异测试、零调用者检查（适用处）和 command gates 全部满足，并完成残余风险记录时停止；不以某个单次 RSS 数值或一次本地运行宣称额外优化已完成。

## Protected Invariants
- Core/ctxmux 继续是 Session、Run、ordered bytes、Replay、Gap、Attachment 的唯一权威；Renderer/Main 只管理各自 surface 的投影和可验证的重建入口，不复制或删除这些事实。Workspace/Topic/Region 布局身份在 cold-park 前后保持不变，回访走既有 replay/attach owner。
- Terminal、Monaco、Browser 分别测量、分别判断可重建性和释放边界；项目切换本身不触发冷停，pending startup、activity portal、不可重建 PTY、测量窗口和 cooldown 等保护条件不能被预算逻辑绕过。
- RSS working-set 是分层观测，不是泄漏判定；V8/macOS allocator 保留页、共享 Chromium 页和单个 helper 的高水位必须与 heap/owner/count、同场景 before/after 一起解释，不写未经测量的数值承诺。
- Non-goal: 不重写 ctxmux/Agent Runtime，不把“卸载所有隐藏 Workbench”当作修复，不建立第二套 Session、Replay、Browser 或 Terminal 生命周期/缓存池。

## Acceptance And Stop Rules
- Acceptance: T-001 报告按阶段列出 Main/Renderer/GPU/Utility/Browser 与 Terminal/Monaco/Browser/attachment owner counts，并记录 AgentMux commit、Electron、ctxmux manifest、平台；重复运行保持工作树不变且临时 workspace、userData、runtime、报告文件清理。T-002 证明 TTL、hot-retain 上限、cooldown 和保护条件下的 Terminal 回访、Session/Run binding 与 Region 保留，并有 before/after 收敛证据。T-003 证明 Browser/Monaco 各自 owner/rebuild/release 合同、变异测试会红、生产调用者存在，并把正确性、边界、鲁棒性、复杂度和可解释性审计写入 review artifact。
- Insufficient: 只有单一场景或总 RSS、只有 UI mount/unmount 断言、没有 owner/身份/清理证据、把 RSS 不回落直接称为泄漏、或用兼容层/第二份 Runtime 绕过现有 owner，均不算完成。
- Stop and ask before: 改变 Core/ctxmux 的公开协议或权威事实、删除用户可恢复的 Session/Run/Attachment、扩大到新的产品目标、引入显著外部成本/发布或不可逆数据操作，或验收/权限边界与 reviewed task 不一致。

## Authority And Orchestration
- Follow only this Feature's owner receipt, state, and reviewed tasks.
- Before substantial work and after every review, re-read this Goal and the current acceptance evidence.
- Take the smallest action that directly advances that evidence or removes a real blocker. Defer anything not required for the current closure; stop when acceptance and applicable mandatory gates are satisfied.
- Do not implement a chat-only requirement. First record each accepted new requirement in the appropriate reviewed Feature Task through Feature Tracker.
- Prove the cheapest representative user-visible vertical before broad horizontal infrastructure.
- For engineering work, satisfy acceptance first; among valid solutions minimize enduring states, owners, APIs, abstractions, duplicated truth, and temporary scaffolding.
- Keep measurements reproducible and read-only with respect to the source tree; record evidence in the Feature's reviewed artifacts and use the existing Core/ctxmux and Desktop owner seams. Parallel work is allowed only when task dependencies and shared files remain explicit; reconcile through Feature Tracker before merging. Escalate unknown ownership or a repeated healthy-Agent process failure as a workflow warning rather than silently blocking the Agent.

## Context References
- `docs/reviews/agentmux-surface-memory-plan.md`: reviewed task boundary and Refproj comparison; read before changing acceptance or lifecycle policy.
- `docs/design/agentmux-desktop-interaction.md`: Workspace/Region continuity, cold-park protections, and Core/ctxmux authority; read before surface lifecycle changes.
- `docs/design/agentmux-surface-density.md`: process/owner attribution and density constraints; read before measurement/report changes.
