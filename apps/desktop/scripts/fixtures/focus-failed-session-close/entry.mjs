import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createElement as h, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { executionFocusPresentation } from '../../../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { ordinaryWorkbenchViewTargets } from '../../../src/renderer/src/lib/workbench-resource-display'
import { workbenchProjectionSlotId } from '../../../src/renderer/src/lib/workbench-projection'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { TransientErrorNotice } from '../../../src/renderer/src/components/TransientErrorNotice'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'
const phase = new URLSearchParams(location.search).get('phase')
const config = await api.config.get(), initialSnapshot = await api.sessions.snapshot()
const { pendingInteraction: _request, ...base } = initialSnapshot.sessions.find(session => session.kind === 'agent')
const workspace = { ...config.workspaces[0], id: 'failed-close-workspace', hostId: 'local', path: _hygiene_fixturePath("private/failed-close"), name: 'Release work · original drafts retained' }
function agent(id, processState, state, detail) { return { ...base, id, label: id === 'healthy' ? 'Healthy release work' : 'Release agent · original failure details', workspacePath: workspace.path, hostId: 'local', processState,
  status: { state, source: 'run-process', observedAt: Date.now(), ...(detail ? { detail } : {}), ...(processState === 'exited' ? { exitCode: 7, exitReason: 'crashed' } : {}) },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'typed-failed-close-' + id } } } }
const initialAgents = [agent('failed', 'exited', 'error', 'Executor exited before completing the release. Original draft and history are retained.'),
  agent('healthy', 'running', 'working'), agent('refused', 'exited', 'error', 'Previous release failed. Core has not confirmed that its Session can be retired.'),
  agent('unknown', 'interrupted', 'error', 'Runtime observation is unavailable. The original Run state cannot be confirmed.'),
  agent('healthy-error', 'running', 'error', 'History reader is unavailable. Core still reports that the Run is alive.')]
