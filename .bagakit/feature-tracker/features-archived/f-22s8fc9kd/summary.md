# Feature Summary: f-22s8fc9kd

- Title: Claude Model and Effort Launch Options
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
- Confirmation Ref: .bagakit/feature-tracker/features/f-22s8fc9kd/artifacts/plan-review-independent-review.md

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
  - Rationale: Provider Launch Option 一节记录：claude 的 --model 给出指向最新模型的稳定别名（fable/opus/sonnet，全名不声明因会过期）、--effort 明确枚举 low..max，故据实声明；codex/cursor 的 --model 收任意字符串无枚举，依未声明即不渲染保持无按钮，绝不为对称编造会过期的清单。同时记录 model/effort 不带 tier 的理由：RiskTier 分级的是权限与沙箱危险，选模型与选推理深度既不放宽也不收紧权限，标 tier 会在名册行打出假风险标记。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 手写模型清单会在厂商改阵容时立刻过期，而过期的清单比没有清单更糟——它把用户导向一个已不存在的模型。因此只声明 CLI 自身枚举过的值，且对例举式表述（claude 的 --model）用稳定别名措辞而非宣称严格枚举。
  - Refs: .bagakit/feature-tracker/features/f-22s8fc9kd/artifacts/implementation-review-T-003.md
- Promotion: not_needed
  - Rationale: 只声明对真实二进制核实过的 flag、未声明即不渲染，均已是既有的 Provider 声明原则，本次为执行而非新增规则。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 4

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
