# AgentMux 终端交互分层与机制导航

本文沿 PTY、xterm、Renderer、Electron Main 与 OS 五层，定位复制、粘贴、键盘、IME、重排和链接的机制边界。它提供源码核查入口与故障判别线索；产品行为唯一归[Terminal、历史与成本](behavior/terminal-reading.md)，视觉归[Terminal 阅读呈现](presentation/terminal-reading.md)，验证责任归[测试策略](../testing/strategy.md#任务验收与假绿防护)。

机制名称与 symbol 用于核对当前源码，不证明已安装副本或真实运行通过验收。文中的既往缺口只说明当时未覆盖范围，不能当作当前缺陷、执行授权或永久数值要求；依赖版本与实际限额沿原源码、manifest 和 lockfile。

## 0. 五层与它们的边界

一次按键或一次复制，要穿过这些层。**每一层都能独立地把同一个功能弄坏，且症状相同。**

| 层 | 归属 | 它拥有什么 | 它坏掉时的典型症状 |
|---|---|---|---|
| L1 PTY / ctxmux | 进程外 | 字节流、retained scrollback、终端几何 | 内容缺失、replay 与 live 重叠或断档 |
| L2 xterm.js | 依赖（版本与补丁以 [Desktop package](../../apps/desktop/package.json)、[lockfile](../../pnpm-lock.yaml) 和 [workspace patch 配置](../../pnpm-workspace.yaml) 为准；与 Core 的 headless emulator 分开） | 解析器、缓冲区、选区服务、键盘编码器、链接 provider | 选区恒空、和弦被 `preventDefault` 吃掉、粘贴两次 |
| L3 Renderer | 我们 | 复制/粘贴路径、快捷键裁决、IME、重排恢复、链接落点 | 手势无反应、组字被覆写、重启后花屏 |
| L4 Electron main | 我们 | 剪贴板 IPC、原生菜单与它的加速键、窗口安全 | 原生 Paste 消失、加速键抢走按键 |
| L5 OS / macOS | 平台 | ⌘ vs Ctrl、AppKit 菜单优先级、系统剪贴板 | 平台分支写反，一侧永远是死键 |

**边界纪律**：L3 只能通过 xterm 的公开 API 读 L2；读 L2 内部实现（比如选区服务的启停条件）时，
必须注明上游依据。类型关系沿 xterm 公开类型派生——见
[terminal-selection-mode.ts](../../apps/desktop/src/renderer/src/lib/terminal-selection-mode.ts): `MouseTrackingMode`（索引访问 `Terminal['modes']['mouseTrackingMode']`，不手抄模式 union）；升级后的兼容性由实际类型和测试核对。

---

## 1. 复制：一个症状，四条独立机制

复制症状须按数据源与触发路径定位，不能只检查菜单是否可见。

### 1.1 四条复制路与它们的数据源

| 路 | 触发 | 数据源 | 落点 |
|---|---|---|---|
| A 选区复制 | 右键 Copy / 裸 Ctrl+C / `terminal.copy` 和弦（⌘C 或 Ctrl+Shift+C） | **选区** | [TerminalView.tsx](../../apps/desktop/src/renderer/src/components/TerminalView.tsx): `copySelection` |
| B 复制可见输出 | 右键菜单 | **缓冲区视口** | [terminal-buffer-copy.ts](../../apps/desktop/src/renderer/src/lib/terminal-buffer-copy.ts): `terminalViewportText` |
| C 复制全部输出 | 右键菜单 | **当前保留的 normal 回滚缓冲** | [terminal-buffer-copy.ts](../../apps/desktop/src/renderer/src/lib/terminal-buffer-copy.ts): `terminalScrollbackText` |
| D OSC 52 | PTY 里的程序主动写 | **PTY 载荷（base64）** | [terminal-osc-clipboard.ts](../../apps/desktop/src/shared/terminal-osc-clipboard.ts): `terminalOscClipboardWrite` |

A 的三个触发共用选区数据源，同时失败时先核选区是否建立。

**所有四条路只有一个剪贴板出口**：[clipboard-copy.ts](../../apps/desktop/src/renderer/src/lib/clipboard-copy.ts): `copyTextToClipboard(text, reportError)`。
`reportError` 是必填形参——静默失败因此是类型错误，不是疏忽。

### 1.2 坑 1：鼠标上报一开，选区服务自己关掉

**机制**：PTY 里的 TUI 发 DECSET `?9`/`?1000`/`?1002`/`?1003` 开鼠标上报，xterm 的
`onProtocolChange` 就调 `_selectionService.disable()`。此后普通左键拖拽在 `handleMouseDown` 里直接
早退，**不建立选区模型**，于是 `getSelection()` 恒为空串、`hasSelection()` 恒假。

**为什么三条路一起死**：它们共用「选区」这一个数据源。右键 Copy 置灰、Ctrl+C 不复制、划词复制
无效——用户看到三个故障，代码里是一个。

**判别器**：`terminal.modes.mouseTrackingMode !== 'none'` 而屏幕上明明有文字。等价地：换成
⌥Option+拖拽（mac）或 Shift+拖拽（其他平台）能选中——那是 xterm 的 `shouldForceSelection` 逃生手势。

**规范**：**至少要有一条复制路不依赖选区，且它永不置灰。**

**源码核查点**：B 读 `buffer.active` 的可见视口，C 读 `buffer.normal` 当前保留的回滚（[terminal-buffer-copy.ts](../../apps/desktop/src/renderer/src/lib/terminal-buffer-copy.ts): `terminalViewportText`／`terminalScrollbackText`）。二者都不依赖鼠标选区服务；“全部”不包含已淘汰行或 alternate 输出。范围与空结果行为只见[终端复制 owner](behavior/terminal-reading.md#终端复制范围与空结果)。

**守卫**：[terminal-selection-mode.test.ts](../../apps/desktop/test/terminal-selection-mode.test.ts)（逐模式的抑制判定 + 提示文案）、
[terminal-buffer-copy-wiring.test.ts](../../apps/desktop/test/terminal-buffer-copy-wiring.test.ts)（AST：菜单项 → 函数 → 缓冲区 → 剪贴板整条接线）。

**不许做的事**：不要试图重新打开选区服务或拦截 DECSET——鼠标上报是 TUI 要的，抢回来会让 TUI
的点击失灵。正确姿态是**承认选区不可用，并提供不经过选区的出路**，同时在置灰的 Copy 下面
如实解释（[terminal-selection-mode.ts](../../apps/desktop/src/renderer/src/lib/terminal-selection-mode.ts): `selectionForceGestureHint`）。

### 1.3 坑 2：空文本会擦掉剪贴板

**机制**：坐标意义上的 `hasSelection` 与 trim 之后的选区文本**在空白拖拽时分岔**——拖过一片空白，
坐标上有选区，文本是空串。若不判空就写剪贴板，用户会丢掉剪贴板里原有的内容。

**修法**：复制前先判文本非空——[terminal-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/terminal-shortcuts.ts): `terminalShortcutHandlers` 的 `terminal.copy`
动作里 `if (!text) return`，空文本既不记也不写。裸 Ctrl+C 与注册表命中两条路共用同一个谓词
`hasCopyableText`（[terminal-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/terminal-shortcuts.ts): `terminalKeyEventHandler` 内），不各写一遍。

**判别器**：在空白处拖一下再按复制，剪贴板变空。

**守卫**：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts) 的空文本拒绝用例。注意这一条曾经被「三处命中的在场 grep」
假绿背书过（#618）——判据必须执行那条分支，不能只证明字符串在场。

### 1.4 坑 3：右键会先清掉选区

**机制**：上下文菜单拿走焦点时 xterm 会清 live selection，于是菜单里的 Copy 读到空。

**修法**：`terminalSelectionForCopy(live, remembered)` 保留一份快照——在 `onPointerDown` 且
`event.button === 2` 时、以及 `onSelectionChange` 时各记一次。

**判别器**：划词选中后右键弹出菜单，再点 Copy，看剪贴板拿到的是刚才那段选区还是空串。

**守卫**：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts) 的 `terminalSelectionForCopy` 用例（live 非空取 live、
live 空取 remembered），以及同文件 `terminal.copy 把当前选区记下来` / `没选区时不去覆盖记住的那份`
两条真跑断言。

