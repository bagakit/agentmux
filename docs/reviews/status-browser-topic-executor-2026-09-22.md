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

### Final review corrections

- 修复了真实的重复计数：Project/Scratch/group 文案的 working 数量排除安静的 running Session，独立运行标记仍沿用 Board 的可用性投影。Project 行渲染测试明确区分 `1 Agent is working` 与 `1 idle`。
- 旧 Appearance 头像进入 Executor 设置草稿，并参与 Tab 的视觉去重；明确 Reset 写入空的 Executor 外观覆盖。保存、重开设置与实际 AgentAvatar 都保持重置结果，旧记录没有被删除，Reset 在默认外观时禁用。
- 修复后的定向回归为 `14 files / 216 tests passed`；另外 `project-rail` 的 35 条与 `session-connecting-surface` 的 9 条通过。恢复套件为 `7 files / 78 tests passed`，Desktop typecheck 通过。
- 三个补充变异均按预期变红并恢复：反转 producing 的 running 排除项（Project 行三条断言红）；移除 Tab facts 的既有头像读取（两枚不同标记被错误合并，断言红）；Reset 删除空覆盖（持久化重置断言红）。
- `producingAgentCount` 排除定义文件后的生产调用位是 WorkspaceSidebar 的 Scratch、Project 与 group 三处；Tab facts 的既有头像参数由 WorkspaceWorkbench 实际传入。
- 测试依赖曾被外部临时安装目录的 symlink 替换而失效；已用项目现有锁文件离线重装依赖，未增加包或修改锁文件。T-005 先前 `-15` 只说明命令收到了 SIGTERM，没有证据把它归因为测试超时。

### Bounded learning

Provider 相同不等于 Executor 外观相同；所有去重都必须读实际渲染的外观。进程可用性与语义产出应在文案里说清楚，不能把 quiet Session 同时计入两个互斥描述。上述结论已归入本轮交互 SSOT；不另建知识或配置存储。
