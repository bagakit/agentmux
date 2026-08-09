# Feature Summary: f-2378fnh3k

- Title: Copy an Address, Not an ID
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
- Confirmation Ref: .bagakit/feature-tracker/features/f-2378fnh3k/artifacts/plan-review-r1.md

## Closure
- Git Workspace: unchanged; use ordinary Git commands for worktree or branch cleanup
- Preserved Root Entries: 

## Task Stats
- todo: 0
- in_progress: 0
- done: 4
- blocked: 0

## Closeout Review
- Documentation: updated
  - Rationale: 交互合同新增「寻址与复制」一节，紧随 Session/Run/View 身份边界之后与之同源：复制出去的是一个寻址方式而不是一个 id，成品必须让接收方仅凭这一次复制完成寻址；三级地址回答三个不同问题（Session=哪个 Agent、Region=屏幕哪一格、View=哪张完整工作面）且绝不互为别名；歧义在源头消除而不甩给接收方——多 Agent 分屏时直接给 Region 地址，不再让接收方撞 MESSAGE_TARGET_NOT_UNIQUE 后自己挑 candidate；复制入口按其能消除的歧义就近放置（Region 右键菜单点哪格就是哪格，不依赖聚焦）；只使用 CLI 已接受的 flag，不发明第二套语法。
  - Refs: docs/design/agentmux-desktop-interaction.md
- Execution Learning (Agent-authored): candidates_reviewed
  - Rationale: 用户的洞见是这个 feature 的判据本身：copy 一个信息其实是 copy 一个寻址方式。按这条看，裸 id 是不合格的交付——接收方拿到 session:abc 无从知道该配哪个 flag。更值得记的是旧 handoff 文本：它已经知道 Tab 地址在分屏下有歧义，解决办法却是让接收方再跑一次 inspect 去消歧——歧义只在源头可见，复制发生时我们知道用户点的是哪一格，接收方不知道。另记一次自查失误：回退时用 git checkout -- 误删了同文件里另一个已归档 feature 的交付，应先看该文件相对 HEAD 的 diff 里有哪些是别人的东西。
  - Refs: .bagakit/feature-tracker/features/f-2378fnh3k/artifacts/implementation-review-T-004.md
- Promotion: promoted
  - Rationale: 把「复制出去的是寻址方式而非 id」与「歧义在源头消除」写进交互合同，作为后续任何复制/分享类交付的判据；Region 作为一等寻址身份的 UI 缺口也一并补上——此前 CLI 与 skill 已把它当一等目标，唯独界面没有入口。
  - Refs: docs/design/agentmux-desktop-interaction.md

## Counters
- gate_fail_streak: 0
- no_progress_rounds: 0
- round_count: 5

## Notes
- Closeout review is final planning truth; durable knowledge remains with its existing project owner.
- Agent-authored execution learning is not requirement authority and must not redefine confirmed scope.
