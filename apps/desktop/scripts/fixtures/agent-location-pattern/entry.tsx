import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentInformationPreviewHost } from '../../../src/renderer/src/components/AgentInformationPreview'
import { ExecutorIdentityContext } from '../../../src/renderer/src/components/AgentAvatar'
import { FocusContextRow } from '../../../src/renderer/src/components/FocusContextRow'
import { QuickSwitcher } from '../../../src/renderer/src/components/QuickSwitcher'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../../../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { agentContextForSession } from '../../../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
const snapshot = await api.sessions.snapshot()
const workspace = config.workspaces[0]!
const original = snapshot.sessions.find(session => session.kind === 'agent' && session.hostId === workspace.hostId)!
const agent = { ...original, label: 'Review Agent', workspacePath: workspace.path }
api.sessions.snapshot = async () => ({ ...snapshot, sessions: [agent] })
const context = agentContextForSession(agent, undefined, 'Review Agent', workspace, null)
const first = createWorkbenchTab('draft-view', { kind: 'agent', regionId: 'draft-region', workspaceId: workspace.id,
  phase: 'attached', sessionId: agent.id }, 'Review')
const second = createWorkbenchTab('review-view', { kind: 'agent', regionId: 'review-region', workspaceId: workspace.id,
  phase: 'attached', sessionId: agent.id }, 'Review')
const tabs = { [first.id]: first, [second.id]: second }
const layouts = { [workspace.id]: createWorkspaceLayout('review-group', Object.keys(tabs)) }
const drafts = { [agent.id]: 'Keep this original review draft.' }
const readSpatial = api.spatial.read.bind(api.spatial)
let available = true
api.spatial.read = () => available ? readSpatial() : Promise.reject(new Error('Fixture spatial source unavailable'))

useAppStore.setState({ config, sessions: [agent], tabs, layouts, activeWorkspaceId: workspace.id })
await api.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
useAppStore.setState({ restoredWorkbench: { tabs, layouts } })
let disconnect = await useAppStore.getState().initialize()
function restorePreviewObservations() {
  useAppStore.setState({ sessions: [agent], mainSurface: 'workbench', agentComposerDrafts: drafts, viewModes: { [agent.id]: 'activity' } })
}
restorePreviewObservations()
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })

const frame = document.getElementById('root')!
const overlay = document.createElement('div')
overlay.dataset.overlayHost = ''
document.body.append(overlay)
function Consumer() {
  return <ExecutorIdentityContext.Provider value={{ config }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) minmax(0, 1fr)', height: '100vh' }}>
      <aside style={{ padding: 'var(--sp-4)', background: 'var(--surface-1)' }}>
        <FocusContextRow context={context} selected={false} onSelect={id => useAppStore.getState().focusExecutionSession(id)} />
      </aside>
      <WorkspaceWorkbench workspaceId={workspace.id} />
    </div>
    <QuickSwitcher open={false} onClose={() => {}} />
    <AgentInformationPreviewHost />
  </ExecutorIdentityContext.Provider>
}
flushSync(() => createRoot(frame).render(<Consumer />))
Object.assign(window, { agentLocationFixture: {
  setAppearance(appearance: 'light' | 'dark') { updateThemeSelection({ ...config.appearance, appAppearance: appearance }) },
  async unavailable() {
    available = false
    disconnect()
    disconnect = await useAppStore.getState().initialize()
    restorePreviewObservations()
  },
  facts() {
    const state = useAppStore.getState()
    return { selection: state.workbenchSpaceSelection, request: state.sessionLocationRequest?.requestId ?? null,
      sameDrafts: state.agentComposerDrafts === drafts, sameRun: state.sessions.some(session => session.id === agent.id && session.control.run.runId === agent.control.run.runId) }
  }
} })
