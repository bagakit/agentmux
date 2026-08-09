# Feature Summary: f-23g8feb8c

- Title: 流程坏了不等于 Agent 坏了：三态分流与服务窗
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
- Confirmation Ref: docs/reviews/agentmux-handshake-degrade-plan.md

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
  - Rationale: 握手降级方案里唯一诚实标注的『未验证』小节已被实测替换：codex 双分支抓包逐字节相同、两次都推 ESC[>7u，且推入发生在查询之前——结论不变但理由要换（不是它守 progressive enhancement，而是它压根没有『等应答再决定』这个决策点）。同时作废了原文『codex 若认定支持并推』这个条件句，实测里没有『若』。并写明该结论的有效期绑在两件事上（parser 不匹配 ?、codex 仍先推后问），后者是别人的实现细节可能随升级改变。
  - Refs: docs/reviews/agentmux-handshake-degrade-plan.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 两条：其一，实验做到一半的停滞不能当结论——第一次只答 kitty 一项，codex 卡在 91 字节，若就此收工会得出『两边都没推』的反向错误结论；补全 CPR/DA1/OSC 应答后才是 3999 字节的稳态。判据是先确认被测程序真的进入了稳态，再读它的输出。其二，文档里写着『刻意不匹配 X』而没有断言守着，等于没有——本轮补的两条断言（含真实抓包开场序列）在 parser 放宽到匹配 ? 时会红，而在补之前那个支点可以被删掉且唯一症状是 Shift+Enter 静默送错字节。
  - Refs: docs/reviews/agentmux-handshake-degrade-plan.md
- Promotion: not_needed
  - Rationale: 原则 11 的三态分流与两条边界（不静默放行第 2 类、不把未知当好的）已是仓库既有原则，本 feature 三个 task 都是它的应用；本轮没有产生需要新增或与之竞争的规则。
  - Refs: 

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 5

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
