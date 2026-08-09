# Feature Summary: f-22r8feyju

- Title: Steer a Working Agent
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
- Confirmed Plan Revision: 3
- Confirmation Ref: .bagakit/feature-tracker/features/f-22r8feyju/artifacts/plan-review-r2.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 4
- blocked: 0

## Closeout Review
- Documentation: updated
  - Rationale: 交互合同新增 steer 条款：送达经既有 send 通路（store.send → submitPrompt → Core），working 时界面允许提交而主动作仍是 ■，判定收敛为一个不读 Store、不按 providerId 分支的纯函数。并明写这不是普遍送达承诺——render-then-submit Provider（codex）的 mid-turn steer 由 Core fail-closed 拒绝，被拒时草稿保留且不产生 user 回合；pending interaction 期间卡片是唯一输入面，Renderer 不提供提交、Core 亦抛 AGENT_INTERACTION_PENDING。同时记录不做输入队列的理由。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 把合同写成普遍承诺会与已封的 readiness 门自相矛盾，并诱导后人去削弱它。界面该回答的是是否允许尝试提交，能否真正送达归 Core 裁决——两个问题分开表述，才不会让文档承诺一件运行时会拒绝的事。
  - Refs: .bagakit/feature-tracker/features/f-22r8feyju/artifacts/implementation-review-T-004.md
- Promotion: not_needed
  - Rationale: Renderer 不猜测 readiness、Core 是权威，已是既有分层原则；本 Feature 是在该原则下补齐一个自相矛盾的承诺，未新增规则。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 4

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
