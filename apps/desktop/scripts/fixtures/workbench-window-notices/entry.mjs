import { updateThemeSelection } from '@agentmux/client-ui/theme'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { returnWorkbenchWindow } from '../../../src/renderer/src/lib/workbench-windows'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { directoryIdentity, workspaceZoneId } from '../../../src/shared/space-addresses'
import '../../../src/renderer/src/styles/index.css'

const preview = await api.config.get()
const workspace = { id: 'window-notice-proof', name: 'Original work', hostId: 'local', path: '/private/window-notice-proof', kind: 'folder' }
const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'launcher', workspaceId: workspace.id })
const layout = createWorkspaceLayout('original-group', [tab.id])
const spaceId = directoryIdentity(workspace.hostId, workspace.path)
const zoneId = workspaceZoneId(spaceId, workspace.id)
const calls = []
for (const key of ['launchAgent', 'launchTerminal', 'resume', 'stop', 'write', 'submitPrompt']) {
  api.sessions[key] = async () => { calls.push(key); throw new Error('No Runtime mutation in the private window notice proof') }
}
let changed
let operation
let holdResponse = false
let releaseResponse
const windows = [{ windowId: 'main-window', documentGeneration: 'main-document', target: null, presentation: 'visible', bounds: null, focused: true }]
api.ui.workbenchWindows.onChanged = callback => { changed = callback; return () => {} }
api.ui.workbenchWindows.ready = async () => ({ windowId: 'main-window', documentGeneration: 'main-document' })
api.ui.workbenchWindows.call = async (method, input) => {
  if (method === 'app.window.ls') {
    const page = { windows, recordedOperation: operation }
    return holdResponse ? new Promise(resolve => { releaseResponse = () => resolve(page) }) : page
  }
  operation = { method, input, actor: { kind: 'user', id: 'private-proof' }, state: 'unknown',
    windowId: input.windowId, documentGeneration: input.documentGeneration,
    message: 'The original interface has not confirmed this window return. Original content remains in its window. ' + 'Original operation diagnostic. '.repeat(24) }
  const page = { windows, recordedOperation: operation }
  if (holdResponse) return new Promise(resolve => { releaseResponse = () => resolve(page) })
  return page
}
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...preview, workspaces: [workspace] },
  sessions: [], timelines: {}, activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: true,
  tabs: { [tab.id]: tab }, layouts: { [workspace.id]: layout }, workbenchSpaceSelection: {
    spaceId, zoneId, workspaceId: workspace.id, groupId: layout.activeGroupId, tabId: tab.id, regionId: tab.layout.activeRegionId, topicId: null
  }, prewarmTerminal: async () => {}, error: null, agentComposerDrafts: { 'original-region': 'Original unsent draft' } })
const baseline = useAppStore.getState()
createRoot(document.getElementById('root')).render(createElement(DesktopClientUiProvider, null, createElement(App)))
window.windowNoticeProof = {
  async fail() { await returnWorkbenchWindow({ windowId: 'original-window', documentGeneration: 'original-document' }) },
  confirm(unrelated = false) {
    changed({ windows, issue: null, recordedOperation: { ...operation, state: 'confirmed', message: null,
      input: { ...operation.input, operationId: unrelated ? 'unrelated-operation' : operation.input.operationId } } })
  },
  async staleCall() {
    holdResponse = true
    const pending = returnWorkbenchWindow({ windowId: 'original-window', documentGeneration: 'original-document' })
    window.windowNoticeProof.confirm()
    releaseResponse()
    holdResponse = false
    await pending
  },
  holdInspect() { holdResponse = true },
  completeInspect() { window.windowNoticeProof.confirm(); releaseResponse(); holdResponse = false },
  theme(theme) { updateThemeSelection({ appAppearance: theme }) },
  facts() {
    const shell = document.querySelector('.app-shell'), footer = document.querySelector('.window-status-bar')
    const trigger = footer?.querySelector('.workbench-window-notice .service-disclosure__trigger')
    const panel = document.querySelector('.workbench-window-notice .service-disclosure__details')
    const rect = node => { const r = node?.getBoundingClientRect(); return r ? { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom } : null }
    const state = useAppStore.getState()
    return { shell: rect(shell), footer: rect(footer), trigger: rect(trigger), panel: rect(panel), panelOpen: panel?.matches(':popover-open'),
      rootOverflow: document.getElementById('root').scrollHeight - innerHeight, triggerText: trigger?.textContent,
      body: document.body.innerText, calls: [...calls], tabsKept: state.tabs === baseline.tabs,
      draftsKept: state.agentComposerDrafts === baseline.agentComposerDrafts, layoutsKept: state.layouts === baseline.layouts,
      scrollable: panel ? panel.querySelector('.service-disclosure__content')?.scrollHeight > panel.querySelector('.service-disclosure__content')?.clientHeight : false }
  }
}
