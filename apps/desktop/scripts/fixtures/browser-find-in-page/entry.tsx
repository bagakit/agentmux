import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { AgentMuxBrowserControl } from '@agentmux/core'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, workbenchSurfaces } from '../../../src/renderer/src/lib/workbench-tabs'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Real BrowserPane and its find row over the web-preview Browser. Find answers are preview data in this
// document only; Chromium's find, the Main/IPC boundary and the Agent refusal are proved by their tests.
type Answer = { status: 'found'; activeMatchOrdinal: number; matches: number } | { status: 'unconfirmed' } | { status: 'failed' }
const config = await api.config.get()
const workspaceId = config.workspaces[0]!.id
const profileId = (await api.browser.readProfiles()).profiles[0]!.id
const url = 'https://docs.northwind.example/release-notes'
const tab = createWorkbenchTab('b-release', { kind: 'browser', workspaceId, regionId: 'b-release-region' } as never)
Object.assign(Object.values(tab.regions)[0] as Record<string, unknown>, { browserId: 'b-release', profileId, title: 'Release notes', url })
useAppStore.setState({ config, loading: false, tabs: { [tab.id]: tab } as never })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
const snapshot = await api.browser.create('b-release', url, workspaceId, profileId)
useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...snapshot, title: 'Release notes' } })

let answer: Answer = { status: 'found', activeMatchOrdinal: 3, matches: 14 }
const previewFind = api.browser.findInPage
api.browser.findInPage = async (id, text, request) => {
  if (answer.status === 'failed') throw new Error('This page did not answer the find request.')
  const { navigationId } = await previewFind(id, text, request)
  return answer.status === 'found' ? { ...answer, navigationId } : { status: 'unconfirmed', navigationId }
}
const agentControl: AgentMuxBrowserControl = { owner: 'agent', activeOperationId: null, revision: 1, inputIsolation: 'isolated' }
let control: AgentMuxBrowserControl | undefined
function Scene() {
  const current = useAppStore(state => state.tabs[tab.id])!
  const browser = workbenchSurfaces(current).find(surface => surface.kind === 'browser')!
  return <DesktopClientUiProvider><main style={{ width: '100%', height: '100%' }}>
    <BrowserPane tab={{ ...browser, ...(control ? { control } : {}) } as never} visible />
  </main></DesktopClientUiProvider>
}
const root = createRoot(document.getElementById('root')!)
const render = () => flushSync(() => root.render(<Scene />))
render()
Object.assign(window, { findVisual: {
  appearance: (mode: 'dark' | 'light') => updateThemeSelection({ ...config.appearance, appAppearance: mode }),
  answer: (next: Answer) => { answer = next },
  agent: (owned: boolean) => { control = owned ? agentControl : undefined; render() }
} })
