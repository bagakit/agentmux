# Terminal 外观：palette、OSC 颜色回复与主题边界

本文说明终端外观的当前源码机制：完整 ANSI palette 由谁定义，Desktop 主题与 TUI 自身表面的边界，以及 OSC 10/11 颜色查询由谁、在什么时机回复。字节通路、附着与输入见 [Terminal 运行时](terminal-runtime.md)；本文不声明某个安装或运行实例已通过验证。

## 外观所有权

物理终端通路只传输字节、尺寸与生命周期，不承载主题（见 [Terminal 运行时《端到端链路》](terminal-runtime.md#1-端到端链路)）。外观相关的事实分别由以下位置持有：

| 关注点 | Owner | 源码入口 |
| --- | --- | --- |
| xterm theme（终端外观 `ITheme`） | Renderer，取自共享 palette | [terminal-theme.ts](../../apps/desktop/src/renderer/src/lib/terminal-theme.ts)、[terminal-palettes.ts](../../packages/client-ui/src/theme/terminal-palettes.ts) |
| App chrome（产品外框视觉） | Desktop 应用外框，与终端外观分开 | `terminal-theme.ts` 的边界说明 |
| OSC 10/11 回复所用的前景／背景色 | client-ui 的共享 palette，经 `setTerminalViewColors` 注入 Main | RuntimeController／IPC、`terminal-palettes.ts` |
| Agent 的 OSC 10/11 回复（Renderer 未附着时） | `RuntimeController`（Main） | `publish` / `replyToAgentColorQuery` |
| 普通 terminal 的 OSC 10/11 回复（Renderer 在场） | Renderer 的 xterm parser handler | [terminal-capability-replies.ts](../../apps/desktop/src/renderer/src/lib/terminal-capability-replies.ts)、TerminalView |

`terminal-theme.ts` 的注释概括了这一分层："App chrome owns product surfaces, xterm owns terminal appearance, and the PTY/CtxMux path owns bytes only."

## 完整 ANSI palette

终端外观由一份完整的 `ITheme` 决定，唯一来源是 `packages/client-ui/src/theme/terminal-palettes.ts`。`TerminalPalette` 类型要求 23 个键：`background`、`foreground`、`cursor`、`cursorAccent`、`selectionBackground`、`selectionForeground`、16 个 ANSI 角色（`black`…`brightWhite`），以及 240 色的 `extendedAnsi`（索引 16–255）。`apps/desktop/test/terminal-theme.test.ts` 断言每个 catalog palette 恰好 23 个键、`extendedAnsi` 恰好 240 项，不允许残缺的 palette。

当前 Graphite 的默认值：

- `background: '#000000'`：Graphite 稳定的纯黑工作面。
- `foreground: '#ffffff'`。
- `cursorAccent: '#000000'`：与工作面一致。
- `black: '#1d1f21'`：ANSI 黑，与工作面是两个不同的角色。

完整 palette 让 TUI 可以用 ANSI 背景区分 composer、instruction block 与终端工作面，不需要 Desktop 解析或改写 TUI 输出。

## 主题边界

1. **Desktop 主题决定工作面。** Graphite 稳定使用 `#000000`，Codex 等 TUI 的灰色 composer 与消息表面因此保持原生层次。
2. **TUI 决定自己的 surface。** ANSI `black` 保持 `#1d1f21`，不等于 `background`；完整的 16 色角色让 composer、消息块和警告自行分层。Desktop 不解析 ANSI 输出，也不为单个 Provider 动态改写 palette。
3. **OSC 10/11 只报告所选 palette 的真实值。** Renderer 与 Main 使用同一份共享 palette；Renderer 未附着时 Main 也回复 `#000000`，同一个 Run 在附着前后看到一致的宿主背景。

## OSC 10/11 回复的编码

回复格式在 `apps/desktop/src/shared/terminal-osc-color-query.ts`：`cssColorToOscRgb` 把 `#rrggbb` 转成 16 位的 `rgb:RRRR/GGGG/BBBB`（每字节重复为 4 位十六进制），`terminalOscColorQueryReply` 按 slot 10／11 选前景或背景并加上 OSC 终止符。`terminal-osc-color-query.test.ts` 锁定这一格式，例如 `#000000 → rgb:0000/0000/0000`。

## OSC 回复的时机

Codex 可能在 Renderer 尚未附着时就发出 OSC 10/11 查询。如果在 Core 完成自己的终端握手（`client.ts` 的 `ensureTerminalHandshake`）之前抢先回复，回复会与握手争用同一个 ctxmux 输入 cursor。回复因此分两条路径，并且回放中的旧查询不回复。

### Agent：Main 缓冲，Session ready 后再回复

`RuntimeController.publish`（`runtime-controller.ts`）用 Core 已解码的实时文本识别完整或跨块的查询。只有重连快照中超出已发布游标的原始尾段需要流式解码。普通输出没有 OSC 起始、也无需保留或清理分片时，扫描直接返回。分片保存在对应 Host 和 Run 的 `terminalColorQueryRemainders` 中。

- 该 Run 还没有 ready 的 Agent Session（`readyAgentColorQueryRuns` 无记录）时，回复暂存进 `pendingAgentColorQueryReplies`，上限 4 KiB。
- Core 发布 `agent-session` 事件后，该 Run 标记为 ready，暂存的回复经 `replyToAgentColorQuery` 写回。写回调用 `RuntimeController.write(…, 'terminal-protocol')`，与按键、粘贴共用 Host 在途 owner，不另开连接准备（见 [Terminal 运行时《输入顺序与等待成本》](terminal-runtime.md#12-输入顺序与等待成本)）。
- Run 结束或被移除时清理这三张表。

回归测试 `apps/desktop/test/runtime-controller.test.ts` 的「answers split Codex color queries only after Core publishes the ready Agent Session」先发一个跨两个 chunk 的 `OSC 10;?;?` 查询，断言 `writeAgent` 未被调用；发布 `agent-session` 后，断言当前前景／背景色的 OSC 回复被写回。测试以同一共享 palette 的 Graphite 纯黑背景核对 Main 的回复，不另存一套颜色示例。

### 普通 terminal：Renderer 回复，回放不回复

`session.kind === 'terminal'` 时由 Renderer 的 xterm parser handler 回复（`TerminalView.tsx` 的 `respondFromRenderer: session.kind === 'terminal'`）。`installTerminalOscHandlers`（`terminal-capability-replies.ts`）为 slot 10／11 注册 OSC handler：

- 只有 `respondFromRenderer && !isReplaying()` 时才回复；`isReplaying` 绑定为 `() => replayingContinuation || historicalOutputDepth > 0`（`TerminalView.tsx`）。
- 无论是否回复都 `return true`：xterm 消费该 OSC，但回放期间不回复。

Main 已在无 Renderer 时回复 live 查询；xterm 消费 replay 里的旧查询而不再回复，避免重开 Tab 后把历史响应注入当前前台进程。OSC 回复的 `sendInput` 同样受 `canControlRun` 约束，历史 Run 不会收到回复（见 [Terminal 运行时《历史 Run 只读》](terminal-runtime.md#51-历史-run-只读)）。

## 防回归测试

| 故障／风险 | 防回归测试 | 断言要点 |
| --- | --- | --- |
| Graphite 工作面或 cursor accent 偏离稳定纯黑 | `apps/desktop/test/terminal-theme.test.ts` | Graphite `background === cursorAccent === '#000000'`；`black === '#1d1f21'` 且与工作面不同 |
| palette 残缺导致 TUI 无法分层 | `apps/desktop/test/terminal-theme.test.ts` | 每个 catalog palette 恰好 23 个键，`extendedAnsi` 恰好 240 项 |
| OSC 抢答争用输入 cursor，或 Session 未 ready 即回复 | `apps/desktop/test/runtime-controller.test.ts` | ready 前 `writeAgent` 未调用；ready 后写回共享 Graphite 前景／背景色 |
| 跨 chunk 的 OSC 查询被漏答或重复回答 | `apps/desktop/test/terminal-osc-color-query.test.ts` | 分片查询保留 `remainder`，合并后只回答一次 |
| replay 中的旧查询被再次注入当前进程 | `terminal-capability-replies.ts` 的 `!isReplaying()` 门控；`terminal-osc-color-query.test.ts` | 回放期不回复；malformed 与改色查询被忽略 |
| OSC 回复格式漂移 | `terminal-osc-color-query.test.ts` | 16 位 `rgb:RRRR/GGGG/BBBB` 形式 |

本表列出回归意图，测试存在不代表本轮候选已通过；整体 oracle 与证据范围见[测试策略](../testing/strategy.md)。
