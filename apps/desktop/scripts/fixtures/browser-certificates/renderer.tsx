import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'
import '../browser-recovery-surface/fixture.css'

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
let appearance: any, stopTheme: (() => void) | undefined
const stopEvents = api.browser.onEvent(event => useAppStore.getState().applyBrowserEvent(event))
const stopControl = api.control.onRequest((request, signal) => useAppStore.getState().executeControl(request, signal, { admittedControlRequestId: request.requestId }))
function Fixture() {
  const surface = useAppStore(state => state.tabs.original?.regions.original)
  return <DesktopClientUiProvider><main className="recovery-fixture">
    <header className="recovery-fixture__header"><strong>Browser workface</strong><span>Original page and profile are retained</span></header>
    <div className="recovery-fixture__layout">
      <section className="recovery-fixture__page" data-workbench-region-id="original">
        {surface?.kind === 'browser' ? <BrowserPane tab={surface} visible /> : null}
      </section>
      <aside className="recovery-fixture__sibling"><strong>Sibling work</strong><p>This draft remains available during certificate review.</p>
        <textarea aria-label="Sibling draft" defaultValue="Keep this sibling draft" />
      </aside>
    </div>
  </main></DesktopClientUiProvider>
}
Object.assign(window, { certificateProof: {
  async setup(config: any, url: string) {
    appearance = config.appearance
    const browser = await api.browser.create('original', url, 'certificate-workspace')
    const surface = { ...browser, kind: 'browser' as const, browserId: browser.id, regionId: 'original', workspaceId: 'certificate-workspace' }
    const tab = createWorkbenchTab('original', surface)
    useAppStore.setState({ config, tabs: { original: tab }, layouts: {}, loading: false, toolsOpen: false,
      reportError: error => errors.push(String(error)) })
    stopTheme = mountThemeRuntime(window, { ...appearance, appAppearance: 'light' })
    root.render(<Fixture />)
    return browser
  },
  async persistDescriptor() {
    const current = await api.spatial.read()
    return api.spatial.commit({ expectedRevision: current?.revision ?? 0,
      graph: desktopSpatialGraph(useAppStore.getState(), [], current?.graph ?? null) })
  },
  theme(mode: 'light' | 'dark') { updateThemeSelection({ ...appearance, appAppearance: mode }) },
  navigate(url: string) { return api.browser.navigate('original', url) },
  facts() {
    const surface = document.querySelector('section[aria-label="Server certificate decision"]')
    return { pending: Boolean(surface), description: surface?.textContent,
      buttons: [...(surface?.querySelectorAll('button') ?? [])].map(button => ({ text: button.textContent, disabled: button.disabled })),
      errors: errors.slice(), sibling: document.querySelector<HTMLTextAreaElement>('textarea')?.value }
  },
  dispose() { stopControl(); stopEvents(); root.unmount(); stopTheme?.() }
} })
