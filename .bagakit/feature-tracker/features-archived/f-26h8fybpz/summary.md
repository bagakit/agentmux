# Feature Summary: f-26h8fybpz

- Title: Pin a Topic or Branch; pinned items surface in the sidebar
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
- Confirmed Plan Revision: 3
- Confirmation Ref: docs/reviews/workspace-pane-collapse-and-pin-2026-09-15.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 6
- blocked: 0
- failed: 0 (requires reviewed replan)
- cancelled: 0
- transferred: 0

## Closeout Review
- Documentation: verified_current
  - Rationale: 设计合同（pin 的 scope 语义、分区坐在拖拽序之上、静息态可辨识）在实现前已写定并逐字落地，实现未偏离，故无需改动；本轮没有产生新的公开行为或契约需要另找 SSOT 记录。
  - Refs: docs/reviews/workspace-pane-collapse-and-pin-2026-09-15.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 三条：(1) scope 是这套东西的真要害——分支名只在仓内唯一，两个 project 都能有 main，去掉 scope 的变异同时打红三条断言，且 scope 活在组件/store/左栏三个消费方，任一处漏写都串味；(2) 遇到挡路的断言先问它守的是什么——Topic 行那条「只留一个常驻图标按钮」的计数断言把 pin 动作逼进右键菜单、静息态改用非按钮 svg，结果比放宽断言好；(3) 新类名要写成 BEM 才真的被 rendered-class-has-rule 覆盖，扁平名会从那个守卫的过滤器里溜过去，留下一个看着满足验收、实则无人守的类名。
  - Refs: docs/reviews/workspace-pane-collapse-and-pin-2026-09-15.md
- Promotion: not_needed
  - Rationale: 三条教训都已由测试本身钉死（scope 独立性、分区保序、类名有规则各有具名断言，且都经变异验证会红），不需要再往原则层加一条靠人记的规矩；仓库原则层也没有需要废止的条目。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 6

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
