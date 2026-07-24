import type { ITheme, ITerminalOptions } from '@xterm/xterm'
import type { TerminalThemeId } from '../../../shared/contracts'

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
    theme: Object.freeze({
      background: '#282c34',
      foreground: '#ffffff',
      cursor: '#ffffff',
      cursorAccent: '#282c34',
      selectionBackground: '#5a7898',
      selectionForeground: '#ffffff',
      black: '#1d1f21',
      red: '#cc6666',
      green: '#b5bd68',
      yellow: '#f0c674',
      blue: '#81a2be',
      magenta: '#b294bb',
      cyan: '#8abeb7',
      white: '#c5c8c6',
      brightBlack: '#666666',
      brightRed: '#d54e53',
      brightGreen: '#b9ca4a',
      brightYellow: '#e7c547',
      brightBlue: '#7aa6da',
      brightMagenta: '#c397d8',
      brightCyan: '#70c0b1',
      brightWhite: '#eaeaea'
    })
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Softer contrast · warmer accents',
    theme: Object.freeze({
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b70',
      selectionForeground: '#cdd6f4',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    })
  }
])

export function terminalTheme(themeId: TerminalThemeId): Readonly<ITheme> {
  const definition = TERMINAL_THEME_CATALOG.find((candidate) => candidate.id === themeId)
  if (!definition) throw new Error(`Unknown terminal theme: ${String(themeId)}`)
  return definition.theme
}

const TERMINAL_BASE_OPTIONS = Object.freeze({
  cursorBlink: true,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace',
  fontSize: 12,
  fontWeight: '300',
  fontWeightBold: '500',
  lineHeight: 1.2,
  allowTransparency: false,
  minimumContrastRatio: 3,
  drawBoldTextInBrightColors: true
}) satisfies Partial<ITerminalOptions>

export function terminalOptions(themeId: TerminalThemeId): Partial<ITerminalOptions> {
  return { ...TERMINAL_BASE_OPTIONS, theme: terminalTheme(themeId) }
}
