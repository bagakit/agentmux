import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import '../../../src/renderer/src/styles/index.css'

const request = window.projectHistoryBoundary.request
const setup = await request('setup')
const [alpha, beta] = setup.config.workspaces
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.scratch.listTopics = async () => []
api.workspaces.appearance = async id => request('appearance', id)
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: setup.config.workspaces.find(workspace => workspace.id === id).path })
api.sessions.snapshot = async () => request('snapshot')
api.sessions.attach = async (control, afterByte) => request('attach', control, afterByte)
api.sessions.detach = async id => request('detach', id)
api.sessions.replay = async (id, afterByte) => request('replay', id, afterByte)
api.sessions.resize = async (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = async (control, data, source) => request('write', control, data, source)
api.sessions.stop = async control => request('stop', control)
api.sessions.resolve = async control => request('resolve', control)
api.sessions.refresh = async control => request('refresh', control)
api.sessions.recover = async (control, path) => request('recover', control, path)
api.sessions.launchTerminal = async input => request('launch', input)
api.sessions.launchAgent = async input => request('launch-agent', input)
api.sessions.historyPage = async (control, options) => request('history', control, options)
api.sessions.timeline = async control => request('timeline', control)
api.sessions.historySources = async () => request('history-sources')
api.sessions.onEvent = createRendererSessionEvents(listener => window.projectHistoryBoundary.onEvent(listener))
api.ui.requestStorageFlush = async () => request('flush')
let ids = setup.ids
if (setup.phase === 'seed') {
  const { session: keep } = await request('launch-agent', { hostId: 'local', executorId: 'codex', workspacePath: alpha.path })
  const archive = await request('launch', { hostId: 'local', workspacePath: beta.path })
  const original = await request('launch', { hostId: 'local', workspacePath: alpha.path })
  const companion = await request('launch', { hostId: 'local', workspacePath: alpha.path })
  const keepTab = createWorkbenchTab('keep-tab', { regionId: 'keep-region', kind: 'agent', phase: 'attached', workspaceId: alpha.id, sessionId: keep.id })
  const archiveTab = createWorkbenchTab('archive-tab', { regionId: 'archive-region', kind: 'terminal', phase: 'attached', workspaceId: beta.id, sessionId: archive.id })
  const originalTab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'terminal', phase: 'attached', workspaceId: alpha.id, sessionId: original.id })
  originalTab.layout = splitWorkbenchRegion(originalTab.layout, 'original-region', 'right', 'companion-region')
  originalTab.layout.root.ratio = 0.61
  originalTab.regions['companion-region'] = { regionId: 'companion-region', kind: 'terminal', phase: 'attached', workspaceId: alpha.id, sessionId: companion.id }
  const alphaLayout = createWorkspaceLayout('alpha-group', [keepTab.id, originalTab.id])
  alphaLayout.groups[0].activeTabId = originalTab.id
  const betaLayout = createWorkspaceLayout('beta-group', [archiveTab.id])
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { [keepTab.id]: keepTab, [archiveTab.id]: archiveTab, [originalTab.id]: originalTab }, layouts: { [alpha.id]: alphaLayout, [beta.id]: betaLayout } }),
    activeWorkspaceId: alpha.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    focusTimelineHeight: 208, agentComposerDrafts: { [keep.id]: 'A real unsent draft remains' }
  } }))
  ids = { keep: keep.id, keepRun: keep.control.run.runId, archive: archive.id, original: original.id, companion: companion.id, originalRun: original.control.run.runId }
  await request('save-ids', ids)
}
window.projectHistoryIds = ids
window.projectHistoryState = () => {
  const state = useAppStore.getState(), durable = projectPersistedWorkbench(state)
  return { tabs: durable.tabs, layouts: durable.layouts, focus: state.agentFocus, drafts: state.agentComposerDrafts, activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, height: state.focusTimelineHeight, error: state.error }
}
window.projectHistoryObservation = () => readTerminalViewObservation({ regionId: 'original-region', sessionId: ids.original, runId: ids.originalRun })
window.projectHistoryUi = () => ({
  projects: [...document.querySelectorAll('[data-timeline-project]')].filter(node => !node.hidden).map(node => ({ key: node.dataset.timelineProject, name: node.querySelector('strong').textContent, count: Number(node.querySelector('.recent-focus__project-heading small').textContent), expanded: node.querySelector('button').getAttribute('aria-expanded') })),
  tracks: [...document.querySelectorAll('.recent-focus__track')].filter(node => !node.hidden).map(node => ({ id: node.dataset.focusTimelineId, historical: node.dataset.historyOnly, name: node.querySelector('.recent-focus__gutter > span').textContent })),
  originalRegion: !!document.querySelector('[data-workbench-region-id="original-region"]'),
  companionRegion: !!document.querySelector('[data-workbench-region-id="companion-region"]'),
  originalTerminal: !!document.querySelector('[data-workbench-region-id="original-region"] .xterm'),
  currentFocus: useAppStore.getState().agentFocus.execution.sessionId
})
window.projectHistoryPrepare = async () => {
  if (setup.phase === 'seed') {
    for (const [id, name] of [[ids.keep, 'Context research'], [ids.archive, 'Closed review'], [ids.original, 'Focused work'], [ids.companion, 'Build checks']]) useAppStore.getState().renameAgent(id, name)
    // Controlled historical timestamps enter through the real Store writer. They describe
    // observed Focus visits, never a real elapsed Run duration or human send timestamp.
    const clock = Date.now, now = clock()
    try {
      Date.now = () => now - 2 * 3600000; useAppStore.getState().focusExecutionSession(ids.keep)
      Date.now = () => now - 3600000; useAppStore.getState().focusExecutionSession(ids.archive)
      Date.now = () => now - 30 * 60000; useAppStore.getState().focusExecutionSession(ids.original)
    } finally { Date.now = clock }
    if (!await useAppStore.getState().closeTab(alpha.id, 'alpha-group', 'keep-tab', { keepAgentSessions: true })) throw new Error('keepSession close failed')
    if (!await useAppStore.getState().closeTab(beta.id, 'beta-group', 'archive-tab')) throw new Error('Terminal archive close failed')
  }
  useAppStore.getState().setMainSurface('agents')
  useAppStore.getState().setFocusTimelineHeight(208)
}
window.projectHistoryFlush = async () => { prepareRendererUpdate(); await request('flush') }
createRoot(document.getElementById('root')).render(createElement(App))
window.projectHistoryReady = true
