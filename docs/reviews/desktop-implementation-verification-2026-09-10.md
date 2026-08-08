# Desktop implementation verification

范围索引：`docs/delivery/desktop-experience-update-2026-09-10.md`。
本记录汇总实施验证，不替代安装后的交付验收。

## 候选与命令

实施基线为 `9487471`；后续文档提交不改变产品实现。
`pnpm typecheck` 通过。与 `test:fast` 相同排除项的 Vitest 全量快速检查通过：
459 个文件通过、3 个跳过，5548 个测试通过、3 个跳过；以四个 worker 运行。
测试子进程清除继承的 `AGENTMUX_*`，避免当前受管会话的 hook、Session store 和 Runtime
环境污染隔离用例。Core 构建串行执行，不能让两个检查同时删除和写入同一 dist。
最终 renderer manifest 身份调整随后通过对应 Tracker gate 的 8 项检查。

各 Feature `tasks.json` 保存实际命令 gate；本次没有将跳过项宣称为通过。
原始会话证据保留在本机 `amx-full-final.log`、`amx-typecheck-final.log`、
`amx-renderer-final-gate.log`、`amx-mutation-evidence.json` 与 `amx-production-callers.txt` 临时产物中；
本记录保留不会随临时目录清理而丢失的结果和边界。

## 十二项变异

以下实现变异逐项使相应测试变红，随后恢复原始字节并重跑对应 Feature gate。

| 变异对象 | 被破坏的行为 | 非定义文件中的产品消费者 |
| --- | --- | --- |
| HoverDropdownMenu | 悬停开启 | PaneSplitMenu、BrowserPane、AgentRoster 等 |
| ProjectRailToolbar | 底部键盘帮助入口 | App、WorkspaceSidebar |
| Explorer 链接目录处理 | 按链接路径展开 | Main IPC 与 Explorer 树 |
| discoverAgentSkills | 实际技能发现 | Main IPC |
| ProjectActivity | 待处理明细与会话定位 | WorkspaceSidebar |
| RendererUpdates | 加载前 checkpoint | Main index |
| 工作台持久化 | 草稿与 dirty 内容保留 | App store 与 Main checkpoint |
| TerminalReplayGapNotice | Redraw 结果反馈 | TerminalView |
| TerminalViewportSynchronizer | 未交付 resize 不得报成功 | TerminalView |
| isImeOwnedKeyboardEvent | 组合键不被快捷键截走 | shortcut-registry、terminal-shortcuts |
| 已安装 xterm CompositionHelper | 排除旧 textarea 后缀 | TerminalView 的 Terminal 实例 |
| 已安装 WebGL GlyphRenderer | 每个 renderer 的图集代次检查 | TerminalView 的 WebglAddon |

生产调用检查排除定义文件与测试文件；不是仅证明存在导出符号。
依赖变异采用原子替换以避免修改 pnpm 共享硬链接，之后恢复。

## 原生证据与限制

隔离 Electron profile 的文件源存储实验通过：跨候选目录加载保留草稿、dirty 内容和布局，
回切保留后续用户修改。另一隔离 Electron 实验加载实际安装的 xterm 产物，
两次在已有中文中间组合输入的发送结果严格为 `['新增', '中文']`，没有重复旧文字。
这是 Electron 内的合成 CompositionEvent，不能表述为真实 macOS 输入法人工实测。

安装前原生文件编辑探针发现 tooltip 文案与项目定位耦合。修复使用既有 Workspace ID 后，
完整探针通过保存代次、冲突、工作区回访、菜单移动、PointerSensor 拖动和 hover 展开。
该修复由安装任务 T-002 持有。对实际编译的 Main 选择器做变异（将 data-workspace-id 改成 title），同一原生探针在项目定位处失败并 exit 1；随后逐字节恢复编译产物。生产非定义文件调用在 Main index。完整打包 gate 和安装后连续性仍须另行提供证据。

## 复盘

调试隔离环境前先检查依赖产物与继承变量。新工作树虽然完成依赖解析，Electron 二进制
没有落盘；执行该锁定依赖自带安装程序补齐。类型和单测通过不能证明打包依赖齐全。
测试定位使用真实身份，tooltip 留给用户说明；不为通过旧选择器删掉已接受的产品体验。
这些教训复用已有项目原则，不另建配置层、日志系统或知识生命周期。
