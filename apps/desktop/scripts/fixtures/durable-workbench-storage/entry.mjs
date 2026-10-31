import { createElement as h } from 'react'
import { App } from '../../../src/renderer/src/App'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { desktopUserFragments } from '../../../src/renderer/src/lib/desktop-user-state'
import { DESKTOP_FRAGMENT_KEYS } from '../../../src/renderer/src/lib/desktop-user-fragments'
import { auxiliaryUserValues } from '../../../test/helpers/auxiliary-user-values'
import '../../../src/renderer/src/styles/index.css'

window.terminals = []
const request = window.durableRestart.request
const setup = await request('setup'), workspace = setup.config.workspaces[0]
const auxiliary = auxiliaryUserValues(workspace.id)
const tabId = 'original-workface', terminalRegion = 'original-terminal', fileRegion = 'original-file'
const queueId = 'original-retained-agent', queue = [{ operationId: 'original-queued-input', runId: 'original-retained-run',
  text: 'Original queued user input; do not replay', status: 'deferred', awaitingExplicitSend: true, enqueuedAt: 1 }]
const originalFile = '# Original file\n\nOriginal unsaved content survives.\n'
api.config.get = async () => setup.config
api.providers.list = async options => options?.observation ? { catalog: [], warnings: [] } : []
api.demands.list = async () => []
api.spatial.read = () => request('spatial-read')
api.spatial.commit = value => request('spatial-commit', value)
api.spatial.retainLabels = value => request('spatial-labels', value)
api.spatial.onChange = window.durableRestart.onSpatialChange
api.ui.readWorkbenchState = () => request('user-read')
api.ui.writeWorkbenchState = value => request('user-write', value)
api.ui.importWorkbenchState = value => request('user-import', value)
api.ui.requestStorageFlush = () => request('flush')
api.sessions.snapshot = () => request('snapshot')
api.sessions.attach = (control, afterByte) => request('attach', control, afterByte)
api.sessions.detach = attachment => request('detach', attachment)
api.sessions.replay = (attachment, afterByte) => request('replay', attachment, afterByte)
api.sessions.resize = (attachment, cols, rows) => request('resize', attachment, cols, rows)
api.sessions.write = (control, value, source) => request('write', control, value, source)
api.sessions.refresh = control => request('refresh', control)
api.sessions.onEvent = createRendererSessionEvents(window.durableRestart.onSessionEvent)
for (const operation of ['launchAgent', 'launchTerminal', 'recover', 'stop', 'submitPrompt']) api.sessions[operation] = () => {
  throw Error('Recovery must not issue lifecycle or replayed input: ' + operation)
}
api.files.readDirectory = async () => [{ name: 'notes.md', path: 'notes.md', isDirectory: false, isSymlink: false }]
api.files.read = async (_workspace, path) => ({ status: 'read', document: { path, revision: 'original-file-revision', content: '# Original file\n' } })
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.notesStorage.inspect = async () => ({ directory: workspace.path + '/notes', catalogPath: workspace.path + '/notes/notebooks.json',
  resourceChanges: [], directoryChanges: [], operation: null })
api.spaceObjects.appearance = async () => ({ local: true, icon: null })
window.agentmux = { git: { status: async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path }) } }

if (setup.phase === 'seed') {
  const terminal = createWorkbenchTab(tabId, { kind: 'terminal', phase: 'attached', regionId: terminalRegion,
    workspaceId: workspace.id, sessionId: setup.session.id })
  const tab = addWorkbenchRegion(terminal, terminalRegion, 'right', { kind: 'file', regionId: fileRegion, workspaceId: workspace.id, path: 'notes.md' })
  tab.layout.root.ratio = 0.58
  tab.layout.activeRegionId = terminalRegion
  const retained = createWorkbenchTab('original-other-tab', { kind: 'launcher', regionId: 'original-other-region', workspaceId: workspace.id })
  const layout = createWorkspaceLayout('original-group', [tab.id, retained.id])
  layout.groups[0].activeTabId = tab.id
  const graph = desktopSpatialGraph({ config: setup.config, tabs: { [tab.id]: tab, [retained.id]: retained },
    sessions: [setup.session], layouts: { [workspace.id]: layout }, spaceZoneBindings: {}, spatialRequests: {} }, [])
  await api.spatial.commit({ expectedRevision: 0, graph })
  // Existing user bytes are seeded once in the outgoing browser owner. Real
  // hydration must import them; later processes never seed user or spatial data.
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: {
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    agentComposerDrafts: { [terminalRegion]: 'Original legacy draft' }, agentSteerQueues: { [queueId]: queue },
    documents: { [workspace.id + '\0notes.md']: { path: 'notes.md', revision: 'original-file-revision', content: originalFile } },
    dirtyDocuments: { [workspace.id + '\0notes.md']: true }
  } }))
  for (const [key, raw] of Object.entries(auxiliary.legacy)) localStorage.setItem(key, raw)
}

const initialize = useAppStore.getState().initialize
useAppStore.setState({ initialize: async () => {
  const dispose = await initialize()
  if (setup.phase === 'seed') {
    useAppStore.getState().setAgentComposerDraft(terminalRegion, 'Latest native-host draft survives both exit modes')
    useAppStore.getState().updateDocument(tabId, originalFile + '\nLatest unsaved annotation.\n', fileRegion)
    useAppStore.getState().focusRegion(workspace.id, tabId, terminalRegion, 'navigation', 'original-group')
  }
  window.durableRestartReady = true
  return dispose
} })

window.durableRestartFacts = () => {
  const state = useAppStore.getState(), persisted = projectPersistedWorkbench(state)
  return { phase: setup.phase, seeded: setup.phase === 'seed', loading: state.loading,
    tabs: persisted.tabs, layouts: persisted.layouts, selection: state.workbenchSpaceSelection,
    focus: state.agentFocus, drafts: state.agentComposerDrafts, queues: state.agentSteerQueues,
    documents: Object.fromEntries(Object.entries(state.documents).filter(([key]) => state.dirtyDocuments[key])),
    dirtyDocuments: Object.fromEntries(Object.entries(state.dirtyDocuments).filter(([, dirty]) => dirty)),
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
    error: state.error, saveWarning: state.workbenchSaveWarning,
    originalLegacyPresent: localStorage.getItem('agentmux-workbench-v1') !== null,
    auxiliary: Object.fromEntries(Object.keys(DESKTOP_FRAGMENT_KEYS).map(name => [name, desktopUserFragments.read(name)])),
    auxiliaryLegacyPresent: Object.keys(auxiliary.legacy).some(key => localStorage.getItem(key) !== null),
    regions: [...document.querySelectorAll('[data-workbench-region-id]')].filter(node => node.getClientRects().length)
      .map(node => node.dataset.workbenchRegionId).sort(),
    terminal: window.terminals.map(terminal => ({ connected: Boolean(terminal.element?.isConnected),
      regionId: terminal.element?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId,
      lines: Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString()).join('\n') })) }
}
window.agentmuxPrepareRendererUpdate = intent => prepareRendererUpdate(intent)
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider, null, h(App)))
