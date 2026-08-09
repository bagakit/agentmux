# Feature Summary: f-22p8f93c8

- Title: Attention Surfaces and Failure Visibility
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
- Confirmed Plan Revision: 2
- Confirmation Ref: .bagakit/feature-tracker/features/f-22p8f93c8/artifacts/plan-review-r2.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 7
- blocked: 0

## Closeout Review
- Documentation: updated
  - Rationale: 交互合同新增四条已交付的公共行为：汇总栏总数段作为名册入口、名册行显示启动授权范围的两条诚实规则、注意力沿导航树上卷、以及后台通知的纯判定与 typed 投递结果。密度合同的圆角条款改为如实开放两类例外并由静态检查守住。仅更新拥有这些行为的 SSOT，未把实现细节抄进别处。
  - Refs: docs/design/agentmux-desktop-interaction.md, docs/design/agentmux-surface-density.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 四条经过验证的教训。其一，验收证据必须可执行：计划把 gate 写成 path#scripts.name 这种引用式，而 tracker 会原样交给 shell，于是 exit 127 —— 闸门从未运行却看起来像失败过，仓库里既有 feature 同样如此。其二，守卫必须双向验证：Presence 动画与圆角两条静态检查都确认过在漂移重现时会红，其中 Presence 守卫随后在本轮新增的名册 CSS 上真实生效。其三，先闭合最小端到端路径是对的：T-001 交付的报错通路成为后续所有面的失败可见性基础。其四，动手前必须查 SSOT —— 我把早已存在于 T-019 的 Inbox 计划当成新提议，并把基本未开工的 f-2258fa79w 说成已交付。
  - Refs: .bagakit/feature-tracker/features/f-22p8f93c8/artifacts/plan-review-r2.md, docs/design/agentmux-surface-density.md
- Promotion: not_needed
  - Rationale: 四条教训都已落在既有归属处：可执行 gate 与守卫双向验证由 tasks.json 的 verification 与两个静态检查测试自身承载，最小端到端优先与 SSOT 优先已是 skill 与 AGENTS.md 的既有规则。另起一个知识面会与这些真相竞争。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 11

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
