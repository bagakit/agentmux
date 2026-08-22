# AgentMux 本轮工作交接

更新时间：2026-09-22。用户要求列明在做和后续事项，交给另外一个 Agent；本 Agent 在此停止实现，不启动接手 Agent。

## 现场与约束

- 仓库：本仓库，当前在 `main`。
- 当前 HEAD：`b5c97ccb`（docs: record disk capacity blocker for macOS installation）。本轮实现均为**未提交工作区修改**，尚未打包、安装，不能声称已交付。
- Feature：`f-29r8fvgbg`，Status, Browser, Scratch Topic 与 Executor identity 收敛；current_tree。
- Tracker：T-001/T-002/T-003/T-004 为 in_progress，T-005 为 todo、等待前四项。没有任何 task 已 done；尚未运行 task gate。
- Tracker CLI：`feature-tracker.sh`。路径失效按 AGENTS.md 重新定位 `.sh`。
- 已写设计 SSOT：`docs/design/agentmux-desktop-interaction.md`、`docs/design/agentmux-surface-density.md`。
- Reviewed plan：`docs/plans/status-browser-topic-executor-task-plan-2026-09-22.json`；review：`docs/reviews/status-browser-topic-executor-2026-09-22.md`。
- 先读根 `AGENTS.md`、`RED-LINES.md`。需求先记录设计和 Tracker；done 前必须变异变红、零调用者检查、非空扫描证明；涉及布局/Session 必须验证重启后恢复。
- 核心 Runtime 不依赖 UI。ctxmux 是 Run/PTY/replay 权威；本轮主要改 Renderer，不创建第二份生命周期实现。
- 不启动其他 Agent，除非用户明确授权。用户现在只要交接清单。
- `docs/reviews/agents-session-board-navigation-2026-09-22.md` 出现的“右上角重复入口修复”增量**不是本轮写入**。共享工作区，保留并确认归属，勿回滚、勿混称本轮工作。Tracker index 也可能有并行修改。

## 1. 停止态误报和 idle 计数（T-001）

已改：

- `lib/session-state.ts`：agent-error 中 `AGENT_RUN_EXITED` 不再直接显示 error，新增 `displayStateForAgentError` 映射到 exited；其余 error 保留。Core 已有明确的 user-stopped/crashed/disconnected 投影。
- `lib/project-board.ts`：新增 `idleAgentCount`，只计 agent 且 status=running。
- `WorkspaceSidebar.tsx`：Project/Scratch 行显示 idle 数量，标签区分 working/idle，分组标题也含计数；`chrome.css` 加计数样式。
- 新增 `run-process-status-convergence.test.ts` 与 `working-count-convergence.test.tsx` 用例。

已验证：早期定向 31 tests 通过（后续其他组件改动后尚未最终重跑）。

接着做：复查 `AGENT_RUN_EXITED` 不会把真实 crash 的权威状态盖成中性；跑状态、attention、tree 测试，做两处变异（映射回 error、idle 返回零）及生产调用检查。

## 2. Browser 只显示 ready/control（T-002）

找到真实布局根因：`.browser-surface` 原为两行 grid `38px minmax(0,1fr)`，实际三个子元素：toolbar、operation rail、browser-stage。rail 占了页面伸展行，stage 落到隐式行。

已改：

- `BrowserOperationSurface.tsx`：无 operation、人类控制、无 warning 时返回 null；有交接/告警仍显示 rail。
- `styles/browser.css`：根容器改纵向 flex；stage `flex:1`，rail 不伸展，toolbar 固定 38px。
- 删除 Browser 对内部 Provider 图标的独立大小/圆框覆盖。
- `browser-operation-surface.test.tsx` 添加 idle rail 空输出测试。

接着做：真实 Chromium/Electron 测量 idle、Agent control、有 operation 三种情况下 stage 都有足够高度；截图看页面。仅 idle 返回 null 的单测**证明不了 grid 根因已修**。补 CSS/DOM 契约或布局测量；跑 browser-toolbar、browser-view-manager。至少两种通用导航/控制形态，不写站点特判。

## 3. Scratch / Topic 列表重做（T-003）

找到结构问题：Topic row CSS 两列，但 entry、reveal、wiki、其它按钮曾各自作为 grid 子元素，落入错行错列。

已改：

- `WorkspaceTopicsPanel.tsx`：统一紧凑 Topics header、loading/empty/create 状态；行首 NotebookText/spinner；当前行 data 标记；操作全部包到 `.workspace-topic-actions` 一个 grid 单元；点击操作 stopPropagation。
- `styles/dock.css`：紧凑 outlined list、两列布局、42px 行、选中左边线、动作 hover/focus 显示、较小 wiki 文本。
- 父级 Scratch 行计数已随 T-001 修改。原 Project pin 小字、下划线、虚线、dense 档已存在；本轮未重新实现。

已验证：早期 scratch-topics、scratch-topic-layout、topic-agent-status、Browser surface 共 71 tests 通过；最新 topic-agent-status 24 tests 通过。

