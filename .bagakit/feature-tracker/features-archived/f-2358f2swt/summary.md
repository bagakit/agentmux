# Feature Summary: f-2358f2swt

- Title: Git Source Control and Pull Requests
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
- Confirmation Ref: .bagakit/feature-tracker/features/f-2358f2swt/artifacts/plan-review-r1.md

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
  - Rationale: 交互合同新增 Git 源码控制与 PR 一节：本地 status/stage/commit/结构化 diff/unstage/discard，远程 push/pull/fetch 与对有效上游计算的 ahead-behind，PR 创建流与认证完全委托 gh auth。并明写四条不可退让约束：argv 不拼 shell、远程错误擦凭据后再上浮、PR 一键流键到 run-token 且切 worktree 不劫持、后端 preflight 终裁且 unavailable 即拒。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 凭据擦除只匹配带冒号的 userinfo，导致 CI 最常用的 bare-token 形式逐字泄露。它通过了此前的变异验证——那次证明的是擦除函数被调用了，不是擦除规则正确。教训：对规则/校验/解析类代码，除变异外还须枚举输入形态。另记 pr-eligibility 阶梯一度零调用者，收口时接入 store 创建流才闭合。
  - Refs: .bagakit/feature-tracker/features/f-2358f2swt/artifacts/implementation-review-T-007.md
- Promotion: promoted
  - Rationale: 许可证义务判定成文：未移植参考项目实质代码故不新增 THIRD_PARTY_NOTICES 条目，并记录判断依据，使日后审查可追溯为什么没登记。
  - Refs: .bagakit/feature-tracker/features/f-2358f2swt/artifacts/license-obligation-T-007.md

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 8

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
