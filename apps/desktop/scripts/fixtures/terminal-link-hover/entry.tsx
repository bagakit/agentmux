import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Terminal } from '@xterm/xterm'
import '../../../src/renderer/src/styles/index.css'

const w = window as unknown as Window & {
  terminals: Terminal[]; pathQueries: unknown[]; pathHovers: unknown[]; errors: string[]; opens: unknown[];
  ready: boolean; hoverFacts(): unknown; cellPoint(row: number, text: string): unknown
}
w.terminals = []; w.pathQueries = []; w.pathHovers = []; w.errors = []; w.opens = []
const pointers: unknown[] = []
document.addEventListener('mousemove', event => pointers.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted,
  target: (event.target as Element).className, hit: document.elementFromPoint(event.clientX, event.clientY)?.className }))
window.addEventListener('error', event => w.errors.push(event.message))
window.addEventListener('unhandledrejection', event => w.errors.push(String(event.reason)))
const { useAppStore } = await import('../../../src/renderer/src/store')
const { TerminalView } = await import('../../../src/renderer/src/components/TerminalView')
const snapshot = await window.agentmux!.sessions.snapshot()
const session = snapshot.sessions[0]!
if (session.kind !== 'terminal' || snapshot.sessions.length !== 1) throw Error('Expected one private actual Core terminal Run')
const origin = { workspaceId: 'hover-private-workspace', tabGroupId: 'hover-private-group', tabId: 'hover-private-tab', regionId: 'hover-private-region' }
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
  workspaces: [{ id: origin.workspaceId, hostId: 'local', path: session.workspacePath, kind: 'folder' }] } as NonNullable<ReturnType<typeof useAppStore.getState>['config']>,
  sessions: [session], openFile: async (...args) => { w.opens.push({ kind: 'file', args }); return true },
  openHttpLink: async (...args) => { w.opens.push({ kind: 'http', args }) }, reportError: error => w.errors.push(String(error)) })
createRoot(document.getElementById('container')!).render(<TerminalView session={session} themeId="graphite" fontSize={17}
  interactiveResize={false} visible autoFocus={false} linkOrigin={origin} />)
let original: Terminal | undefined
w.hoverFacts = () => {
  const terminal = w.terminals[0]; original ??= terminal
  const buffer = terminal?.buffer.active
  const rect = document.querySelector('.xterm-screen')?.getBoundingClientRect()
  const popup = document.querySelector('.terminal-link-preview')?.getBoundingClientRect()
  // Independent native witness: intersect painted cell extents with the measured popup.
  const readoutGlyphOverlap: unknown[] = []
  if (terminal && buffer && rect && popup) {
    const width = rect.width / terminal.cols, height = rect.height / terminal.rows
    for (let y = 0; y < terminal.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y)
      for (let x = 0; line && x < terminal.cols; x++) {
        const cell = line.getCell(x)!, span = cell.getWidth()
        if (span === 0 || !cell.getChars().trim()) continue
        const left = rect.left + x * width, top = rect.top + y * height
        if (left < popup.right && left + span * width > popup.left && top < popup.bottom && top + height > popup.top)
          readoutGlyphOverlap.push({ x, y, chars: cell.getChars(), span })
      }
    }
  }
  return { terminalCount: w.terminals.length, sameTerminal: !!terminal && terminal === original,
    sessionId: session.id, runId: session.control.run.runId,
    cols: terminal?.cols, rows: terminal?.rows, unicode: terminal?.unicode.activeVersion,
    buffer: buffer && { baseY: buffer.baseY, viewportY: buffer.viewportY, length: buffer.length },
    lines: buffer && Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true)),
    selection: terminal?.getSelection(), readout: document.querySelector('.terminal-link-preview__url')?.textContent ?? null,
    screen: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    queries: w.pathQueries, pathHovers: w.pathHovers, readoutGlyphOverlap, opens: w.opens, errors: w.errors, pointers,
    hydrating: !!document.querySelector('.terminal-view__xterm--hydrating') }
}
w.cellPoint = (row, text) => {
  const terminal = w.terminals[0]!, line = terminal.buffer.active.getLine(row)!
  const index = line.translateToString(true).indexOf(text)
  if (index < 0) throw Error('Expected independent fixture text is absent')
  let offset = 0, col = 0
  for (; col < terminal.cols; col++) {
    const cell = line.getCell(col)!
    if (cell.getWidth() === 0) continue
    if (offset === index) break
    offset += cell.getChars().length || 1
  }
  if (col === terminal.cols) throw Error('Expected text cell is absent')
  const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect()
  return { x: screen.left + (col + 0.5) * screen.width / terminal.cols,
    y: screen.top + (row - terminal.buffer.active.viewportY + 0.5) * screen.height / terminal.rows,
    column: col + 1, bufferRow: row + 1 }
}
w.ready = true
