# Feature Summary: f-26b8fcf5g

- Title: 陈旧状态冒充 running：15 分钟没动静的 Agent 界面上写着 active now
- Final Status: discarded
- Closed From Status: proposal
- Workspace Mode: proposal_only
- Base Ref: main
- Branch: 
- Worktree: 
- Discard Reason: cancelled
- Replacement Feat: 
- Transferred To: 

## Requirement Authority
- Archive Synthesis: none; archive does not reinterpret or rewrite requirements
- Canonical Truth: tasks.json
- Confirmed Plan Revision: none
- Confirmation Ref: 

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 0
- blocked: 0
- failed: 0 (requires reviewed replan)
- cancelled: 0
- transferred: 0

## Closeout Review
- Documentation: updated
  - Rationale: 已实现并合入 commit 9cc967f3；行为与理由记录在提交正文与两处 docstring（core agentEvidenceStale、project-activity-row working 臂）。goal 提到的 working 计数一并由 goal 自身的约束「不得制造第三份在不在干活的判据」解决：教计数认新鲜度正是它禁止的第三裁决点，故计数不动、只改行文案，收敛由 working-count-convergence.test.tsx 继续守住。
  - Refs: packages/core/src/agent-status-freshness.ts
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 与 dc77127c 同族：衰减机制正确而末端标签撒谎。派生谓词优于新增字段——存字段会与它复制的时间戳漂移。semanticStatusStale 的 can-decay 门让它对自己下游的衰减产物失明。
  - Refs: apps/desktop/test/project-activity-row-staleness.test.ts
- Promotion: not_needed
  - Rationale: 同族教训已记在提交正文与 docstring
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 0

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
