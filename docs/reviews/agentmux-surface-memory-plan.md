# Task Plan Review — AgentMux Surface 内存预算与有限 cold-park

状态：approved（诊断与后续实现边界）

## 用户原话

> Agentmux 的内存占用相当夸张，比别的同类工具高得多，这是为什么？

## 结论

当前差异首先是生命周期策略，不足以直接判定存在泄漏。AgentMux 为了切换项目时不丢
xterm/attachment，把所有已有布局的 Workbench 子树同时挂载；成熟的同类实现对隐藏终端采用有限
hot-retain、TTL、数量上限和 cold-park。AgentMux 必须先用同条件的进程/owner 数据建立基线，
再在不破坏 Session、Region、Replay 与 attachment 事实的前提下移植有限 parking。

## 约束

- 活动面与近期访问面回访不能出现 `Restoring terminal…`、二次 TUI loading 或人为制造 replay gap。
- cold-park 只释放可验证可重建的 Renderer/native surface；不复制 Core/ctxmux 的 Run、PTY、Replay、
  Session 或 Topic 真相，也不删除布局投影。
- Terminal、Monaco、Browser 分别计量和治理；不能把 Browser 的 Chromium renderer 内存误归因给 xterm。
- 采用 TTL、hot-retain 数量上限与 cooldown，避免切换抖动；收益必须由同场景 before/after working-set
  和 resource-owner counts 证明。
- 未有实测前不承诺某个 RSS 数字，也不以卸载所有隐藏 Workbench 作为修复。

## 参考实现

一个成熟的同类实现在隐藏终端 parking 上使用 30s cold-park
延迟、5min hot-retain 和有限数量（Tab 6、Worktree 4），并在 pending startup、activity portal、
PTY 可恢复性、测量窗口等条件不满足时禁止 parking。该模式是比较证据，不是 AgentMux 的第二个
Runtime；迁移时只复用策略思想和可验证条件。

## 独立验收

先得到 AgentMux 单 Workspace、多个隐藏 Workspace/Tab、Browser、Monaco 的分阶段基线，并保留
commit/ctxmux manifest 身份。随后实现最小 Terminal cold-park 竖切，证明回访恢复、Session/Run
仍由 Core 维护，且 steady-state working-set 与 owner counts 收敛。Browser/Monaco 只有各自有
重建证明后才进入后续任务。
