import { createElement as h, Fragment, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, moveTabToNewGroup, addTabOccurrence, activateTab } from '@agentmux/layout'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { executionFocusPresentation } from '../../../src/renderer/src/lib/focus-tab-projection'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId } from '../../../src/renderer/src/lib/workbench-projection'
import { formatTabAddress } from '../../../src/renderer/src/lib/agent-address'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { PmoTeamsTopicFloatingPanel } from '../../../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { PmoTeamsTopicEntry } from '../../../src/renderer/src/components/PmoTeamsTopicEntry'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { usePmoTeamsTopicFloatingState, pmoTeamsTopicFloatingViewTargets, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import { moteConfig, moteSessions, moteTabs, moteTopics, executionAgent } from '../../../test/fixtures/mote-workface'
import '../../../src/renderer/src/styles/index.css'

const phase = new URL(location.href).searchParams.get('phase')
window.sceneErrors = []
window.addEventListener('error', event => window.sceneErrors.push({ message: event.message, stack: event.error?.stack }))
window.addEventListener('unhandledrejection', event => window.sceneErrors.push({ message: String(event.reason), stack: event.reason?.stack }))
if (!['seed', 'restore'].includes(phase)) throw new Error('Exact private scene phase required')
const sourceId = 'displayed-complete-tab', sourceRegion = 'displayed-agent-region'
const reference = { displayWorkspaceId: 'project', groupId: 'exact-second-group', tabId: sourceId, regionId: sourceRegion }
const longName = 'Release review · long complete Tab title with two original Regions and exact retained location'
// An exact retained Mote with unconfirmed executor configuration must keep the
// newborn discussion/request. This visual boundary cannot claim actual delivery.
const config = { ...moteConfig, executors: {} }
const originalSnapshot = await api.sessions.snapshot()
api.config.get = async () => config
api.sessions.snapshot = async () => ({ ...originalSnapshot, sessions: moteSessions, recoveryCandidates: [] })
api.providers.list = async () => []
api.workspaces.listBranches = async workspaceId => {
  const workspace = config.workspaces.find(item => item.id === workspaceId)
  if (!workspace) throw new Error('Missing exact fixture workspace: ' + workspaceId)
  return { kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path }
}
api.demands.list = async () => []
api.scratch.listTopics = async () => moteTopics
api.scratch.readTopic = async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null
const reads = { timeline: 0, historyPage: 0, historySources: 0, topics: 0 }, control = { launchAgent: 0, stop: 0, resume: 0, write: 0 }
for (const key of Object.keys(reads)) { const port = key === 'topics' ? api.scratch : api.sessions, method = key === 'topics' ? 'listTopics' : key, original = port[method]; port[method] = (...args) => { reads[key]++; return original(...args) } }
for (const key of Object.keys(control)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { control[key]++; return original(...args) } }
let preparationReleased = phase === 'restore'
const preparations = []
api.scratch.ensureMote = async (_workspace, id) => preparationReleased
  ? moteTopics.find(topic => topic.id === id)
  : new Promise(resolve => preparations.push(() => resolve(moteTopics.find(topic => topic.id === id))))