### 1.5 坑 4：OSC 52 的反向剪贴板通道

**机制**：PTY 里的程序发 `ESC]52;c;<base64>` 就能往用户的系统剪贴板写字节。这是唯一一条
**从 PTY 流向用户**的剪贴板路径，其余三条都是用户主动取。

**判别器**：用户没有任何复制动作，系统剪贴板内容却变了——那就是 PTY 侧的 OSC 52，不是选区/菜单/
裸 Ctrl+C 那三条用户主动取的路。

**源码核查点**：只写不读（读形式 `52;c;?` 结构上不可达——该模块只产文本，没有
`sendInput` 通路）；base64 必须严格解码；空载荷忽略（防止静默清空剪贴板）；整帧限额沿 parser 的当前来源，旧验证值为 128 KiB；
选择目标白名单 `{c, s, ''}`；**replay 期不写**——历史 scrollback 里的 OSC 52 不许劫持当下的剪贴板
（闸是 `isReplaying()`）。落点是 [terminal-osc-clipboard.ts](../../apps/desktop/src/shared/terminal-osc-clipboard.ts): `terminalOscClipboardWrite`。

**守卫**：[terminal-osc-clipboard.test.ts](../../apps/desktop/test/terminal-osc-clipboard.test.ts)——`只接系统剪贴板与默认选区，不接 X11 primary`（白名单）、
`空载荷不算写` / `纯空白载荷同样不算写`（防静默清空）、`坏 base64 给 null`（严格解码）、
`体积上限就是 128KiB 整帧` + `恰好落在上限上的整帧要过`（上限边界）、
`重放留存输出时不写剪贴板`（`isReplaying()` 闸，且有抬闸后同帧会写的对照）、
`52 永远不回送任何字节给 PTY`（只写不读）。