接着做：实际窄栏/长标题/多个 Agent/打开 Topic/空态的视觉检查；检查操作区仍可能过宽；检查小图 mosaic 缩放和 tooltip。原测试多为数据投影，不能证明行布局正确；补实际结构/布局断言和变异。

## 4. 统一 Executor 图标和 hover 面板（T-004）

已改共享组件 `AgentAvatar.tsx`：

- 现在支持可选 state、executorId、sessionId、size、detail；没有状态时不造假状态。
- `ExecutorIdentityContext` 接收 desktop config 与 sessions，根 `App.tsx` 提供；根据 session/executor 解析头像、标签和状态。
- Provider + 小 badge + enamel 使用同一路；working 用 Activity 图标，idle/normal 不画常驻点。
- hover/focus 弹出 portal 信息面板；小设置按钮 `navigation.open('agents', executorId)`；显示状态 detail。旧 `AgentIdentity` click popover 改为薄封装。
- `SettingsNavigation`/`App`/`SettingsPanel` 增加 executorId 路由；`AgentSettingsPane` 打开并滚动到对应 details。
- `WorkbenchTabMarks` 不再 Provider + 独立 StatusDot；tab facts 携带 sessionId。
- `SessionConnectingSurface` 删除独立 ConnectingExecutorMark，使用无状态 AgentAvatar。
- SelectorList、TopicPresence、Branches、Topic 列表、Browser rail、NewTab、BoardDiscussion、WorkspaceBoard、GlobalAgents、ProjectActivity、SurfaceToolDock、QuickSwitcher 已换共享组件或补身份传递。
- 移除 tabs/dock 特制状态点尺寸覆盖；SurfaceToolDock/WorkspaceBoard 去重独立 Agent 状态点。
- Provider 汇总 `AgentStatusBar` 与历史说话人 `ConversationSpeakerAvatar` 仍用纯 ProviderIcon（不是具体 Executor）；审查语义后决定是否保留。

必须继续审查的风险：

1. `markAppearance` 去重键仍只含 provider/status，**尚未把不同 Executor 的 avatar 外观纳入**；同 Provider/同状态但 badge/tint 不同可能被折掉。需要修复并加测试。
2. hover panel 用自写 fixed portal、160ms 延迟：需测试鼠标移入面板、离开、Escape、滚动、resize、焦点到设置按钮，以及窄窗边界。当前无 scroll/resize dismiss；role=dialog 有交互但触发器 role=img，需要核对键盘访问。
3. AgentSettingsPane 深链接 effect 仅依赖 executorId；同一已打开 SettingsPanel 再切其它 Executor 时 active 初始 state/路由更新是否生效需检查。
4. Electron WebContentsView 是 native 层，Browser rail 的 portal 面板可能被页面盖住，需要真实 UI 验证。
5. Context 根提供会随 sessions 变化渲染所有头像；先验证行为，不要扩大重构。
6. 尽管头像统一，仍须扫其它独立状态点/ProviderIcon 调用者，确认没有重复标记。
7. 珐琅算法 `AgentEnamelFilter` 本轮未改：已有闭合 alpha、neutral backing、opaque 1px rim，源图在最上。需要实际截图证明不是荧光，不要以 JSX/filter 存在等同视觉验收。

## 5. Avatar 设置归属（属于 T-004）

已改：

- AppearanceSettingsPane 不再编辑头像。
- AgentSettingsPane 每个 Executor card 内有 tint、固定 badge、Reset，和 Executor 一起保存。
- desktop `shared/contracts.ts` 定义 `AgentExecutorConfig = CoreAgentExecutorConfig & { avatar?: AgentAvatarAppearance }`；Core 类型不改。
- `config-store.ts` Executor schema 新增 avatar；AppearanceConfig/schema 删除 agentAvatars。
- 生产读取点改为 `config.executors[id].avatar`。
- Appearance schema 从 strict 改为 strip，意图为去掉退休字段同时保留 palette/font。**必须复查是否合乎仓库的无兼容/无迁移要求，以及是否会静默丢掉用户原头像。当前未解决旧自定义头像保留策略。** 不可把旧 config 加载成功当成旧头像已保留；不要擅自重置用户配置。

已验证：更新后的 agent-avatar-config 3 tests 通过（新配置保存/重新读/非法值拒绝）。需补旧已安装配置检查及与 Core 配置传递的类型/协议检查。

## 6. 当前测试断点（优先处理）

最新 `pnpm --filter @agentmux/desktop typecheck` 已完整通过。

最新定向运行中通过：

- workbench-tab-marks：39 tests
- topic-agent-status：24 tests
- agent-avatar-config：3 tests
- session-connecting-surface：9 tests

但是 `agent-avatar-settings.test.tsx` 在同轮运行中造成 Node heap OOM，整个命令失败，**不能说测试全绿**。

该轮日志留在临时文件，没有入库。运行命令：

