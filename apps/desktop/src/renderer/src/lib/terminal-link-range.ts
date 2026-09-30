import type { IBuffer, IBufferCell, IBufferLine, IBufferRange } from '@xterm/xterm'
import { detectTerminalPathLinks, type TerminalPathLink } from './terminal-path-link'

// One hover window, independent of scrollback size. This also bounds combined-cell text.
const TERMINAL_LINK_WINDOW_CELLS = 4096
const TERMINAL_LINK_WINDOW_ROWS = 32
type Buffer = Pick<IBuffer, 'getLine' | 'getNullCell'>
type Cell = { chars: string; x: number; width: number }
type Row = { y: number; line: IBufferLine; cells: Cell[]; clipped: boolean }
export type TerminalBufferPathLink = { link: TerminalPathLink; range: IBufferRange }

export function terminalPathLinksInBuffer(buffer: Buffer, y: number, workspaceRoot: string): TerminalBufferPathLink[] {
  if (!Number.isInteger(y) || y < 1) return []
  const current = buffer.getLine(y - 1)
  if (!current) return []
  const scratch = buffer.getNullCell()
  let remaining = TERMINAL_LINK_WINDOW_CELLS
  let textRemaining = TERMINAL_LINK_WINDOW_CELLS
  function readRow(line: IBufferLine, row: number): Row {
    const cells: Cell[] = []
    let column = 0
    for (; column < line.length && remaining > 0; column++) {
      remaining--
      const cell: IBufferCell | undefined = line.getCell(column, scratch)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars()
      const length = chars.length || 1
      if (length > textRemaining) break
      textRemaining -= length
      cells.push({ chars, x: column + 1, width: cell.getWidth() })
    }
    return { y: row, line, cells, clipped: column < line.length }
  }
  const rows = [readRow(current, y)]
  while (rows[0]!.line.isWrapped && rows.length < TERMINAL_LINK_WINDOW_ROWS) {
    const previous = buffer.getLine(rows[0]!.y - 2)
    if (!previous || previous.length > remaining) break
    const row = readRow(previous, rows[0]!.y - 1)
    // A clipped previous row cannot be concatenated as though it contained its missing tail.
    if (row.clipped) break
    rows.unshift(row)
    if (row.cells.some(cell => /\s/.test(cell.chars))) break
  }
  let next = buffer.getLine(y)
  while (!rows.at(-1)!.clipped && next?.isWrapped && rows.length < TERMINAL_LINK_WINDOW_ROWS && next.length <= remaining) {
    const row = readRow(next, rows.at(-1)!.y + 1)
    rows.push(row)
    next = buffer.getLine(row.y)
    if (row.clipped || row.cells.some(cell => /\s/.test(cell.chars))) break
  }
  const leftIncomplete = rows[0]!.line.isWrapped
  const rightIncomplete = rows.at(-1)!.clipped || next?.isWrapped === true
  let text = ''
  const positions: Array<{ from: number; to: number; start: { x: number; y: number }; end: { x: number; y: number } }> = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!, following = rows[index + 1]
    const continues = following?.line.isWrapped ?? next?.isWrapped ?? false
    // Keep blank cells within a wrapped line: erasing its tail must not glue two path tokens.
    // The one layout-only gap is xterm's last-column padding before an early-wrapped wide cell.
    if (continues) {
      if (following?.cells[0]?.width === 2 && row.cells.at(-1)?.x === row.line.length && row.cells.at(-1)?.chars === '') row.cells.pop()
    } else {
      while (row.cells.at(-1)?.chars === '') row.cells.pop()
    }
    for (const cell of row.cells) {
      const from = text.length
      text += cell.chars || ' '
      positions.push({ from, to: text.length, start: { x: cell.x, y: row.y }, end: { x: cell.x + cell.width - 1, y: row.y } })
    }
  }
  const firstBoundary = text.search(/\s/)
  const lastBoundary = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\t'))
  const result: TerminalBufferPathLink[] = []
  for (const link of detectTerminalPathLinks(text, workspaceRoot)) {
    // Only complete tokens in the bounded window: do not invent a path from a clipped token.
    if (leftIncomplete && (firstBoundary < 0 || link.index < firstBoundary)) continue
    if (rightIncomplete && link.index + link.length > lastBoundary) continue
    const start = positions.find(cell => cell.to > link.index)?.start
    const end = positions.find(cell => cell.to >= link.index + link.length)?.end
    if (!start || !end || y < start.y || y > end.y) continue
    result.push({ link, range: { start, end } })
  }
  return result
}

export function terminalPathLinkAtBufferCell(buffer: Buffer, x: number, y: number, workspaceRoot: string): TerminalPathLink | null {
  return terminalPathLinksInBuffer(buffer, y, workspaceRoot).find(({ range }) =>
    (y > range.start.y || x >= range.start.x) && (y < range.end.y || x <= range.end.x))?.link ?? null
}
