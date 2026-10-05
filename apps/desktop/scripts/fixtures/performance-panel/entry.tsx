import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { performanceSnapshot, performanceAttributionSnapshots } from './data'
import '../../../src/renderer/src/styles/index.css'

// 实际 App/Settings/TerminalView/CSS 与实际 isolated preload/registered Toolkit IPC。
// 唯一受控 seam 是原 preview Session事实和明确的 Metrics DTO port；不启动用户或私有Native Run。
const w = window as any, bridge = w.performanceProof
const preview = await api.config.get()
const originalSnapshot = await api.sessions.snapshot()
const localPath = _hygiene_fixturePath("private/performance/workspace")
preview.workspaces = preview.workspaces.map(workspace => workspace.hostId === 'local' ? { ...workspace, path: localPath } : workspace)
const sessions = originalSnapshot.sessions.map(session => session.hostId === 'local'
  ? { ...session, workspacePath: localPath, label: 'Review Toolkit ownership and resource observation across the complete Agent workspace' } : session)
api.sessions.snapshot = async () => ({ ...originalSnapshot, sessions: structuredClone(sessions) })
const setup = await bridge.setup(preview)
if (setup.phase === 'agent-cards') {
  // Controlled local identity input for the second Provider; original preview Sessions stay intact.
  const original = sessions.find(candidate => candidate.kind === 'agent' && candidate.providerId === 'claude')!
  sessions.push({...original,id:'cards-preview-claude',hostId:'local',workspacePath:localPath,label:'Review the prepared changes',
    control:{kind:'agent',hostId:'local',agentSessionId:'cards-preview-claude',run:{runId:'cards-preview-claude-run'}}})
}
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
if (setup.phase === 'control' || setup.phase === 'placement' || setup.phase === 'buttons' || setup.phase === 'attribution' || setup.phase === 'agent-cards' || setup.phase === 'epoch-peak') {
  const tab = createWorkbenchTab('performance-original-tab', { regionId: 'performance-original-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { ...state.layouts, [workspace.id]: createWorkspaceLayout('performance-original-group', [tab.id]) },
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    viewModes: { [session.id]: 'terminal' }, agentComposerDrafts: { [session.id]: 'Original unsent draft remains exact.' } })
}
const snapshot = structuredClone(setup.phase === 'epoch-peak' ? performanceAttributionSnapshots.waiting : setup.phase === 'attribution' ? performanceAttributionSnapshots.fresh : performanceSnapshot)
snapshot.observation!.process.data![0] = { ...snapshot.observation!.process.data![0]!, hostId: session.hostId, runId: session.control.run.runId }
// Same public document references as the adjusted controlled process sample.
const firstCard = snapshot.document?.agentCards?.items[0]
if (firstCard) firstCard.reference = {kind:'run',hostId:session.hostId,runId:session.control.run.runId}
if (setup.phase === 'agent-cards') {
  snapshot.observation!.runTotals = {coverage:{trackedRuns:8,observedRoots:8,missingRoots:0},cpuPercent:42.8,rssKib:3133440,processCount:22}
  snapshot.document!.items = [{label:'Total CPU',value:'42.8%'},{label:'Total RSS',value:'3133440 KiB'}]
  const other = state.sessions.find(candidate => candidate.kind === 'agent' && candidate.hostId === session.hostId && candidate.id !== session.id)
  if (other) {
    snapshot.observation!.process.data![1] = {...snapshot.observation!.process.data![1]!,hostId:other.hostId,runId:other.control.run.runId}
    snapshot.document!.agentCards!.items[1]!.reference = {kind:'run',hostId:other.hostId,runId:other.control.run.runId}
  }
}
await bridge.publish(snapshot)
const surface = () => {
  const current = useAppStore.getState()
  return { ...projectPersistedWorkbench(current), activeWorkspaceId: current.activeWorkspaceId, drafts: current.agentComposerDrafts,
    sessions: current.sessions.map(s => ({ id: s.id, control: s.control, processState: s.processState })) }
}
w.performanceScene = {
  ready: true, phase: setup.phase, snapshot, writes, attachments, events, surface, mainSurface: () => useAppStore.getState().mainSurface,
  publish: (next: typeof snapshot) => bridge.publish(next),
  publishAttribution: (state: keyof typeof performanceAttributionSnapshots) => {
    if (!['attribution','epoch-peak'].includes(setup.phase) || !Object.hasOwn(performanceAttributionSnapshots, state)) throw Error('Explicit attribution scene required')
    return bridge.publish(structuredClone(performanceAttributionSnapshots[state]))
  },
  theme: async (appearance: 'light' | 'dark') => { const current = await api.config.get(); return api.config.save({ ...current, appearance: { ...current.appearance, appAppearance: appearance } }, current) },
  preferences: async (enabled: boolean, statusBar: 'icon' | 'label') => { const current = await api.config.get(); return api.config.save({ ...current, toolkit: { ...current.toolkit, performance: { enabled, statusBar } } }, current) },
  flush: () => bridge.flush(), facts: () => bridge.facts()
}
