import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { terminalTheme } from '../src/renderer/src/lib/terminal-theme.js'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('terminal indexed color rendering', () => {
  it('keeps Claude-style 256-color foreground and background cells distinct', async () => {
    const theme = terminalTheme('graphite')
    expect(theme.extendedAnsi?.[208 - 16]).toBe('#ff8700')
    expect(theme.extendedAnsi?.[148 - 16]).toBe('#afd700')
    const terminal = new Terminal({ cols: 4, rows: 1, allowProposedApi: true, theme })
    try {
      await write(terminal, '\u001b[38;5;208mA\u001b[48;5;148mB')
      const line = terminal.buffer.active.getLine(0)
      const foreground = line?.getCell(0)
      const background = line?.getCell(1)
      expect(foreground?.getFgColorMode()).toBe(33554432)
      expect(foreground?.getFgColor()).toBe(208)
      expect(background?.getBgColorMode()).toBe(33554432)
      expect(background?.getBgColor()).toBe(148)
    } finally {
      terminal.dispose()
    }
  })
})
