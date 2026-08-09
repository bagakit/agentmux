# Feature Summary: f-2388fkprc

- Title: Switching a Topic Switches Its Tabs
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
- Confirmation Ref: docs/design/agentmux-desktop-interaction.md

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
  - Rationale: 交互合同记录：切 Topic 就换那一组 Tab，和项目里选 Branch 是同一种体验；并说明同源的理由——Branch 天然换 Tab 条是因为布局按 Workspace 键控而每个 worktree 就是一个 Workspace，Scratch 的所有 Topic 共用一个 Workspace 故需显式投影。同时写明两条边界：未绑定任何 Topic 的 Tab 始终可见（藏起来就再也找不回），活动 Tab 跟着 Topic 走（判据是它属于这个 Topic，而非它还看得见）。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 不新增数据维度：tab.topicId 已存在，按它过滤即可，布局仍只有一份、过滤发生在渲染时，不建第二份 Tab 状态。另记一个被测试逼出来的真实缺陷：活动项初版判据是「还看得见就保留」，于是未绑定 Topic 的 Tab（始终可见）会在切换后继续当活动项——用户切过去却什么也没发生。判据应是「它属于这个 Topic」。
  - Refs: .bagakit/feature-tracker/features/f-2388fkprc/artifacts/implementation-review-T-002.md
- Promotion: not_needed
  - Rationale: 复用既有 Workspace/Topic 分层与投影而非新建状态，已是既有 SSOT 原则；本次为执行。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 2

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
