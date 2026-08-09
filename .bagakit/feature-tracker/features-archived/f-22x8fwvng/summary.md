# Feature Summary: f-22x8fwvng

- Title: Topic Holds Many Agents
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
- Confirmed Plan Revision: 1
- Confirmation Ref: .bagakit/feature-tracker/features/f-22x8fwvng/artifacts/plan-review-r1.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 3
- blocked: 0

## Closeout Review
- Documentation: updated
  - Rationale: SSOT 记录：一个 Topic 容纳多个 Agent（磁盘侧以 collaborators 表达）；Topic 切换归 Topic 面板；Topic 列表来自文件系统快照，绝不从 View 反推；topicId 不得由 tabId 派生。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 缺陷根因是 topicId ?? tabId：因为 launcher:<uuid> 恰好满足 Topic-id 文法，这个 ?? 会静默为每次启动铸出新 Topic。更重要的是固化该缺陷的断言是当时全仓唯一的失败测试，连带卡住四个无关 Feature 的统一门禁——一条错误断言的传染半径远超它所在的 Feature，遇到长期红的门禁应先查断言本身是否固化了缺陷。
  - Refs: .bagakit/feature-tracker/features/f-22x8fwvng/artifacts/implementation-review-T-003.md
- Promotion: not_needed
  - Rationale: 不建第二份 Registry、不从投影反推磁盘真相，均为既有 Owner 边界原则；本次为执行。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 3

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
