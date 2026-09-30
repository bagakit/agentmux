import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { terminalPathLinkAtBufferCell, terminalPathLinksInBuffer } from '../src/renderer/src/lib/terminal-link-range'

const terminals: Terminal[] = []
async function parsed(text: string, cols = 80, rows = 8) {
  const terminal = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'; terminals.push(terminal)
  await new Promise<void>(resolve => terminal.write(text, resolve))
  return terminal
}
afterEach(() => { for (const terminal of terminals) terminal.dispose(); terminals.length = 0 })

describe('published xterm buffer to file-link cell ranges', () => {
  for (const [prefix, start] of [['See ', 5], ['说明 ', 6], ['😀 ', 4], ['e\u0301 ', 3], ['a😀说明e\u0301 ', 10]] as const) {
    it(`maps the actual Unicode 11 cells after ${JSON.stringify(prefix)}, not UTF-16 offsets`, async () => {
      const terminal = await parsed(prefix + '@src/example.ts:3:2, next')
      const links = terminalPathLinksInBuffer(terminal.buffer.active, 1, '/repo')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ link: { path: 'src/example.ts', line: 3, column: 2 }, range: { start: { x: start + 1, y: 1 }, end: { x: start + 18, y: 1 } } })
      expect(terminalPathLinkAtBufferCell(terminal.buffer.active, start, 1, '/repo')).toBeNull()
      expect(terminalPathLinkAtBufferCell(terminal.buffer.active, start + 1, 1, '/repo')?.path).toBe('src/example.ts')
      expect(terminalPathLinkAtBufferCell(terminal.buffer.active, start + 19, 1, '/repo')).toBeNull()
    })
  }
  it('returns the same complete path and inclusive multi-row range from either soft-wrapped row', async () => {
    const terminal = await parsed('说明 src/example.ts:3:2,', 12)
    const first = terminalPathLinksInBuffer(terminal.buffer.active, 1, '/repo')
    const second = terminalPathLinksInBuffer(terminal.buffer.active, 2, '/repo')
    expect(first).toHaveLength(1); expect(second).toEqual(first)
    expect(first[0]).toMatchObject({ link: { path: 'src/example.ts', line: 3, column: 2 }, range: { start: { x: 6, y: 1 }, end: { x: 11, y: 2 } } })
    expect(terminalPathLinkAtBufferCell(terminal.buffer.active, 4, 2, '/repo')?.path).toBe('src/example.ts')
  })
  it('preserves literal spaces at wrap boundaries and does not join separate paths or null padding into a fake path', async () => {
    const terminal = await parsed('src/a.ts    src/b.ts', 12)
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 1, '/repo').map(item => item.link.path)).toEqual(['src/a.ts'])
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 2, '/repo').map(item => item.link.path)).toEqual(['src/b.ts'])
    const separate = await parsed('src/a.ts\r\nb.ts')
    expect(terminalPathLinksInBuffer(separate.buffer.active, 1, '/repo').map(item => item.link.path)).toEqual(['src/a.ts'])
    expect(terminalPathLinksInBuffer(separate.buffer.active, 2, '/repo')).toEqual([])
  })
  it('removes the actual early-wide-character padding while keeping the next cell coordinates correct', async () => {
    const terminal = await parsed('1234567说明 src/x.ts', 8)
    const links = terminalPathLinksInBuffer(terminal.buffer.active, 3, '/repo')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ link: { path: 'src/x.ts' }, range: { start: { x: 6, y: 2 }, end: { x: 5, y: 3 } } })
  })
  it('does not glue paths across a wrapped row whose tail was erased into null cells', async () => {
    const terminal = await parsed('src/a.tsXXXXsrc/b.ts\x1b[1;9H\x1b[K', 12)
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 1, '/repo').map(item => item.link.path)).toEqual(['src/a.ts'])
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 2, '/repo').map(item => item.link.path)).toEqual(['src/b.ts'])
  })
  it('uses the actual buffer row after scrollback, with no work amplification from unrelated history', async () => {
    const reads: Array<{ history: number; lines: number; cells: number; links: number }> = []
    for (const history of [2, 900]) {
      const terminal = await parsed('unrelated\r\n'.repeat(history) + '说明 src/example.ts:3:2', 12)
      const buffer = terminal.buffer.active, y = buffer.baseY + buffer.cursorY + 1
      let lines = 0, cells = 0
      const counted = { getNullCell: () => buffer.getNullCell(), getLine(index: number) {
        lines++
        const line = buffer.getLine(index)
        return line ? { isWrapped: line.isWrapped, length: line.length, translateToString: line.translateToString.bind(line), getCell(x: number, cell?: ReturnType<typeof buffer.getNullCell>) { cells++; return line.getCell(x, cell) } } : undefined
      } }
      const links = terminalPathLinksInBuffer(counted, y, '/repo')
      expect(links).toHaveLength(1); expect(links[0]!.range.end.y).toBe(y)
      reads.push({ history, lines, cells, links: links.length })
    }
    expect(reads).toHaveLength(2)
    expect(reads[1]!.lines).toBe(reads[0]!.lines); expect(reads[1]!.cells).toBe(reads[0]!.cells)
    expect(reads[0]!.cells).toBeGreaterThan(0); expect(reads[0]!.cells).toBeLessThanOrEqual(4096)
    expect(reads[0]!.lines).toBeLessThanOrEqual(34)
  })
  it('bounds pathological wrapped output and refuses clipped partial path tokens', async () => {
    // 32 rows here are shorter than the scanner's token cap, so only the window fences reject truncation.
    const terminal = await parsed('src/' + 'a'.repeat(6000) + '/tail.ts', 4)
    const buffer = terminal.buffer.active
    for (const y of [1, buffer.baseY + buffer.cursorY + 1]) {
      let cells = 0, lines = 0
      const counted = { getNullCell: () => buffer.getNullCell(), getLine(index: number) {
        lines++; const line = buffer.getLine(index)
        return line ? { isWrapped: line.isWrapped, length: line.length, translateToString: line.translateToString.bind(line), getCell(x: number, cell?: ReturnType<typeof buffer.getNullCell>) { cells++; return line.getCell(x, cell) } } : undefined
      } }
      expect(terminalPathLinksInBuffer(counted, y, '/repo')).toEqual([])
      expect(cells).toBeGreaterThan(0); expect(cells).toBeLessThanOrEqual(4096)
      expect(lines).toBeLessThanOrEqual(34)
    }
  })
})