**历史未覆盖范围（#815）**：当时解码文本未经过 ESC 正文净化即写剪贴板；正文粘贴的净化器不自动证明反向 OSC 52 已受保护。核查当前状态时分别读取 OSC parser／剪贴板出口与对应测试，不能以粘贴测试通过代签反向路径，也不能把尚未实现的动作写成已有守卫。历史状态不等于当前仍未修复。

---

## 2. 粘贴：两个入口，一个 ESC 判定

### 2.1 入口

| 入口 | 触发 | 接线 |
|---|---|---|
| A 菜单 Paste | 右键菜单 | [TerminalView.tsx](../../apps/desktop/src/renderer/src/components/TerminalView.tsx): `pasteClipboard` → `api.ui.readClipboardText()` → `pasteIntoTerminal` |
| B 原生 ⌘V/Ctrl+V | OS/Electron 的 Edit→Paste role 发出原生 DOM `paste` 事件 | [terminal-paste.ts](../../apps/desktop/src/renderer/src/lib/terminal-paste.ts): `installTerminalPasteSanitizer` |

两个入口都收敛到 [terminal-paste.ts](../../apps/desktop/src/renderer/src/lib/terminal-paste.ts): `pasteIntoTerminal`，它等于
`terminal.paste(sanitizeBracketedPasteText(text))`。消毒器的 SSOT 在
[bracketed-paste.ts](../../packages/core/src/bracketed-paste.ts)，prompt 投递路也用同一个。

### 2.2 坑 5：xterm 只加括号不转义（pastejacking）

**机制**：xterm 的 `bracketTextForPaste` 用 `ESC[200~`/`ESC[201~` 把粘贴内容包起来，但**不转义内容
本身**。载荷里若带 `ESC[201~` 就能提前闭合括号，后面的字节被 shell 当成真实输入执行。

**修法**：[bracketed-paste.ts](../../packages/core/src/bracketed-paste.ts): `sanitizeBracketedPasteText` 把 ESC 换成可见的
␛（U+241B），不是删除：
**判定的是「ESC 这个字节」，不是「`ESC[201~` 这个串」**——收窄到具体串会漏掉伪造起始符、光标
移动、OSC 等其它构造。消毒是替换而非删除，因为用户要看得见有人往里塞了控制序列。正文粘贴与 Prompt 载荷共用这一判定；原生键盘、鼠标、binary 和终端协议回复不走正文净化，保持原字节语义。

**判别器**：粘一段自带 `ESC[201~` 或其它控制序列的文本，看它是被当命令执行了，还是原样显示成 ␛。

**守卫**：[bracketed-paste.test.ts](../../packages/core/test/bracketed-paste.test.ts) + [terminal-paste-sanitizer.test.ts](../../apps/desktop/test/terminal-paste-sanitizer.test.ts)。

### 2.3 坑 6：粘贴会发生两次

**机制**：xterm 自己的 paste 处理器注册在**两个**节点上（`textarea` 与 `element`，都是冒泡），且
它只调 `stopPropagation()`，**从不检查 `defaultPrevented`**。所以我们的消毒监听器必须是
**捕获阶段** + `preventDefault()` + `stopImmediatePropagation()`，少一样就会粘两遍或绕过消毒。

**修法**：[terminal-paste.ts](../../apps/desktop/src/renderer/src/lib/terminal-paste.ts): `installTerminalPasteSanitizer` 在 `terminal.element` 上装捕获期 paste
监听，`preventDefault()` + `stopImmediatePropagation()` 一次掐掉那两个冒泡监听，再走
`pasteIntoTerminal` 消毒后粘贴。

