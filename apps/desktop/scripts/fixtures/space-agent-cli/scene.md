# Space CLI：后台移动与显式导航

约束来自 [交互 SSOT](../../../../../docs/design/agentmux-desktop-interaction.md) 的 Space/Zone/Tab/Region、后台启动、布局移动、重启恢复和服务窗章节，控件遵循 [密度 SSOT](../../../../../docs/design/agentmux-surface-density.md)。

实际产品 App/Store/WorkspaceWorkbench/SessionPane/TerminalView 在私有 Electron profile 中渲染。四个 Agent 通过真实 Control socket、Desktop IPC bridge、Main Git/目录 owner 和 Core 启动；Provider 是仓库 fake Codex CLI。没有访问用户 App、Runtime 或 Session。可选 warm shell 在 fixture API 边界排除。

- `background-move-source.png`：PMO 在另一个 Space 开出首 Tab；调用者工作面含 A/B/C 三格，A 活动时用公开 CLI 后台搬走它。源工作面保留精确逻辑焦点，显示持续提示，B/C 不被自动选中、键盘关闭或分屏。私有下一次命令沿产品真实 shortcut caller 验证无动作。
- `explicit-target-focus.png`：独立 Electron 重启后保留同一布局及焦点引用，再通过公开 CLI `--focus` 到精确目标。产品自行把 DOM caret 移入该 Region；Chromium 输入字符走真实 TerminalView/Core/ctxmux，原 Run 输入字节增长并显示 Provider 的 composer 输出。fixture 不调用 terminal.focus 补导航。

采图只证明这些真实私有场景。看图由独立 Agent 完成，结果与截图、source hashes 和回执放在同一轮证据中；采图成功本身不代表审美通过。
