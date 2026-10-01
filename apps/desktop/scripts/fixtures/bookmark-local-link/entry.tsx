import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { FileExplorer } from '../../../src/renderer/src/components/FileExplorer'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { TransientErrorNotice } from '../../../src/renderer/src/components/TransientErrorNotice'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import '../../../src/renderer/src/styles/index.css'

const boot = (window as any).bookmarkFixtureBoot
console.error('PRIVATE_STAGE renderer-entry')
if (!boot || !window.agentmux) throw new Error('Private native preload facts are required')
const workspaceId = boot.config.workspaces[0].id
const storedBeforeInitialize = boot.phase === 'restart' ? JSON.parse(localStorage.getItem('agentmux-workbench-v1') ?? 'null')?.state : null
// Config and Core discovery are controlled. Browser, preload, files and Chromium storage stay real.
api.config = { ...api.config, get: async () => structuredClone(boot.config), save: async config => structuredClone(config) }
api.sessions = { ...api.sessions, snapshot: async () => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], environmentWarning: null }),
  launchTerminal: async () => {
    // A controlled failure retains the real IPC task boundary while a pending Browser Launcher mounts.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    throw new Error('Private bookmark proof does not launch Terminal sessions')
  } }
api.providers = { ...api.providers, list: async () => [] }
api.demands = { ...api.demands, list: async () => [] }
await useAppStore.getState().initialize()
console.error('PRIVATE_STAGE store-initialized')
const durable = () => {
  const state = useAppStore.getState()
  return { ...projectPersistedWorkbench(state), activeWorkspaceId: state.activeWorkspaceId,
    documents: structuredClone(state.documents), dirtyDocuments: structuredClone(state.dirtyDocuments) }
}
const beforeFixture = boot.phase === 'restart' ? durable() : null
if (boot.phase === 'capture') await useAppStore.getState().openFile('notes.md', undefined, undefined, workspaceId)
useAppStore.setState({ toolsOpen: false })
const root = createRoot(document.getElementById('root')!)
function Shell() {
  const chromeWarning = useNativeOverlayChrome()
  const error = useAppStore(state => state.error), dismissed = useAppStore(state => state.errorDismissed), lastError = useAppStore(state => state.lastError)
  return <><aside id="fixture-tree"><FileExplorer /></aside><div id="fixture-center" data-chrome-warning={chromeWarning}><div id="fixture-workbench"><WorkspaceWorkbench workspaceId={workspaceId} /></div>
    <div className="main-shell__notices"><TransientErrorNotice error={error} dismissed={dismissed} lastError={lastError}
      onDismiss={() => useAppStore.getState().dismissError()} onReopen={() => useAppStore.getState().reopenError()} /></div></div><WindowOverlayHost /></>
}
flushSync(() => root.render(<Shell />))
const probe = {
  workspaceId, beforeFixture, storedBeforeInitialize, durable,
  facts() {
    const state = useAppStore.getState()
    return { ...durable(), error: state.error, surfaces: Object.values(state.tabs).flatMap(tab => Object.values(tab.regions)) }
  },
  async create(url: string) {
    const state = useAppStore.getState()
    return state.createBrowser(state.layouts[workspaceId]!.activeGroupId, undefined, url, undefined, workspaceId)
  },
  async open(path: string) { await useAppStore.getState().openFile(path, undefined, undefined, workspaceId) },
  async split(tabId: string, ratio: number) {
    await useAppStore.getState().openFile('notes.md', undefined, undefined, workspaceId)
    const state = useAppStore.getState(), tab = state.tabs[tabId]!
    state.activateTab(workspaceId, state.layouts[workspaceId]!.activeGroupId, tabId)
    const neighborId = 'source-neighbor:' + tabId
    let next = Object.values(tab.regions).some(surface => surface.regionId === neighborId) ? tab :
      addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', { regionId: neighborId, kind: 'file', workspaceId, path: 'notes.md' })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio }, activeRegionId: tab.layout.activeRegionId } }
    flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [tabId]: next } }))
  },
  activate(tabId: string) {
    const state = useAppStore.getState(), layout = state.layouts[workspaceId]!
    state.activateTab(workspaceId, layout.activeGroupId, tabId)
  },
  theme(theme: 'light' | 'dark') { document.documentElement.dataset.appearance = theme },
  flush() { return prepareRendererUpdate('quit') }
}
Object.assign(window, { bookmarkProbe: probe })
console.error('PRIVATE_STAGE probe-ready')
