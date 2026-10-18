import '../terminal-region-menu/entry'
import { flushSync } from 'react-dom'
import type { Terminal } from '@xterm/xterm'
import { terminalContextPathAtBufferCell } from '../../../src/renderer/src/lib/terminal-context-path'
import { workspaceRootForPath } from '../../../src/renderer/src/lib/workbench-tabs'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

// Actual WorkspaceWorkbench → SessionPane → TerminalView → original Region menu.
// Only the host I/O port is recorded; no user's Finder or live Run is touched.
const calls: unknown[] = []
api.files.reveal = async (...args) => { calls.push({ kind: 'reveal', args }) }
api.files.openSystem = async (...args) => { calls.push({ kind: 'open-system', args }) }
function terminal(): Terminal {
  const element = document.querySelector('[data-workbench-region-id="region-actions-target"] .xterm')
  return (window as any).identityTerminals.find((record: any) => !record.disposed && record.terminal.element === element).terminal
}
Object.assign(window, { fileContext: {
  async prepare(kind: 'bare' | 'declared' | 'http') {
    const store = useAppStore.getState(), workspace = store.config!.workspaces.find(workspace => workspace.id === store.activeWorkspaceId)!
    // The shared legacy preview has relative Session cwd values. Give this local
    // scenario an accurate absolute Session/Workspace binding before writing bytes.
    const sessionId = store.tabs['region-actions-tab']!.regions['region-actions-target']!.sessionId
    flushSync(() => useAppStore.setState({ sessions: store.sessions.map(session => session.id === sessionId
      ? { ...session, workspacePath: workspace.path } : session) }))
    const t = terminal(); t.reset(); calls.length = 0
    const path = kind === 'bare' ? 'release/App.dmg' : 'release/App 中.dmg'
    const uri = kind === 'http' ? 'https://example.test/download' : 'file://' + workspace.path + '/release/App%20%E4%B8%AD.dmg'
    const text = kind === 'bare' ? path : `\x1b]8;;${uri}\x07${kind === 'http' ? 'release/fake.dmg' : 'DMG 已生成'}\x1b]8;;\x07`
    await new Promise<void>(done => t.write(text + '\r\nRetained terminal output', done))
    ;(window as any).terminalMenu.clearInputs()
    return { workspaceId: workspace.id, path }
  },
  facts() { return { calls: [...calls], terminal: (window as any).terminalMenu.facts(),
    line: terminal().buffer.active.getLine(0)?.translateToString(true),
    debug: (() => { const state = useAppStore.getState(); const source=state.sessions[0]!; return {
      activeWorkspaceId: state.activeWorkspaceId, workspaces: state.config?.workspaces, hosts: state.config?.hosts,
      source: { hostId: source.hostId, workspacePath: source.workspacePath }, root: workspaceRootForPath(state.config, source),
      target: terminalContextPathAtBufferCell(terminal(),2,1,workspaceRootForPath(state.config,source)??'') } })() } },
  point() {
    const t = terminal(), r = t.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
    return { x: r.left + 1.5 * r.width / t.cols, y: r.top + .5 * r.height / t.rows }
  }
} })