**判别器**：粘贴一次出现两份内容。

**守卫**：[terminal-paste-sanitizer.test.ts](../../apps/desktop/test/terminal-paste-sanitizer.test.ts) 的 `installTerminalPasteSanitizer：接管原生 paste`
一组——`装的是**捕获期**监听——xterm 的 handlePasteEvent 从不看 defaultPrevented`（capture 标志），
与 `同时 preventDefault 与 stopImmediatePropagation`。

### 2.4 坑 7：把粘贴写进快捷键注册表 = 粘两次

**机制**：粘贴有两条能到 PTY 的路——原生 Edit→Paste role，和我们自己的键处理器。原生路径始终在：
xterm 的键回调返回 `false` 时并不 `preventDefault`，Electron 的 `role: 'editMenu'` 照常触发。若我们
再把粘贴注册进 `SHORTCUT_BINDINGS` / 键处理器，同一次 Cmd/Ctrl+V 就走两条路，粘两次。

**规范**：**粘贴故意不进 `SHORTCUT_BINDINGS`，也不进终端键处理器的 handler map。** 它的 SSOT 在
Electron 的 `role: 'editMenu'` 里（核对当前注册表与原生菜单，不能仅凭旧条目数量判断）。

**判别器**：Cmd/Ctrl+V 粘一次出现两份内容——且与坑 6 区分开：坑 6 是消毒监听器没装在捕获期、被
xterm 自己的两个冒泡监听重复消费；坑 7 是我们**主动**给粘贴加了第二条 JS 路径（注册表或 handler
map 里冒出一条 paste 条目）。看「注册表/handler map 里有没有 paste 条目」即可分辨。

**修法**：不注册即修好——让第二条路根本不存在。反过来，`role: 'editMenu'` 是**承重**的，不能因为
「我们自己画菜单」就把它摘掉。

推论：[application-menu.ts](../../apps/desktop/src/main/application-menu.ts): `applicationMenuTemplate` 里的 `role: 'editMenu'` 是承重的。菜单模板
是手搭的（为了甩掉 Cmd+W / Cmd+R 这类会静默丢数据的加速键），但 `appMenu` + `editMenu` 必须留着。

**守卫**：两侧各一道。
- 「不许出现第二条 JS 路径」：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts): `paste 刻意不在 handler map 里`
  （`not.toContain('terminal.paste')`）；同文件 `注册表里有 id 但 handler map 里没有的键，交还而不是
  吞掉` 钉住即便有 id 也不吞（吞掉会让粘贴彻底失效，比粘两次更糟）。
- 「editMenu 不许摘」：[application-menu.test.ts](../../apps/desktop/test/application-menu.test.ts): `保留 Edit 菜单——终端粘贴依赖原生 Paste role`
  （断言模板里 `item.role === 'editMenu'` 在场）。

右键菜单显示的粘贴键位（[terminal-menu-chords.ts](../../apps/desktop/src/renderer/src/lib/terminal-menu-chords.ts): `NATIVE_PASTE_CHORD`）是**全仓唯一一个手写和弦**，
理由就是它的 SSOT 不在我们这儿。两个平台都**不带 Shift**——写成 `Ctrl+Shift+V` 就是宣传一个死键
（#367 的第二层）。这一点由 [terminal-menu-chords.test.ts](../../apps/desktop/test/terminal-menu-chords.test.ts) 守（断言 `NATIVE_PASTE_CHORD.shift` 为假）。

---

## 3. 键盘：一次按键的裁决顺序

按键从 OS 到 PTY 要过四道关，**顺序本身就是合同**：

1. **原生菜单加速键**（L4/L5）。AppKit 在 webContents 之前就吃掉它，渲染层的 `preventDefault()`
   **取消不了**。所以危险加速键（Cmd+W / Cmd+R / Cmd+Shift+R）的处置只能是「不要把那个 role
   放进菜单模板」，不能靠渲染层拦。
2. **窗口级捕获监听**（[App.tsx](../../apps/desktop/src/renderer/src/App.tsx) 的 `keydown` + `{capture: true}` → [shortcut-registry.ts](../../apps/desktop/src/renderer/src/lib/shortcut-registry.ts): `routeWindowShortcut`）。
   它在 xterm 的 textarea **之前**跑。
3. **xterm 自定义键处理器**（[terminal-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/terminal-shortcuts.ts): `terminalKeyEventHandler`）。内部顺序：
   裸 Ctrl+C → 注册表匹配 → 未匹配则交给 bypass 策略。
