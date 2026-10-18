import type { IBufferCell, Terminal } from '@xterm/xterm'
import { classifyMarkdownLinkHref } from '@agentmux/client-ui/markdown-file-reference'
import type { TerminalPathLink } from '@agentmux/client-ui/terminal-path-link'
import { terminalPathLinkAtBufferCell } from './terminal-link-range'

// Pinned xterm has no public OSC 8 cell lookup. Keep this read-only native seam here:
// CellData owns the current cell's urlId; OscLinkService owns its declared URI.
// Reading at menu invocation avoids stale hover targets after output, scroll or reset.
type HyperlinkCell = IBufferCell & { extended: { urlId: number } }
type HyperlinkTerminal = Terminal & {
  _core: { _oscLinkService: { getLinkData(id: number): { uri: string } | undefined } }
}

export function terminalContextPathAtBufferCell(
  terminal: Terminal, x: number, y: number, workspaceRoot: string
): TerminalPathLink | null {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || x > terminal.cols || y < 1) return null
  const cell = terminal.buffer.active.getLine(y - 1)?.getCell(x - 1) as HyperlinkCell | undefined
  if (!cell) return null
  const urlId = cell.extended.urlId
  if (!urlId) return terminalPathLinkAtBufferCell(terminal.buffer.active, x, y, workspaceRoot)
  const uri = (terminal as HyperlinkTerminal)._core._oscLinkService?.getLinkData(urlId)?.uri
  // A declared but unresolved/unsupported link must never borrow its display label's path.
  if (!uri) return null
  let href = uri
  if (/^file:/i.test(uri)) {
    // URL normalizes raw controls/backslashes and hides empty query/fragment delimiters.
    if (/[?#\\\u0000-\u001f\u007f-\u009f]/u.test(uri)) return null
    let url: URL
    try { url = new URL(uri) } catch { return null }
    if ((url.hostname && url.hostname !== 'localhost') || url.search || url.hash) return null
    href = url.pathname
  }
  return classifyMarkdownLinkHref(href, workspaceRoot)
}
