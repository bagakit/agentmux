export type TerminalShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>

export function isTerminalAppShortcut(
  event: TerminalShortcutEvent,
  key: string,
  isMac: boolean
): boolean {
  if (event.key.toLowerCase() !== key || event.altKey) return false
  return isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && event.shiftKey && !event.metaKey
}

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
export const SHIFT_ENTER_CSI_U = '\u001b[13;2u'
export const SHIFT_ENTER_ESC_CR = '\u001b\r'

export function shiftEnterInput(kittyKeyboardActive: boolean): string {
  return kittyKeyboardActive ? SHIFT_ENTER_CSI_U : SHIFT_ENTER_ESC_CR
}

/**
 * 这个按键事件是不是"要换行的 Shift+Enter"。
 *
 * 只认单独的 Shift：叠加 Ctrl/Alt/Meta 时是另外的和弦，可能有它自己的含义，我们不接管——
 * 接管一个自己没想清楚的组合，等于替下游程序做了它没同意的决定。
 */
export function isShiftEnterNewline(event: TerminalShortcutEvent): boolean {
  if (event.key !== 'Enter') return false
  return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
}
