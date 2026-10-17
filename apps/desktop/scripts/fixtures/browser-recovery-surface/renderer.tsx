import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'
import './fixture.css'

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
let choose: (id: string) => void
let originalId = '', appearance: any, stopTheme: (() => void) | undefined
const stopEvents = api.browser.onEvent(event => useAppStore.getState().applyBrowserEvent(event))
function Fixture() {
  const [selected, setSelected] = useState(originalId)
  choose = setSelected
  const surface = useAppStore(state => state.tabs['recovery-' + selected]?.regions['region-' + selected])
  return <DesktopClientUiProvider><main className="recovery-fixture">
    <header className="recovery-fixture__header"><strong>Browser workface</strong><span>Original page and address are retained</span></header>
    <div className="recovery-fixture__layout">
      <section className="recovery-fixture__page" data-workbench-region-id={'region-' + selected}>
        {surface?.kind === 'browser' ? <BrowserPane key={selected} tab={surface} visible /> : null}
      </section>
      <aside className="recovery-fixture__sibling"><strong>Sibling work</strong><p>This draft remains available while the page reconnects.</p>
        <textarea aria-label="Sibling draft" defaultValue="Keep this sibling draft" />
      </aside>
    </div>
  </main></DesktopClientUiProvider>
}
Object.assign(window, { recoveryProof: {
  async setup(config: any, url: string, siblingUrl: string) {
    originalId = 'recovery-original'; appearance = config.appearance
    const original = await api.browser.create(originalId, url, 'recovery-workspace')
    const sibling = await api.browser.create('recovery-sibling', siblingUrl, 'recovery-workspace')
    const tabs = Object.fromEntries([original, sibling].map(browser => {
      const region = { ...browser, kind: 'browser' as const, browserId: browser.id,
        regionId: 'region-' + browser.id, workspaceId: 'recovery-workspace' }
      const tab = createWorkbenchTab('recovery-' + browser.id, region)
      return [tab.id, tab]
    }))
    useAppStore.setState({ config, tabs, layouts: {}, loading: false, toolsOpen: false,
      reportError: error => { errors.push(String(error)) } })
    stopTheme = mountThemeRuntime(window, { ...appearance, appAppearance: 'light' })
    root.render(<Fixture />)
    return { original, sibling }
  },
  async firstFailure(url: string) {
    const browser = await api.browser.create('recovery-first-failure', url, 'recovery-workspace')
    const surface = { ...browser, kind: 'browser' as const, browserId: browser.id,
      regionId: 'region-' + browser.id, workspaceId: 'recovery-workspace' }
    const tab = createWorkbenchTab('recovery-' + browser.id, surface)
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
    choose(browser.id)
    return browser.id
  },
  original() { choose(originalId) },
  theme(mode: 'light' | 'dark') { updateThemeSelection({ ...appearance, appAppearance: mode }) },
  reload() { return api.browser.reload(originalId) },
  facts() {
    const surface = document.querySelector<HTMLElement>('section[aria-label="Browser recovery"]')
    const address = document.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')
    const sibling = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Sibling draft"]')
    const state = useAppStore.getState()
    return { recovery: Boolean(surface), identity: surface?.querySelector('h2')?.textContent,
      description: surface?.textContent, address: address?.value, focused: document.activeElement === address,
      selection: address ? [address.selectionStart, address.selectionEnd] : null,
      busy: Boolean(surface?.querySelector('button[aria-busy="true"]')),
      detailsOpen: Boolean(surface?.querySelector('details[open]')),
      sibling: sibling?.value, errors: errors.slice(),
      browsers: Object.values(state.tabs).flatMap(tab => Object.values(tab.regions).filter(region => region.kind === 'browser')) }
  },
  dispose() { stopEvents(); root.unmount(); stopTheme?.() }
} })
