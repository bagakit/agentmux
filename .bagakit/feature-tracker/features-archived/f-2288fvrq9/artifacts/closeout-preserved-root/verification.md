# T-004 Refproj Terminal 与文件菜单验收

## Automated Checks

- Command: `pnpm check`
- Result: 通过；Terminal／Explorer 交互、CtxMux 控制边界、黑底 Agent Surface、OSC 回复时序与 Production build 均有自动证据。
- `pnpm check` 通过：Core/Desktop typecheck、194 个 Fast tests、1 个 checkout-external packed CtxMux native consumer 和 Production build 全绿。
- `terminal-theme.test.ts` 固定 Graphite 真黑工作面、Refproj-derived ANSI 色槽、12px 字号例外、1.0 行高、字重、滚动、Option 与对比度参数。
- `terminal-osc-color-query.test.ts` 与 `runtime-controller.test.ts` 固定 OSC 10/11 完整／跨 chunk 解析，并证明 Desktop Main 必须等 Core 发布 ready Agent Session 后才经 Core → CtxMux Input 回复，不与 Codex Terminal handshake 竞争 Input cursor。
- `terminal-viewport-sync.test.ts` 固定 historical Run 只做本地 xterm fit，不发送 PTY Resize；Renderer 同时禁止其 Input 与 OSC 回复。
- `terminal-shortcuts.test.ts` 固定 macOS Command 与其他平台 Ctrl+Shift 行为，不夺走 Agent CLI 的 Ctrl chord。
- `external-url.test.ts` 固定 Main 只允许 HTTP/HTTPS；`file:`、`javascript:` 与 `data:` 失败关闭。
- Explorer tests 固定 host-native Copy Path、Workspace Root confinement、本地 Reveal 与远端拒绝；Production bundle 包含 Search、WebLinks、WebGL 和 Radix Context Menu。
- `package:mac:install` 通过完整 DMG、签名、CtxMux artifact、LaunchServices 与安装 Gate；候选已安装到 `/Users/bytedance/Applications/AgentMux.app`。

## Manual Checks

- Step: 在当前安装候选中打开新 Codex 与历史 Run，并检查视觉层次、右键菜单、只读回放和元信息复制。
- Outcome: 等待 Owner 在已安装候选中完成视觉与交互验收；自动 Gate 不代替人工结论。
- 当前候选已重新安装；启动后必须确认 `AgentMux` Main 与其内置 `ctxmuxd` 都来自 Applications 路径。
- 需要 Owner 在当前已打开的 Production App 中新建 Codex，确认输入区灰色语义背景、ANSI 色彩、字形密度、右键菜单和文件行菜单与 Refproj 参考一致。
- Computer Use 当前缺少 Accessibility 权限，因此本轮没有把无法观察的窗口状态伪装成自动视觉通过。

## Residual Risks

- AgentMux 使用与 xterm 5.5 兼容的稳定 Search/WebLinks/WebGL addons；Refproj 当前使用带大规模产品私有补丁的 xterm 6 beta。当前先对齐公开行为、palette、metrics 与渲染策略，不复制 Refproj 的 1,200 行 vendor patch。若 Owner 视觉验收仍发现渲染级差异，应以具体像素／行为证据决定是否需要更窄的上游修复，而不是整包引入 Refproj 私有 patch stack。
- 可选真实 Codex E2E 已证明本轮候选能创建真实 Run，Terminal handshake 持久化为 `[0,5)`，且没有复现 `applied-input cursor is 50, not expected 0`。完整用例未在 120 秒内闭合：用户 Codex 启动 8 个 MCP 时，`codex_apps` 返回 token expired，目标回答在测试门限后才输出；这属于外部 Codex 配置／延迟，不记为 T-004 自动通过。
- T-003 的资源总验收仍是独立未完成任务；本文件只证明 T-004，不把 Terminal 交互通过外推为资源收敛完成。

# T-010 Scratch 与 Project Rail 验收

## Automated Checks

