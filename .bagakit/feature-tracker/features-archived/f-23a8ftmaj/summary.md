# Feature Summary: f-23a8ftmaj

- Title: AgentMux Desktop Workline Surfaces
- Final Status: archived
- Closed From Status: done
- Workspace Mode: current_tree
- Base Ref: main
- Branch: 
- Worktree: 
- Discard Reason: 
- Replacement Feat: 

## Requirement Authority
- Archive Synthesis: none; archive does not reinterpret or rewrite requirements
- Canonical Truth: tasks.json
- Confirmed Plan Revision: 6
- Confirmation Ref: docs/reviews/agentmux-desktop-workline-plan.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 11
- blocked: 0

## Closeout Review
- Documentation: updated
  - Rationale: T-006 收尾时发现设计 SSOT《状态栏》节仍写「真实 tokens/s 需要 Provider 原生 usage 回执，接入之前不展示」——usage 已接入，照字面读就该展示速率，而真正的决定是永不给速率（分母含用户思考/审批/工具/网络，不可验证）。已把该条改成「报累计量、永不报速率」，并补上原文缺的落点（名册行而非状态栏）与三态不许塌成 0，逐个列出守护测试。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 1) 任务标题会带过时前提：T-006 标题要「显示真实 tokens/s」，而设计 SSOT 与 types.ts 早已决定不给任何速率——正解是修文档与标题前提，绝不改代码去迎合过时标题。2) 一条链上每段都有人守仍可能整体静默失效：usage 的声明/抽取/并入/投影/覆盖/名册接线全有测试，唯独 catalog→hook 环境那次注入无人守，禁掉它 27 条全绿；接线与判定要分开守。
  - Refs: packages/core/test/agent-usage-env-injection.test.ts
- Promotion: not_needed
  - Rationale: 两条均为既有原则（SSOT 唯一、测试要能被变异打红）的具体形态，已由改后的设计条目与新增守卫测试承载，不另立规则。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 13

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
