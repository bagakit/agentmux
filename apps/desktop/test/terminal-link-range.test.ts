import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { terminalLinkAtCell, terminalLinksAtRow, terminalLinksInBuffer } from '../src/renderer/src/lib/terminal-link-range'
import { resolveTerminalLinkPath, terminalLocalWorkspaceIndex } from '../src/renderer/src/lib/terminal-link-target'

const terminals: Terminal[] = []
async function parsed(text: string, cols = 80, rows = 8) {
  const terminal = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'; terminals.push(terminal)
  await new Promise<void>(resolve => terminal.write(text, resolve))
  return terminal
}
afterEach(() => { for (const terminal of terminals) terminal.dispose(); terminals.length = 0 })

type Buffer = Parameters<typeof terminalLinksInBuffer>[0]
function terminalPathLinksInBuffer(buffer: Buffer, y: number, workspaceRoot: string) {
  return terminalLinksInBuffer(buffer, y, { workspaceRoot }).flatMap(({ target, range }) =>
    target.kind === 'file' ? [{ link: target.file, range }] : [])
}
function terminalPathLinkAtBufferCell(buffer: Buffer, x: number, y: number, workspaceRoot: string) {
  const target = terminalLinkAtCell(terminalLinksInBuffer(buffer, y, { workspaceRoot }), x, y)
  return target?.kind === 'file' ? target.file : null
}

describe('published xterm buffer to file-link cell ranges', () => {
  it('requires one local owner for a foreign absolute path and keeps relative paths in the source Workspace', () => {
    const workspaceRoot = _hygiene_fixturePath('terminal-source')
    const owner = { id: 'report', hostId: 'local', path: _hygiene_fixturePath('registered-report') }
    const candidate = owner.path + '/reports/result.md'
    const scope = (workspaces: typeof owner[]) => ({ workspaceRoot, registeredWorkspaces: terminalLocalWorkspaceIndex(workspaces) })
    expect(resolveTerminalLinkPath(candidate, scope([owner]))).toEqual({ path: 'reports/result.md', workspace: { id: owner.id, path: owner.path } })
    expect(resolveTerminalLinkPath('reports/result.md', scope([owner]))).toEqual({ path: 'reports/result.md' })
    expect(resolveTerminalLinkPath(candidate, scope([{ ...owner, hostId: 'remote' }]))).toBeNull()
    expect(resolveTerminalLinkPath(candidate, scope([owner, { ...owner, id: 'same-root' }]))).toBeNull()
    expect(resolveTerminalLinkPath(candidate, scope([owner, { ...owner, id: 'nested', path: owner.path + '/reports' }]))).toBeNull()
    expect(resolveTerminalLinkPath(owner.path + '/reports/../result.md', scope([owner]))).toBeNull()
  })

  for (const [prefix, start] of [['See ', 5], ['说明 ', 6], ['😀 ', 4], ['e\u0301 ', 3], ['a😀说明e\u0301 ', 10]] as const) {
    it(`maps the actual Unicode 11 cells after ${JSON.stringify(prefix)}, not UTF-16 offsets`, async () => {
      const terminal = await parsed(prefix + '@src/example.ts:3:2, next')
      const links = terminalPathLinksInBuffer(terminal.buffer.active, 1, _hygiene_fixturePath("repo"))
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ link: { path: 'src/example.ts', line: 3, column: 2 }, range: { start: { x: start + 1, y: 1 }, end: { x: start + 18, y: 1 } } })
      expect(terminalPathLinkAtBufferCell(terminal.buffer.active, start, 1, _hygiene_fixturePath("repo"))).toBeNull()
      expect(terminalPathLinkAtBufferCell(terminal.buffer.active, start + 1, 1, _hygiene_fixturePath("repo"))?.path).toBe('src/example.ts')
      expect(terminalPathLinkAtBufferCell(terminal.buffer.active, start + 19, 1, _hygiene_fixturePath("repo"))).toBeNull()
    })
  }
  it('returns the same complete path and inclusive multi-row range from either soft-wrapped row', async () => {
    const terminal = await parsed('说明 src/example.ts:3:2,', 12)
    const first = terminalPathLinksInBuffer(terminal.buffer.active, 1, _hygiene_fixturePath("repo"))
    const second = terminalPathLinksInBuffer(terminal.buffer.active, 2, _hygiene_fixturePath("repo"))
    expect(first).toHaveLength(1); expect(second).toEqual(first)
    expect(first[0]).toMatchObject({ link: { path: 'src/example.ts', line: 3, column: 2 }, range: { start: { x: 6, y: 1 }, end: { x: 11, y: 2 } } })
    expect(terminalPathLinkAtBufferCell(terminal.buffer.active, 4, 2, _hygiene_fixturePath("repo"))?.path).toBe('src/example.ts')
  })
  it('preserves literal spaces at wrap boundaries and does not join separate paths or null padding into a fake path', async () => {
    const terminal = await parsed('src/a.ts    src/b.ts', 12)
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 1, _hygiene_fixturePath("repo")).map(item => item.link.path)).toEqual(['src/a.ts'])
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 2, _hygiene_fixturePath("repo")).map(item => item.link.path)).toEqual(['src/b.ts'])
    const separate = await parsed('src/a.ts\r\nb.ts')
    expect(terminalPathLinksInBuffer(separate.buffer.active, 1, _hygiene_fixturePath("repo")).map(item => item.link.path)).toEqual(['src/a.ts'])
    expect(terminalPathLinksInBuffer(separate.buffer.active, 2, _hygiene_fixturePath("repo"))).toEqual([])
  })
  it('preserves an independent following path after wide-character padding', async () => {
    const terminal = await parsed('1234567说明 src/x.ts', 8)
    const links = terminalPathLinksInBuffer(terminal.buffer.active, 3, _hygiene_fixturePath("repo"))
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ link: { path: 'src/x.ts' }, range: { start: { x: 6, y: 2 }, end: { x: 5, y: 3 } } })
  })
  it('does not open joined or split paths when a wrapped row tail was erased into null cells', async () => {
    const terminal = await parsed('src/a.tsXXXXsrc/b.ts\x1b[1;9H\x1b[K', 12)
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 1, _hygiene_fixturePath("repo"))).toEqual([])
    expect(terminalPathLinksInBuffer(terminal.buffer.active, 2, _hygiene_fixturePath("repo"))).toEqual([])
  })
  it('keeps exact targets when the expanded or erased row contains a written boundary', async () => {
    for (const text of ['src/a.ts XXXXsrc/b.ts\x1b[1;10H\x1b[K', 'src/a.tsXXXXX src/b.ts\x1b[1;9H\x1b[K']) {
      const terminal = await parsed(text, 13)
      const paths = [1, 2].flatMap(y => terminalPathLinksInBuffer(terminal.buffer.active, y, _hygiene_fixturePath('repo')))
      expect(paths.map(item => item.link.path)).toEqual(['src/a.ts', 'src/b.ts'])
    }
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
      const links = terminalPathLinksInBuffer(counted, y, _hygiene_fixturePath("repo"))
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
      expect(terminalPathLinksInBuffer(counted, y, _hygiene_fixturePath("repo"))).toEqual([])
      expect(cells).toBeGreaterThan(0); expect(cells).toBeLessThanOrEqual(4096)
      expect(lines).toBeLessThanOrEqual(34)
    }
  })
})


