// The "what bytes / which text after the key" helpers for the terminal. The chord decisions themselves —
// is this Cmd+F / Cmd+C / Cmd+K, is this the bare Shift+Enter newline — now live in `shortcut-registry.ts`
// (terminal scope), so the one platform bottom line is expressed once. What stays here is the part that is
// NOT a key decision: which selection to copy, and which byte sequence a newline must send.

/**
 * xterm can clear its live selection while a context menu takes focus. Keep the
 * last non-empty selection as a copy source so a right-click Copy remains
 * deterministic even after that focus transition.
 */
export function terminalSelectionForCopy(liveSelection: string, rememberedSelection: string): string {
  return liveSelection || rememberedSelection
}

/**
 * Shift+Enter 该送哪几个字节。
 *
 * 终端本身对 Enter 与 Shift+Enter 不可分辨——两者默认都是 `\r`，因为传统终端的线路上根本没有
 * 表达修饰键的位置。于是下游 TUI 看到 `\r` 只能理解成"提交"，用户就写不了多行。要分得开，
 * 必须由宿主显式送出不同的字节，这是我们的活，不是可以指望的默认行为。
 *
 * 两种编码，取决于下游程序自己有没有协商 kitty keyboard 协议：
 * - 协商过：送 CSI-u（`ESC [13;2u`，13 是 Enter 的键码，2 是 Shift 修饰位）——这是该协议下
 *   表达"带修饰键的 Enter"的正规说法。
 * - 没协商过：退回 `ESC CR`。这是许多 TUI 沿用已久的"Alt/Meta+Enter 换行"约定，在没有协议
 *   支持时它是最可能被正确理解的一种。
 *
 * 没协商过却送 CSI-u 会让那个程序收到一串它不认识的字节，因此协议状态只能探测、不能假定，
 * 见 `terminal-kitty-keyboard.ts`。
 */
export const SHIFT_ENTER_CSI_U = '[13;2u'
export const SHIFT_ENTER_ESC_CR = '\r'

export function shiftEnterInput(kittyKeyboardActive: boolean): string {
  return kittyKeyboardActive ? SHIFT_ENTER_CSI_U : SHIFT_ENTER_ESC_CR
}

/**
 * 终端绑定命中之后要做的事，注入形式的依赖。
 *
 * 每个字段都是壳能提供、而这一层不该自己去拿的东西：`sendInput` 通向 PTY，`clipboard` 通向系统
 * 剪贴板（含它自己的响亮报错），其余三个是 xterm 实例上的取值/动作。刻意不接收 `terminal` 本体：
 * 那样这层就得知道 xterm 的形状，而它只需要这几个动作。
 */
export interface TerminalShortcutDeps {
  /** 往 PTY 送字节。 */
  sendInput: (data: string) => void
  /** 下游程序有没有协商 kitty keyboard 协议——决定 Shift+Enter 送哪种编码。 */
  kittyKeyboardActive: () => boolean
  /** 打开/关闭终端内搜索条。 */
  setSearchOpen: (open: boolean) => void
  /** 当前选区（空串表示没有选中）。 */
  readSelection: () => string
  /** 记住这次选区，供右键 Copy 在焦点转移后仍可用。 */
  rememberSelection: (text: string) => void
  /** 把文本送进系统剪贴板；失败要响亮报错而不是静默丢。 */
  writeClipboard: (text: string) => void
  /** 清屏。 */
  clear: () => void
}

/**
 * 每条 `terminal` scope 绑定命中后的动作，键是绑定 id。
 *
 * 为什么抽出来：这些分支此前内联在 `TerminalView` 的 `attachCustomKeyEventHandler` 里，运行期
 * 完全够不着——把任一分支的**体**掏空（`if (id === 'terminal.search') { return false }`），56 条
 * 终端搜索测试与整族快捷键测试全绿，而那个键对用户彻底失效。跨 scope 的接线守卫因此只能读源码
 * 断言「比较在场」，那是最弱的一层。抽成纯工厂后它可以被直接调用并断言后果。
 *
 * 镜像 `windowShortcutHandlers` 的形状（`Record<id, handler>`）。返回的 handler 只在 keydown 时
 * 被调用一次——「keydown 还是 keyup」是壳的判断，不是这层的；这层只回答「做什么」。
 *
 * 注意 **paste 刻意不在这里**：xterm 的 `attachCustomKeyEventHandler` 返回 false 不会
 * preventDefault，所以原生 Edit→Paste 路径照旧触发。在这里也处理 Cmd/Ctrl+V 会让同一份剪贴板
 * 文本被贴两次。原生路径是 paste 的唯一所有者。
 */
export function terminalShortcutHandlers(deps: TerminalShortcutDeps): Record<string, () => void> {
  return {
    'terminal.newline': () => {
      // xterm 对 Enter 与 Shift+Enter 送同一个裸 \r（终端线路上没有表达修饰键的位置），下游 TUI
      // 因此只能把 Shift+Enter 读成提交，用户写不了多行。这里显式送出不同的字节。
      deps.sendInput(shiftEnterInput(deps.kittyKeyboardActive()))
    },
    'terminal.search': () => {
      deps.setSearchOpen(true)
    },
    'terminal.copy': () => {
      const text = deps.readSelection()
      if (text) deps.rememberSelection(text)
      deps.writeClipboard(text)
    },
    'terminal.clear': () => {
      deps.clear()
    }
  }
}

/** {@link terminalKeyEventHandler} 除动作之外还要的两件事。 */
export interface TerminalKeyEventDeps extends TerminalShortcutDeps {
  /** 这个事件命中了哪条 terminal 绑定（`null` 表示不是我们的键）。通常是 `matchShortcut` 的柯里化。 */
  matchTerminalShortcut: (event: KeyboardEvent) => string | null
  /** 终端此刻有没有选区——`terminal.copy` 的认领条件。 */
  hasSelection: () => boolean
}

/**
 * xterm `attachCustomKeyEventHandler` 的整个回调：返回 `false` 表示这个键被我们吞掉。
 *
 * 为什么连回调一起抽出来，而不只抽动作：只抽 {@link terminalShortcutHandlers} 时「动作对不对」
 * 可测了，但「这层壳有没有被执行到」照旧无人守——在组件里 `matchShortcut` 之后插一句
 * `return true`，整个回调变 no-op（每个终端键都失效），而工厂那族与接线守卫全绿，实测过。
 * 判「取值关系」的 AST 守卫看不见一句早退。
 *
 * 收法是让壳里没有语句可插：组件那侧只剩
 * `terminal.attachCustomKeyEventHandler(terminalKeyEventHandler({ … }))` 一句转发，判定与吞键
 * 的全部逻辑在这里，可以直接喂事件断言返回值。
 */
export function terminalKeyEventHandler(deps: TerminalKeyEventDeps): (event: KeyboardEvent) => boolean {
  const actions = terminalShortcutHandlers(deps)
  return (event) => {
    const shortcutId = deps.matchTerminalShortcut(event)
    if (!shortcutId) return true
    // Copy 只在真有选区时认领。没选区就把键交还终端——Ctrl+C 在那种情况下是 SIGINT，
    // 吞掉它会让用户中断不了正在跑的程序。
    if (shortcutId === 'terminal.copy' && !deps.hasSelection()) return true
    const act = actions[shortcutId]
    // 没有对应动作就交还。paste 走的正是这条：见上面工厂注释，原生 Edit→Paste 是它的唯一所有者。
    if (!act) return true
    // keydown / keyup 的区分在这里：动作只跑一次，但两个事件都要吞掉，否则 keyup 会漏给终端。
    if (event.type === 'keydown') act()
    return false
  }
}
