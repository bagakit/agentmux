// 终端右键菜单上宣传的键位，逐行说明它来自哪一个来源。
//
// 守的缺陷（#367）：菜单曾经自己算一个 `const modifier = isMac ? '⌘' : 'Ctrl+Shift+'`，然后把它拼到
// C / V / F / K 前面。两个毛病，第二个是今天就错的：
//
//   1. 注册表已经是快捷键的 SSOT（`shortcut-registry`），cheat-sheet 也已经通过 `formatChord` 从它投影
//      出显示串。菜单手抄一份，等于同一个键位有两处定义——改键（#361）落地那天，注册表变了而菜单
//      静默显示旧键，而菜单恰恰是用户用鼠标找键位的地方。
//   2. **那个前缀被用在了两类不同的加速键上。** copy / search / clear 是注册表里的 `letterChords`，
//      非 mac 上确实是 Ctrl+Shift+X；但 **paste 根本不在注册表里**——它走的是原生 Edit→Paste role
//      （`main/application-menu.ts` 写明这是承重能力：整个 Edit 菜单保留就是为了它，渲染层刻意不接管
//      Cmd/Ctrl+V，见 `terminal-shortcuts.ts` 工厂注释）。而原生 paste 的加速键**没有 Shift**：
//      mac 是 ⌘V，其他平台是 Ctrl+V。于是非 mac 上菜单宣传的 `Ctrl+Shift+V` 是一个按了没反应的键。
//
// 所以这一层的形状不是「都从注册表取」，而是**每一行说清自己的键位出自哪个来源**：
//   - {@link REGISTRY_BACKED} 三行取注册表；
//   - paste 取 {@link NATIVE_PASTE_CHORD}，并在类型上就与前者分开。
// 两类共用同一个渲染器 `formatChord`（符号 vs 单词、修饰键次序都只有一处定义），分岔只在**和弦形状**
// 上——那正是事实：它们是两套加速键，不是同一套的两种拼法。

import { bindingById, chordForPlatform, type Chord } from './shortcut-registry'
import { formatChord } from './shortcut-cheat-sheet'

/** 终端右键菜单上会显示键位的那几行。Select all / Scroll to bottom 没有键位，本来就不在这里。 */
export type TerminalMenuAction = 'copy' | 'paste' | 'search' | 'clear'

/**
 * 键位来自注册表的那几行，以及各自的 binding id。
 *
 * paste 刻意不在这张表里：它没有注册表条目。把它塞进来只能靠编一个不存在的 id，那就把「这一行的键
 * 来自别处」这件事藏起来了。
 */
const REGISTRY_BACKED: Record<Exclude<TerminalMenuAction, 'paste'>, string> = {
  copy: 'terminal.copy',
  search: 'terminal.search',
  clear: 'terminal.clear'
}

/**
 * 原生 Edit→Paste role 的加速键。Electron 给这个 role 绑的是 mac `Cmd+V` / 其他平台 `Ctrl+V`——
 * **两边都没有 Shift**，所以它与注册表里 `letterChords` 那一族形状不同，两个平台共用同一个和弦。
 *
 * 这是唯一一处手写的和弦，理由是它的 SSOT 在 Electron 里而不在本仓：`main/application-menu.ts` 保留
 * 整段 `role: 'editMenu'` 就是为了这个键，模板里根本看不到 accelerator 字段（role 在
 * `buildFromTemplate` 时隐式绑上）。所以本仓没有可派生的取值口，只能照着 role 的约定写一次并钉住。
 */
export const NATIVE_PASTE_CHORD: Chord = { key: 'v', primary: true, shift: false, alt: false }

/**
 * 一组显示 token 连成菜单里那一个 `<kbd>` 的内容。
 *
 * mac 的符号是紧挨着的（⌘C），其他平台是单词，要用 `+` 分开（Ctrl+Shift+C）——不加分隔会连成
 * `CtrlShiftC`。cheat-sheet 面板不需要这个规则，因为它把每个 token 渲染成独立的 `<kbd>`；菜单一行只有
 * 一个 `<kbd>`，所以连接规则住在这里。
 */
function joinTokens(tokens: string[], isMac: boolean): string {
  return isMac ? tokens.join('') : tokens.join('+')
}

/**
 * 终端右键菜单每一行要显示的键位串。
 *
 * 注册表里查不到一个 {@link REGISTRY_BACKED} 声明的 id 时抛错，不静默兜底：那种情况下菜单正在宣传一个
 * 已经不存在的手势，而「显示了一个错键」恰恰是这一族缺陷本身。抛错让它在测试里当场红，走不到用户面前
 * （与 `shortcut-cheat-sheet.ts` 的 `groupIdForBinding` 对未映射 scope 的处理同一条纪律）。
 */
export function terminalMenuChords(isMac: boolean): Record<TerminalMenuAction, string> {
  const fromRegistry = (action: keyof typeof REGISTRY_BACKED): string => {
    const id = REGISTRY_BACKED[action]
    const binding = bindingById(id)
    if (!binding) {
      throw new Error(
        `terminal context menu advertises ${id}, which the shortcut registry no longer declares`
      )
    }
    return joinTokens(formatChord(chordForPlatform(binding, isMac), isMac), isMac)
  }
  return {
    copy: fromRegistry('copy'),
    search: fromRegistry('search'),
    clear: fromRegistry('clear'),
    paste: joinTokens(formatChord(NATIVE_PASTE_CHORD, isMac), isMac)
  }
}
