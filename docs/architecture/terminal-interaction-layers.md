# 终端交互分层与机制

本文说明 Terminal 的复制、粘贴、键盘、IME、重排和链接在 PTY、xterm、Renderer、Electron Main 与 OS 五层中的当前机制，并给出源码文件与 symbol 作为核查入口。产品行为唯一归[Terminal、历史与成本](../design/behavior/terminal-reading.md)，视觉归[Terminal 阅读呈现](../design/presentation/terminal-reading.md)，验证责任归[测试策略](../testing/strategy.md#任务验收与假绿防护)。

文中的 symbol 和测试名描述当前源码，不证明安装副本或真实运行已通过验收；依赖版本与实际限额以源码、manifest 和 lockfile 为准。标为「当前缺口」的条目是源码现状，不是产品要求。

## 0. 五层与边界

一次按键或一次复制要穿过下面五层，任意一层都可能单独造成同一个症状。

| 层 | 归属 | 拥有什么 | 出问题时的典型症状 |
|---|---|---|---|
| L1 PTY / ctxmux | 进程外 | 字节流、retained scrollback、终端几何 | 内容缺失、replay 与 live 重叠或断档 |
| L2 xterm.js | 依赖（版本与补丁以 [Desktop package](../../apps/desktop/package.json)、[lockfile](../../pnpm-lock.yaml) 和 [workspace patch 配置](../../pnpm-workspace.yaml) 为准；与 Core 的 headless emulator 分开） | 解析器、缓冲区、选区服务、键盘编码器、链接 provider | 选区恒空、和弦被 `preventDefault` 吃掉、粘贴两次 |
| L3 Renderer | AgentMux | 复制/粘贴路径、快捷键裁决、IME、重排恢复、链接落点 | 手势无反应、组字被覆写、重启后花屏 |
| L4 Electron Main | AgentMux | 剪贴板 IPC、原生菜单与加速键、窗口安全 | 原生 Paste 消失、加速键抢走按键 |
| L5 OS / macOS | 平台 | ⌘ 与 Ctrl、AppKit 菜单优先级、系统剪贴板 | 平台分支写反，一侧永远是死键 |

L3 只通过 xterm 的公开 API 读 L2；需要依赖 L2 内部实现（例如选区服务的启停条件）时，在源码注释里写明上游依据，并在升级 xterm 时复核。类型关系沿 xterm 公开类型派生，例如 [terminal-selection-mode.ts](../../apps/desktop/src/renderer/src/lib/terminal-selection-mode.ts) 的 `MouseTrackingMode` 由 `Terminal['modes']['mouseTrackingMode']` 索引得到，不手抄模式 union。

---

## 1. 复制：四条按数据源划分的路径

复制故障按数据源与触发路径定位，不能只检查菜单是否可见。复制范围与空结果的产品约束见[《终端复制范围与空结果》](../design/behavior/terminal-reading.md#终端复制范围与空结果)。

### 1.1 四条复制路与数据源

| 路 | 触发 | 数据源 | 落点 |
|---|---|---|---|
| A 选区复制 | 右键 Copy、裸 Ctrl+C、`terminal.copy` 和弦（⌘C 或 Ctrl+Shift+C） | **选区** | [TerminalView.tsx](../../apps/desktop/src/renderer/src/components/TerminalView.tsx): `copySelection` |
| B 复制可见输出 | 右键菜单 | 缓冲区视口（`buffer.active`） | [terminal-buffer-copy.ts](../../apps/desktop/src/renderer/src/lib/terminal-buffer-copy.ts): `terminalViewportText` |
| C 复制全部输出 | 右键菜单 | 当前保留的 normal 回滚缓冲（`buffer.normal`） | [terminal-buffer-copy.ts](../../apps/desktop/src/renderer/src/lib/terminal-buffer-copy.ts): `terminalScrollbackText` |
| D OSC 52 | PTY 里的程序主动写 | PTY 载荷（base64） | [terminal-osc-clipboard.ts](../../apps/desktop/src/shared/terminal-osc-clipboard.ts): `terminalOscClipboardWrite` |

A 的三种触发共用选区这一个数据源，所以它们同时失效时，先核对选区是否建立。拖选本身由 xterm 原生选择承担，是建立选区的手势，不是第五条复制路。

四条路只有一个剪贴板出口：[clipboard-copy.ts](../../apps/desktop/src/renderer/src/lib/clipboard-copy.ts): `copyTextToClipboard(text, reportError)`。`reportError` 是必填形参，调用方不传错误出口就无法通过类型检查，复制失败因此不会静默。

### 1.2 鼠标上报会关闭选区服务

**机制**：PTY 里的 TUI 发 DECSET `?9`/`?1000`/`?1002`/`?1003` 打开鼠标上报后，xterm 的 `onProtocolChange` 调用 `_selectionService.disable()`。此后普通左键拖拽在 `handleMouseDown` 里提前返回，不建立选区模型，`getSelection()` 恒为空串、`hasSelection()` 恒为假。A 的三种触发因此一起失效：右键 Copy 置灰、Ctrl+C 不复制、拖选无效。

**判别**：`terminal.modes.mouseTrackingMode !== 'none'`，而屏幕上有文字。等价检查是按住 ⌥ Option（macOS）或 Shift（其他平台）拖拽能选中，这是 xterm `shouldForceSelection` 的逃生手势；macOS 一侧只在 [terminal-theme.ts](../../apps/desktop/src/renderer/src/lib/terminal-theme.ts) 设置 `macOptionClickForcesSelection: true` 时生效。

**当前机制**：B 读 `buffer.active` 的可见视口，C 读 `buffer.normal` 当前保留的回滚，二者都不经过选区服务；「全部」不包含已淘汰的行和 alternate buffer 的输出。置灰的 Copy 下方用 [terminal-selection-mode.ts](../../apps/desktop/src/renderer/src/lib/terminal-selection-mode.ts): `selectionForceGestureHint` 说明逃生手势；提示文案与 `macOptionClickForcesSelection` 配置必须同时成立，由同一组测试读取。

**不做的事**：不重新打开选区服务，也不拦截 DECSET。鼠标上报是 TUI 自己请求的，抢回来会让 TUI 的点击失灵；正确做法是承认选区不可用，并提供不经过选区的复制路。

**守卫**：[terminal-selection-mode.test.ts](../../apps/desktop/test/terminal-selection-mode.test.ts)（逐模式的抑制判定与提示文案）、[terminal-buffer-copy-wiring.test.ts](../../apps/desktop/test/terminal-buffer-copy-wiring.test.ts)（AST 检查菜单项 → 函数 → 缓冲区 → 剪贴板的整条接线）。

### 1.3 空文本会擦掉剪贴板

**机制**：坐标意义上的 `hasSelection()` 与 trim 后的选区文本在空白处拖拽时分岔：坐标上有选区，文本却是空串。不判空就写剪贴板，会抹掉用户剪贴板里原有的内容。

**当前机制**：[terminal-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/terminal-shortcuts.ts): `terminalShortcutHandlers` 的 `terminal.copy` 动作在文本为空时直接返回，既不记也不写。裸 Ctrl+C 与注册表命中两条路共用同一个谓词 `hasCopyableText`（在 `terminalKeyEventHandler` 内），不各写一遍。

**判别**：在空白处拖一下再按复制，剪贴板变空。

**守卫**：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts) 的空文本拒绝用例。这一条曾被只证明字符串在场的源码 grep 判为通过；守卫必须真正执行这条分支。

### 1.4 右键会先清掉选区

**机制**：上下文菜单拿走焦点时，xterm 会清掉 live selection，菜单里的 Copy 因此读到空串。

**当前机制**：`terminalSelectionForCopy(live, remembered)` 使用一份快照：在 `onPointerDown` 且 `event.button === 2` 时、以及每次 `onSelectionChange` 时各记一次。

**判别**：划词选中后右键，再点 Copy，看剪贴板拿到的是选区还是空串。

**守卫**：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts) 的 `terminalSelectionForCopy` 用例（live 非空取 live，live 为空取 remembered），以及同文件 `terminal.copy 把当前选区记下来`、`没选区时不去覆盖记住的那份` 两条真跑断言。

