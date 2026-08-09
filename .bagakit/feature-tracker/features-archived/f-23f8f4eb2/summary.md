# Feature Summary: f-23f8f4eb2

- Title: 重启后布局还在，session 能直接 resume
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
- Confirmation Ref: docs/reviews/agentmux-restart-persistence-plan.md

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
  - Rationale: 交互合同的《Session 恢复》原先只列三类失败且其中两个 code 名（provider-unsupported / continuity-conflict）在 Core 中不存在；已按 agent-session-continuity.ts:21 的实际四值 union 更正，并补上界面对每一类欠的东西（按钮永远说得出下一步、Core 没给原因时如实说不知道、原因分支不设 default）。同一对错误 code 也出现在 continuity review doc 的表里，一并更正。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 本 feature 三个 task 各暴露一次同形的假绿：测试自己把被断言的值喂进 fixture，于是『代码跑了』与『代码被删了』无法区分。T-003 是 layout restore 整个关掉仍全绿（fixture 种的是已合法的值）；T-002 是 store 丢掉 continuityReason 仍全绿（pane 测试把它直接种进 session fixture）。两次的修法相同：断言必须落在被测函数的返回值上，为此把 module-private 的投影函数导出。这是第六种源码扫描/断言假绿模式，值得记住的判据是——把这行代码删掉，测试会不会红？
  - Refs: docs/reviews/agentmux-restart-persistence-plan.md
- Promotion: not_needed
  - Rationale: 两把尺子（变异测试 + 零调用者检查）已在 AGENTS.md:69-75 作为 done 的判据存在，本轮只是又一次应用它并抓到两个假绿，没有产生与现有原则竞争或需要新增的规则。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 3

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
