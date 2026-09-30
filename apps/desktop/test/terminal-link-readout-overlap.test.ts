import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { terminalLinkReadoutOverlapsText } from '../src/renderer/src/lib/terminal-link-readout'

const terminals: Terminal[] = []
async function parsed(text: string, rows = 4) {
  const terminal = new Terminal({ cols: 8, rows, scrollback: 10000, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'; terminals.push(terminal)
  await new Promise<void>(resolve => terminal.write(text, resolve))
  return terminal
}
afterEach(() => { for (const terminal of terminals) terminal.dispose(); terminals.length = 0 })
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height })
const screen = rect(40, 30, 80, 80)
const overlaps = (terminal: Terminal, popup: ReturnType<typeof rect>) => terminalLinkReadoutOverlapsText(terminal.buffer.active, terminal.cols, terminal.rows, screen, popup)

describe('passive readout versus actual published xterm cells', () => {
  it('permits genuine blank visible cells and ignores unrelated text outside the popup rectangle', async () => {
    const terminal = await parsed('visible')
    expect(terminal.buffer.active.getLine(0)!.getCell(0)!.getChars()).toBe('v')
    expect(overlaps(terminal, rect(40, 90, 50, 20))).toBe(false)
    expect(overlaps(terminal, rect(40, 30, 50, 20))).toBe(true)
    expect(overlaps(terminal, rect(0, 30, 40, 20))).toBe(false)
  })
  it('finds a width-2 owner when the popup covers only its width-0 continuation cell', async () => {
    const terminal = await parsed('  说明')
    expect(terminal.buffer.active.getLine(0)!.getCell(2)!.getWidth()).toBe(2)
    expect(terminal.buffer.active.getLine(0)!.getCell(3)!.getWidth()).toBe(0)
    expect(overlaps(terminal, rect(71, 31, 8, 18))).toBe(true)
    expect(overlaps(terminal, rect(40, 31, 19, 18))).toBe(false)
  })
  it('uses the real combined glyph and exact rectangle boundaries without assigning UTF-16 widths', async () => {
    const terminal = await parsed('e\u0301')
    expect(terminal.buffer.active.getLine(0)!.getCell(0)!.getChars()).toBe('e\u0301')
    expect(overlaps(terminal, rect(49, 31, 1, 18))).toBe(true)
    expect(overlaps(terminal, rect(50, 31, 10, 18))).toBe(false)
  })
  it('checks the actual scrolled viewport and only the popup-related cells independent of history size', async () => {
    const reads: Array<{ history: number; lines: number[]; cells: number }> = []
    for (const history of [2, 900]) {
      const terminal = await parsed('unrelated\r\n'.repeat(history) + 'last\r\n')
      const buffer = terminal.buffer.active, lines: number[] = []; let cells = 0
      const counted = { viewportY: buffer.viewportY, getNullCell: () => buffer.getNullCell(), getLine(y: number) {
        lines.push(y); const line = buffer.getLine(y)
        return line ? { length: line.length, isWrapped: line.isWrapped, translateToString: line.translateToString.bind(line), getCell(x: number, scratch?: ReturnType<typeof buffer.getNullCell>) { cells++; return line.getCell(x, scratch) } } : undefined
      } }
      expect(terminalLinkReadoutOverlapsText(counted, 8, 4, screen, rect(61, 91, 8, 18))).toBe(false)
      expect(lines).toEqual([buffer.viewportY + 3]); expect(cells).toBe(2)
      reads.push({ history, lines, cells })
    }
    expect(reads).toHaveLength(2)
    expect(reads[0]!.cells).toBe(reads[1]!.cells)
  })
  it('does not call a missing or unmeasurable screen blank', async () => {
    const terminal = await parsed('text')
    expect(terminalLinkReadoutOverlapsText(terminal.buffer.active, 8, 4, rect(0, 0, 0, 80), rect(0, 0, 20, 20))).toBe(true)
  })
})
