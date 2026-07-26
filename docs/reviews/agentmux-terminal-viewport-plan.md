# AgentMux terminal viewport continuity plan

Status: approved

用户要求终端切回时不要每次从顶部滚下来：如果离开前在最新输出处，回切后继续显示并跟随最新输出；如果用户主动向上翻阅，回切后保留上次视口位置。首次建立或真正重建且没有可恢复视口记忆时，直接显示最新输出。用户进一步指出 TUI 会像逐字蹦出；连续的 live bytes 需要在有界窗口内合并成视觉批次，不能把底层 RuntimeEvent 边界直接暴露为绘制节奏。

行为 Owner 是 Desktop Renderer 的 `TerminalView`。保留的 xterm 实例负责保存短期展示状态；Renderer 在可见性切换边界记录并恢复视口，不把视口状态写进 ctxmux、Run 或 Agent Session。ctxmux 仍是 PTY 字节、replay、gap、attachment 与 ordered bytes 的唯一 Owner。

最小竖切是一个纯视口记忆判定模块加上 TerminalView 的 hide/show 接线：记录 xterm active buffer 的 `viewportY/baseY`，区分“跟随最新”与“保留滚动行”，回切时先恢复该判定再让既有 viewport synchronizer 做尺寸同步；live 输出在同一 owner 内按上限合批并在批次间让出。回放期间仍保持隐藏，避免用户看到从顶部滚落的中间帧。

验证必须覆盖四件事：底部状态恢复到最新、上卷状态恢复原行、TerminalView 确实在可见性边界调用记录/恢复而不是只测纯函数、连续小 live chunks 会合并而不是逐块写入。把恢复接线剪掉、把上卷分支改为最新或移除合批都应让测试变红。
