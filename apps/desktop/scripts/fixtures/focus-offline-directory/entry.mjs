import { fixturePath as _hygiene_fixturePath, fixtureYear as _hygiene_fixtureYear } from "../../lib/fixture-values.mjs"
import { createElement as h, useEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { executionFocusPresentation } from '../../../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { workbenchProjectionSlotId } from '../../../src/renderer/src/lib/workbench-projection'
import { scratchTopicsForWorkspace } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

const phase = new URL(location.href).searchParams.get('phase')
if (!['seed', 'restore'].includes(phase)) throw new Error('Exact ordinary GUI phase required')
window.sceneErrors = []
window.addEventListener('error', event => window.sceneErrors.push({ message: event.message, stack: event.error?.stack }))
window.addEventListener('unhandledrejection', event => window.sceneErrors.push({ message: String(event.reason), stack: event.reason?.stack }))
const originalSnapshot = await api.sessions.snapshot(), originalConfig = await api.config.get()
const base = originalSnapshot.sessions.find(session => session.kind === 'agent' && session.id === 'session-codex')
if (!base) throw new Error('Nonempty public preview Agent input required')
const projectNames = ['Terminal reading', 'Release review', 'Knowledge search', 'Conversation tools', 'Workspace layout', 'Design system', 'Provider adapters', 'Project planning', 'Runtime observations', 'Documentation', 'Research notes', 'Keyboard navigation', 'Performance study', 'Recovery workflow', 'Browser tools', 'Local editing', 'Team coordination', 'Topic organization', 'Product feedback', 'Archive indexing']
const workspaces = projectNames.map((name, index) => ({ id: `directory-project-${index + 1}`, name, hostId: 'local', path: (_hygiene_fixturePath("private/directory-fixture/project-") + (index + 1) + ""), kind: 'folder' }))
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath("private/directory-fixture/topics"), kind: 'folder' }
const topic = (id, title, summary) => ({ id, title, summary, collaborators: [], directoryPath: `${scratch.path}/${scratchTopicDirectoryName(id)}`, topicPath: `${scratch.path}/${scratchTopicDirectoryName(id)}/topic.md` })
const topics = [topic('launcher:reading', '连续阅读与离线工作目录', 'Keep the original workface while improving everyday reading.'), topic('launcher:research', 'Research and implementation notes', 'Observed notes from the previous review, with their original context.')]
const primary = { ...topic(PMO_TEAMS_TOPIC_ID, 'Mote', ''), soul: { path: `${scratch.path}/${scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)}/SOUL.md`, content: '# Mote', version: 'fixture-v1' } }
const config = { ...originalConfig, workspaces: [...workspaces, scratch] }
const fixedTime = Date.UTC(_hygiene_fixtureYear, 9, 5, 12, 15)
const names = ['Keep continuous terminal reading stable', 'Review the original workspace and tab identity', 'Research clear, readable context directories', 'Restore keyboard focus to the exact entry', 'Check narrow window scrolling and hit targets', '保留原会话与未发送的草稿']
const offlineSessions = Array.from({ length: 67 }, (_, index) => {
  const id = index === 0 ? base.id : `offline-${String(index + 1).padStart(3, '0')}`
  const workspacePath = index < 60 ? workspaces[Math.floor(index / 3)].path : topics[index < 64 ? 0 : 1].directoryPath
  return { ...base, id, hostId: 'local', workspacePath, label: `${names[index % names.length]} · ${index + 1}`, processState: 'interrupted', semanticStatus: undefined, pendingInteraction: undefined,
    status: { state: 'disconnected', source: 'run-process', observedAt: fixedTime },
    control: { ...base.control, hostId: 'local', agentSessionId: id, run: { ...base.control.run, runId: index === 0 ? base.control.run.runId : `retained-offline-run-${index + 1}` } } }
})
const timelines = Object.fromEntries(offlineSessions.flatMap((session, index) => index % 3 === 2 ? [] : [[session.id, { agentSessionId: session.id, revision: 1, items: [{ id: `observed-${index}`, agentSessionId: session.id, kind: index % 4 === 1 ? 'user_message' : 'assistant_message', status: 'complete', source: 'native-hook', createdAt: fixedTime + index * 60000, updatedAt: fixedTime + index * 60000, title: 'Observed conversation', content: index % 4 === 1 ? 'Please check the saved layout and keep the same Session, original Region, and unsent request.' : 'Verified scrolling and focus return while retaining the original Session. The known transcript excerpt remains available for review.' }] }]]))
const live = { ...offlineSessions[0], id: 'typed-live', label: 'Continue active implementation', processState: 'running', status: { state: 'working', source: 'run-process', observedAt: fixedTime }, control: { ...base.control, agentSessionId: 'typed-live', run: { runId: 'typed-private-live-run' } } }
const reads = { timeline: 0, historyPage: 0, historySources: 0 }, control = { launchAgent: 0, stop: 0, resume: 0, recover: 0, write: 0 }
api.config.get = async () => config
api.sessions.snapshot = async () => ({ ...originalSnapshot, sessions: offlineSessions, timelines, recoveryCandidates: [] })
api.providers.list = async () => []
api.demands.list = async () => []
api.workspaces.listBranches = async id => {
  const workspace = config.workspaces.find(item => item.id === id)
  if (!workspace) throw new Error('Exact private workspace unavailable: ' + id)
  return { kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path }
}
api.workspaces.appearance = async () => ({ kind: 'repository', icon: null })
api.scratch.listTopics = async id => id === SCRATCH_WORKSPACE_ID ? [...topics, primary] : []
api.scratch.readTopic = async (_workspace, id) => [...topics, primary].find(item => item.id === id) ?? null
api.scratch.ensureMote = async (_workspace, id) => [...topics, primary].find(item => item.id === id) ?? primary
const originalTimeline = api.sessions.timeline
api.sessions.timeline = async value => { reads.timeline++; return timelines[value.agentSessionId] ?? originalTimeline(value) }
for (const method of ['historyPage', 'historySources']) { const original = api.sessions[method]; api.sessions[method] = (...args) => { reads[method]++; return original(...args) } }
for (const method of Object.keys(control)) { const original = api.sessions[method]; api.sessions[method] = (...args) => { control[method]++; return original(...args) } }
const workspaceId = workspaces[0].id, tabId = 'retained-directory-tab', regionId = 'retained-directory-region', groupId = 'exact-directory-owner-group'
const reference = { displayWorkspaceId: workspaceId, groupId, tabId, regionId }
if (phase === 'seed') {
  const first = createWorkbenchTab(tabId, { workspaceId, regionId, kind: 'agent', phase: 'attached', sessionId: base.id }, 'Original workface · two retained Regions')
  const original = addWorkbenchRegion(first, regionId, 'right', { workspaceId, regionId: 'retained-directory-second-region', kind: 'agent', phase: 'attached', sessionId: base.id })
  const decoy = createWorkbenchTab('retained-directory-neighbor', { workspaceId, regionId: 'retained-neighbor-region', kind: 'agent', phase: 'attached', sessionId: base.id }, 'Other original view')
  const layout = moveTabToNewGroup(createWorkspaceLayout('original-directory-group', [decoy.id, original.id]), original.id, 'original-directory-group', 'original-directory-group', 'right', groupId)
  const layouts = Object.fromEntries(config.workspaces.map(item => [item.id, item.id === workspaceId ? { ...layout, activeGroupId: groupId } : createWorkspaceLayout(`retained-empty-${item.id}`)]))
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { [original.id]: original, [decoy.id]: decoy }, layouts }),
    activeWorkspaceId: workspaceId, mainSurface: 'agents', projectRailOpen: false, toolsOpen: false, focusTimelineHeight: 96,
    agentNames: Object.fromEntries(offlineSessions.map(session => [session.id, session.label])),
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [regionId]: 'Original Region unsent request · do not replace', 'retained-directory-second-region': 'Second original Region draft', [base.id]: 'Keep the exact original Session draft' }
  } }))
}
// Second ordinary GUI executes this owner against the existing profile, with no
// second seed, Store replacement, restore hook or post-initialize setState.
await useAppStore.getState().initialize()
const rect = node => node?.getBoundingClientRect().toJSON() ?? null
window.offlineDirectoryProbe = {
  ready: false, phase, seedCount: phase === 'seed' ? 1 : 0, firstId: base.id, lastId: offlineSessions.at(-1).id, reference,
  mixed() { if (phase !== 'seed') throw new Error('Restore cannot inject Store inputs'); useAppStore.setState({ sessions: [...offlineSessions, live] }) },
  onlyOffline() { if (phase !== 'seed') throw new Error('Restore cannot inject Store inputs'); useAppStore.setState({ sessions: offlineSessions }) },
  selectOriginal() { if (phase !== 'seed') throw new Error('Restore cannot seed Focus'); useAppStore.getState().focusExecutionSession(base.id, reference) },
  flush: () => prepareRendererUpdate('quit'),
  facts() {
    const state = useAppStore.getState(), persisted = projectPersistedWorkbench(state)
    return { tabs: persisted.tabs, layouts: persisted.layouts, drafts: state.agentComposerDrafts, focus: state.agentFocus, activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, timelineHeight: state.focusTimelineHeight,
      identities: state.sessions.map(session => ({ sid: session.id, runId: session.control.run.runId, workspacePath: session.workspacePath })), control: { ...control }, reads: { ...reads }, error: state.error }
  },
  geometry() {
    const main = document.querySelector('.global-focus-main'), canvas = document.querySelector('.global-board-columns'), directory = document.querySelector('.focus-disconnected-projects'), rows = directory?.querySelector('.focus-project-lanes__rows')
    const cards = [...(directory?.querySelectorAll('.focus-context--directory') ?? [])]
    const overflow = [...(directory?.querySelectorAll('.focus-project-lanes__rows, .focus-project-lanes__track, .focus-disconnected-projects__cards, .focus-context--directory') ?? [])].filter(node => node.clientWidth > 0).map(node => ({ className: node.className, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }))
    return { width: innerWidth, main: rect(main), canvas: rect(canvas), directory: rect(directory), rows: rect(rows), expanded: directory?.dataset.expanded,
      count: cards.length, projectCount: new Set([...directory.querySelectorAll('[data-project-id]')].map(node => node.dataset.projectId)).size, laneCount: directory.querySelectorAll('[data-lane-id]').length,
      cardWidths: cards.map(node => node.getBoundingClientRect().width), cardHeights: cards.map(node => node.getBoundingClientRect().height), columnCount: directory.querySelector('.focus-disconnected-projects__cards') ? getComputedStyle(directory.querySelector('.focus-disconnected-projects__cards')).gridTemplateColumns.split(' ').length : 0,
      scrollTop: rows?.scrollTop ?? 0, scrollHeight: rows?.scrollHeight ?? 0, clientHeight: rows?.clientHeight ?? 0, horizontalOverflow: overflow.some(item => item.scrollWidth > item.clientWidth + 1), overflow,
      liveHidden: document.querySelector('.focus-project-board__live')?.hidden, focusedSession: document.activeElement?.dataset.sessionId, focusedLane: document.activeElement?.closest('[data-lane-id]')?.dataset.laneId,
      knownRecap: cards.some(node => node.querySelector('.focus-context__excerpt-source')), unknownRecap: cards.some(node => node.textContent.includes('No excerpt recorded')), knownTime: cards.some(node => node.querySelector('time')), unknownTime: cards.some(node => node.textContent.includes('Activity time unknown')) }
  }
}
function Scene() {
  const state = useAppStore()
  const catalog = useMemo(() => spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch) ?? []), [state.config, state.tabs, state.layouts, state.sessions, state.spaceZoneBindings, state.scratchTopicSnapshots])
  const presentation = useMemo(() => executionFocusPresentation(state.agentFocus.execution, state.tabs, catalog, reference => useAppStore.getState().focusExecutionSession(state.agentFocus.execution.sessionId, reference)), [state.agentFocus.execution, state.tabs, catalog])
  const projection = presentation.projection, selected = projection?.selection[0]
  const viewTargets = selected && projection ? { [selected.tabId]: [{ hostId: workbenchProjectionSlotId(`${projection.presentationId}-slot`, selected), active: true, visible: true, surface: 'focus', retainedRegionId: selected.regionId, headerPortalTargetId: 'focus-workspace-slot-header', projection, reference: selected, onSelectRegion: regionId => projection.onSelect({ ...selected, regionId }) }] } : {}
  const focusSource = Boolean(selected && state.tabs[selected.tabId]?.workspaceId === workspaceId)
  useEffect(() => { window.offlineDirectoryProbe.ready = true }, [])
  // App's retained home tree is out of flow and hidden/inert until this exact
  // workspace is a Focus source. visible=false alone does not supply that host.
  return h('section', { className: 'workspace-main-surface', style: { width: '100vw', height: '100vh', position: 'relative' } },
    h(GlobalFocusSurface, { presentation, viewTargets }),
    h('div', { className: `workspace-workbench-registry${focusSource ? '' : ' workspace-workbench-registry--parked'}`, 'aria-hidden': !focusSource, inert: !focusSource },
      h('div', { className: `workspace-workbench-slot${focusSource ? ' workspace-workbench-slot--focus-source' : ' workspace-workbench-slot--parked'}`, 'data-workspace-id': workspaceId, 'data-visible': focusSource ? 'true' : 'false', 'aria-hidden': !focusSource, inert: !focusSource },
        h(WorkspaceWorkbench, { workspaceId, visible: false, viewTargets }))))
}
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider, null, h(Scene)))
