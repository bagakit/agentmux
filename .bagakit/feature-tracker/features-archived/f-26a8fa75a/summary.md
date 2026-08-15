# Feature Summary: f-26a8fa75a

- Title: 驱动中的 Browser 在应用 chrome 上认得出来
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
- Confirmation Ref: docs/plans/agentmux-agent-browser-drive-requirements.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 1
- blocked: 0
- failed: 0 (requires reviewed replan)
- cancelled: 0
- transferred: 0

## Closeout Review
- Documentation: updated
  - Rationale: 设计 SSOT（Browser 工作面一节）加了一条约束：驱动中的 Browser 在标签上要与闲着的画得不一样，这条差别是去重的一部分，且驱动是瞬时事实不进持久化。CLI browser.run 与 skill 两处都补了「Tab 上也标出来了，人不切过去也能看见你在哪一格」。ideas/index.md 的 CLI help 行号引用跟着改动更新。
  - Refs: docs/design/agentmux-desktop-interaction.md, packages/core/src/agentmux-cli-help.ts
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 一条可复用的：给一个已有的去重键新增维度时，判据必须成对——只判「两种状态画两个」的话，一个「这一类一律不去重」的实现也会绿，而那恰恰是去重规则本来要挡的东西（三个闲着的 Browser 堆三个一样的地球）。本次两侧都判了，M7 变异（appearance 掺进 regionId）因此变红。另一条是既有记忆的再次印证：跨进程的可见性改动，纯函数测试证不了「主进程有没有真把它送出去」——M3/M4/M5 三个变异全落在 emit 那一侧，而标记那 39 条对它们全部失明。
  - Refs: apps/desktop/test/browser-run-script-wiring.test.ts
- Promotion: not_needed
  - Rationale: 两条都是既有规则（markAppearance 自己的注释、以及记忆里「竖切要判到消费方」）在一个新场景下的应用，没有跨仓库的普适增量。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 1

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
