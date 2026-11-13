import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab, workbenchSurfaces } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'
import '../browser-recovery-surface/fixture.css'

const root = createRoot(document.getElementById('root')!), errors: string[] = []
let appearance: any, stopTheme: (() => void) | undefined, setSettings: (show: boolean) => void = () => {}, setViewed: (id: string) => void = () => {}
const stopEvents = api.browser.onEvent(event => useAppStore.getState().applyBrowserEvent(event))
const stopControl = api.control.onRequest((request, signal) => useAppStore.getState().executeControl(request, signal, { admittedControlRequestId: request.requestId }))
function Fixture() {
  const [settings, updateSettings] = useState(true), [viewed, updateViewed] = useState('original')
  setSettings = updateSettings; setViewed = updateViewed
  const tabs = useAppStore(state => state.tabs), surface = Object.values(tabs).flatMap(workbenchSurfaces).find(value => value.kind === 'browser' && value.browserId === viewed)
  return <DesktopClientUiProvider><main className="recovery-fixture">
    <header className="recovery-fixture__header"><strong>Browser workface</strong><span>Original page and Profile are retained</span></header>
    <div className="recovery-fixture__layout">
      <section className="recovery-fixture__page" data-workbench-region-id={viewed}>
        {surface?.kind === 'browser' ? <BrowserPane tab={surface} visible={!settings} /> : null}
      </section>
      <aside className="recovery-fixture__sibling"><strong>Sibling work</strong><textarea aria-label="Sibling draft" defaultValue="Keep this sibling draft" /></aside>
    </div>
    {settings ? <div style={{ position: 'absolute', inset: 0 }}><SettingsPanel initialSection="browser-profiles" onClose={() => updateSettings(false)} /></div> : null}
  </main></DesktopClientUiProvider>
}
Object.assign(window, { copyProof: {
  async setup(config: any, url: string, sourceProfileId?: string) {
    appearance = config.appearance
    const browser = await api.browser.create('original', url, 'copy-workspace', sourceProfileId)
    const surface = { ...browser, kind: 'browser' as const, browserId: browser.id, regionId: 'original', workspaceId: 'copy-workspace' }
    const tab = createWorkbenchTab('original', surface)
    useAppStore.setState({ config, tabs: { original: tab }, activeWorkspaceId: 'copy-workspace', layouts: { 'copy-workspace': createWorkspaceLayout('copy-group', ['original']) },
      loading: false, toolsOpen: false, reportError: error => errors.push(String(error)) })
    stopTheme = mountThemeRuntime(window, { ...appearance, appAppearance: 'light' })
    root.render(<Fixture />)
    return browser
  },
  profiles() { return api.browser.readProfiles() },
  async update(id: string, edit: any) { const list = await api.browser.readProfiles(); return api.browser.updateProfile(id, edit, list.profiles.find(value => value.id === id)!.revision) },
  username(id: string) { return api.browser.readProfileProxySignIn(id) },
  async persist() { const current = await api.spatial.read(); return api.spatial.commit({ expectedRevision: current?.revision ?? 0, graph: desktopSpatialGraph(useAppStore.getState(), [], current?.graph ?? null) }) },
  settings(show: boolean) { setSettings(show) }, showBrowser(id: string) { setViewed(id); setSettings(false) },
  theme(mode: 'light' | 'dark') { updateThemeSelection({ ...appearance, appAppearance: mode }) },
  facts() { return { editor: document.querySelector('article.browser-profile-editor')?.getAttribute('aria-label'),
    proxyDraft: document.querySelector<HTMLInputElement>('input[aria-label="Proxy server"]')?.value,
    notice: document.querySelector('.browser-profiles-settings__service')?.textContent,
    profiles: [...document.querySelectorAll('[data-settings-field="browser-profiles"] [role="option"]')].map(value => value.textContent),
    surfaces: Object.values(useAppStore.getState().tabs).flatMap(workbenchSurfaces).map(value => ({ kind: value.kind, id: value.regionId, browserId: value.kind === 'browser' ? value.browserId : undefined, profileId: value.kind === 'browser' ? value.profileId : undefined })),
    errors: errors.slice(), sibling: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Sibling draft"]')?.value } },
  dispose() { stopControl(); stopEvents(); root.unmount(); stopTheme?.() }
} })