let runtime = await window.failedCloseIO.readRuntime()
if (!runtime) {
  if (phase !== 'first') throw new Error('Second process cannot seed Runtime or the workbench')
  runtime = { sessions: initialAgents }; await window.failedCloseIO.writeRuntime(runtime)
}
api.config.get = async () => ({ ...config, workspaces: [workspace] })
api.sessions.snapshot = async () => ({ ...initialSnapshot, sessions: runtime.sessions, timelines: {}, recoveryCandidates: [] })
api.providers.list = async () => []
api.demands.list = async () => []
api.scratch.listTopics = async () => []
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path })
api.ui.requestStorageFlush = () => window.failedCloseIO.flush()
let publishTransport
api.sessions.onEvent = createRendererSessionEvents(listener => { publishTransport = listener; return () => { publishTransport = undefined } })
const controls = [], reads = { historyPage: 0, timeline: 0, historySources: 0 }
for (const key of Object.keys(reads)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { reads[key]++; return original(...args) } }
let releaseStop
api.sessions.stop = async control => {
  controls.push(structuredClone(control))
  if (control.agentSessionId === 'refused') throw new Error('Registry close was refused; the original Session remains available. Retry when the service is ready.')
  if (control.agentSessionId !== 'failed' || control.run.runId !== 'typed-failed-close-failed') throw new Error('Probe rejects unintended Session control')
  if (controls.filter(item => item.agentSessionId === 'failed').length === 1) await new Promise(done => { releaseStop = done })
}
const originalInitialize = useAppStore.getState().initialize
await originalInitialize()
const originalDrafts = { failed: '原失败草稿：没有发送或丢弃。', healthy: 'Healthy original unsent draft', refused: 'Refused close keeps this draft', unknown: 'Unknown Run keeps this draft' }
const filePath = 'src/release-note.md', fileKey = documentKey(workspace.id, filePath)
let seedCount = 0
function seed() {
  if (phase !== 'first' || seedCount) throw new Error('One workbench seed only; second process must restore')
  seedCount++
  const shared = addWorkbenchRegion(createWorkbenchTab('shared-release-tab', { kind: 'agent', regionId: 'failed-region', phase: 'attached', workspaceId: workspace.id, sessionId: 'failed' }, 'Release work · shared tab'), 'failed-region', 'right',
    { kind: 'agent', regionId: 'healthy-region', phase: 'attached', workspaceId: workspace.id, sessionId: 'healthy' })
  const unknown = createWorkbenchTab('unknown-tab', { kind: 'agent', regionId: 'unknown-region', phase: 'attached', workspaceId: workspace.id, sessionId: 'unknown' }, 'Unknown · keep original')
  const refused = createWorkbenchTab('refused-tab', { kind: 'agent', regionId: 'refused-region', phase: 'attached', workspaceId: workspace.id, sessionId: 'refused' }, 'Refused · retry here')
  const file = createWorkbenchTab('unsaved-file-tab', { kind: 'file', regionId: 'file-region', workspaceId: workspace.id, path: filePath }, 'Unsaved release note')
  useAppStore.setState({ tabs: Object.fromEntries([shared, unknown, refused, file].map(tab => [tab.id, tab])), layouts: { [workspace.id]: createWorkspaceLayout('release-group', [shared.id, unknown.id, refused.id, file.id]) },
    activeWorkspaceId: workspace.id, mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentNames: Object.fromEntries(runtime.sessions.map(session => [session.id, session.label])), agentComposerDrafts: originalDrafts,
    documents: { [fileKey]: { path: filePath, content: 'Unsaved original release note — preserve across closing and restart.', revision: 'original-revision' } }, dirtyDocuments: { [fileKey]: true } })
}
function ErrorSurface() {
  const error = useAppStore(state => state.error), lastError = useAppStore(state => state.lastError), dismissed = useAppStore(state => state.errorDismissed)
  return h(TransientErrorNotice, { error, lastError, dismissed, onDismiss: () => useAppStore.getState().dismissError(), onReopen: () => useAppStore.getState().reopenError() })
}
function Scene() {
  const state = useAppStore()
  const presentation = useMemo(() => executionFocusPresentation(state.agentFocus.execution, state.tabs, spatialCatalog(state, []), reference => useAppStore.getState().selectExecutionFocusReference(reference, state.agentFocus.execution)), [state.agentFocus.execution, state.tabs, state.layouts, state.sessions])
  const targets = useMemo(() => {
    const ordinary = ordinaryWorkbenchViewTargets(state.layouts[workspace.id], state.tabs, workspace.id)
    const result = Object.fromEntries(Object.entries(ordinary).map(([id, list]) => [id, list.map(target => ({ ...target, visible: false }))]))
    const projection = presentation.projection, reference = projection?.selection[0]
    if (projection && reference) (result[reference.tabId] ??= []).push({ hostId: workbenchProjectionSlotId(projection.presentationId + '-slot', reference), active: true, visible: true, surface: 'focus', retainedRegionId: reference.regionId,
      headerPortalTargetId: 'focus-workspace-slot-header', projection, reference, onSelectRegion: regionId => useAppStore.getState().selectExecutionFocusReference({ ...reference, regionId }, state.agentFocus.execution) })
    return result
  }, [state.tabs, state.layouts, state.agentFocus.execution, presentation])
  return h('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column', minHeight: 0 } }, h(GlobalFocusSurface, { presentation, viewTargets: targets }),
    h('div', { className: 'workspace-workbench-registry workspace-workbench-registry--parked' }, h(WorkspaceWorkbench, { workspaceId: workspace.id, visible: false, viewTargets: targets })), h(ErrorSurface))
}
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider, null, h(Scene)))
window.failedCloseProof = {
  ready: true, phase, seed,
  release() { if (!releaseStop) throw new Error('Original pending stop required'); releaseStop(); releaseStop = undefined },
  async confirm() {
    runtime = { sessions: runtime.sessions.filter(session => session.id !== 'failed') }; await window.failedCloseIO.writeRuntime(runtime)
    publishTransport({ type: 'core', hostId: 'local', event: { type: 'run-removed', agentSessionId: 'failed', run: { runId: 'typed-failed-close-failed' }, evidence: { source: 'run-process', observedAt: Date.now() } } })
  },
  async flush() { await prepareRendererUpdate('quit') },
  facts() { const state = useAppStore.getState(); return { originalInitialize: state.initialize === originalInitialize, initialized: !state.loading, seedCount, sessions: state.sessions.map(session => ({ id: session.id, control: session.control, processState: session.processState, detail: session.status.detail })),
    tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts, documents: state.documents, dirty: state.dirtyDocuments, selected: state.agentFocus.execution.sessionId,
    presentedTab: document.querySelector('.focused-tab-workspace')?.dataset.focusTabId ?? null, presentedRegions: [...document.querySelectorAll('.focused-tab-workspace [data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId), controls: [...controls], reads: { ...reads }, error: state.error, panel: document.querySelector('.attention-request-panel')?.innerText ?? null } }
}