describe('terminal links use complete original targets', () => {
  const root = '/home/source/repo'
  const osc = (uri: string, label: string) => '\x1b]8;;' + uri + '\x07' + label + '\x1b]8;;\x07'

  it('preserves provable neighbors and declines both file URI fragments after identical growth and VT erase', async () => {
    const scope = { workspaceRoot: root }
    const lead = 'src/before.ts 详见file://' + root + '/nested/'
    const directoryTail = 'x'.repeat(80 - lead.length - 2)
    const first = lead + directoryTail, second = 'suffix/src/%E5%AE%9E%E9%AA%8C.ts'
    const url = 'https://example.test/exact'
    const right = second + ' src/after.ts ' + osc(url, 'A')
    const unchanged = await parsed(first + right, 80)
    const target = `nested/${directoryTail}suffix/src/实验.ts`
    expect(terminalLinkAtCell(terminalLinksAtRow(unchanged, 1, scope), 70, 1)).toMatchObject({ file: { path: target } })
    expect(terminalLinkAtCell(terminalLinksAtRow(unchanged, 2, scope), 1, 2)).toMatchObject({ file: { path: target } })

    unchanged.resize(94, 8)
    const erased = await parsed(first + 'X'.repeat(14) + right + '\x1b7\x1b[1;81H\x1b[K\x1b8', 94)
    const cells = (terminal: Terminal) => [0, 1].map(y => {
      const row = terminal.buffer.active.getLine(y)!
      return { wrapped: row.isWrapped, cells: Array.from({ length: row.length }, (_, x) => {
        const cell = row.getCell(x)!
        return [cell.getChars(), cell.getWidth(), cell.getCode(), cell.getFgColor(), cell.getBgColor()]
      }) }
    })
    expect(cells(unchanged)).toEqual(cells(erased))
    expect(unchanged.buffer.active.getLine(1)?.isWrapped).toBe(true)
    expect(unchanged.buffer.active.getLine(0)?.getCell(79)?.getChars()).toBe('x')
    expect(unchanged.buffer.active.getLine(0)?.getCell(80)?.getChars()).toBe('')
    for (const terminal of [unchanged, erased]) {
      const left = terminalLinksAtRow(terminal, 1, scope), right = terminalLinksAtRow(terminal, 2, scope)
      expect(left.map(link => link.target)).toEqual([expect.objectContaining({ file: expect.objectContaining({ path: 'src/before.ts' }) })])
      expect(right.map(link => link.target)).toEqual([
        { kind: 'http', url }, expect.objectContaining({ file: expect.objectContaining({ path: 'src/after.ts' }) })
      ])
      expect(terminalLinkAtCell(left, 70, 1)).toBeNull()
      expect(terminalLinkAtCell(right, 1, 2)).toBeNull()
    }
  })

  it('does not use an erased wide-wrap-shaped cell as padding and join a target', async () => {
    const terminal = await parsed('src/good.tX测试.ts\x1b[1;11H\x1b[K', 11)
    expect(terminal.buffer.active.getLine(1)?.getCell(0)?.getWidth()).toBe(2)
    expect(terminalLinksAtRow(terminal, 1, { workspaceRoot: root })).toEqual([])
  })

  it('recovers a one-cell OSC link at the end of a row, including adjacent declarations', async () => {
    const file = 'file:///home/source/repo/src/%E4%B8%AD%20%3A42'
    const terminal = await parsed(osc('https://example.test/first', 'A') + osc(file, 'B'))
    const links = terminalLinksAtRow(terminal, 1, { workspaceRoot: root })
    expect(links.map(link => link.range)).toEqual([
      { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
      { start: { x: 2, y: 1 }, end: { x: 2, y: 1 } }
    ])
    expect(terminalLinkAtCell(links, 2, 1)).toEqual({
      kind: 'file', file: { index: 0, length: file.length, path: 'src/中 :42' }
    })
  })

  it('uses identical complete Unicode and quoted targets from each row of a wrapped token', async () => {
    const terminal = await parsed('"src/(区)/[id]/cafe\u0301 🖼️ 预览.ts":12:3', 13)
    const scope = { workspaceRoot: root }
    const expected = terminalLinksAtRow(terminal, 1, scope)
    expect(expected).toHaveLength(1)
    expect(expected[0]).toMatchObject({ target: { kind: 'file', file: {
      path: 'src/(区)/[id]/cafe\u0301 🖼️ 预览.ts', line: 12, column: 3
    } } })
    expect(expected[0]!.range.start).toEqual({ x: 1, y: 1 })
    expect(expected[0]!.range.end.y).toBeGreaterThan(1)
    for (let row = 2; row <= expected[0]!.range.end.y; row++) expect(terminalLinksAtRow(terminal, row, scope)).toEqual(expected)
  })

  it('never uses a file-shaped label or URL query as a substitute for the target', async () => {
    const terminal = await parsed(osc('https://example.test/original', 'src/wrong.ts') +
      ' https://example.test/?src=nested/wrong.ts file:///home/source/repo/src/right.ts', 80)
    const links = [1, 2].flatMap(row => terminalLinksAtRow(terminal, row, { workspaceRoot: root }))
    const paths = links.flatMap(({ target }) => target.kind === 'file' ? [target.file.path] : [])
    expect(paths).toContain('src/right.ts')
    expect(paths.every(path => path === 'src/right.ts')).toBe(true)
  })

  it('uses the confirmed local home and never invents it for another host', async () => {
    const terminal = await parsed('~/repo/src/预览.ts')
    expect(terminalLinksAtRow(terminal, 1, { workspaceRoot: root })).toEqual([])
    expect(terminalLinksAtRow(terminal, 1, { workspaceRoot: root, homeDir: '/home/source' })[0])
      .toMatchObject({ target: { kind: 'file', file: { path: 'src/预览.ts' } } })
  })

  it('refuses a clipped URL on every hovered row instead of opening a shorter address', async () => {
    const terminal = await parsed('https://example.test/' + 'x'.repeat(4000) + '/right', 60, 100)
    for (const row of [1, 2, 31, 66]) expect(terminalLinksAtRow(terminal, row, { workspaceRoot: root })).toEqual([])
  })
})