### 1.5 OSC 52：从 PTY 流向用户的剪贴板路径

**机制**：PTY 里的程序发 `ESC]52;c;<base64>` 就能写用户的系统剪贴板。这是唯一一条从 PTY 流向用户的剪贴板路径，其余三条都由用户主动发起。

**判别**：用户没有任何复制动作，系统剪贴板却变了。

**当前机制**：
- [terminal-capability-replies.ts](../../apps/desktop/src/renderer/src/lib/terminal-capability-replies.ts): `installTerminalOscHandlers` 同时安装 OSC 10/11 颜色查询与 OSC 52，两者共用一个 `isReplaying()` 闸。TerminalView 传入的判据是 `replayingContinuation || historicalOutputDepth > 0`，重放留存输出时既不回答颜色查询，也不写剪贴板。
- 只写不读：解析模块只产出文本，52 的 handler 拿不到 `sendInput`，读形式 `52;c;?` 在结构上无法回送字节。
- base64 严格解码；空载荷与纯空白载荷不写，防止静默清空剪贴板；选区白名单 `{c, s, ''}`，不接 X11 primary。
- 整帧上限 `TERMINAL_OSC_CLIPBOARD_MAX_PAYLOAD`（当前 128 KiB），在切分选区之前判断。
- 解码后的文本经 TerminalView 的 `writeClipboard` 交给同一个 `copyTextToClipboard` 出口。

