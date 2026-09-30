import type { IBuffer } from '@xterm/xterm'

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>

/** Check only the popup's visible cells, including a wide glyph's owner to its left. */
export function terminalLinkReadoutOverlapsText(
  buffer: Pick<IBuffer, 'viewportY' | 'getLine' | 'getNullCell'>,
  cols: number,
  rows: number,
  screen: Rect,
  popup: Rect
): boolean {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0 ||
    screen.width <= 0 || screen.height <= 0 || popup.width <= 0 || popup.height <= 0) return true
  const left = Math.max(screen.left, popup.left), right = Math.min(screen.right, popup.right)
  const top = Math.max(screen.top, popup.top), bottom = Math.min(screen.bottom, popup.bottom)
  if (right <= left || bottom <= top) return false
  const cellWidth = screen.width / cols, cellHeight = screen.height / rows
  const firstColumn = Math.max(0, Math.floor((left - screen.left) / cellWidth) - 1)
  const lastColumn = Math.min(cols - 1, Math.ceil((right - screen.left) / cellWidth) - 1)
  const firstRow = Math.max(0, Math.floor((top - screen.top) / cellHeight))
  const lastRow = Math.min(rows - 1, Math.ceil((bottom - screen.top) / cellHeight) - 1)
  const scratch = buffer.getNullCell()
  for (let y = firstRow; y <= lastRow; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line) return true
    for (let x = firstColumn; x <= lastColumn; x++) {
      const cell = line.getCell(x, scratch)
      if (!cell) return true
      const width = cell.getWidth()
      if (width === 0 || !/\S/u.test(cell.getChars())) continue
      const glyphLeft = screen.left + x * cellWidth
      const glyphRight = screen.left + Math.min(cols, x + width) * cellWidth
      if (glyphLeft < right && glyphRight > left) return true
    }
  }
  return false
}
