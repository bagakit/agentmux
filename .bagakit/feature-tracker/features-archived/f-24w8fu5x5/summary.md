# Feature Summary: f-24w8fu5x5

- Title: Restart layout and session recovery regression
- Final Status: archived
- Closed From Status: done
- Workspace Mode: current_tree
- Base Ref: main
- Branch: 
- Worktree: 
- Discard Reason: 
- Replacement Feat: 
- Transferred To: 

## Requirement Authority
- Archive Synthesis: none; archive does not reinterpret or rewrite requirements
- Canonical Truth: tasks.json
- Confirmed Plan Revision: 1
- Confirmation Ref: docs/reviews/agentmux-restart-recovery-regression-2026-09-11.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 3
- blocked: 0
- failed: 0 (requires reviewed replan)
- cancelled: 0
- transferred: 0

## Closeout Review
- Documentation: updated
  - Rationale: 强化重启后布局与 Session 必须恢复的项目原则，并补充交互与密度设计合同。
  - Refs: AGENTS.md, docs/design/agentmux-desktop-interaction.md, docs/design/agentmux-surface-density.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 启动恢复失败时保留 hydrated Workbench，避免异常路径将持久化布局覆盖为空。
  - Refs: docs/reviews/agentmux-restart-recovery-regression-2026-09-11.md
- Promotion: not_needed
  - Rationale: 现有项目原则已覆盖该约束。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 3

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