**当前缺口**：解码文本直接写剪贴板，不经过正文粘贴的 ESC 净化（`sanitizeBracketedPasteText`）。正文粘贴的净化测试不覆盖这条反向路径。

**守卫**：[terminal-osc-clipboard.test.ts](../../apps/desktop/test/terminal-osc-clipboard.test.ts)：`只接系统剪贴板与默认选区，不接 X11 primary`、`空载荷不算写`、`纯空白载荷同样不算写`、`坏 base64 给 null`、`体积上限就是 128KiB 整帧`、`恰好落在上限上的整帧要过`、`重放留存输出时不写剪贴板`（含抬闸后同帧会写的对照）、`52 永远不回送任何字节给 PTY`。

---

## 2. 粘贴：两个入口，一个 ESC 判定

### 2.1 入口

| 入口 | 触发 | 接线 |
|---|---|---|
| A 菜单 Paste | 右键菜单 | [TerminalView.tsx](../../apps/desktop/src/renderer/src/components/TerminalView.tsx): `pasteClipboard` → `api.ui.readClipboardText()` → `pasteIntoTerminal` |
| B 原生 ⌘V/Ctrl+V | Electron 的 Edit→Paste role 发出原生 DOM `paste` 事件 | [terminal-paste.ts](../../apps/desktop/src/renderer/src/lib/terminal-paste.ts): `installTerminalPasteSanitizer` |

两个入口都收敛到 [terminal-paste.ts](../../apps/desktop/src/renderer/src/lib/terminal-paste.ts): `pasteIntoTerminal`，它等于 `terminal.paste(sanitizeBracketedPasteText(text))`。净化器的唯一定义在 [bracketed-paste.ts](../../packages/core/src/bracketed-paste.ts)，Prompt 投递也用它。粘贴字节最终经 `createTerminalPasteInput` 与 `terminalInputSender` 送出（见 §5.4），整段文本是一次粘贴，不拆成逐行输入。

### 2.2 xterm 只加括号、不转义内容

**机制**：xterm 的 `bracketTextForPaste` 用 `ESC[200~`/`ESC[201~` 包住粘贴内容，但不转义内容本身。载荷里带 `ESC[201~` 就能提前闭合括号，后面的字节会被 shell 当作真实输入执行（pastejacking）。

**当前机制**：`sanitizeBracketedPasteText` 把 ESC 替换成可见的 ␛（U+241B），而不是删除。判定对象是 ESC 这个字节，不是 `ESC[201~` 这个串；收窄到具体串会漏掉伪造起始符、光标移动和 OSC 等构造。替换而非删除，是为了让用户看得见有人往内容里塞了控制序列。正文粘贴与 Prompt 载荷共用这一判定；原生键盘、鼠标、binary 与终端协议回复不走正文净化，保持原字节。

**判别**：粘贴一段带 `ESC[201~` 或其他控制序列的文本，看它被当成命令执行，还是原样显示为 ␛。

**守卫**：[bracketed-paste.test.ts](../../packages/core/test/bracketed-paste.test.ts)、[terminal-paste-sanitizer.test.ts](../../apps/desktop/test/terminal-paste-sanitizer.test.ts)。

### 2.3 粘贴会发生两次（监听阶段）

**机制**：xterm 自己的 paste 处理器注册在 `textarea` 与 `element` 两个节点上，都在冒泡阶段，并且只调用 `stopPropagation()`，从不检查 `defaultPrevented`。

