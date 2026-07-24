import { describe, expect, it } from 'vitest'
import {
  TERMINAL_THEME_CATALOG,
  terminalOptions,
  terminalTheme
} from '../src/renderer/src/lib/terminal-theme.js'

describe('terminal appearance', () => {
  it('keeps Graphite aligned with the proven Ghostty dark semantic palette', () => {
    expect(terminalTheme('graphite')).toEqual({
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
  })

  it('does not collapse the default TUI composer color into the work area', () => {
    const theme = terminalTheme('graphite')
    expect(theme.black).toBe('#1d1f21')
    expect(theme.black).not.toBe(theme.background)
  })

  it('offers only complete curated palettes', () => {
    expect(TERMINAL_THEME_CATALOG.map((item) => item.id)).toEqual([
      'graphite',
      'catppuccin-mocha'
    ])
    for (const { theme } of TERMINAL_THEME_CATALOG) {
      expect(Object.keys(theme)).toHaveLength(22)
      expect(theme.black).not.toBe(theme.background)
    }
  })

  it('keeps renderer behavior stable while selecting a palette', () => {
    expect(terminalOptions('catppuccin-mocha')).toMatchObject({
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontSize: 12,
      fontWeight: '300',
      fontWeightBold: '500',
      lineHeight: 1.2,
      allowTransparency: false,
      minimumContrastRatio: 3,
      drawBoldTextInBrightColors: true,
      theme: terminalTheme('catppuccin-mocha')
    })
  })
})
