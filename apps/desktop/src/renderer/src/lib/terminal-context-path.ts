import type { Terminal } from '@xterm/xterm'
import type { TerminalPathLink } from '@agentmux/client-ui/terminal-path-link'
import { terminalLinkAtCell, terminalLinksAtRow } from './terminal-link-range'
import type { TerminalLinkScope } from './terminal-link-target'

export function terminalContextPathAtBufferCell(
  terminal: Terminal, x: number, y: number, workspaceRoot: string, homeDir?: string,
  registeredWorkspaces?: TerminalLinkScope['registeredWorkspaces']
): TerminalPathLink | null {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || x > terminal.cols || y < 1) return null
  const target = terminalLinkAtCell(terminalLinksAtRow(terminal, y, { workspaceRoot, ...(homeDir ? { homeDir } : {}),
    ...(registeredWorkspaces ? { registeredWorkspaces } : {}) }), x, y)
  return target?.kind === 'file' ? target.file : null
}
