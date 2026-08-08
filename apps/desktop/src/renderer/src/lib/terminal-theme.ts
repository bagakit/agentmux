import type { ITheme, ITerminalOptions, Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { TerminalThemeId } from '../../../shared/contracts'
import { TERMINAL_FONT_SIZE_DEFAULT } from '../../../shared/contracts'
import { terminalPalette } from '../../../shared/terminal-palettes'

export type TerminalThemeDefinition = {
  id: TerminalThemeId
  label: string
  description: string
  theme: Readonly<ITheme>
}

// App chrome owns product surfaces, xterm owns terminal appearance, and the
// PTY/CtxMux path owns bytes only. A complete palette is important: TUIs use
// ANSI backgrounds to distinguish composers and instruction blocks from the
// terminal work area.
export const TERMINAL_THEME_CATALOG: readonly TerminalThemeDefinition[] = Object.freeze([
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'AgentMux default · crisp neutral work area',
    theme: terminalPalette('graphite')
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Softer contrast · warmer accents',
    theme: terminalPalette('catppuccin-mocha')
  }
])

export function terminalTheme(themeId: TerminalThemeId): Readonly<ITheme> {
  const definition = TERMINAL_THEME_CATALOG.find((candidate) => candidate.id === themeId)
  if (!definition) throw new Error(`Unknown terminal theme: ${String(themeId)}`)
  return definition.theme
}

const TERMINAL_BASE_OPTIONS = Object.freeze({
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace',
  fontWeight: '300',
  fontWeightBold: '500',
  lineHeight: 1,
  scrollSensitivity: 1.15,
  fastScrollSensitivity: 5,
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  allowTransparency: false,
  minimumContrastRatio: 3,
  drawBoldTextInBrightColors: true
}) satisfies Partial<ITerminalOptions>

// `fontSize` is deliberately NOT a member of TERMINAL_BASE_OPTIONS: the size is user-adjustable and its
// default lives in the contract's `TERMINAL_FONT_SIZE_DEFAULT` (the single source of truth). Deriving it
// here — never re-declaring a literal — is what keeps the hardcoded `12` from creeping back: change the
// default and the terminal follows, in one place.
export function terminalOptions(
  themeId: TerminalThemeId,
  fontSize: number = TERMINAL_FONT_SIZE_DEFAULT
): Partial<ITerminalOptions> {
  return { ...TERMINAL_BASE_OPTIONS, theme: terminalTheme(themeId), fontSize }
}

/** xterm 默认宽度表是 Unicode 6：CJK 尚可，但 emoji、较新的符号按 1 列排版。 */
export const UNICODE_WIDTH_VERSION = '11'

/**
 * 装上并**激活** Unicode 11 宽度表。
 *
 * 两步缺一不可，这正是这个函数存在的理由：
 * `loadAddon(new Unicode11Addon())` 只把 '11' 登记进 `terminal.unicode.versions`，
 * **不改 activeVersion**——只 load 不激活，宽度表还是默认的 6，等于没做。必须紧接着
 * 把 `activeVersion` 显式设成 '11' 才真正生效。而 setter 会校验版本已登记，先激活后注册
 * 会抛 `unknown Unicode version "11"`，所以顺序被语言本身钉死：先 register，后 activate。
 *
 * 更关键的是**调用时机**：单元格宽度在字节**写入那一刻**按当时的 activeVersion 定型，
 * 之后再切版本也改不动已经落定的格子。所以这一步必须发生在任何回放/实时字节写进终端**之前**，
 * 否则先写进去的宽字符已经按错误宽度串行了。调用点把它放在 `terminal.open()` 之后、
 * 首个 replay write 之前。
 *
 * 返回**真正生效**的版本号（读回 `terminal.unicode.activeVersion`，不是回显传入的常量），
 * 让调用点在写字节前据此判断是否降级：激活成功返回 '11'，失败则返回宿主当前的版本（通常 '6'）。
 *
 * 失败**绝不抛**（工程原则 11：我们自己的流程步骤不许拖垮一个健康的终端）。这一步在 attach
 * 的同步建立段里、`terminal.open()` 之后执行，若在此 throw 会把它下面的链接 provider、WebGL、
 * attach 全部掐断，让一个本可正常工作的终端因为一个装饰性能力失败而变黑。所以吞掉异常、
 * 退回当前版本，把"要不要提示降级"这个决定交给调用点的返回值，而不是在这里阻断。
 */
export function activateTerminalUnicodeWidth(terminal: Terminal): string {
  try {
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = UNICODE_WIDTH_VERSION
  } catch (error) {
    console.warn('[terminal] Unicode width table activation failed; keeping the host default', error)
  }
  return terminal.unicode.activeVersion
}