if (phase === 'seed') {
  const agent = createWorkbenchTab(sourceId, { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: sourceRegion, sessionId: executionAgent.id }, longName)
  const source = addWorkbenchRegion(agent, sourceRegion, 'right', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'source-second-region', sessionId: executionAgent.id })
  const decoy = createWorkbenchTab('ordinary-decoy', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'decoy-region', sessionId: executionAgent.id }, longName)
  const split = moveTabToNewGroup(createWorkspaceLayout('ordinary-group', [decoy.id, source.id]), source.id, 'ordinary-group', 'ordinary-group', 'right', reference.groupId)
  // The original Tab occurs in both Groups while Focus switches Tab/Region.
  // No single home occurrence can be guessed from that shared membership.
  // View in Space must still choose the exact displayed Group reference.
  const layout = activateTab(addTabOccurrence(split, 'ordinary-group', source.id), 'ordinary-group', source.id)
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { ...moteTabs, [source.id]: source, [decoy.id]: decoy }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(moteTabs)), project: { ...layout, activeGroupId: 'ordinary-group' } } }),
    activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'agents', projectRailOpen: false, toolsOpen: false,
    agentFocus: { execution: { sessionId: executionAgent.id, history: [], reference }, pmo: { sessionId: 'default-agent' } },
    agentComposerDrafts: { [sourceRegion]: 'Source Region unsent: keep this original request', 'execution-agent': 'Execution unsent', 'default-agent': 'Default Mote unsent', 'custom-agent': 'Custom Mote unsent' }
  } }))
}
await useAppStore.getState().initialize()
// No seeding, Store replacement or rehydration override occurs on restore.
function Scene() {
  const state = useAppStore(), [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const [regionOnly, setRegionOnly] = useState(false)
  const presentation = useMemo(() => executionFocusPresentation(state.agentFocus.execution, state.tabs, spatialCatalog(state, moteTopics), choice => useAppStore.getState().selectExecutionFocusReference(choice, state.agentFocus.execution), regionOnly ? 'region' : 'tab'), [state.agentFocus.execution, state.tabs, state.layouts, regionOnly])
  const projection = state.mainSurface === 'agents' ? presentation.projection : null
  const selected = projection?.selection[0]
  const focusTargets = selected && projection ? { [selected.tabId]: [{
    hostId: (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, selected),
    active: true, visible: true, surface: 'focus', retainedRegionId: selected.regionId,
    headerPortalTargetId: 'focus-workspace-slot-header', projection, reference: selected,
    onSelectRegion: regionId => projection.onSelect({ ...selected, regionId })
  }] } : {}
  const targets = useMemo(() => pmoTeamsTopicFloatingViewTargets(floating, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], state.agentFocus.pmo.sessionId), [floating, state.tabs, state.layouts, state.agentFocus.pmo.sessionId])
  return h(Fragment, null,
    h('main', { style: { height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 } },
      h(GlobalFocusSurface, { presentation, viewTargets: focusTargets, regionOnly, onToggleRegion: () => setRegionOnly(value => !value), visible: state.mainSurface === 'agents' }),
      h('div', { style: { display: 'flex', alignItems: 'center', margin: '6px 8px', gap: '8px' } }, h(PmoTeamsTopicEntry), h('input', { id: 'later-input', 'aria-label': 'Original later input', defaultValue: 'Keep the later caret', style: { width: 'min(260px, calc(100% - 16px))' } }))),
    h('div', { className: 'workspace-workbench-registry workspace-workbench-registry--parked' },
      h(WorkspaceWorkbench, { workspaceId: 'project', visible: state.mainSurface === 'workbench', viewTargets: focusTargets }),
      h(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, visible: false, viewTargets: targets })),
    h(PmoTeamsTopicFloatingPanel, { floating, setFloating }), h('footer', { className: 'window-status-bar', style: { position: 'fixed', left: 0, right: 0, bottom: 0 } }, h(GlobalSystemNotices)))
}
window.toolbarActionsScene = {
  ready: true, phase, seedCount: phase === 'seed' ? 1 : 0, sourceId, sourceRegion, longName, sourceAddress: formatTabAddress(sourceId),
  releasePreparation() { preparationReleased = true; for (const resolve of preparations.splice(0)) resolve() }, closeFloat() { requestPmoTeamsTopicFloatingClose({ restoreFocus: false }) },
  showFocus() { useAppStore.setState({ mainSurface: 'agents' }) }, flush: () => prepareRendererUpdate('quit'),
  churn() { for (let n = 0; n < 80; n++) useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id !== executionAgent.id ? { ...session, latestOutputBytes: session.latestOutputBytes + 1 } : session) })) },
  facts() { const state = useAppStore.getState(); return {
    tabs: projectPersistedWorkbench(state).tabs, layouts: projectPersistedWorkbench(state).layouts,
    drafts: state.agentComposerDrafts, focus: state.agentFocus, activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
    error: state.error, reads: { ...reads }, control: { ...control },
    identities: state.sessions.map(session => ({ sid: session.id, runId: session.control.run.runId })),
    discussionIds: Object.keys(state.tabs).filter(id => id.startsWith('launcher:')),
    floating: JSON.parse(localStorage.getItem('agentmux.leader-topic-floating.v1') ?? 'null'),
    persistedBytes: localStorage.getItem(useAppStore.persist.getOptions().name),
    title: document.querySelector('.focus-toolbar__identity strong')?.textContent,
    active: document.activeElement?.id ?? document.activeElement?.getAttribute('aria-label')
  } }
}
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider, null, h(Scene)))
