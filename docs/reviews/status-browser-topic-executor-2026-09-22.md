# Status, Browser, Topic 与 Executor identity review

日期：2026-09-22

## Reviewed goal

把当前工作面里四类互相可见的事实重新收敛到统一投影：停止的 Agent 不再被流程告警误画成红色错误；Project 树明确显示 idle Session 数量；Browser 控制提示不能取代真实页面；Scratch/Topic 导航恢复为紧凑、可辨识的一等列表；所有 Executor 图标位置共用同一身份组件和 hover 信息面板，头像编辑进入 Executor 模板设置。

## Protected invariants

- Core/ctxmux 仍是 Run、PTY、ordered bytes、Replay、Gap 和进程终止事实的唯一 owner；Renderer 只做语义投影。
- 真实崩溃、非零退出、明确 error 与 disconnected 继续可见；健康 Agent 不因我们的探测、重挂或提示流程被阻断。
- Browser 的 Main-owned WebContentsView、页面导航和系统交接链保持不变；控制条不能覆盖页面或伪造另一份 Browser 内容。
- Executor、Provider、Session、Workspace 和 Topic 的稳定 ID 不变；只统一展示与设置入口。
- 设计约束写入两份 SSOT，Feature Tracker 的 reviewed task plan 是本轮执行边界。

## Accepted scope

1. 修复停止/退出/error 的渲染映射，并在 Project/Scratch 树显示 idle 数量。
2. 让 Browser idle 时不渲染大块 ready/control 占位，同时保留 active operation 和 control handoff rail。
3. 重新设计 Scratch/Topic 行、空态、hover/selected/open presence 与紧凑 spacing。
4. 建立统一 Executor identity 组件，覆盖 Tab、树、Session/Board、Browser 等现有调用者；hover/focus 显示统一信息面板，设置按钮指向 Executor 模板设置。
5. 做组件/投影/扫描和回归验证，提交主干并重新打包安装。

## Decision

本 review 已由当前用户需求明确确认，状态为 **approved**。实现按 `status-browser-topic-executor-task-plan-2026-09-22.json` 执行；若发现跨越上述 closure 的新需求，另建 successor Feature，不在本 Feature 隐式扩张。

## Verification evidence

### Focused behavior and recovery

- 定向回归：`14 files / 220 tests passed`，覆盖状态投影、Project/Scratch idle 聚合、Browser rail、Browser toolbar/view manager、Scratch/Topic 列表、统一头像、Tab 标记、Executor 设置持久化和本契约扫描。
- 重启/持久化回归：`7 files / 77 tests passed`，覆盖 `store-persistence`、`workbench-persistence`、persisted region drift、workspace navigation recovery、session recovery candidate、board recovery 和 default-session floating contract。布局与 Session 引用没有因恢复快照为空而被清掉。
- Desktop 类型检查：`pnpm --filter @agentmux/desktop typecheck` 通过。为完成这一门检查，补齐了 Default Session 浮层向 WorkspaceWorkbench 传递 `showDefaultSessionEntry` 的公开参数，并沿 SplitNode/SplitBranch/PaneGroup 透传；浮层因此不会重复绘制入口。

### Mutation evidence

每个变异都在单次测试前临时写入、测试后恢复，源码工作区没有保留变异：

- T-001：把 `AGENT_RUN_EXITED` 映射回 error，`run-process-status-convergence.test.ts` 变红；把 idle 谓词改成 `needs-user`，`working-count-convergence.test.ts` 变红。
- T-002：把 quiet rail 的 CSS 选择器改名，`status-idle-browser-topic-executor-contract.test.ts` 变红。
- T-003：把 Topic action cell 类名改名，`status-idle-browser-topic-executor-contract.test.ts` 变红。
- T-004：删除 Tab 标记 key 中的 tint/badge，`workbench-tab-marks.test.ts` 变红；把 hover 面板的 Executor 设置路由改错，契约扫描变红。

### Zero-caller evidence

生产调用者扫描（排除定义文件和测试）命中：`AgentAvatar` 14 个调用文件；`idleAgentCount` 在 `WorkspaceSidebar` 的 Project、Scratch 和 group 三处使用；`BrowserOperationRail` 在 `BrowserPane` 挂载；`workspace-topic-actions` 同时命中 Topic JSX 与其 CSS。扫描契约本身还断言这些来源非空，避免空集合导致的 vacuous green。

### Visual acceptance

使用 `pnpm --filter @agentmux/desktop dev:web` 的真实页面预览检查了默认工作面、窄视口、空闲 Browser、Agents 面板和 Executor 设置：

- 空闲 Browser 只留下右侧紧凑的历史入口，页面主体保持可见，没有 `Browser ready` 或 `You have control` 大块占位。
- Agents 面板的 working/error 状态、Provider 图标和状态点层次清楚；悬停或键盘聚焦头像会出现统一 `Executor details` 面板，设置按钮实际进入 Agents/Executors 设置。
- Executor 设置中的 Avatar、Tint、Icon 与稳定 Executor ID 同行，Appearance 页面不再出现头像编辑入口。
- 窄视口下项目栏、工具栏和主内容仍保持可读，长内容通过现有裁剪与标题提示处理；未发现 Browser rail 遮挡原生页面的现象。