- `workspace-projects.test.ts` 固定 Scratch 与普通 Project 的导航投影分离。
- `workspace-selection.test.ts` 固定 `projectRailOpen` 只改变 Renderer UI 状态，不改变 `toolsOpen`、Tab、Layout 或 Session owner。
- Desktop typecheck 通过；最终统一 Gate 由 Tracker 的 T-010 gate result 记录。

## Manual Checks

- 2026-08-21 通过 Computer Use 在开发版 Electron 窗口验证展开、收起、重新展开，以及收起状态下关闭和重新打开 Workspace tools。
- Surface tools 打开时，compact title cap 由最左侧 activity bar 承接；tools 关闭时由 root tabbar 承接。两种状态都从窗口左边开始，并保留 traffic lights、Show projects sidebar、Show/Hide workspace tools 和 180px 右边界。
- Project rail 的纵向导航在收起后完全释放；36px 以下没有空 rail。整个往返没有宽度动画，也没有清除当前 Workspace、Tab、Session 或 Terminal 内容。

## Residual Risks

- 当前人工证据覆盖 root tabbar 与 Surface tools owner 交接；split chromeline 与 Board topbar 通过同一个 `TopRowLeadingChrome` 路径和 Production build 证明结构一致，但没有为验收临时改写用户当前 Pane 布局。

# T-011 顶部双导航固定槽位验收

## Automated Checks

- Desktop typecheck 与 Scratch / Project rail focused tests 通过；最终统一 Gate 由 Tracker 的 T-011 gate result 记录。
- `projectRailOpen` 与 `toolsOpen` 仍由原有 Zustand UI Store 独立持有，没有增加位置状态、配置字段或动画。

## Manual Checks

- 2026-08-21 通过 Computer Use 依次验证 Project rail / Workspace tools 的 `开/开`、`关/开`、`关/关`、`开/关` 四种组合。
- 四种组合中 Projects `PanelLeft` 始终是红绿灯后的第一个槽位，Workspace tools `PanelsTopLeft` 始终是第二个槽位；坐标与顺序不变，只有 active 背景和 accessible name 改变。
- Rail 展开时 BrandIcon 接在固定控制后；Rail 收起时 180px title cap 在控制之后结束。Tools dock 与 main top row 的 owner 交接没有产生重复按钮。

# T-013 Project rail 收起后的工具栏边界验收

## Automated Checks

- `surface-tool-dock.test.ts` 固定普通 236px 与 rail 收起态 274px 两个渲染下限；274px 来自 180px compact title cap、4px 列间距、三个 28px Workspace 工具按钮、两个 1px 按钮间距和 4px 右 padding。
- 同一测试固定仅切换 rail 时保存宽度仍是 236px、收起态渲染为 274px、重新展开后重新呈现 236px；无位移 resize 不提交临时下限，有位移 drag 从实际渲染边界开始。
- `workspace-selection.test.ts` 固定 `toggleProjectRail` 前后 `toolDockWidth` 仍为 236px；active 最小宽度同时用于鼠标 resize、键盘 resize 和 separator 的 ARIA 数值。
- Focused tests、Desktop typecheck 与 `git diff --check` 通过；最终统一 Gate 由 Tracker 的 T-013 gate result 记录。

## Manual Checks

- 2026-08-21 通过 Computer Use 在干净重启的开发版 Electron 中依次验证 `开/开`、`开/关`、`关/关`、`关/开` 四种组合。
- `关/开` 状态中三个 Workspace tool 按钮完整显示在 180px compact title cap 之后，tools dock 的右边界位于首个 Claude Tab 之前；Computer Use 截图与 Accessibility tree 同时确认该边界。
- 四种组合中双 toggle 顺序和坐标稳定；tools 关闭时 main top row 接管 compact chrome，tools 打开时 activity bar 接管，没有重复 owner、隐藏工具按钮或叠加层。

## Residual Risks

- Electron 窗口已有 980px 原生最小宽度，274px dock 下限不会与 `max-width: calc(100% - 48px)` 冲突。Board 只有一个工具入口但沿用同一收起态下限，以避免 Board/Workbench 切换时再次改变窗口 chrome 边界。

# T-014 Project rail 紧凑底栏验收

