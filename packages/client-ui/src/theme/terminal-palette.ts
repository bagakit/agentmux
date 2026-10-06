import type { ResolvedTheme } from './catalog.js'

export type TerminalPalette = Readonly<{
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
  /** The 240 indexed ANSI colors (16–255), supplied explicitly to xterm. */
  // xterm's ITheme type is mutable, but the shared palette is frozen at construction.
  extendedAnsi: string[]
}>

function xtermExtendedAnsiPalette(): string[] {
  const colors: string[] = []
  const levels = [0, 95, 135, 175, 215, 255]
  for (const red of levels) {
    for (const green of levels) {
      for (const blue of levels) {
        colors.push('#' + red.toString(16).padStart(2, '0') + green.toString(16).padStart(2, '0') + blue.toString(16).padStart(2, '0'))
      }
    }
  }
  for (let gray = 8; gray <= 238; gray += 10) {
    colors.push('#' + gray.toString(16).padStart(2, '0').repeat(3))
  }
  return Object.freeze(colors) as unknown as string[]
}

export const TERMINAL_EXTENDED_ANSI = xtermExtendedAnsiPalette()


/** ANSI roles derive from the user's complete theme; no separately persisted color table. */
export function workspaceTerminalPalette(theme: Pick<ResolvedTheme, 'mode' | 'variant'>): TerminalPalette {
  const c = theme.variant.colors
  return {
    background: c.surface0, foreground: c.text, cursor: c.action, cursorAccent: c.surface0,
    selectionBackground: c.surface3, selectionForeground: c.text,
    black: theme.mode === 'light' ? c.text : c.textSubtle,
    red: c.danger, green: c.success, yellow: c.warning, blue: c.info, magenta: c.special, cyan: c.action,
    white: c.textMuted,
    brightBlack: c.textSubtle, brightRed: c.danger, brightGreen: c.actionHover, brightYellow: c.warning,
    brightBlue: c.info, brightMagenta: c.special, brightCyan: c.action,
    brightWhite: c.text,
    extendedAnsi: TERMINAL_EXTENDED_ANSI
  }
}