4. **kitty 编码器 / bypass 策略**（[xterm-bypass-policy.ts](../../apps/desktop/src/renderer/src/lib/xterm-bypass-policy.ts): `shouldBypassXtermKeyboardEvent`）。

### 3.1 坑 8：窗口级绑定在终端聚焦时**全部**会被提供

**机制**：[workbench-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/workbench-shortcuts.ts): `isEditableChordTarget` 在 `.xterm` 内部返回 `false`。也就是说
「不在可编辑元素里才生效」这道闸**挡不住终端**——每一个窗口级绑定，无论有没有这道闸，都会在
终端聚焦时拿到按键。

**后果**：新加一个窗口级和弦，如果它和终端里常用的键撞了，终端用户会突然发现那个键被抢走。

**修法**：终端不可被这道闸屏蔽（`isEditableChordTarget` 在 `.xterm` 内恒返回 `false` 是刻意的——
capture 监听存在就是为了抢在 xterm 前拿到键）。所以纪律不是「屏蔽终端」，而是**未设 gate 的窗口
和弦不许与任何终端绑定撞键**，否则那条终端绑定直接够不着（窗口动作每次都赢）。

**判别器**：焦点在终端里按那个和弦，看它是走了窗口动作还是进了 PTY。

**守卫**：[shortcut-registry.test.ts](../../apps/desktop/test/shortcut-registry.test.ts): `an un-gated window binding never collides with a terminal or
editor chord — those surfaces do not shield it`（撞键规则，从注册表自己派生的 scope 列表遍历，非
手写 `terminal || editor`）；[workbench-shortcuts.test.ts](../../apps/desktop/test/workbench-shortcuts.test.ts): `isEditableChordTarget：非终端可编辑控件
放行，终端焦点仍接管`（终端子树内一律不放行，即使那是个 textarea）。接线由
[shortcut-scope-wiring.test.tsx](../../apps/desktop/test/shortcut-scope-wiring.test.tsx) / [workbench-shortcut-wiring.test.tsx](../../apps/desktop/test/workbench-shortcut-wiring.test.tsx) 按 AST 守。

### 3.2 坑 9：kitty 渐进增强会吃掉剪贴板和弦

**机制**：CLI 打开 kitty progressive enhancement 之后，xterm 的 CSI-u 编码器会对 ⌘C/⌘V 这类和弦
`preventDefault()`，原生复制粘贴当场失效。

**修法**：`shouldBypassXtermKeyboardEvent` 在编码器跑之前返回 `false` 让 xterm 提前出让。平台分支：
mac 让出 ⌘C/⌘V；其他平台让出 Ctrl+Shift+C、Ctrl+V、Ctrl+Shift+V、Shift+Insert，而 **Ctrl+C 只在
有选区时让出**——没选区时它必须是 SIGINT。

**判别器**：在开了 kitty progressive enhancement 的 CLI 里按 ⌘C/⌘V，看原生复制粘贴是否当场失效
（失效即编码器把和弦 `preventDefault` 了，旁路没生效）。

**守卫**：[xterm-bypass-policy.test.ts](../../apps/desktop/test/xterm-bypass-policy.test.ts)——`mac 剪贴板和弦` 与 `非 mac 剪贴板和弦` 两组逐和弦质询，
其中 `非 mac：Ctrl+C 且**有选区** → 旁路（复制）` 与 `非 mac：Ctrl+C 且**无选区** → 不旁路（它是
SIGINT，必须到 shell）` 成对钉住那条选区分支。

### 3.3 坑 10：裸 Ctrl+C 有两个互斥语义

**机制**：裸 Ctrl+C 这一个键要分成两件事——有可复制文本时是「复制」，没有时是终端的 SIGINT。
注册表里 `terminal.copy` 的两个和弦（mac 的 Cmd+C、非 mac 的 Ctrl+Shift+C）都不匹配裸 Ctrl+C，
所以它此前在两个平台上都直落「不是我们的键」出口——是**缺失的能力，不是回归**。

**修法**：[terminal-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/terminal-shortcuts.ts): `isBareCtrlC` + `terminalKeyEventHandler` 里那条**排在注册表匹配之前**
的分支：有可复制文本 → 复制；没有 → 交回 PTY 当 SIGINT。

**判别器**：文本非空，不是坐标 `hasSelection`（见坑 2 的分岔）。没选区时按 Ctrl+C 看跑飞的程序能
不能被中断——被吞成「复制空串」就是判据用错成了坐标。这条刻意不走 bypass 策略（旁路策略的
interrupt-C 分支读的是坐标 hasSelection，在空白横拖时会分岔）。