## Automated Checks

- `project-rail-toolbar.test.ts` 固定展开态只有 Settings / Hosts 两个直达按钮、无 `Settings & hosts` 文案，并固定收起态只保留一个 Settings 角标。
- `workspace-selection.test.ts` 与现有 Project rail tests 继续固定 Settings route 不进入 Zustand，Project rail 开合不清除 Workspace、Tab、Layout 或 Session owner。
- 相关 16 个 focused tests、Desktop typecheck 与 `git diff --check` 通过；最终统一 Gate 由 Tracker 的 T-014 gate result 记录。

## Manual Checks

- 2026-08-21 通过 Computer Use 在 1480×940 的开发版 Electron 窗口验证展开态底栏：40px toolbar 只有 Settings 与 Hosts 两个图标入口，Accessibility tree 投影为 `Project rail tools / Settings / Hosts`。
- Hosts 图标直达 Settings 的 Hosts section；Settings 图标直达 General。关闭 Settings 后分别恢复进入前的 rail 展开或收起状态，以及原 Workspace、Tabs 与 Session。
- Project rail 收起后，整条纵向 rail 释放，只在窗口左下角留下 36×36 Settings 角标；重新展开后角标消失，rail 内 toolbar 只出现一组，没有重复入口。
- 分别检查 Workspace tools 打开和关闭状态：tools 打开时角标位于 tools dock 的空白左下角；tools 关闭时角标保持在窗口角落，避开顶部导航、Terminal 的右侧滚动条与当前输入行。

## Residual Risks

- 角标是用户明确要求的窗口级浮动 affordance；Workspace tools 关闭时它会占用 Terminal 左下角的 36×36 像素，但当前人工场景中该区域只有非交互状态文本。若未来 Terminal 在左下角增加 app-owned 按钮，应由同一 Project rail navigation owner 重新分配该角标位置，而不是再叠一个浮层。

# T-015 顶部双导航位置验收

## Automated Checks

- 现有 `SidebarToggleChrome` 仍是所有顶行 owner 的单一组件；本任务只把其 macOS traffic-light pad 从 112px 收回到 Refproj 已验证的 80px，没有改动 Zustand、owner 交接或 dock 宽度计算。
- 相关 16 个 focused tests、Desktop typecheck 与 `git diff --check` 通过；最终统一 Gate 由 Tracker 的 T-015 gate result 记录。

## Manual Checks

- 2026-08-21 通过 Computer Use 在 1480×940 的开发版 Electron 中验证 Project rail 展开态：两个 28px toggle 的中心从原来的 x=126px / 156px 收回到 x=94px / 124px，紧跟 macOS 红绿灯，不再悬在 rail 中间。
- 依次验证 Project rail 收起且 Workspace tools 打开、Project rail 与 Workspace tools 都收起，以及 Board topbar；三个 owner 状态中按钮顺序与 x=94px / 124px 坐标一致。
- 180px compact title cap、rail/tools 分组边界、首个 Tab 与 Board breadcrumb 均保持清晰；剩余 title cap 是可拖动呼吸区，不再是按钮前方的死区。

## Residual Risks

- 本轮按用户截图处理 macOS 普通窗口。全屏时原生 traffic lights 不显示，但当前 AgentMux 仍沿用同一 80px pad；如果后续要针对全屏回收这段空间，应由 Electron window-chrome owner 提供明确的 full-screen 状态，而不是在 CSS 中猜测平台状态。

# T-016 Project rail 底栏与角标密度验收

## Automated Checks

- `project-rail-toolbar.test.ts` 固定展开态只有两个局部 compact button、收起态只有一个同类 Settings button，并固定图标降到 13px；没有修改全局 `.icon-button`。
- 相关 11 个 focused tests、Desktop typecheck 与 `git diff --check` 通过；最终统一 Gate 由 Tracker 的 T-016 gate result 记录。

## Manual Checks

