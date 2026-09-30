import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { performanceSnapshot } from './data'
import '../../../src/renderer/src/styles/index.css'

// 实际 App/Settings/TerminalView/CSS 与实际 isolated preload/registered Toolkit IPC。
// 唯一受控 seam 是原 preview Session事实和明确的 Metrics DTO port；不启动用户或私有Native Run。
const w = window as any, bridge = w.performanceProof
const preview = await api.config.get()
const originalSnapshot = await api.sessions.snapshot()
const localPath = '/private/performance/workspace'
preview.workspaces = preview.workspaces.map(workspace => workspace.hostId === 'local' ? { ...workspace, path: localPath } : workspace)
const sessions = originalSnapshot.sessions.map(session => session.hostId === 'local'
  ? { ...session, workspacePath: localPath, label: 'Review Toolkit ownership and resource observation across the complete Agent workspace' } : session)
api.sessions.snapshot = async () => ({ ...originalSnapshot, sessions: structuredClone(sessions) })
const setup = await bridge.setup(preview)
api.config.get = () => bridge.get()
api.config.save = (next, expected) => bridge.save(next, expected)
api.config.onChange = listener => bridge.onChange(listener)
api.ui.requestStorageFlush = () => bridge.flush()
api.toolkit = w.agentmux.toolkit
const writes: unknown[] = [], attachments: unknown[] = [], events: unknown[] = []
const attach = api.sessions.attach
api.sessions.attach = async (...args) => { const value = await attach(...args); attachments.push({ control: args[0], attachmentId: value.attachmentId });
  return { ...value, session: structuredClone(sessions.find(session => session.id === value.session.id) ?? value.session) } }
api.sessions.write = async (control, data, source) => { writes.push({ control, data: typeof data === 'string' ? data : Array.from(data), source }) }
document.addEventListener('keydown', event => events.push({ key: event.key, code: event.code, keyCode: event.keyCode, isComposing: event.isComposing, isTrusted: event.isTrusted, target: (event.target as HTMLElement)?.className, prevented: event.defaultPrevented }), true)
createRoot(document.getElementById('root')!).render(createElement(App))
while (useAppStore.getState().loading || !useAppStore.getState().config) await new Promise(resolve => setTimeout(resolve, 10))
const state = useAppStore.getState(), session = state.sessions.find(s => s.id === 'session-codex')!
if (!session) throw Error('原 preview Session 非空正控缺失')
const workspace = state.config!.workspaces.find(workspace => workspace.path === session.workspacePath) ?? state.config!.workspaces[0]!
if (setup.phase === 'control') {
  const tab = createWorkbenchTab('performance-original-tab', { regionId: 'performance-original-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { ...state.layouts, [workspace.id]: createWorkspaceLayout('performance-original-group', [tab.id]) },
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    viewModes: { [session.id]: 'terminal' }, agentComposerDrafts: { [session.id]: 'Original unsent draft remains exact.' } })
}
const snapshot = structuredClone(performanceSnapshot)
snapshot.observation!.process.data![0] = { ...snapshot.observation!.process.data![0]!, hostId: session.hostId, runId: session.control.run.runId }
await bridge.publish(snapshot)
const surface = () => {
  const current = useAppStore.getState()
  return { ...projectPersistedWorkbench(current), activeWorkspaceId: current.activeWorkspaceId, drafts: current.agentComposerDrafts,
    sessions: current.sessions.map(s => ({ id: s.id, control: s.control, processState: s.processState })) }
}
w.performanceScene = {
  ready: true, phase: setup.phase, snapshot, writes, attachments, events, surface,
  publish: (next: typeof snapshot) => bridge.publish(next),
  theme: async (appearance: 'light' | 'dark') => { const current = await api.config.get(); return api.config.save({ ...current, appearance: { ...current.appearance, appAppearance: appearance } }, current) },
  preferences: async (enabled: boolean, statusBar: 'icon' | 'label') => { const current = await api.config.get(); return api.config.save({ ...current, toolkit: { ...current.toolkit, performance: { enabled, statusBar } } }, current) },
  flush: () => bridge.flush(), facts: () => bridge.facts()
}