**当前机制**：`installTerminalPasteSanitizer` 在 `terminal.element` 上注册**捕获阶段**的 paste 监听，同时调用 `preventDefault()` 与 `stopImmediatePropagation()`，一次截住两个冒泡监听，再走 `pasteIntoTerminal`。三者少一样，就会粘两遍或绕过净化。

**判别**：粘贴一次出现两份内容。

**守卫**：[terminal-paste-sanitizer.test.ts](../../apps/desktop/test/terminal-paste-sanitizer.test.ts) 的 `installTerminalPasteSanitizer：接管原生 paste` 一组（检查 capture 标志，以及同时调用 `preventDefault` 与 `stopImmediatePropagation`）。

### 2.4 粘贴不进快捷键注册表

**机制**：原生 Edit→Paste role 始终存在：xterm 的键回调返回 `false` 时并不 `preventDefault`，Electron 的 `role: 'editMenu'` 照常触发。若再把粘贴注册进 `SHORTCUT_BINDINGS` 或终端键处理器，同一次 Cmd/Ctrl+V 会走两条路，粘两次。

**不变量**：粘贴不进 `SHORTCUT_BINDINGS`，也不进终端键处理器的 handler map；它的唯一入口是 [application-menu.ts](../../apps/desktop/src/main/application-menu.ts): `applicationMenuTemplate` 里的 `role: 'editMenu'`。菜单模板是手写的，以去掉 Cmd+W、Cmd+R 这类会静默丢数据的加速键，但 `appMenu` 与 `editMenu` 必须保留。

**判别**：Cmd/Ctrl+V 粘一次出现两份内容。与 §2.3 的区别：§2.3 是净化监听器不在捕获阶段，被 xterm 的冒泡监听重复消费；这里是注册表或 handler map 里多了一条 paste 条目。

**守卫**：
- 不许出现第二条 JS 路径：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts) 的 `paste 刻意不在 handler map 里`；同文件 `注册表里有 id 但 handler map 里没有的键，交还而不是吞掉` 保证即使有 id 也不吞键（吞掉会让粘贴彻底失效）。
- `editMenu` 不许删：[application-menu.test.ts](../../apps/desktop/test/application-menu.test.ts) 的 `保留 Edit 菜单——终端粘贴依赖原生 Paste role`。

右键菜单显示的粘贴键位 [terminal-menu-chords.ts](../../apps/desktop/src/renderer/src/lib/terminal-menu-chords.ts): `NATIVE_PASTE_CHORD` 是全仓唯一手写的和弦，因为它的唯一来源是原生菜单。两个平台都不带 Shift，写成 `Ctrl+Shift+V` 就是宣传一个死键；[terminal-menu-chords.test.ts](../../apps/desktop/test/terminal-menu-chords.test.ts) 断言 `NATIVE_PASTE_CHORD.shift` 为假。

---

## 3. 键盘：一次按键的裁决顺序

按键从 OS 到 PTY 依次经过四道关，顺序本身就是合同：

1. **原生菜单加速键**（L4/L5）。AppKit 在 webContents 之前处理它，Renderer 的 `preventDefault()` 取消不了。危险加速键（Cmd+W、Cmd+R、Cmd+Shift+R）只能通过「不把对应 role 放进菜单模板」处置。
2. **窗口级捕获监听**：[App.tsx](../../apps/desktop/src/renderer/src/App.tsx) 的 `keydown`（`{ capture: true }`）→ [shortcut-registry.ts](../../apps/desktop/src/renderer/src/lib/shortcut-registry.ts): `routeWindowShortcut`，在 xterm 的 textarea 之前运行。
3. **xterm 自定义键处理器**：[terminal-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/terminal-shortcuts.ts): `terminalKeyEventHandler`，内部顺序为裸 Ctrl+C → 注册表匹配 → 未匹配则交给 bypass 策略。
4. **kitty 编码器与 bypass 策略**：[xterm-bypass-policy.ts](../../apps/desktop/src/renderer/src/lib/xterm-bypass-policy.ts): `shouldBypassXtermKeyboardEvent`。

### 3.1 终端聚焦时，所有窗口级绑定都会拿到按键

**机制**：[workbench-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/workbench-shortcuts.ts): `isEditableChordTarget` 在 `.xterm` 内部返回 `false`。「不在可编辑元素里才生效」这道闸挡不住终端，每个窗口级绑定都会在终端聚焦时拿到按键。这是刻意的：捕获监听存在的目的就是抢在 xterm 之前拿到键。

**不变量**：未设 gate 的窗口和弦不得与任何终端绑定撞键，否则那条终端绑定永远够不着。

