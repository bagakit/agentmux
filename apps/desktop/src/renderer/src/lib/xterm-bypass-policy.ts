// xterm 键盘旁路策略——faithful port of the reference project's xterm-bypass-policy.ts。
//
// 为什么需要它：当某个 CLI 启用 kitty progressive enhancement（`CSI > N u`）后，xterm 的
// KittyKeyboard 编码器会把每一个带修饰键的和弦——**包括** Cmd+C、Cmd+V——都编成一条 CSI-u
// 序列，并且带 `cancel: true`，也就是在 keydown 上调 `preventDefault()`。那次 preventDefault 把
// Chromium 原生的 `copy` / `paste` 事件一并压掉，于是 xterm 挂在容器上的原生 `copy` 监听器
// （5.5.0 里 `addDisposableDomListener(this.element, "copy", …)`，仅在 `hasSelection()` 时写剪贴板）
// 根本不触发，原生 Edit→Paste 也送不到 textarea。
//
// 修法与参考项目一致、且结构上更简单：**不自己实现剪贴板**，而是对剪贴板和弦让 xterm 提前
// 出让——从 `attachCustomKeyEventHandler` 返回 `false`。返回 false 会让 xterm 在跑 kitty 编码器
// **之前**就 bail，于是浏览器的 copy/paste 管线与 OS 级键位都照常触发。
//
// 与参考项目之间两处已知差异，显式记录而不是默默吞掉：
//   (a) 版本差异：我们用 @xterm/xterm ^5.5.0；参考项目用 6.1.0-beta.287，且带一份 1055 行的源码
//       补丁。`kittyKeyboardFlags` 在参考实现里就已经是 `XtermBypassOptions` 的字段但函数体从不
//       读它（它是给 6.x 的其它决策留的钩子）——这里原样保留字段与调用形状，但同样不消费它，
//       以免与参考实现的选项形状漂移。5.5.0 上原生 `copy` 监听器在场（见上），故 copy 分支可用。
//   (b) 和弦来源：参考项目在本文件里硬编码字符串和弦（'Mod+C' 等），靠它自己的 `keybindingMatchesInput`
//       原语匹配。本仓有 `shortcut-registry.ts`，本仓也一再吃过「手抄常量表漂移」的亏，所以
//       **copy 和弦从注册表取**（`terminal.copy`：mac 是 Cmd+C、其余是 Ctrl+Shift+C，一次查表同时
//       覆盖参考项目 mac 分支的 `Mod+C` 与非 mac 分支的 `Ctrl+Shift+C`）。paste / Shift+Insert /
//       带选区的裸 Ctrl+C 这几条**注册表里刻意没有**（paste 的所有者是原生 Edit→Paste，见
//       terminal-shortcuts.ts 的工厂注释），所以它们在本文件就地定义为 `Chord`，用注册表同一个
//       匹配原语 `chordMatches` 判——它们没有第二个 SSOT 可漂移。

import { bindingById, chordForPlatform, chordMatches, type Chord } from './shortcut-registry'

/** attachCustomKeyEventHandler 回调看到的键盘事件里，本策略读到的那些字段。 */
export type XtermBypassEvent = {
  type: string
  key: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  repeat?: boolean
  defaultPrevented?: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type XtermBypassOptions = {
  isMac: boolean
  /** 版本钩子（见文件头 (a)）：参考实现留着它给 6.x 用，本函数体不消费。 */
  kittyKeyboardFlags?: number
  /** 终端此刻有没有文本选区——非 mac 上 Ctrl+C 只在有选区时才让给剪贴板，否则它是 SIGINT，
   *  必须原样到达 shell。 */
  hasSelection: boolean
  /** 渲染层是否跑在 iOS/iPadOS WebKit 里；那里系统靠改写字段而非组字会话来输入 CJK。
   *  本仓是 Electron 桌面端，这一路今天不可达，但分支保留（见 shouldBypassXtermForIosTextEdit）。 */
  isIosWeb?: boolean
}

const TERMINAL_MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])

