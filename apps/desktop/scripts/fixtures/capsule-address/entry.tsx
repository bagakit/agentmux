import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { flushSync } from 'react-dom'
import { useLayoutEffect } from 'react'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { FileExplorer } from '../../../src/renderer/src/components/FileExplorer'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { installDesktopPresentationOwner, desktopPresentationCommitted } from '../../../src/renderer/src/lib/desktop-presentation'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import '../../../src/renderer/src/styles/index.css'

const boot = (window as any).capsuleAddressBoot
if (!boot || !window.agentmux) throw new Error('The private native preload must supply the original boot facts')
const workspaceId = boot.config.workspaces[0].id
// Only resource discovery is controlled. The Store, file writes, localStorage,
// BrowserPane, public preload, Capsule owner and native Browser stay production.
api.config = { ...api.config, get: async () => structuredClone(boot.config), save: async config => structuredClone(config) }
api.sessions = { ...api.sessions, snapshot: async () => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], environmentWarning: null }),
  launchTerminal: async () => { throw new Error('This private proof never launches user Sessions or Runs') } }
api.providers = { ...api.providers, list: async (options?: { observation?: boolean }) => options?.observation ? { catalog: [], warnings: [] } : [] } as typeof api.providers
api.demands = { ...api.demands, list: async () => [] }
mountThemeRuntime(window, { appAppearance: 'dark' })
await useAppStore.getState().initialize()
const durable = () => {
  const state = useAppStore.getState()
  return { ...projectPersistedWorkbench(state), activeWorkspaceId: state.activeWorkspaceId }
}
const beforeFixture = boot.phase === 'restart' ? durable() : null
if (boot.phase === 'capture') await useAppStore.getState().openFile('notes.md', undefined, undefined, workspaceId)
useAppStore.setState({ toolsOpen: false })
function Shell() {
  const warning = useNativeOverlayChrome()
  const loading = useAppStore(state => state.loading), tabs = useAppStore(state => state.tabs), layouts = useAppStore(state => state.layouts)
  useLayoutEffect(() => installDesktopPresentationOwner(() => ({ loading: useAppStore.getState().loading,
    overlays: { settings: false, quickSwitcher: false }, floating: { state: 'closed', topicId: null, tabId: null } })), [])
  useLayoutEffect(() => desktopPresentationCommitted(), [loading, tabs, layouts])
  return <><aside id="fixture-tree"><FileExplorer /></aside><div id="fixture-center"><div id="fixture-workbench" data-desktop-surface="space"><WorkspaceWorkbench workspaceId={workspaceId} /></div></div>
    <footer className="window-status-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}><GlobalSystemNotices nativeOverlayWarning={warning} /></footer><WindowOverlayHost /></>
}
const root = createClientUiRoot(document.getElementById('root')!)
flushSync(() => root.render(<Shell />))
Object.assign(window, { capsuleAddressProbe: {
  workspaceId, beforeFixture, spatialBeforeInitialize: boot.spatialBeforeInitialize, durable,
  facts() { const state = useAppStore.getState(); return { ...durable(), liveTabs: state.tabs, error: state.error, surfaces: Object.values(state.tabs).flatMap(tab => Object.values(tab.regions)) } },
  async create() { const state = useAppStore.getState(); return state.createBrowser(state.layouts[workspaceId]!.activeGroupId, undefined, 'about:blank', undefined, workspaceId) },
  theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
  flush: () => prepareRendererUpdate('quit')
} })
