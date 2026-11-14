import type { IBuffer, IBufferCell, IBufferLine, IBufferRange, Terminal } from '@xterm/xterm'
import { resolveTerminalDeclaredLink, terminalTextLinks, type TerminalLinkScope, type TerminalLinkTarget } from './terminal-link-target'

// One hover window, independent of scrollback size. This also bounds combined-cell text.
const TERMINAL_LINK_WINDOW_CELLS = 4096
const TERMINAL_LINK_WINDOW_ROWS = 32
const BARE_LINK_SEPARATOR = /[\s<>"\x60]/u
type Buffer = Pick<IBuffer, 'getLine' | 'getNullCell'>
type Cell = { chars: string; x: number; width: number; urlId?: number }
type Row = { y: number; line: IBufferLine; cells: Cell[]; clipped: boolean }
export type TerminalBufferLink = { target: TerminalLinkTarget; range: IBufferRange }

type OscCell = IBufferCell & { extended?: { urlId?: number } }
type LinkTerminal = Terminal & { _core?: { _oscLinkService?: { getLinkData(id: number): { uri: string } | undefined } } }

/** xterm does not expose OSC 8 cell metadata through its typed public API. Keep the read seam here. */
export function terminalLinksAtRow(terminal: Terminal, y: number, scope: TerminalLinkScope): TerminalBufferLink[] {
  const service = (terminal as LinkTerminal)._core?._oscLinkService
  return terminalLinksInBuffer(terminal.buffer.active, y, scope, id => service?.getLinkData(id)?.uri)
}

export function terminalLinksInBuffer(buffer: Buffer, y: number, scope: TerminalLinkScope,
  declaredUri?: (id: number) => string | undefined): TerminalBufferLink[] {
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
      const cell: OscCell | undefined = line.getCell(column, scratch)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars()
      const length = chars.length || 1
      if (length > textRemaining) break
      textRemaining -= length
      const urlId = declaredUri && cell.extended?.urlId
      cells.push({ chars, x: column + 1, width: cell.getWidth(), ...(urlId ? { urlId } : {}) })
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
  }
  let next = buffer.getLine(y)
  while (!rows.at(-1)!.clipped && next?.isWrapped && rows.length < TERMINAL_LINK_WINDOW_ROWS && next.length <= remaining) {
    const row = readRow(next, rows.at(-1)!.y + 1)
    rows.push(row)
    next = buffer.getLine(row.y)
  }
  const incomplete = rows[0]!.line.isWrapped || rows.at(-1)!.clipped || next?.isWrapped === true
  let text = ''
  const wrapGaps: { from: number; to: number }[] = []
  type Position = { from: number; to: number; start: IBufferRange['start']; end: IBufferRange['end']; urlId?: number }
  const positions: Position[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!, following = rows[index + 1]
    const continues = following?.line.isWrapped ?? next?.isWrapped ?? false
    if (!continues) while (row.cells.at(-1)?.chars === '') row.cells.pop()
    let nullStart = -1
    for (const cell of row.cells) {
      const from = text.length
      text += cell.chars || ' '
      if (cell.chars || cell.urlId) nullStart = -1
      else if (nullStart < 0) nullStart = from
      positions.push({ from, to: text.length, start: { x: cell.x, y: row.y },
        end: { x: cell.x + cell.width - 1, y: row.y }, ...(cell.urlId ? { urlId: cell.urlId } : {}) })
    }
    if (continues && nullStart >= 0) wrapGaps.push({ from: nullStart, to: text.length })
  }

  const result: TerminalBufferLink[] = []
  for (let index = 0; index < positions.length; index++) {
    const first = positions[index]!
    if (!first.urlId) continue
    while (positions[index + 1]?.urlId === first.urlId) index++
    const last = positions[index]!
    const uri = declaredUri?.(first.urlId)
    if (uri && y >= first.start.y && y <= last.end.y) {
      result.push({ target: resolveTerminalDeclaredLink(uri, scope), range: { start: first.start, end: last.end } })
    }
  }
  // A clipped logical line cannot prove the beginning/end of quoted or escaped
  // tokens. Declared OSC targets above remain exact independently of display length.
  if (incomplete) return result

  // A declaration reserves its cells even if the URI is unavailable or invalid.
  // Insert a non-path separator without changing UTF-16 offsets of neighboring links.
  let bare = '', cursor = 0
  for (const cell of positions) {
    if (!cell.urlId) continue
    bare += text.slice(cursor, cell.from) + '<'.repeat(cell.to - cell.from)
    cursor = cell.to
  }
  bare += text.slice(cursor)
  // A cursor group skipped by xterm reflow and a VT erase can leave the same tail
  // cells. Both sides may belong to one token. Explicit separators and declared
  // targets bound only the affected candidate, and no gap becomes a file space.
  for (const gap of wrapGaps) {
    let left = gap.from, right = gap.to
    while (left > 0 && !BARE_LINK_SEPARATOR.test(bare[left - 1]!)) left--
    while (right < bare.length && !BARE_LINK_SEPARATOR.test(bare[right]!)) right++
    if (left < gap.from && right > gap.to) { gap.from = left; gap.to = right }
  }
  let at = 0, gapIndex = 0
  for (const link of terminalTextLinks(bare, scope)) {
    const endIndex = link.index + link.length
    while (wrapGaps[gapIndex] && wrapGaps[gapIndex]!.to <= link.index) gapIndex++
    if (wrapGaps[gapIndex] && wrapGaps[gapIndex]!.from < endIndex) continue
    while (positions[at] && positions[at]!.to <= link.index) at++
    const start = positions[at]?.start
    while (positions[at] && positions[at]!.to < endIndex) at++
    const end = positions[at]?.end
    if (start && end && y >= start.y && y <= end.y) result.push({ target: link.target, range: { start, end } })
  }
  return result
}

export function terminalLinkAtCell(links: readonly TerminalBufferLink[], x: number, y: number): TerminalLinkTarget | null {
  return links.find(({ range }) => y >= range.start.y && y <= range.end.y &&
    (y > range.start.y || x >= range.start.x) && (y < range.end.y || x <= range.end.x))?.target ?? null
}