/** 硬件键盘会直接在 `KeyboardEvent.key` 里报出来的 Hangul jamo：conjoining / compatibility /
 *  extended / halfwidth 各块，含 Shift 打出的双写（ㄲ ㄸ ㅃ ㅆ ㅉ，它们与单写同住 compatibility 块）。
 *  Ported from the reference project's hangul-jamo-key.ts。 */
const HANGUL_JAMO_KEY = /^[ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿ﾠ-ￜ]$/

function isHangulJamoKeyText(key: string): boolean {
  return HANGUL_JAMO_KEY.test(key)
}

function isSingleNonAsciiPrintableText(key: string): boolean {
  const chars = Array.from(key)
  if (chars.length !== 1) {
    return false
  }
  const codePoint = chars[0]?.codePointAt(0)
  return codePoint !== undefined && codePoint >= 0x80
}

function isXtermHandledKeyEvent(type: string): boolean {
  return type === 'keydown' || type === 'keyup'
}

/**
 * iOS/iPadOS 靠 `beforeinput`/`input` 改写字段来组 CJK，没有组字会话，而那只有在可打印 keydown
 * 到达默认处理器时才跑。xterm 必须对这些键让路，`keypress` 也包含在内，否则 `_keyPress` 会把
 * 字形连同 preedit 提交再送一遍。
 *
 * 本仓是 Electron 桌面端，`isIosWeb` 今天恒为 false，故这一路不可达——但按「不删分支」保留，
 * 且它是 shouldBypassXtermKeyboardEvent 的一个真实分支。
 */
export function shouldBypassXtermForIosTextEdit(
  event: XtermBypassEvent,
  isIosWeb: boolean
): boolean {
  if (!isIosWeb || event.ctrlKey || event.metaKey || event.altKey) {
    return false
  }
  if (event.isComposing === true) {
    // 会真的跑组字会话的输入源留给 xterm 的 CompositionHelper，它已经能正确提交。
    return false
  }
  if (!isXtermHandledKeyEvent(event.type) && event.type !== 'keypress') {
    return false
  }
  // 为什么只认 jamo 而不是所有非 ASCII 键：被它认领的键，下游没有任何东西会再送一遍。
  // 一个 Cyrillic 或假名键会同时丢掉 keydown、keypress 和随后的 `input`，最终一个字符都到不了 PTY。
  return isHangulJamoKeyText(event.key)
}

/** copy 和弦以注册表 `terminal.copy` 为 SSOT（mac: Cmd+C；其余: Ctrl+Shift+C）。 */
function matchesTerminalCopyChord(event: XtermBypassEvent, isMac: boolean): boolean {
  const copy = bindingById('terminal.copy')
  return copy ? chordMatches(chordForPlatform(copy, isMac), asChordInput(event), isMac) : false
}

// paste / Shift+Insert / 带选区的裸 Ctrl+C：注册表刻意没有（见文件头 (b)），就地定义为 Chord。
// 它们对两个平台的差异只在「primary 是 Cmd 还是 Ctrl」，由 chordMatches 按 isMac 解释，所以一份
// 定义两个平台通用。
const PASTE_CHORD: Chord = { key: 'v', primary: true, shift: false, alt: false }
const PASTE_SHIFT_CHORD: Chord = { key: 'v', primary: true, shift: true, alt: false }
const INTERRUPT_C_CHORD: Chord = { key: 'c', primary: true, shift: false, alt: false }
const SHIFT_INSERT_CHORD: Chord = { key: 'insert', primary: false, shift: true, alt: false }

/** chordMatches 只读 ShortcutEvent 的 5 个字段；XtermBypassEvent 是它的超集，收窄一下。 */
function asChordInput(event: XtermBypassEvent): {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
} {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey
  }
}

