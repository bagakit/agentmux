import { readResolvedTheme, resolveTheme, workspaceTerminalPalette, type ResolvedTheme } from '@agentmux/client-ui/theme'
import type { ITheme, ITerminalOptions } from '@xterm/xterm'
export { activateTerminalUnicodeWidth, UNICODE_WIDTH_VERSION } from '@agentmux/client-ui/terminal/unicode'
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
    id: 'workspace', label: 'Workspace theme', description: 'Follow this window’s theme and brightness · semantic ANSI colors',
    get theme() { return workspaceTerminalPalette(typeof window === 'undefined' ? resolveTheme() : readResolvedTheme()) }
  },
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
  },
  { id: 'dracula', label: 'Dracula', description: 'Classic · violet and vivid ANSI', theme: terminalPalette('dracula') },
  { id: 'nord', label: 'Nord', description: 'Arctic · cool slate and restrained ANSI', theme: terminalPalette('nord') },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark', description: 'Medium dark · warm earth tones', theme: terminalPalette('gruvbox-dark') },
  { id: 'solarized-dark', label: 'Solarized Dark', description: 'Deep teal · balanced original ANSI', theme: terminalPalette('solarized-dark') },
  { id: 'solarized-light', label: 'Solarized Light', description: 'Warm paper · balanced original ANSI', theme: terminalPalette('solarized-light') }
])

export function terminalTheme(themeId: TerminalThemeId, workspace?: ResolvedTheme): Readonly<ITheme> {
  if (themeId === 'workspace') return workspaceTerminalPalette(workspace ?? readResolvedTheme())
  const definition = TERMINAL_THEME_CATALOG.find((candidate) => candidate.id === themeId)
  if (!definition) throw new Error(`Unknown terminal theme: ${String(themeId)}`)
  return definition.theme
}

const TERMINAL_BASE_OPTIONS = Object.freeze({
  allowProposedApi: true,
  scrollOnUserInput: false,
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