- 2026-08-21 通过 Computer Use 在 1480×940、2× DPR 的开发版 Electron 中验证：展开态 footer 从 40px 降到 32px，内部 Settings / Hosts 为 24px button；Accessibility tree 仍投影为 `Project rail tools / Settings / Hosts`。
- Project rail 收起后，左下入口外框从 36×36 降到 28×28，距左、下各 4px；截图确认已移除浮动卡片式重阴影与 backdrop blur，角标位于 Workspace tools 空白区且没有覆盖 Terminal 输入或 resize handle。
- 实际点击左下角标后进入 Settings 的 General section，证明 compact 投影仍调用原有 `settingsRoute`，不是静态装饰或第二套状态。

## Residual Risks

- 24px 是参考 Refproj `icon-xs` 的视觉与命中尺寸，也是本轮继续压缩的下限；若未来需要更大的无障碍命中区，应通过不可见 hit slop 扩大点击区，不把角标重新画成 36px 浮动卡片。

# T-017 Agent / Terminal Pane 单行 Tabbar 验收

## Automated Checks

- `session-metadata.test.ts` 固定 Session tooltip 包含完整 ID、Host、Started、Active，运行中与 interrupted Session 可 Stop、exited Session 不再显示 Stop；结构 guard 固定 `SessionPane` 不含 `session-info-bar` / `Stop Run`，Run action 与 Copy Session ID 分别归 Pane Tabbar 和 Tab context menu。
- 相关 16 个 focused tests、Desktop typecheck 与 `git diff --check` 通过；最终统一 Gate 由 Tracker 的 T-017 gate result 记录。

## Manual Checks

- 2026-08-21 通过 Computer Use 在 1480×940、2× DPR 的干净重启开发版中验证：原来位于 Tab 下方的 28px `ID / Started / Active / Recent / Stop Run` 整行已经消失，Terminal 内容直接从唯一 Pane Tabbar 下方开始。
- 选择仍在运行的 Claude Session 后，Accessibility tree 在同一 Tabbar actions 中投影 `Terminal / Activity / Stop Run claude · deepseek-harness / New tab`；截图确认 Stop 是 24px 无文字方形图标，没有形成第二行。选择 exited Codex 时 Stop 不出现。
- Provider icon、Session label、状态点和 Close 仍在各自 Tab 中；四个既有 Agent Tab、Workspace / Board switch 与 Surface tools 保持同一横向 header，没有改变 Tab 顺序或 owner。

## Residual Risks

- 本轮只把完整 Session ID 放入 context menu；Start / Active 保留在 Tab 原生 tooltip，Recent 回到 Activity View。若后续需要更强的诊断面，应新增按需打开的 Session Inspector，而不是恢复常驻第二行。

# T-019 窄分屏 Tab overflow 验收

## Automated Checks

- `workbench-tab-strip.test.ts` 固定无 overflow、左右边界和小数像素容差下的导航状态；Desktop typecheck 与统一 Gate 证明组件、Renderer 和 Production build 兼容。
- Tab overflow 仅由 `WorkbenchTabStrip` 持有三个布尔显示状态，没有新增依赖、Zustand 字段、Layout 字段或 Core API。

## Manual Checks

- 2026-08-22 用 Playwright 在 1200×760 Web Desktop 中创建 7 个同 Pane Tab，再从 Pane 自己的 Split 按钮向右创建空 Pane。
- 原 Pane 的 7 个 Tab 均保持 112px 可读下限，所有 label 的 `white-space` 为 `nowrap`、高度为 12px；Tab strip 为 `scrollWidth=832`、`clientWidth=246`，显示两侧导航。
- 向 Tab strip 发送纵向滚轮后 `scrollLeft` 从 0 变为 120；分别激活首尾隐藏 Tab 后滚动位置到达 0 与最大边界，证明 nearest reveal 可达全部 Tab。
- 右侧空 Pane 保持独立：Tab 数为 0、`scrollWidth=clientWidth=220`、不显示 overflow 导航。整个复现中 Renderer Console 为 0 error / 0 warning。

## Residual Risks

- 触控板横移沿用浏览器原生横向滚动，本轮自动化验证覆盖了同一 scroll owner 和鼠标纵向滚轮映射，没有伪造硬件触控板手势。