```sh
pnpm --filter @agentmux/desktop exec vitest run test/agent-avatar-settings.test.tsx test/agent-avatar-config.test.ts test/session-connecting-surface.test.tsx test/workbench-tab-marks.test.ts test/topic-agent-status.test.ts
```

OOM 待证假设：新测试把含 review 的 config 传给 AgentSettingsPane，但 composerDOM 默认 store.config 只有 codex；AgentSettingsPane effect 等 review detection，store.detectExecutors 只探测 store 的 executors，造成状态更新循环。应先逐个 `-t` 定位、让测试 store/config 一致并稳定 mock 原生检测，别只提高 heap 掩盖循环。另：脚本在该测试文件最前插入 import，把 `// @vitest-environment happy-dom` 移到第二行；核对环境注解仍被识别。

新 tests 已改为验证 Executor 设置、hover/focus、设置路由、appearance 无头像编辑。由于 OOM，这些新用例尚未验证。

前一轮通过过 agent-avatar-state-visual 11、browser-operation-surface 12、sliced-scan 2、vacuous-on-empty 3。最终需在整合后重跑。

## 7. 尚未建立的验收证据

- Plan 多处引用 `apps/desktop/test/status-idle-browser-topic-executor-contract.test.ts`，**文件尚不存在**。要建立来源扫描非空断言，覆盖 Browser 布局、Topic action wrapper、共享 Avatar 调用者、settings 路由、idle count 接线；不要写手工清单冒充来源。
- 所有 task 的变异测试尚未跑。建议逐次改坏并恢复：停止映射回 error；idle 计数归零；Browser flex 改回旧 grid；Topic wrapper 拆掉；Tab 改回独立状态点；hover handler/Executor 路由移除。每次保存原文件、确认相关用例红、恢复后绿。
- 零调用者检查尚未最终记录。检查 AgentAvatar、idleAgentCount、BrowserOperationRail、Topic 组件等真实生产调用，排除定义文件与测试。
- 重启恢复回归尚未跑：至少 store-persistence、workbench-persistence；再用真实已安装进程重启确认原 Tab/Tab Group/Region/焦点/布局保留并恢复 Session。
- 未跑 desktop test typecheck；旧测试 fixture 可能仍有 avatar 旧结构/AppearanceSettingsPane 的 executors prop，需检查。

## 8. 收尾顺序

1. 解决上述 OOM，确认不是生产 effect 循环。
2. 补 Tab 去重外观、hover 边界/键盘、配置归属风险，做实际 UI 观察。
3. 建 missing contract test，跑完整本轮定向测试 + typecheck/test typecheck + 恢复回归。
4. 做变异/零调用者检查，记证据到本 Feature review/verification。
5. `run-task-gate`、`finish-task` 完成 T-001..T-004；再 start T-005。
6. Review 当前 diff，确认无别人的文件混入；主干提交本轮实现、设计、Tracker。不要直接 git add -A 吞掉共享目录中的外部工作。
7. 提交后打包安装：`pnpm --filter @agentmux/desktop package:mac:install`。此命令包括较多打包/runtime/smoke 验证，读脚本再操作。
8. 最后观察磁盘只有约 6.3 GiB 空余；前一个提交记录过空间不足。打包前先 df，删除仅能确定本任务拥有、可重建的临时产物；不要删用户数据或其它构建。
9. 核对新包 source SHA、安装位置、启动进程与画面，确认工作面恢复；不以 DMG 生成代替安装成功。
10. T-005 gate/finish；按 Tracker skill closeout（documentation/learning/promotion）并归档。安装结果、未完成项如实说明。

## 9. 早前用户要求：作为安装版回归清单，尚未全部重新审计

用户长线程还要求过以下内容。本轮聚焦上面的 Feature，不要假设这些已经在最终包正确交付：

- 图标只最外层 1px 珐琅描边，镂空先面化，Provider 与自定义小 badge 一起计算；无荧光；固定 badge 而非自定义文字。
- Project pin 小字、下划线 hover、虚线关联；减缩进、增加更紧密档位。
- Interrupt 统一颜色，不回退黄色。
- `[Output sequence gap; earlier bytes are unavailable]` 及显示错乱。
- AgentMux `--skill` 应教自己/Workspace 取可读名称（不是 Agent Lark）。
- restoring 和 launching 界面质量相当但明确不同。
- Codex 对话模式后续 user 消息漏显示。
- region 缩放正确后顶部 redraw 提示同步。
- terminal DMG/本地文件链接打开系统应用及 Finder/Explorer 菜单。
- 状态只 working/需提醒画角标，idle 用树计数；停止不能红叹号。
- 与需求池/Feature Tracker 的相关条目闭环；保持 Provider/插件化边界，可参考 deepseek-harness/a mature workbench。

接手者应以 git history、当前 code、Tracker 和安装版实测判断哪些已完成、哪些要补，不把这份历史清单全部当本轮新实现。用户仍期待主干提交和最新安装包。
