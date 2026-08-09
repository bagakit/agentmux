# f-22p8f93c8 计划评审记录

Feature: `f-22p8f93c8` — Attention Surfaces and Failure Visibility
计划修订: 1
评审结论: **approved**
日期: 2026-08-28

## 用户确认的范围

用户在会话中确认建立一个新 feature 交付高 ROI 项，并在同一轮要求先把既有 feature
重新整理归档；随后把"先做哪个"的排序决定显式委派给执行方，并追加一条要求：本
feature 的最后一步除验收之外还要回填 `ideas/index.md` 的对照表。

据此确定的边界：

- **只收**"读现有投影、不需要新 Core 合同"的项。这是本 feature 能与既有四个活跃
  feature 并行而不互相阻塞的唯一理由。
- **名册与 Inbox 合并为一个面**，而不是两个。二者是同一缺口的两面：现有全窗口汇总
  栏只能跳到等待最久的那一个，没有可枚举的名册。
- **明确排除**：
  - Design Mode 补 computed CSS 与截图入 prompt → 属于已交付的 `f-22j8frn9v`
    浏览器工作面的增量，不进本 feature。
  - Agent 间结构化通信与编排 → 早已是 `f-2248f4yx5` 的 T-019，且其 acceptance 明写
    "Core 提供通信事实，不实现自动调度、Agent 选型、结果评判或 coordinator loop"。
  - 一 prompt 扇出 N 个 worktree 比稿 → 需要新原语，范围另行讨论后再立。

## 排序理由（执行方依委派决定）

依 skill 的"首个执行任务应闭合最小端到端验收路径"：

1. **T-001 先行**，因为它是唯一一个已确认会咬到用户的缺陷（粘贴图片保存失败被静默
   吞掉），且它建立的报错通路是后续所有面共用的失败可见性基础。
2. **T-002 在 T-003 之前**，把"哪次跃迁值得打扰"收敛成一个纯判定，避免通知、上卷、
   名册三个面各自散落条件、各自猜测什么算"完成"。
3. **T-003 / T-004 / T-005 / T-006 相互独立**，可并行推进：分别是系统通知、行级上卷、
   可枚举名册、圆角契约收口。只有 T-003 依赖 T-002 的判定。
4. **T-007 最后**，依赖前述全部，负责统一门禁与回填 `ideas/index.md`。

## 依据

- 42 项能力对照的核实结论与证据: `ideas/index.md`
- 交互与 Owner 边界合同: `docs/design/agentmux-desktop-interaction.md`
- 视觉与密度合同: `docs/design/agentmux-surface-density.md`
- 仓库工程原则: `AGENTS.md`

## 需要在 T-007 更正的已知错误结论

回填时必须修正对照表中两处执行方先前的误判，而不只是把状态改绿：

1. 统一 Inbox 与 Agent 间通信被写成"新提议"，实际早已存在于 `f-2248f4yx5` 的 T-019
   计划中。
2. `f-2258fa79w`（Authorized Image Input and Mouse-First Interaction）曾被描述为
   "代码已交付、状态未同步"。实际该 feature 基本未开工：它要求 Core 建立完整跨层
   receipt 合同、经 CtxmuxRunAdapter 用版本锁定 public protocol stage artifact、
   Run replacement 后旧 receipt 必须失效并显式 restage。当前实现（图片落盘 + 插路径
   引用）只是其 T-003 中的一小块，且不满足上述任一约束。
