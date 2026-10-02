import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import '../../../src/renderer/src/styles/index.css'

window.terminals = []
const request = window.hostUiBoundary.request
const setup = await request('setup')
api.config.get = async () => setup.config
api.spatial = {
  read: () => request('spatial-read'), commit: input => request('spatial-commit', input),
  onChange: listener => window.hostUiBoundary.onSpatialChange(listener)
}
api.providers.list = () => request('providers')
api.demands.list = async () => []
api.scratch.listTopics = async () => []
api.executors.detect = (executorId, hostId) => request('detect', executorId, hostId)
api.hosts.check = host => request('check-host', host)
for (const method of ['readDirectory', 'read', 'write']) {
  api.files[method] = (...args) => request(`file-${method}`, ...args)
}
// File observation, Git/browser metadata and the empty-host candidate are controlled optional
// facts. Creation, files, discovery, Sessions, output and durable spatial storage are real owners.
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.sessions.snapshot = () => request('snapshot')
api.sessions.launchAgent = input => request('launch-agent', input)
api.sessions.launchTerminal = input => request('launch-terminal', input)
api.sessions.creation = (host, id) => request('creation', host, id)
api.sessions.attach = (control, byte) => request('attach', control, byte)
api.sessions.replay = (id, byte) => request('replay', id, byte)
api.sessions.detach = id => request('detach', id)
api.sessions.resize = (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = (control, data, source) => request('write', control, data, source)
api.sessions.paste = (control, text, data) => request('paste', control, text, data)
api.sessions.resolve = control => request('resolve', control)
api.sessions.refresh = control => request('refresh', control)
api.sessions.stop = control => request('stop', control)
api.sessions.submitPrompt = (...args) => request('submit-prompt', ...args)
api.sessions.submitMessage = (...args) => request('submit-message', ...args)
api.sessions.onEvent = createRendererSessionEvents(listener => window.hostUiBoundary.onEvent(listener))
api.ui.requestStorageFlush = () => request('flush')

if (setup.phase === 'seed') {
  const healthy = await request('seed-local')
  let tab = createWorkbenchTab('host-ui-original-tab', {
    regionId: 'host-ui-launcher-a', kind: 'launcher', workspaceId: 'host-ui-local'
  })
  tab = addWorkbenchRegion(tab, 'host-ui-launcher-a', 'right', {
    regionId: 'host-ui-launcher-b', kind: 'launcher', workspaceId: 'host-ui-local'
  })
  tab = addWorkbenchRegion(tab, 'host-ui-launcher-b', 'down', {
    regionId: 'host-ui-local-terminal', kind: 'terminal', phase: 'attached',
    workspaceId: 'host-ui-local', sessionId: healthy.id
  })
  tab.layout.activeRegionId = 'host-ui-launcher-a'
  const workbench = { tabs: { [tab.id]: tab }, layouts: {
    'host-ui-local': createWorkspaceLayout('host-ui-original-group', [tab.id])
  } }
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench(workbench), activeWorkspaceId: 'host-ui-local',
    mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    agentComposerDrafts: { 'host-ui-launcher-b': setup.secondDraft }
  } }))
}

const visible = element => {
  if (!element?.isConnected || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
}
window.hostUiState = () => {
  const state = useAppStore.getState()
  return JSON.parse(JSON.stringify({ ...projectPersistedWorkbench(state), loading: state.loading,
    activeWorkspaceId: state.activeWorkspaceId, drafts: state.agentComposerDrafts,
    names: state.launcherNameDrafts, options: state.launcherOptionDrafts,
    warm: state.warmTerminal, focus: state.agentFocus, error: state.error,
    pendingLaunches: Object.fromEntries(Object.entries(state.pendingAgentLaunches).map(([id, pending]) => [id, {
      request: pending.request ? { executorId: pending.request.executorId, hostId: pending.request.hostId,
        workspacePath: pending.request.workspacePath, prompt: pending.request.prompt } : null,
      created: pending.created ? { agentSessionId: pending.created.agentSessionId, hostId: pending.created.hostId,
        workspacePath: pending.created.workspacePath, run: pending.created.run } : null,
      bufferedEventCount: pending.events.length, overflowed: pending.overflowed
    }])),
    launcherPresentation: useLauncherState.getState(),
    sessions: state.sessions.map(one => ({ id: one.id, kind: one.kind, hostId: one.hostId,
      workspacePath: one.workspacePath, state: one.state, control: one.control, executorId: one.executorId })),
    regions: [...document.querySelectorAll('[data-workbench-region-id]')].filter(visible).map(one => ({
      id: one.dataset.workbenchRegionId, text: one.innerText,
      width: one.getBoundingClientRect().width, height: one.getBoundingClientRect().height
    })) }))
}
window.hostUiFlush = async () => { await prepareRendererUpdate(); await request('flush') }
window.hostUiNative = (regionId, sessionId, runId) => readTerminalViewObservation({ regionId, sessionId, runId })
// Presentation-only setup for the final screenshot. Launcher execution never uses these helpers.
window.hostUiFocusAgent = id => {
  useAppStore.getState().focusExecutionSession(id)
  useAppStore.getState().setMainSurface('agents')
}
window.hostUiRevealWorkbench = () => useAppStore.getState().setMainSurface('workbench')
createRoot(document.getElementById('root')).render(createElement(DesktopClientUiProvider, null, createElement(App)))
window.hostUiReady = true