**守卫**：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts) 两组——`裸 Ctrl+C：有选区复制，没选区发 SIGINT（#610）`
（含 `注册表两条和弦都不匹配裸 Ctrl+C` 这条把前提做成断言），以及 `终端键回调的吞键判定`
（喂事件问返回值与外界被碰次数，其中 `坐标说有选区但文本是空的，仍要交还` 是那对采样的盲点补齐）。

### 3.4 键位 SSOT

[shortcut-registry.ts](../../apps/desktop/src/renderer/src/lib/shortcut-registry.ts): `SHORTCUT_BINDINGS` 是唯一的键位事实。派生方：窗口监听、终端处理器、
Monaco（`monacoKeybindingFor` 做翻译，遇到未知键抛错）、cheat-sheet、bypass 策略。

**故意在注册表之外**的和弦只有 [xterm-bypass-policy.ts](../../apps/desktop/src/renderer/src/lib/xterm-bypass-policy.ts) 里那几个（paste / Shift+Insert /
interrupt-C）——它们在注册表里没有条目，所以不存在第二份会漂移的 SSOT，且匹配时复用注册表自己的
`chordMatches` 原语。

**规范**：任何在注册表之外手写和弦的地方，必须在注释里写明「它的 SSOT 在哪儿、为什么不能进注册表」。

---

## 4. 输入法（IME）：两个互不相干的机制

「中文输入变成不是我打的字」也是一个症状对多个机制。

### 4.1 机制一：受控 value 在组字中途被回写

**成因**：React 的 `updateTextarea` 无条件做 `element.value = value`，且每次变更后
`restoreStateOfTarget` 会重贴 props。组字期间 DOM 里是候选预览串，任何 `props.value ≠ DOM` 都会
触发一次回写，把正在组的字打断/替换。

**修法**：组字期间 [composer-composition.ts](../../packages/client-ui/src/lib/composer-composition.ts): `composerRenderValue` 返回一份**镜像**（直接读
`event.currentTarget.value`），使 `value !== element.value` 恒不成立。封装成
[ComposerTextarea.tsx](../../packages/client-ui/src/input/ComposerTextarea.tsx) 这个可复用壳，需要受控组字的输入消费同一壳；调用范围沿当前源码核对，不以旧输入框数量证明完整接入。

**判别器**：打一段中文 → 删掉 → 再打，出现你没输入过的旧字符。

**证据边界**：取值层、状态机与 AST 接线检查不能单独证明真实 OS／DOM 输入法可用。组字期间外部写入与 compositionEnd 的裁决须沿原输入 owner 验证，不能以静态或模拟事件代签真实组字。

### 4.2 机制二：Enter 的归属

**成因**：组字确认用的也是 Enter。若不判断「这次 Enter 属于输入法」，确认候选词会被当成提交。

**判据必须读四个源**：`event.isComposing`、`event.keyCode === 229`、`event.nativeEvent.isComposing`、
`event.nativeEvent.keyCode === 229`。第四个最容易漏——某些输入法只在 native 事件上打 229。
SSOT 是 [ime-composition-keyboard-event.ts](../../apps/desktop/src/renderer/src/lib/ime-composition-keyboard-event.ts): `isImeCompositionKeyDown`。

**坑 11：手抄其中两个源**。#609 修好之后，`AgentComposer` 仍然手抄了 2/4（漏掉顶层 `isComposing`
与 `nativeEvent.keyCode`），直到 `91dea7f` 才收到 SSOT 上。**规范：不许手抄这个谓词的任何子集。**

**守卫**：[ime-composition-keyboard-event.test.ts](../../apps/desktop/test/ime-composition-keyboard-event.test.ts)——它是**发现式**的，扫全部 `.tsx` 找
commit-on-Enter 的输入，例外表的条数被 `EXPECTED_EXCEPTION_COUNT` 钉死，所以悄悄开一个新豁免会红。

**历史 debt（#786）**曾涉及 Tab／Agent 就地改名与终端搜索框。当前是否仍是例外，应核实际 `isImeCompositionKeyDown` 调用与例外表；旧 debt 名单不能充当当前缺口清单或豁免。

---

## 5. 重排与 replay：为什么「放大缩小一下就好了」

### 5.1 坑 12：replay 的字节先落地，第一次 fit 后到

**机制**：xterm 以 80×24 构造，retained scrollback 的字节在**第一次确定性 fit 之前**就写进解析器。
于是「第一次 live fit 移动了网格」等价于「刚刚 replay 出来的那屏是按错误宽度排的」。

