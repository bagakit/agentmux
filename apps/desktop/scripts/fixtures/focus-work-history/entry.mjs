import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createElement as h, useEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../../../src/renderer/src/lib/focus-project-lanes'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { removeSessionProjection } from '../../../src/renderer/src/lib/session-state'
import '../../../src/renderer/src/styles/index.css'

const phase = new URL(location.href).searchParams.get('phase')
if (!['seed', 'restore'].includes(phase)) throw new Error('Exact private ordinary GUI phase required')
window.sceneErrors = []
window.addEventListener('error', event => window.sceneErrors.push({ message: event.message, stack: event.error?.stack }))
window.addEventListener('unhandledrejection', event => window.sceneErrors.push({ message: String(event.reason), stack: event.reason?.stack }))
const publicFacts = await window.workHistorySource.facts()
const clockNow = publicFacts.now
Date.now = () => clockNow // Explicit controlled viewport time; public records are not rewritten.
const initialSnapshot = await api.sessions.snapshot(), initialConfig = await api.config.get()
const base = initialSnapshot.sessions.find(session => session.kind === 'agent')
if (!base) throw new Error('Actual public preview Agent descriptor required')
const workspace = { id: 'work-history-project', name: 'Observed work · controlled layout', hostId: 'local', path: _hygiene_fixturePath("private/work-history-layout"), kind: 'folder' }
const config = { ...initialConfig, workspaces: [workspace] }
const ref = id => ({ kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id === publicFacts.controlledId ? 'controlled-layout-run' : 'original-workface-run' } })
const workface = { ...base, id: 'original-workface', hostId: 'local', workspacePath: workspace.path, label: 'Original retained workface',
  processState: 'interrupted', semanticStatus: undefined, status: { state: 'disconnected', source: 'run-process', observedAt: clockNow }, control: ref('original-workface') }
const current = { ...base, id: publicFacts.controlledId, hostId: 'local', workspacePath: workspace.path, label: 'Two rounds · observed completion',
  processState: 'running', semanticStatus: { state: 'done', source: 'acp', observedAt: clockNow, stateEnteredAt: clockNow - 1800000 },
  status: { state: 'done', source: 'acp', observedAt: clockNow }, control: ref(publicFacts.controlledId) }
