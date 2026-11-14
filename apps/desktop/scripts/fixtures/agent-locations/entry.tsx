import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, agentRegionExecution, agentRegionLocationsKnown, rereadAgentRegionExecution } from '../../../src/renderer/src/store'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId } from '../../../src/shared/space-addresses'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { createFocusContextIdentitySelector, focusContextIdentityKey } from '../../../src/renderer/src/lib/focus-context-identity'
import { agentContextForSession } from '../../../src/renderer/src/lib/focus-context'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { ExecutorIdentityContext } from '../../../src/renderer/src/components/AgentAvatar'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceAgentRow } from '../../../src/renderer/src/components/WorkspaceAgentRow'
import { AgentInformationPreviewHost } from '../../../src/renderer/src/components/AgentInformationPreview'
import { agentInformationPreview } from '../../../src/renderer/src/lib/agent-information-preview'
import { registerWorkbenchDocument } from '../../../src/renderer/src/lib/workbench-window-registry'
import { AgentRoster } from '../../../src/renderer/src/components/AgentRoster'
import { QuickSwitcher } from '../../../src/renderer/src/components/QuickSwitcher'
import '../../../src/renderer/src/styles/index.css'

// Original UI/Store owners; only the external discovery facts use the maintained preview.
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')!
if (!base || !config.workspaces[0]) throw new Error('Original typed preview Agent facts missing')
const workspace = { ...config.workspaces[0], id: 'location-proof', name: '文化与产品设计', hostId: 'local' }
const alias = { ...workspace, id: 'location-alias', name: '学习与研究', path: workspace.path + '-alias' }
const originalConfig = { ...config, workspaces: [workspace, alias] }
const now = Date.now(), ids = ['location-multiple', 'location-single', 'location-zero']
const names = ['持续阅读与交互设计 · 原会话和草稿保留', '校对手机排版', '尚未绑定展示位置']
const sessions = ids.map((id, index) => ({ ...base, id, label: names[index], hostId: 'local', workspacePath: workspace.path,
  processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: now },
  control: { ...base.control, agentSessionId: id, run: { ...base.control.run, runId: 'retained-controlled-run-' + id } } }))
