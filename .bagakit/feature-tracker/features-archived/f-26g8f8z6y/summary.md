# Feature Summary: f-26g8f8z6y

- Title: Explorer collapses fully, per-kind default
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
- Confirmation Ref: docs/reviews/workspace-pane-collapse-and-pin-2026-09-15.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 4
- blocked: 0
- failed: 0 (requires reviewed replan)
- cancelled: 0
- transferred: 0

## Closeout Review
- Documentation: updated
  - Rationale: 设计合同 §2.3.1（折叠态不进 PanelGroup）在实现前已写定并逐字落地，无需改动；本轮实际更新的是 styles/ 清单——折叠把 dock.css 推过 400 行上限，拆出 file-explorer.css 后同步了清单（那份清单自身有守卫）。
  - Refs: docs/design/agentmux-surface-density.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 两条可复用教训：(1) indexOf 落空返回 -1 时 slice(start,-1) 不是切出空串而是扩张到文件末尾，源码扫描类断言必须先断言两个锚点都命中，否则改名后哑掉而非变红；(2) 400 行守卫红在 HEAD 时要先 git log 归属再分工，本轮 peer 把两处越界中的一处误判成他人文件，那种记账方式会把红灯停在一个永远不会来修的人身上。
  - Refs: docs/design/workspace-pane-collapse-and-pin-2026-09-15.md
- Promotion: not_needed
  - Rationale: 两条教训都已落进本会话的持久记忆（indexof-anchor-gone / moving-code-silently-guts-source-scanning-tests 一族），且守卫本身已在测试里钉死；仓库原则层没有需要新增或废止的条目。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 5

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
