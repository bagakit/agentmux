# Global Board / Task Work Surface Implementation Review

状态：Approved for implementation planning，生产代码尚未交付。

## 用户确认的目标

AgentMux 需要一个跨 Project、Workspace、Branch、Topic 的全局 Task Board。选中 Task 后不跳页面：Board 左侧继续可见，右半边变成该 Task 的工作区，中间直接以多个 Region 展示关联 Agent 正在工作的 terminal。Region 复用当前 Agent Session、ctxmux Run/PTY、Replay/Gap、ordered bytes 和 attachment lease；默认只读，进入项目才交还唯一输入和尺寸控制权。

Default Session 是默认 Topic 的原生 Tab/Region，不是一套自定义聊天产品。浮动入口打开默认 Topic 的现有工作面和 composer。每个 Topic 都支持可编辑 Wiki 注入；默认 Topic 自带 AgentMux 使用、Project 路由、需求合并/拆分、追问和确认策略规则。Wiki 提供可解释规则和例子，不能覆盖 Runtime/Project/Task 权威事实。

Board、Task 工作区和 Topic Region 使用 AgentMux 现有 surface token 和面性布局：中性色 surface、留白、hairline 分隔和单一选中信号；不做 hero、大标题、底部演示切换器、多彩渐变、发光线框或卡片套卡。

## 计划边界

本计划覆盖 Board 的数据投影、Task 工作区、Session Region 复用、Default Topic/Wiki 注入、CUI 任务写入与决策知识库、重启恢复和最终回归。Provider 不增加 Board 语义；ctxmux 仍是 Run/PTY/Replay/Gap/attachment 的权威来源。计划不包含 Provider 新增、独立知识库 Agent 或第二套终端运行时。

## 关键依赖与收敛理由

1. 先建立 Task 工作区和选择投影，形成最小可见纵切。
2. 再接入 SessionRegionHost/attachment lease，证明多 Region 不会启动第二个 Run。
3. Topic Wiki 与默认 Topic 原生 Region 依赖同一 Region surface。
4. 任务创建策略和结构化决策记录依赖 Topic 注入与 Board CUI。
5. 最终回归统一验证重启恢复、面性视觉和跨层所有权。

## 证明规则

每个实现 Task 都必须有定向 command verification；关键行为需要块级变异后测试变红，并完成定义文件外的生产调用者检查。视觉契约从设计 SSOT 和源码推导，不维护手写选择器清单。所有涉及布局或 Session 生命周期的 Task 都要有一次进程重启后仍可见且可恢复的验证。

## 证据来源

- `docs/design/agentmux-desktop-interaction.md`
- `docs/design/agentmux-surface-density.md`
- `docs/plans/global-board-task-inspector-mvp.md`
- `docs/prototypes/global-board-mvp/index.html`
- `packages/layout/src/workbench-view-layout.ts`
- `apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx`
- `apps/desktop/src/renderer/src/components/TerminalView.tsx`
- `apps/desktop/src/renderer/src/styles/tokens.css`
- `apps/desktop/src/renderer/src/styles/workbench.css`
- `apps/desktop/src/renderer/src/styles/terminal.css`
- `packages/core/src/agent-session-registry.ts`
- `packages/core/src/ctxmux-run-adapter.ts`