/**
 * 决定某个和弦要不要旁路 xterm 的键处理，好让原生浏览器管线（Chromium `copy`/`paste`、Electron
 * 菜单加速键）或 layout-aware 文本事件来处理它，而不是落进 kitty CSI-u 编码器。
 *
 * 分支顺序与参考项目一致，逐条保留：
 *   1. iOS 文本编辑（本仓不可达，保留）；
 *   2. `defaultPrevented && platformModifierHeld`：窗口级快捷键已处理了这个和弦但没停传播——
 *      别让 xterm 再把它当输入送给 shell；
 *   3. Shift + 单个非 ASCII 可打印：xterm 的 kitty 编码器按**物理** `code` 推导 shifted 键码
 *      （KeyA→拉丁 "a"），非美式布局会送错字符；旁路 keydown 让 Chromium 经 keypress 供布局文本，
 *      旁路 keyup 免得 xterm 漏一条释放 CSI-u；
 *   4. mac：Cmd+C（注册表）/ Cmd+V；
 *   5. Windows/Linux：Ctrl+Shift+C（注册表）恒旁路；Ctrl+C 仅在**有选区**时旁路（否则是 SIGINT，
 *      必须到 shell）；Ctrl+V；Ctrl+Shift+V；Shift+Insert。
 */
export function shouldBypassXtermKeyboardEvent(
  event: XtermBypassEvent,
  options: XtermBypassOptions
): boolean {
  if (shouldBypassXtermForIosTextEdit(event, options.isIosWeb === true)) {
    return true
  }
  if (!isXtermHandledKeyEvent(event.type)) {
    return false
  }

  const { isMac, hasSelection } = options
  const platformModifierHeld = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey

  if (event.defaultPrevented && platformModifierHeld) {
    // 为什么：窗口级 AgentMux 快捷键可能已经处理了这个和弦但没停传播。别让 xterm 也把这个
    // 快捷键当成终端输入送出去。
    return true
  }

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    isSingleNonAsciiPrintableText(event.key)
  ) {
    // 为什么：xterm 的 kitty 编码器按物理 `code` 推 shifted 键码（KeyA→拉丁 "a"）。旁路 keydown
    // 让 Chromium 经 keypress 供布局文本，旁路 keyup 免得 xterm 漏一条释放 CSI-u。
    return true
  }

  if (isMac) {
    // 为什么：其它 Cmd 和弦在 Electron 里会被窗口级处理器在 xterm 看到之前就消费掉。Web 客户端
    // 仍需要让 paste 冒泡到 Chromium 原生 paste 事件，而不是落进 xterm 的 kitty 编码器。
    return (
      matchesTerminalCopyChord(event, isMac) ||
      chordMatches(PASTE_CHORD, asChordInput(event), isMac)
    )
  }

  // Windows/Linux：标准剪贴板和弦冒泡；Ctrl+C 只在有选区时冒泡（否则它是 SIGINT，必须到 shell）。
  if (matchesTerminalCopyChord(event, isMac)) {
    return true
  }
  if (chordMatches(INTERRUPT_C_CHORD, asChordInput(event), isMac) && hasSelection) {
    return true
  }
  if (
    chordMatches(PASTE_CHORD, asChordInput(event), isMac) ||
    chordMatches(PASTE_SHIFT_CHORD, asChordInput(event), isMac)
  ) {
    return true
  }
  if (chordMatches(SHIFT_INSERT_CHORD, asChordInput(event), isMac)) {
    return true
  }

  return false
}

/**
 * 陈旧的 kitty keyboard 上报可能在 Ctrl+C 到达之前，把独立的修饰键按下也编成 CSI-u。参考项目在
 * 中断处理之前用这个把它们吞掉。本仓的 TerminalView 由别的 agent 持有、无法接入这条，故此函数
 * 目前**未接线**——保留是为了与参考实现的导出面一致，接线待 TerminalView 侧可动时补。
 */
export function shouldSuppressTerminalModifierKeyboardEvent(event: XtermBypassEvent): boolean {
  return isXtermHandledKeyEvent(event.type) && TERMINAL_MODIFIER_KEYS.has(event.key)
}
