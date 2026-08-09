# Feature Summary: f-22w8fsmnv

- Title: Worktree Path Inside the Project
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
- Confirmation Ref: .bagakit/feature-tracker/features/f-22w8fsmnv/artifacts/plan-review-r1.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 2
- blocked: 0

## Closeout Review
- Documentation: updated
  - Rationale: 交互合同记录：默认 worktree 落在项目自身的隐藏子目录 <项目>/.worktrees/<清洗后的分支名>，而非与项目同级的兄弟目录——它因此受项目 .gitignore 覆盖、随项目目录一起移动或删除、并出现在项目自身的文件树里。这条默认路径只由一处推导，任何调用点不得再拼第二份。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 缺陷只是少了一个路径分隔符，但后果是 worktree 逃出项目、脱离 .gitignore 与文件树。已全仓核实唯一构造点（workspace-projects.ts:65），并做变异验证：去掉分隔符使路径塌回兄弟目录后测试 2 failed，证明断言守得住。
  - Refs: .bagakit/feature-tracker/features/f-22w8fsmnv/artifacts/implementation-review-T-002.md
- Promotion: not_needed
  - Rationale: 默认值只有一处出处，已是既有 SSOT 原则；本次为执行与核实。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 2

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