const controlledHistory = await window.workHistorySource.timeline(publicFacts.controlledId)
const snapshots = phase === 'seed' ? [workface, current] : [workface]
const timelines = phase === 'seed' ? { [publicFacts.controlledId]: controlledHistory } : {}
const reads = { timeline: 0, historyPage: 0, sources: 0 }, controls = { launchAgent: 0, stop: 0, resume: 0, recover: 0, write: 0 }
api.config.get = async () => config
api.sessions.snapshot = async () => ({ ...initialSnapshot, sessions: snapshots, timelines, recoveryCandidates: [] })
api.providers.list = async () => []
api.demands.list = async () => []
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path })
api.workspaces.appearance = async () => ({ kind: 'repository', icon: null })
api.scratch.listTopics = async () => []
api.sessions.timeline = async reference => { reads.timeline++; return window.workHistorySource.timeline(reference.agentSessionId) }
api.sessions.historySources = async () => { reads.sources++; return window.workHistorySource.sources() }
api.sessions.historyPage = async reference => { reads.historyPage++; return window.workHistorySource.historyPage(reference.agentSessionId) }
for (const method of Object.keys(controls)) api.sessions[method] = async () => { controls[method]++; throw new Error('No Run control is allowed in this read-only private scene') }
const tabId = 'history-retained-tab', regionId = 'history-retained-region', groupId = 'history-original-group'
if (phase === 'seed') {
  const first = createWorkbenchTab(tabId, { workspaceId: workspace.id, regionId, kind: 'agent', phase: 'attached', sessionId: workface.id }, 'Original two-Region workface')
  const original = addWorkbenchRegion(first, regionId, 'right', { workspaceId: workspace.id, regionId: 'history-second-region', kind: 'agent', phase: 'attached', sessionId: workface.id })
  const neighbor = createWorkbenchTab('history-neighbor-tab', { workspaceId: workspace.id, regionId: 'history-neighbor-region', kind: 'agent', phase: 'attached', sessionId: workface.id }, 'Original neighboring Tab')
  const layout = moveTabToNewGroup(createWorkspaceLayout('history-neighbor-group', [neighbor.id, tabId]), tabId, 'history-neighbor-group', 'history-neighbor-group', 'right', groupId)
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { [tabId]: original, [neighbor.id]: neighbor }, layouts: { [workspace.id]: { ...layout, activeGroupId: groupId } } }),
    mainSurface: 'agents', activeWorkspaceId: workspace.id, toolsOpen: false, projectRailOpen: false, focusTimelineHeight: 270,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [regionId]: 'Original unsent request · retain exact text', 'history-second-region': 'Second Region draft', [workface.id]: 'Original Session draft' }
  } }))
}
// Original first-party persistence/initializer, same profile; second phase has
// no localStorage seed, setState restoration or copied projected history.
await useAppStore.getState().initialize()
const selector = createFocusProjectionSelector()
const facts = () => {
  const state = useAppStore.getState(), persisted = projectPersistedWorkbench(state)
  return { tabs: persisted.tabs, layouts: persisted.layouts, drafts: state.agentComposerDrafts, focus: state.agentFocus,
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, height: state.focusTimelineHeight,
    identities: state.sessions.map(session => ({ sid: session.id, control: session.control })), reads: { ...reads }, controls: { ...controls }, errors: window.sceneErrors }
}
window.focusWorkHistoryProbe = { ready: false, phase, seedCount: phase === 'seed' ? 1 : 0, facts,
  publicFacts, flush: () => prepareRendererUpdate('quit'),
  closeObserved() { if (phase !== 'seed') throw new Error('Zero-seed restore cannot replace Store'); useAppStore.setState(state => removeSessionProjection(state, publicFacts.controlledId)) },
  geometry() {
    const work = [...document.querySelectorAll('[data-work-end]')].map(node => ({ run: node.dataset.runId, start: Number(node.dataset.workingEnteredAt), through: Number(node.dataset.workingThrough), end: node.dataset.workEnd, rect: node.getBoundingClientRect().toJSON(), label: node.getAttribute('aria-label') }))
    return { width: innerWidth, work, trackHeights: [...document.querySelectorAll('.recent-focus__track')].map(node => node.getBoundingClientRect().height), timeline: document.querySelector('.recent-focus')?.getBoundingClientRect().toJSON(),
      workface: document.querySelector('.workspace-workbench')?.getBoundingClientRect().toJSON(), regions: [...document.querySelectorAll('[data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId),
      unknown: document.querySelector('[data-work-end="unknown"]')?.getBoundingClientRect().toJSON(), live: document.querySelectorAll('.recent-focus__live').length,
      errors: window.sceneErrors, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  }
}
function Scene() {
  const state = useAppStore(), contexts = selector({ sessions: state.sessions, timelines: state.timelines, agentNames: state.agentNames, config: state.config, scratchTopicSnapshots: state.scratchTopicSnapshots }).contexts
  const lanes = useMemo(() => deriveFocusProjectLanes(contexts, state.config), [contexts, state.config])
  useEffect(() => { window.focusWorkHistoryProbe.ready = true }, [])
  return h('section', { style: { height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { style: { flex: '1 1 0', minHeight: 0 } }, h(WorkspaceWorkbench, { workspaceId: workspace.id, visible: true })),
    h(RecentFocusTimeline, { entries: [], currentSessionId: null, contexts, lanes, onSelect() { throw new Error('Historical inspection must not focus or restore a Run') } }))
}
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider, null, h(Scene)))
