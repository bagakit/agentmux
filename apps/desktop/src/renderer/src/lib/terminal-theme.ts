import type { ITheme, ITerminalOptions } from '@xterm/xterm'

// App chrome owns product surfaces, xterm owns terminal appearance, and the
// PTY/CtxMux path owns bytes only. Keep those three concerns independent.
export const DEFAULT_TERMINAL_THEME = Object.freeze({
  background: '#1e2522',
  foreground: '#edf3ef',
  cursor: '#a8f0c6',
  cursorAccent: '#1e2522',
  selectionBackground: '#426b55',
  selectionForeground: '#f4fff7',
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
}) satisfies ITheme

export const DEFAULT_TERMINAL_APPEARANCE = Object.freeze({
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
  drawBoldTextInBrightColors: true,
  theme: DEFAULT_TERMINAL_THEME
}) satisfies Partial<ITerminalOptions>
