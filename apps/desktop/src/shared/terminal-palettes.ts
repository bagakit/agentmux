import type { TerminalThemeId } from './contracts.js'

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

const EXTENDED_ANSI = xtermExtendedAnsiPalette()

// Keep a proven ANSI role palette, but use a true-black terminal work area
// so Codex's own gray composer and message surfaces remain visibly distinct.
// The main process also uses these foreground/background values to answer a
// Run's OSC 10/11 color queries while no Renderer is attached.
const TERMINAL_PALETTES: Readonly<Record<TerminalThemeId, TerminalPalette>> = Object.freeze({
  graphite: Object.freeze({
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#000000',
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
    brightWhite: '#eaeaea',
    extendedAnsi: EXTENDED_ANSI
  }),
  'catppuccin-mocha': Object.freeze({
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
    brightWhite: '#a6adc8',
    extendedAnsi: EXTENDED_ANSI
  })
})

export function terminalPalette(themeId: TerminalThemeId): TerminalPalette {
  const palette = TERMINAL_PALETTES[themeId]
  if (!palette) throw new Error(`Unknown terminal theme: ${String(themeId)}`)
  return palette
}
