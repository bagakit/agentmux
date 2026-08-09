# Feature Goal: 桌面体验更新的安装交付

Contract: `bagakit.feature-goal.v1`
Feature: `f-24n8fj87m`
Convergence: `terminal`
Closure: `state`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive

将 `docs/delivery/desktop-experience-update-2026-09-10.md` 所列已确认改进汇合为一个可验证的桌面版本，提交、打包安装并重启，证明安装后的前端更新、回切与现有 Agent 会话连续性，使后续体验迭代可安全交付。
本 Feature 只拥有菜单改进与最终安装验收；清单中的其他功能仍由各自 Feature 实施和收尾，不创建重复任务或第二份状态表。

## Convergence Contract

- Smallest sufficient closure: 一个包含清单输入的已安装、实际运行且经过更新回切验收的版本。
- Oracle or ratchet: 本 Feature 的 reviewed tasks 通过各自命令及安装实例验收；共同候选、安装副本和运行实例身份可核对；清单输入具备相应验收及 closeout 证据。
- Scope expansion: 为当前安装验收必需的缺陷先记入所属 Feature 的 reviewed Task 再修复；相邻或历史需求继续留在原 Feature，不以泛化清理或未确认的新功能扩大此 Goal。
- Completion or cycle stop: 必需证据齐备，参与清单的 Feature 完成对应 closeout，本 Feature 归档后停止。仅提交、构建、测试或任务 done 均不足以声称最终交付。

## Protected Invariants

- 健康 Agent 不因握手、探测或更新流程失败被杀死或阻断；异常如实说明，未知恢复能力不当作可恢复。
- 相容前端更新保留 Main、Run、布局、草稿和未保存内容；回切不撤销用户数据或会话事实。
- 宿主更新优先保留 Run 并重新 attach，必要时按 Provider native handle resume；ctxmux 变化单独审查，无法保持或恢复 Session 时先征得用户确认。
- Core 持有 Agent 生命周期，ctxmux 持有 Run、PTY 和字节事实，不新增平行实现、兼容层或迁移框架。
- 保留用户与其他工作的未提交修改，不将无关代码混入交付。
- Non-goal: 不把 Region 布局包、自定义 Executor 或其他历史 Feature 自动算进本次版本交付，也不把它们标为完成。

## Acceptance And Stop Rules

- Acceptance: 按 tasks.json 对同一候选核对实现证据、安装身份、实际激活与回切回执、Session/Run/PID 对比和用户状态保持；分清合成输入事件与真实系统输入法观察。
- Insufficient: 只有测试全绿、请求已发出、旧应用仍可用，或安装证据缺失；某个 Task done 但 Feature 尚未 closeout。
- Stop and ask before: 无法保留或恢复 Session 的有损重启；改变已确认成果、权限或不可逆风险边界。普通验证失败继续排障，不把失败的检查当成 Agent 已坏。

## Authority And Orchestration

- Follow only this Feature's owner receipt, state, and reviewed tasks. 从 state 解析实际工作树，不从聊天中的旧路径或提交推断。
- 用户已授权实现、验证、提交、打包安装与可恢复重启；不为相同授权重复询问。
- 实质操作前及检查点后核对 Goal、任务与验收证据，执行直接推进闭合的最小动作。
- 新需求先更新相应设计 SSOT 与 reviewed Task；进行中的 Task 语义保持不变，修订走 Tracker 公共命令。
- 实现验证遵守项目变异红绿、排除定义文件的非空生产调用与扫描非空规则；不要为已有有效证据重复制造仪式性工作。
- 先满足结果与验收，再最小化长期状态、所有者、接口、抽象和重复真相；候选变化只重跑受影响或必需的验证。
- 每次任务完成、阻塞或计划修订后审查可执行前沿，更新同一状态页面；不因可独立推进的工作无关等待而停工。

## Context References

- `docs/delivery/desktop-experience-update-2026-09-10.md`：固定需求清单、输入 Feature ID、历史范围边界和恢复入口。
- `docs/design/agentmux-desktop-interaction.md`：产品行为与分层更新安全约束。
- `docs/design/agentmux-surface-density.md`：界面层级、密度与控件语言。
- `docs/reviews/desktop-delivery-goal-2026-09-10.md`：用户授权来源与安装后验收依赖审查。
- `AGENTS.md`：架构所有权、工作流程及验收尺度。
