# Feature Summary: f-22y8fh4jr

- Title: Move a Session View to Another Worktree
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
- Confirmation Ref: .bagakit/feature-tracker/features/f-22y8fh4jr/artifacts/plan-review-r1.md

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
  - Rationale: 交互合同记录：Session 投影可被显式搬到另一个 Workspace 的 View，只搬展示身份；Agent 的 cwd 归 Core（session.workspacePath，一个已在运行的进程的工作目录），移动绝不改变它，故搬移后该 Session 仍如实显示自己的工作目录，不冒用目标 Workspace 的路径或名字；移动由用户按 Region 显式发起，落点复用既有 selectSession 导航；新建 worktree 绝不自动搬移任何投影——按用户原话，无法假设那个 session 就该移过去。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 本 Feature 唯一的数据风险是诚实性而非数据丢失：若界面让人以为 Agent 换了工作目录，用户会以为自己在改新分支的文件。已用变异验证守住（注入 cwd 改写 → tooltip 断言变红）。另记：实现 agent 主动上报了自己没接 UI 入口，据此补了红测试再接线——纯函数齐备但零调用者是并行开发的典型半成品形态。
  - Refs: .bagakit/feature-tracker/features/f-22y8fh4jr/artifacts/implementation-review-T-003.md
- Promotion: not_needed
  - Rationale: 展示身份与运行时事实分离、不新建第二条导航路径，均为既有分层原则；本次为执行。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 4

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
