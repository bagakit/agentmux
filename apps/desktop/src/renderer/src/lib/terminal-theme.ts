import type { ITheme, ITerminalOptions } from '@xterm/xterm'
import type { TerminalThemeId } from '../../../shared/contracts'
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
  fontSize: 12,
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

export function terminalOptions(themeId: TerminalThemeId): Partial<ITerminalOptions> {
  return { ...TERMINAL_BASE_OPTIONS, theme: terminalTheme(themeId) }
}