const first = addWorkbenchRegion(createWorkbenchTab('first-location', { regionId: 'left-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: ids[0]! }, '阅读与交互设计'),
  'left-region', 'right', { regionId: 'right-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: ids[0]! })
const second = createWorkbenchTab('second-location', { regionId: 'second-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: ids[0]! }, '阅读与交互设计')
const single = createWorkbenchTab('single-location', { regionId: 'single-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: ids[1]! }, '移动端视觉校对')
const tabs = { [first.id]: first, [second.id]: second, [single.id]: single }
const layouts = { [workspace.id]: createWorkspaceLayout('original-location-group', Object.keys(tabs)) }
const primary = directoryIdentity('local', workspace.path), other = directoryIdentity('local', alias.path), zone = workspaceZoneId(primary, workspace.id)
const spaceZoneBindings = { [zone]: { spaceId: primary, workspaceId: workspace.id, relations: { [primary]: true, [other]: true } } }
const draft = { [ids[0]!]: '保留原草稿；查看或取消位置不发送。' }, timelines = {}
const controls: Record<string, number> = {}
for (const method of ['stop', 'resume', 'restart', 'launchAgent', 'recover', 'submitPrompt', 'write', 'interrupt'] as const) {
  const original = api.sessions[method]
  api.sessions[method] = ((...args: never[]) => { controls[method] = (controls[method] ?? 0) + 1; throw new Error('No lifecycle/input belongs to location browsing: ' + method) }) as typeof original
}
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
api.scratch.listTopics = async () => []
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
useAppStore.setState({ config: originalConfig, sessions, loading: false, activeWorkspaceId: workspace.id, mainSurface: 'agents', focusView: 'list', tabs, layouts, spaceZoneBindings,
  agentFocus: { execution: { sessionId: null, reference: null, history: [] }, pmo: { sessionId: null } }, agentNames: Object.fromEntries(ids.map((id, i) => [id, names[i]])), agentComposerDrafts: draft, timelines, providerCatalog: [], scratchTopicSnapshots: {} } as never)
// The unknown frame withholds one spatial notification while the original exact
// read still reaches that owner, matching a retained workface with an unread binding.
let holdSpatialNotifications = false
const observeSpatial = api.spatial.onChange
api.spatial.onChange = listener => observeSpatial(value => { if (!holdSpatialNotifications) listener(value) })
// Use the maintained typed preview owner and the real initialization/projector.
// No boolean or resolver is replaced to pretend spatial facts are confirmed.
await api.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...useAppStore.getState(), tabs: {}, layouts: {} }, []) })
api.config.get = async () => structuredClone(originalConfig)
api.sessions.snapshot = async () => ({ ...snapshot, sessions: structuredClone(sessions) })
useAppStore.setState({ tabs: {}, layouts: {}, restoredWorkbench: { tabs: {}, layouts: {} } })
await useAppStore.getState().initialize()
// The original startup observer sees an empty saved workface, so it need not
// recover any controlled Session. Add its display bindings through that owner.
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const initialized = await api.spatial.read()
if (!initialized) throw Error('The initialized preview spatial document is unavailable')
await api.spatial.commit({ expectedRevision: initialized.revision, graph: desktopSpatialGraph({ ...useAppStore.getState(), tabs, layouts, spaceZoneBindings }, []) })
useAppStore.setState({ mainSurface: 'agents', focusView: 'list', agentComposerDrafts: draft, agentNames: Object.fromEntries(ids.map((id, i) => [id, names[i]])) })
if (!agentRegionLocationsKnown()) throw Error('The original preview spatial initialization is unavailable')
const originalSessions = useAppStore.getState().sessions
const selectIdentity = createFocusContextIdentitySelector()
let showSpace: (space: boolean) => void
function Scene() {
  const [space, setSpace] = useState(false); showSpace = setSpace
  const state = useAppStore(), context = agentContextForSession(state.sessions.find(session => session.id === ids[0]!)!, undefined, names[0], workspace, null)
  const identities = selectIdentity(workbenchSelectionCatalog(state), state.tabs, [context], state.config, state.layouts, agentRegionExecution, agentRegionLocationsKnown())
  return <><header style={{ height: 44, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}><strong>{space ? 'Space · 文化与产品设计' : 'Focus'}</strong></header>
    <main style={{ height: 'calc(100% - 100px)', minHeight: 0 }}>{space ? <div className="workspace-agent-list" style={{ maxWidth: 520, padding: 16 }}><WorkspaceAgentRow context={context} identity={identities.get(focusContextIdentityKey(context.hostId, context.id))} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={id => useAppStore.getState().selectSession(id, 'original-location-group')} /></div>
      : <GlobalFocusSurface workspaceOpen={false} />}</main>
    <footer className="agent-status-bar" style={{ height: 56, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 16 }}><AgentRoster total={sessions.length} /><input aria-label="Original private draft" defaultValue={draft[ids[0]!]} style={{ flex: 1, minWidth: 0 }} /></footer>
    <QuickSwitcher open={false} onClose={() => {}} /></>
}
registerWorkbenchDocument(document, { windowId: 'location-capture-window', documentGeneration: 'location-capture-document' })
flushSync(() => createRoot(document.getElementById('root')!).render(<ExecutorIdentityContext.Provider value={{ config: originalConfig }}><DesktopClientUiProvider><AgentInformationPreviewHost /><Scene /></DesktopClientUiProvider></ExecutorIdentityContext.Provider>))
Object.assign(window, { agentLocationsScene: {
  ready: true,
  async reset(mode: 'dark' | 'light', space = false) {
    holdSpatialNotifications = false
    agentInformationPreview.detach()
    updateThemeSelection({ ...config.appearance, appAppearance: mode })
    await useAppStore.getState().retryWorkbenchSave()
    const observed = await api.spatial.read()
    if (!observed) throw Error('The original preview owner is unavailable')
    await api.spatial.commit({ expectedRevision: observed.revision, graph: desktopSpatialGraph({ ...useAppStore.getState(), tabs, layouts, spaceZoneBindings }, []) })
    flushSync(() => { useAppStore.setState({ sessionLocationRequest: null, mainSurface: space ? 'workbench' : 'agents', agentFocus: { ...useAppStore.getState().agentFocus, execution: { sessionId: null, reference: null, history: [] } } }); showSpace(space) })
  },
  async invalidate() {
    await useAppStore.getState().retryWorkbenchSave()
    const state = useAppStore.getState(), observed = await api.spatial.read()
    if (!observed) throw Error('The original preview owner is unavailable')
    const tab = state.tabs[second.id]!, surface = tab.regions['second-region']!
    const rebound = { ...state.tabs, [second.id]: { ...tab, regions: { ...tab.regions, 'second-region': { ...surface, sessionId: ids[1]! } } } }
    await api.spatial.commit({ expectedRevision: observed.revision, graph: desktopSpatialGraph({ ...state, tabs: rebound }, []) })
  },
  async unknown() {
    await useAppStore.getState().retryWorkbenchSave()
    const observed = await api.spatial.read()
    if (!observed) throw Error('The original preview owner is unavailable')
    const graph = structuredClone(observed.graph)
    graph.regions.find(region => region.tabId === first.id && region.regionId === 'right-region')!.execution = null
    holdSpatialNotifications = true
    await api.spatial.commit({ expectedRevision: observed.revision, graph })
    await rereadAgentRegionExecution({ tabId: first.id, regionId: 'right-region', agentSessionId: ids[0]! })
  },
  facts() { const state = useAppStore.getState(); return { controls, known: agentRegionLocationsKnown(), draftsPreserved: state.agentComposerDrafts === draft, sessionsPreserved: state.sessions === originalSessions, runIds: state.sessions.map(session => session.control.kind === 'agent' ? session.control.run.runId : null), draft: (document.querySelector('[aria-label="Original private draft"]') as HTMLInputElement)?.value, request: state.sessionLocationRequest, selection: state.workbenchSpaceSelection } }
} })