**判别**：焦点在终端里按该和弦，看它走了窗口动作还是进了 PTY。

**守卫**：[shortcut-registry.test.ts](../../apps/desktop/test/shortcut-registry.test.ts) 的 `an un-gated window binding never collides with a terminal or editor chord — those surfaces do not shield it`（从注册表派生的 scope 列表遍历）；[workbench-shortcuts.test.ts](../../apps/desktop/test/workbench-shortcuts.test.ts) 的 `isEditableChordTarget：非终端可编辑控件放行，终端焦点仍接管`。接线由 [shortcut-scope-wiring.test.tsx](../../apps/desktop/test/shortcut-scope-wiring.test.tsx) 与 [workbench-shortcut-wiring.test.tsx](../../apps/desktop/test/workbench-shortcut-wiring.test.tsx) 按 AST 检查。

### 3.2 kitty 渐进增强会吃掉剪贴板和弦

**机制**：CLI 打开 kitty progressive enhancement 后，xterm 的 CSI-u 编码器会对 ⌘C/⌘V 这类和弦调用 `preventDefault()`，原生复制粘贴随之失效。

**当前机制**：`shouldBypassXtermKeyboardEvent` 在编码器运行前返回，让 xterm 提前出让。macOS 出让 ⌘C/⌘V；其他平台出让 Ctrl+Shift+C、Ctrl+V、Ctrl+Shift+V、Shift+Insert，Ctrl+C 只在有选区时出让，没选区时它必须是 SIGINT。

**判别**：在开了 kitty progressive enhancement 的 CLI 里按 ⌘C/⌘V，看原生复制粘贴是否失效。

**守卫**：[xterm-bypass-policy.test.ts](../../apps/desktop/test/xterm-bypass-policy.test.ts) 的 `mac 剪贴板和弦` 与 `非 mac 剪贴板和弦` 两组，其中有选区、无选区两条 Ctrl+C 用例成对出现。

### 3.3 裸 Ctrl+C 的两个互斥语义

**机制**：裸 Ctrl+C 有可复制文本时是复制，没有时是终端的 SIGINT。注册表里 `terminal.copy` 的两个和弦（macOS 的 Cmd+C、其他平台的 Ctrl+Shift+C）都不匹配裸 Ctrl+C。

**当前机制**：[terminal-shortcuts.ts](../../apps/desktop/src/renderer/src/lib/terminal-shortcuts.ts): `isBareCtrlC` 加 `terminalKeyEventHandler` 中排在注册表匹配之前的分支：有可复制文本则复制，没有则交回 PTY。判据是文本非空（§1.3），不是坐标意义上的 `hasSelection()`。这条分支刻意不走 bypass 策略，因为后者的 interrupt-C 分支读的是坐标 `hasSelection`，在空白处横拖时会分岔。

**判别**：没选区时按 Ctrl+C，看跑飞的程序能否被中断；被吞成「复制空串」说明判据用成了坐标。

**守卫**：[terminal-shortcuts.test.ts](../../apps/desktop/test/terminal-shortcuts.test.ts) 的 `裸 Ctrl+C：有选区复制，没选区发 SIGINT（#610）` 一组（含 `注册表两条和弦都不匹配裸 Ctrl+C`），以及 `终端键回调的吞键判定` 一组（其中 `坐标说有选区但文本是空的，仍要交还` 覆盖坐标与文本分岔）。

### 3.4 键位的唯一来源

[shortcut-registry.ts](../../apps/desktop/src/renderer/src/lib/shortcut-registry.ts): `SHORTCUT_BINDINGS` 是唯一的键位事实。派生方包括窗口监听、终端处理器、Monaco（`monacoKeybindingFor` 翻译，遇到未知键抛错）、快捷键速查和 bypass 策略。

刻意放在注册表之外的和弦只有 [xterm-bypass-policy.ts](../../apps/desktop/src/renderer/src/lib/xterm-bypass-policy.ts) 里的 paste、Shift+Insert 与 interrupt-C。它们在注册表里没有条目，因此不存在第二份会漂移的定义，匹配时也复用注册表的 `chordMatches`。

**维护约定**：在注册表之外手写和弦的地方，必须在源码注释里写明它的唯一来源在哪里、为什么不能进注册表。

---

## 4. 输入法（IME）：两个互不相干的机制

「中文输入变成不是我打的字」同样是一个症状对应多个机制。