**它不会自愈**，有两个叠加原因：
- 该既往机制中的 xterm `_isReflowEnabled` 要求 `_hasScrollback`，所以**只有带 scrollback 的 normal buffer
  会重排**；alt screen 的 TUI（diff 视图、vim、htop、lazygit）只做逐行截断/补白。
- 重启恢复出来的 PTY 尺寸通常等于 daemon 保留的尺寸，同尺寸的 `TIOCSWINSZ` **不产生 SIGWINCH**，
  TUI 因此没有任何理由重绘。

**为什么缩放能治**：它真的改变了 CSS 像素/单元格尺寸，既触发 fit 又制造真实的尺寸差。

**判别器**：重启恢复后那一屏花掉，但**放大缩小一下就好了**——「缩放能治而重绘不能」正是这条
（相对字节落地锚点 `gridWhenReplayLanded` 网格移动过、但 PTY 尺寸没变、没有 SIGWINCH）；alt screen
的 TUI 缩放也治不好，因为它压根不重排，那是另一回事。

**修法**：若第一次 live fit 确实移动了网格，强制一次 `requestContentRedraw()`。判据是「相对
**字节落地锚点** `gridWhenReplayLanded` 网格移动了没有」，**不是**「PTY 尺寸变了没有」（渲染层
不可能知道）也**不是**「这次 fit 移动了没有」（非 live 的 fit 也会移动）。全新终端没有 replay，
锚点为 `null`，不付这份代价。

**守卫**：[terminal-replay-reflow-recovery.test.ts](../../apps/desktop/test/terminal-replay-reflow-recovery.test.ts)（`replay 之后的重排补救：判据锚在「重放那一刻的
grid」`）、[terminal-viewport-sync.test.ts](../../apps/desktop/test/terminal-viewport-sync.test.ts)。

### 5.2 坑 13：抖动会把 TUI 画花

**机制**：WebGL/DOM 的单元格度量会在重渲染时抖一列——`proposeDimensions` 差一列而容器 CSS 像素
一点没变。若把这当成真 resize 去 `fit()`，xterm reflow 一列再弹回，把刚画好的 TUI 画花。

**修法**：只有容器 CSS 像素真的变了才 `fit()`——[terminal-viewport-sync.ts](../../apps/desktop/src/renderer/src/lib/terminal-viewport-sync.ts) 的 `samePixels` 闸。
注意抖动基线由「这次 fit」建立，且**replay 阶段的 fit 也要留下基线**，否则起活后第一次抖动这道闸
是空的。

**判别器**：拖拽/重渲染已停（像素固定）却又 fit 了一次——像素没变还 fit 就是 `samePixels` 闸漏了。

**守卫**：[terminal-viewport-sync.test.ts](../../apps/desktop/test/terminal-viewport-sync.test.ts)——`skips a one-column grid wobble when container pixels
have not changed`，以及 `replay 阶段的 fit 也要留下抖动基线，否则起活后第一次 cell-metric 抖动就会
把 TUI 画花`。

### 5.3 replay 与 live 是**不相交**的两条流

[TerminalView.tsx](../../apps/desktop/src/renderer/src/components/TerminalView.tsx) 中的 `readyForLiveOutput` 标记首次交接；`replayingContinuation` 与 `historicalOutputDepth` 继续区分恢复及历史解析。OSC 处理器读取实际 replay 范围，不能仅以首次 live 已就绪判断之后的历史字节可以回答颜色查询或写剪贴板。live 事件在首次 replay 期间进有界缓冲
（`MAX_PENDING_OUTPUT_EVENTS` / `MAX_PENDING_OUTPUT_BYTES`），随后排空，重叠由
[live-output.ts](../../packages/client-ui/src/terminal/live-output.ts): `composeTerminalLiveOutputWrite` 判（全已见 / 部分 / 真断档）。

### 5.4 坑 14：输入有两张面孔

**机制**：xterm 的输入事件分两路：SGR 鼠标上报（DECSET ?1006）是 ASCII，走 `onData`；**旧式协议**
（?1000/?1002/?1003/?9 不带 ?1006）发 ≥128 的坐标字节，语义是 latin1，走 `onBinary`。只订阅
`onData` 会把旧式鼠标上报整个丢掉，而把 latin1 当 UTF-8 编码会把 0x80 变成 0xC2 0x80。

**源码核查点**：两条面孔经 [input.ts](../../packages/client-ui/src/terminal/input.ts): `subscribeTerminalInput` 共用**同一个 accepts 闸**与**同一个
写出口**（`terminalInputSender`）——`terminalAcceptsInput` 要求 `canControlRun && acceptsInput &&
liveReady` 三者同时成立；onBinary 的 latin1 字节先经 `encodeTerminalBinaryInput` 还原成 Uint8Array
再送，不走 UTF-8。把判定和写包在一个函数里是刻意的：组件里不留可取反的 `if`。

