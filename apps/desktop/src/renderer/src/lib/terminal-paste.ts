import { sanitizeBracketedPasteText } from '@agentmux/core/bracketed-paste'

/**
 * 「一段文本要进这个终端的 PTY」——渲染层唯一的粘贴出口。
 *
 * 判定本身不在这里：ESC 怎么办由 `@agentmux/core/bracketed-paste` 说了算，那也是 Core 侧 provider
 * 投递 prompt 用的同一个函数。本文件只负责**把终端的每一条粘贴路径都接到那个判定上**。
 *
 * 为什么需要接（这不是理论）：上游 xterm 5.5.0 的 paste 模块只**包**不**转义**——
 * `prepareTextForTerminal` 只把换行归一成 `\r`，`bracketTextForPaste` 只在前后拼上
 * `ESC[200~` / `ESC[201~`。于是剪贴板载荷里自带一个 `ESC[201~` 就提前闭合了括号，其后的字节被
 * shell 当命令读（pastejacking）。「包起来了所以安全」是错的。
 *
 * 终端有**两条**粘贴入口，它们必须给出同一个答案：
 *  1. 右键菜单 Paste：走应用自己的 `readClipboardText()` → `pasteIntoTerminal`。
 *  2. 原生 Cmd+V：Electron 的 editMenu role 直接触发浏览器原生 paste，**根本不经过应用的 JS**，
 *     落到 xterm 自己注册的 DOM 监听上。只能在 DOM 层截。
 * 只修 1 会把更常用的那条留在外面，而且立刻构成「同一个概念两处判定」——本仓最常复发的缺陷族。
 */

/** 只用到 `paste`，不依赖整个 Terminal 类型，方便测试传最小替身。 */
export type TerminalPasteTarget = { paste(text: string): void }

/** 只用到这两个方法，同上。 */
export type TerminalPasteHost = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/** 粘贴一段文本进终端。两条入口都必须经这里，才不会各自决定 ESC 怎么办。 */
export function pasteIntoTerminal(terminal: TerminalPasteTarget, text: string): void {
  terminal.paste(sanitizeBracketedPasteText(text))
}

/**
 * 在终端的宿主元素上装一个**捕获期** paste 监听，接管原生粘贴。
 *
 * 为什么必须是捕获期、且必须 `stopImmediatePropagation`：
 * - xterm 的 `handlePasteEvent` 只调 `stopPropagation()`，**从不检查 `defaultPrevented`**。所以光
 *   `preventDefault()` 拦不住它——它照样会拿原始文本喂给 `coreService.triggerDataEvent`。
 * - xterm 把同一个 handler 注册在**两个**节点上（`this.textarea` 和 `this.element`，均为冒泡期）。
 *   只摘一个没用。`stopImmediatePropagation` 一次掐掉两个。
 *
 * 为什么装在 `terminal.element` 上，而不是我们自己的 `rootRef`——这是**结构性作用域**，不是运行期
 * 猜测：xterm 的 DOM 是 `element › screenElement › helpers › textarea`，粘贴的目标只可能是那个
 * textarea（它是唯一 `tabIndex=0`、能拿到焦点的节点；`element` 自己不可聚焦，所以永远不会是 target，
 * 我们的捕获监听因此严格先于它的两个冒泡监听）。而终端搜索框那个 `<input>` 是 `terminal.element` 的
 * **兄弟**，不在这棵子树里——于是「往搜索框里粘贴」天然不会走到这里，不需要在运行期比对 event.target。
 *
 * 返回 disposer：监听器归安装者所有，终端拆卸时必须一起摘掉，否则换主题/换 run 重建终端会越挂越多。
 */
export function installTerminalPasteSanitizer(
  host: TerminalPasteHost,
  terminal: TerminalPasteTarget
): () => void {
  const onPaste = (event: Event): void => {
    // 先夺走这次事件，再决定粘不粘：即便剪贴板是空的或读不出文本，也绝不能让 xterm 拿原始载荷接手。
    event.preventDefault()
    event.stopImmediatePropagation()
    const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
    if (text) pasteIntoTerminal(terminal, text)
  }
  host.addEventListener('paste', onPaste, true)
  return () => {
    host.removeEventListener('paste', onPaste, true)
  }
}