### 4.1 受控 value 在组字中途被回写

**成因**：React 的 `updateTextarea` 无条件执行 `element.value = value`，每次变更后 `restoreStateOfTarget` 还会重贴 props。组字期间 DOM 里是候选预览串，任何 `props.value ≠ DOM` 都会触发一次回写，打断或替换正在组的字。

**当前机制**：组字期间 [composer-composition.ts](../../packages/client-ui/src/lib/composer-composition.ts): `composerRenderValue` 返回一份镜像（直接读 `event.currentTarget.value`），使 `value !== element.value` 恒不成立；这层封装在可复用的 [ComposerTextarea.tsx](../../packages/client-ui/src/input/ComposerTextarea.tsx) 中，需要受控组字的 textarea 消费同一个壳。Agent Composer 本身使用 [ComposerCompletionEditor](../../packages/client-ui/src/components/ComposerCompletionEditor.tsx)，组字、选区与撤销由该编辑器持有，宿主只持有草稿。调用范围以当前源码为准，不以旧的输入框数量判断完整接入。

**判别**：打一段中文、删掉、再打，出现没输入过的旧字符。

**证据边界**：取值层、状态机与 AST 接线检查不能单独证明真实 OS／DOM 输入法可用。组字期间的外部写入与 compositionEnd 的裁决须沿原输入 owner 验证，静态或模拟事件不能代替真实组字。

### 4.2 Enter 的归属

**成因**：确认候选词用的也是 Enter。不判断这次 Enter 是否属于输入法，确认候选就会被当成提交。

**当前机制**：判据读四个来源：`event.isComposing`、`event.keyCode === 229`、`event.nativeEvent.isComposing`、`event.nativeEvent.keyCode === 229`；第四个最容易漏，部分输入法只在原生事件上给 229。唯一定义是 [ime-keyboard-event.ts](../../packages/client-ui/src/lib/ime-keyboard-event.ts): `isImeOwnedKeyboardEvent`（包出口 `@agentmux/client-ui/ime-keyboard-event`）；Desktop 的 [ime-composition-keyboard-event.ts](../../apps/desktop/src/renderer/src/lib/ime-composition-keyboard-event.ts): `isImeCompositionKeyDown` 直接委托给它。Agent Composer 的提交键经 [composer-keyboard.ts](../../packages/client-ui/src/lib/composer-keyboard.ts): `matchComposerShortcut` 匹配，IME 拥有的事件在这里返回 `null`。

**不变量**：不手抄这个谓词的任何子集。Agent Composer 曾只手抄其中两个来源（`nativeEvent?.isComposing || keyCode === 229`），提交 `185c86b681` 改为调用四路谓词，并用每次只标记一个来源的用例区分生产代码实际读的是哪一侧。

**守卫**：[ime-composition-keyboard-event.test.ts](../../apps/desktop/test/ime-composition-keyboard-event.test.ts) 采用发现式扫描，遍历全部 `.tsx` 中在 Enter 上提交的输入；例外表 `GUARD_EXCEPTIONS` 的条数由 `EXPECTED_EXCEPTION_COUNT` 固定，悄悄新增豁免会失败。

**当前缺口**：例外表中有两条 `debt` 项尚未补上组字守卫：TerminalView 的搜索框（`input:searchWith`）与 WorkspaceWorkbench 的就地重命名（`input:commitRename`）。其余例外是 `fact` 项（树导航、非编辑元素），本身不承载组字确认。

---

## 5. 重排与 replay