**判别器**：一个只开旧式鼠标协议（无 ?1006）的 TUI 里鼠标完全没反应 → onBinary 没订阅；坐标字节
0x80 变成两字节 → 把 latin1 当 UTF-8 了。

**守卫**：[terminal-reveal.test.ts](../../apps/desktop/test/terminal-reveal.test.ts): `两个输入事件源共用一把闸一个出口`（**真跑**，按出口数判：删
onBinary 订阅、或让它绕过 accepts、或把 latin1 当 UTF-8，各自打红一条），以及
`encodeTerminalBinaryInput 把 latin1 字符串按字节还原，>=128 也不失真`；接线由同文件
`onData/onBinary 没经 subscribeTerminalInput 接到 sender` 一条按源码文本钉住。

---

## 6. 链接

两个 provider 共用一个激活出口 [TerminalView.tsx](../../apps/desktop/src/renderer/src/components/TerminalView.tsx): `activateHttpLink`：

- **裸文本 URL** → `WebLinksAddon` + [terminal-http-link.ts](../../apps/desktop/src/renderer/src/lib/terminal-http-link.ts): `TERMINAL_HTTP_URL_REGEX`（在 xterm 的
  严格语法上加了 CJK 块边界，免得 URL 后面的中文句子被吞进链接）。
- **OSC 8 超链接** → xterm 内建的 `OscLinkProvider`，必须**显式设置** `terminal.options.linkHandler`；
  不设的话它退回原生 `confirm()` + `window.open`，这是很难注意到的那种坏（依赖自带的默认实现就是
  那个没接上的第二入口）。
- **文件路径** → `terminal.registerLinkProvider` + 纯函数 [terminal-path-link.ts](../../packages/client-ui/src/lib/terminal-path-link.ts): `detectTerminalPathLinks`
  （只算字符串，热路径不碰磁盘和 IPC；点击失败就地说明原因，保原输入与工作面）。

**scheme 闸只有一处**：[link-url.ts](../../packages/client-ui/src/lib/link-url.ts): `parseHttpLinkUrl`，只放行 http/https。它刻意不放在组件
里，好让非 xterm 的表面（对话正文）也能引用而不必在模块加载期拉进 xterm。

**`~/` 展开**（[terminal-path-link.ts](../../packages/client-ui/src/lib/terminal-path-link.ts): `resolveWorkspaceRelativePath`）：先按 `homeDir` 展开，再走与
绝对路径**完全相同**的工作区内判定。所以 `~/proj/src/x.ts` 在工作区内可跳，而 `~/.claude/plugins/...`
落在工作区外，被拒的方式与工作区外的系统配置文件一模一样。`~user/` 与裸 `~` 都不匹配。

---

## 7. 按机制定位与验证

收到同一症状再次出现的报障时，沿上文数据源、层与判别器区分原因；修复说明明确已覆盖、未受影响与尚未确认范围。测试的任务验收、变异、真实产品调用链、非空扫描与源码在场判据边界唯一见[测试策略](../testing/strategy.md#任务验收与假绿防护)，本页不另设一套守卫等级或交付 gate。

每节的测试名只是核查入口：需要实际确认测试扫描了目标并执行对应分支；历史测试存在、source symbol 在场或旧 receipt 不能证明当前候选已通过。未实施行为如实记为缺口，不编造守卫；纯文档修改只执行文档来源、链接和语义保全检查。

---

## 8. 机制核查清单

1. 本页四条 Terminal 复制路径的剪贴板写入只经 `copyTextToClipboard`，且错误上报是必填参数。
2. 至少一条复制路不依赖选区，且它**永不置灰**。
3. 批量正文粘贴与 Prompt 文本载荷共用 ESC 判定（`sanitizeBracketedPasteText`）；原生键盘、鼠标、binary 与终端协议回复保持无损，不经过正文净化。
4. 粘贴不进快捷键注册表；`role: 'editMenu'` 不许摘。
5. 键位 SSOT 是 `SHORTCUT_BINDINGS`；注册表外的和弦必须注明 SSOT 在哪儿。
6. IME 谓词读四个源，不许手抄子集。
7. 组字期间受控输入走镜像取值，不做外部回写。
8. OSC 处理器在 replay 期不产生副作用。
9. 输入的两张面孔（`onData` / `onBinary`）共用一个闸、一个写出口。
10. 重排恢复的判据锚在字节落地时刻，不是「尺寸变了」也不是「这次 fit 动了」。
