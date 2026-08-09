# Feature Summary: f-23b8fh58m

- Title: AgentMux Surface Language & Live Region
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
- Confirmation Ref: docs/reviews/agentmux-surface-language-plan.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 8
- blocked: 0

## Closeout Review
- Documentation: updated
  - Rationale: 六条 Topic 反馈与终端恢复态需求都落进了设计 SSOT：交互约束（当前 Topic 由活动 Tab 派生、切回开过的 Tab 不重来一遍）写进 agentmux-desktop-interaction.md，视觉与控件语言（禁左侧竖条选中态、状态到颜色只说一次、样式表按表面分文件的 11 文件清单与约束）写进 agentmux-surface-density.md，每条都点名了守它的测试文件。
  - Refs: docs/design/agentmux-surface-density.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 本 Feature 按最短竖切推进：先 T-101 让当前 Topic 有正确来源，再逐条收视觉，最后两条（T-106 隐藏 Region 保住终端、T-107 拆样式表）是架构面的，放在行为正确之后而不是之前。可复用的一条已提升进 AGENTS.md：扫描式契约测试存在第三种白绿——扫到空内容，必须自证扫描有收获、从来源反推而非手写清单、破例按选择器点名不按值点名。另一条留在本 Feature 内不外推：CSS 文件拆分要证明是纯搬家，规则字节相同还不够，还得检查有没有一对规则相对顺序翻转且能命中同一元素、同等特异性、共享属性。
  - Refs: AGENTS.md
- Promotion: promoted
  - Rationale: 并入 AGENTS.md 既有的"两把尺"一节，作为同一类失效模式的第三种，而不是另起一条竞争规则；没有需要删除的过时指引。
  - Refs: AGENTS.md

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 9

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
