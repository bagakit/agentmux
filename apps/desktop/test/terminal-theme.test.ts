import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_THEME
} from '../src/renderer/src/lib/terminal-theme.js'

describe('default terminal appearance', () => {
  it('keeps a complete AgentMux verdant palette at one renderer-owned boundary', () => {
    expect(DEFAULT_TERMINAL_THEME).toEqual({
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
    })
  })

  it('matches the proven rendering defaults while retaining AgentMux font size', () => {
    expect(DEFAULT_TERMINAL_APPEARANCE).toMatchObject({
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontSize: 12,
      fontWeight: '300',
      fontWeightBold: '500',
      lineHeight: 1.2,
      allowTransparency: false,
      minimumContrastRatio: 3,
      drawBoldTextInBrightColors: true,
      theme: DEFAULT_TERMINAL_THEME
    })
  })
})