Attachment 的恢复、揭示与尺寸提交见 [Terminal Runtime 的回放和尺寸同步](terminal-runtime.md#5-attachment-回放历史只读与尺寸同步)。本节按画面或输入现象定位 xterm 与宿主间的交接。

### 5.1 replay 的字节先落地，第一次 fit 后到

**机制**：xterm 以 80×24 构造，retained scrollback 的字节在第一次确定性 fit 之前就写进解析器。如果第一次 live fit 改变了网格，刚 replay 出来的那屏就是按错误宽度排版的。

它不会自愈，有两个叠加原因：
- xterm 只对带 scrollback 的 normal buffer 做 reflow（上游内部字段 `_isReflowEnabled` 要求 `_hasScrollback`，升级 xterm 时复核）；alternate screen 的 TUI（diff 视图、vim、htop、lazygit）只做逐行截断或补白。
- 重启恢复的 PTY 尺寸通常等于 daemon 保留的尺寸，同尺寸的 `TIOCSWINSZ` 不产生 SIGWINCH，TUI 没有理由重绘。

缩放之所以能修好，是因为它真的改变了 CSS 像素与单元格尺寸，既触发 fit 又制造真实的尺寸差。

**判别**：重启恢复后那一屏花掉，但缩放一下就好了：相对字节落地时刻的网格移动过，PTY 尺寸却没变、没有 SIGWINCH。alternate screen 的 TUI 缩放也修不好，那是另一类问题。

**当前机制**：[terminal-viewport-sync.ts](../../apps/desktop/src/renderer/src/lib/terminal-viewport-sync.ts) 在写完 replay、开始 live 之前记录锚点 `gridWhenReplayLanded`；第一次 live fit 若相对这个锚点移动了网格，就强制一次 `requestContentRedraw()`。判据不是「PTY 尺寸变了没有」（Renderer 无从知道），也不是「这次 fit 移动了没有」（非 live 的 fit 也会移动）。全新终端没有 replay，锚点为 `null`，不付这份代价。

**守卫**：[terminal-replay-reflow-recovery.test.ts](../../apps/desktop/test/terminal-replay-reflow-recovery.test.ts)、[terminal-viewport-sync.test.ts](../../apps/desktop/test/terminal-viewport-sync.test.ts)。

### 5.2 单元格度量抖动会把 TUI 画花

**机制**：WebGL/DOM 的单元格度量在重渲染时可能抖一列：`proposeDimensions` 差一列，容器 CSS 像素却没变。把它当成真实 resize 去 `fit()`，xterm 会 reflow 一列再弹回，把刚画好的 TUI 画花。

**当前机制**：静止容器的单列抖动由 [Terminal Runtime 的尺寸判定](terminal-runtime.md#53-resize-只提交稳定最新的网格)处理。replay 阶段的 fit 也建立像素基线，使第一次 live fit 有值可比较。

**判别**：拖拽与重渲染已停（像素固定），却又 fit 了一次。

**守卫**：[terminal-viewport-sync.test.ts](../../apps/desktop/test/terminal-viewport-sync.test.ts) 的 `skips a one-column grid wobble when container pixels have not changed`，以及 replay 阶段留下抖动基线的用例。

### 5.3 replay 与 live 是不相交的两条流

[TerminalView.tsx](../../apps/desktop/src/renderer/src/components/TerminalView.tsx) 中的 `readyForLiveOutput` 标记首次交接；`replayingContinuation` 与 `historicalOutputDepth` 继续区分恢复与历史解析。OSC 处理器读取实际的 replay 范围，不能只凭首次 live 已就绪判断之后的历史字节可以回答颜色查询或写剪贴板。首次 replay 期间的 live 事件进入有界缓冲（`MAX_PENDING_OUTPUT_EVENTS` / `MAX_PENDING_OUTPUT_BYTES`），随后排空；重叠由 [live-output.ts](../../packages/client-ui/src/terminal/live-output.ts): `composeTerminalLiveOutputWrite` 判定为全部已见、部分已见或真实断档。

### 5.4 输入的两个事件源与唯一写出口

**机制**：xterm 的输入事件分两路。SGR 鼠标上报（DECSET ?1006）是 ASCII，走 `onData`；旧式协议（?1000/?1002/?1003/?9 且不带 ?1006）发 ≥128 的坐标字节，语义是 latin1，走 `onBinary`。只订阅 `onData` 会丢掉旧式鼠标上报；把 latin1 当 UTF-8 编码会把 0x80 变成 0xC2 0x80。

**当前机制**：
- [input.ts](../../packages/client-ui/src/terminal/input.ts): `subscribeTerminalInput` 同时订阅两路，`onBinary` 的 latin1 串先经 `encodeTerminalBinaryInput` 还原成 `Uint8Array` 再送出，不经过 UTF-8。
- 两路交给同一个写出口：调用方传入的 [terminal-reveal.ts](../../apps/desktop/src/renderer/src/lib/terminal-reveal.ts): `terminalInputSender({ accepts, replaying, write })`。它每次送出都重新求值 `accepts`（闸的输入在 attachment 生命周期中会翻转，不能缓存到构造时）；`source === 'terminal-protocol'` 且 `replaying()` 为真时不送（历史解析产生的协议查询描述的是过去的屏幕）；零长度载荷不送（IME 组字途中的 `onData('')` 与被禁用的旧式鼠标上报会产生空载荷，ctxmux 会拒绝空输入）。
- 输入资格只由 `terminalAcceptsInput({ canControlRun, acceptsInput })` 和视图的只读状态决定。`readyForLiveOutput` 只描述输出读取进度，不拥有输入资格：输出尚未接回时，健康 Run 的输入仍按原资格送达。
- 判定与写出包在同一个函数里，组件内不留可以被写反的 `if`。

**判别**：只开旧式鼠标协议（无 ?1006）的 TUI 里鼠标完全没反应，说明 `onBinary` 没订阅；坐标字节 0x80 变成两字节，说明把 latin1 当成了 UTF-8。

**守卫**：[terminal-reveal.test.ts](../../apps/desktop/test/terminal-reveal.test.ts) 的 `两个输入事件源共用一把闸一个出口`（按出口数判定：删 `onBinary` 订阅、绕过 accepts 或把 latin1 当 UTF-8，各自会让一条用例失败）、`encodeTerminalBinaryInput 把 latin1 字符串按字节还原，>=128 也不失真`，以及按源码文本检查接线的 `onData/onBinary 没经 subscribeTerminalInput 接到 sender`。

---

## 6. 链接

[TerminalView](../../apps/desktop/src/renderer/src/components/TerminalView.tsx) 的普通链接和 xterm 原生 OSC 8 回调都进入同一个激活和悬停出口。手势经 `isTerminalLinkClick` 核对，文件进入原文件服务，`amux:` 进入 Core 的对象地址入口，HTTP(S) 沿目的地选择或平台修饰键快路打开。

- [单元格窗口](../../apps/desktop/src/renderer/src/lib/terminal-link-range.ts) 按真实软换行和字符宽度映射范围，同一结果供左键、悬停和右键消费。原生 OSC 8 声明占用其单元格，未知目标也保护标签；本例程补齐原生 provider 漏掉的单格行尾标签。
- [目标分类](../../apps/desktop/src/renderer/src/lib/terminal-link-target.ts) 将裸 URI 与显式声明分别识别，再使用共享的 [HTTP 校验](../../packages/client-ui/src/lib/link-url.ts)、[路径语法和 Workspace 归一化](../../packages/client-ui/src/lib/terminal-path-link.ts)。裸 URI 的文本优先保留，文件候选不会从 URL 查询或混杂方案中再起一条链接。
- [原文件上下文](../../apps/desktop/src/renderer/src/lib/session-project-file-context.ts) 提供文件的 Workspace、Host 和本机 home，当前 Region 只决定展示位置。系统打开和文件管理器定位再经 Main 的真实资源边界。热点识别只读当前相关单元格，不做文件探测或 IPC。

---

## 7. 按机制定位与验证

同一症状再次出现时，沿上文的数据源、层与判别区分原因；修复说明写清已覆盖、未受影响与尚未确认的范围。任务验收、变异、真实产品调用链、非空扫描与源码在场判据的边界唯一见[测试策略](../testing/strategy.md#任务验收与假绿防护)，本页不另设守卫等级或交付 gate。

每节的测试名只是核查入口：需要实际确认测试扫描了目标并执行了对应分支。历史测试存在、symbol 在场或旧 receipt 不能证明当前候选已通过。

## 8. 机制不变量清单

1. 四条复制路径的剪贴板写入只经 `copyTextToClipboard`，错误出口是必填参数。
2. B、C 两档复制不经过鼠标选区服务，选区被 TUI 鼠标上报关闭时仍可用。
3. 正文粘贴与 Prompt 文本载荷共用 ESC 判定（`sanitizeBracketedPasteText`）；原生键盘、鼠标、binary 与终端协议回复保持原字节，不经过正文净化。
4. 粘贴不进快捷键注册表；`role: 'editMenu'` 不删。
5. 键位的唯一来源是 `SHORTCUT_BINDINGS`；注册表外的和弦在注释里写明来源。
6. IME 谓词读四个来源，唯一定义是 `isImeOwnedKeyboardEvent`，不手抄子集。
7. 组字期间受控 textarea 走镜像取值，不做外部回写。
8. OSC 处理器在 replay 期不产生副作用。
9. `onData` / `onBinary` 共用一个闸、一个写出口；输入资格不依赖 `readyForLiveOutput`。
10. 重排补救的判据锚在 replay 字节落地时刻的网格，不是「尺寸变了」也不是「这次 fit 动了」。
