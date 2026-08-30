# 全局 Board 继续实现交接

当前 Feature 是 `f-27y8fzdf5`（全局 Agents 任务看板重构）。本轮已经把 T-001（全局 Board + Task 右侧工作区 MVP）完成并通过 gate，Feature 仍有 T-002～T-005 四个待办；当前版本可以继续开发，但还不是 Feature 完成态。目标与约束以 Feature `f-27y8fzdf5` 的本地 tracker goal、`docs/design/agentmux-desktop-interaction.md`、`docs/design/agentmux-surface-density.md` 为准。

已经落地的部分：

- `GlobalBoardSurface` 已替换旧的局部 Board 视图：全局任务列、搜索/筛选、紧凑任务卡、任务选中后的右半区工作区、单/多 Session arrangement、进入对应 Project 的动作。
- Board 任务的状态投影和持久化已接入 Renderer store；Session 任务是从 Core 快照派生的投影，手写任务可持久化，不能因此复制一套 Agent/ctxmux lifecycle。
- Default Session launcher 已做成 Board 内紧凑入口，支持右键收纳/恢复；默认打开 Scratch 的原生 Tab/Region，不创建独立聊天界面。
- Topic Wiki 已有 `.agentmux/topic-wiki.md` 默认文件、版本摘要和 prompt 注入；Topic 面板可打开原生编辑器。默认 Wiki 已写入 AgentMux 能力、项目路由、任务合并/拆分、追问和风险确认规则。
- Task 右侧 Region 复用现有 `SessionPane`，这里只做观察投影和精确 Project 跳转，不启动第二个进程、不复制 PTY/Run/terminal buffer。

还没有完成的工作：

- T-002：Default Topic 的 CUI/JSON 任务写入、分析依据、确认闸门、决策记录和 CLI/契约测试。
- T-003：Topic Wiki 的完整编辑/启用/停用/恢复协议与真正持久化回归；当前只是文件注入和原生打开入口。
- T-004：独立的共享 SessionRegionHost/attachment projection 抽象，以及多 Session Region 的可靠恢复、性能和控制权边界。
- T-005：全链路恢复验证、Board 数据源/跨项目任务写入闭环、深链接、空态和异常流程的成熟度打磨。

接手时按这个顺序做：

1. 先读 `AGENTS.md`、上面的 goal/design SSOT、`docs/plans/global-board-task-inspector-mvp.md`、`docs/reviews/global-board-task-inspector-plan-2026-09-21.md`，再执行 `show-feature-status --root . --feature f-27y8fzdf5`。
2. 严格按 Tracker 先 `start-task` 再改代码；不要把 T-002～T-005 直接标 done。每个 task 都要有可证伪 acceptance、测试、mutation red 证据和零调用者检查。
3. 优先复用现有 `SessionPane`、`TerminalView`、`packages/layout`、ctxmux attachment 和 AgentMux Core 公开 API。不要在 Board、Topic 或 Renderer 重新实现 PTY、Run、Replay、Gap、输入 owner 或 Session lifecycle。
4. 保持 Board 同页右半区工作区、surface-first、无 hero/演示页、紧凑按钮组和 AgentMux 原生视觉；详情不能靠路由切页，默认 Session 必须使用原生 Tab/Region/composer。
5. 每次改完至少运行：

```bash
CI=true pnpm exec vitest run \
  apps/desktop/test/global-board-task-workspace.test.tsx \
  apps/desktop/test/global-task-board.test.ts \
  apps/desktop/test/board-data-flow.test.tsx \
  apps/desktop/test/workspace-topics-panel.test.tsx \
  apps/desktop/test/scratch-topics.test.ts
CI=true pnpm --filter @agentmux/desktop typecheck
```

再补对应 task 的变异测试、零调用者扫描和“重启后布局/Session 仍可见并可恢复”的回归证据。Tracker gate/finish 命令使用仓库要求的 `feature-tracker.py`，不要只改 JSON 文件。

当前提交已经拆为两笔：`feat(board): add global task workspace` 和 `feat(topic): add editable Topic Wiki injection`；接手 agent 应以工作区实际 `git log` 和 Tracker 状态为准，继续从 T-002 开始。
