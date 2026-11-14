import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, workbenchSurfaces } from '../../../src/renderer/src/lib/workbench-tabs'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Real Settings › Browser Profiles over the web-preview Profile owner. The Profiles, Tabs and
// Browsers below are preview data in this document only; Main persistence is proved by its tests.
const config = await api.config.get()
const list = await api.browser.readProfiles()
const personal = list.profiles[0]!
await api.browser.updateProfile(personal.id, { label: 'Personal', notes: '' }, list.profiles.find(value => value.id === personal.id)!.revision)
const scene = new URLSearchParams(location.search).get('scene')
const singleProfileScene = scene === 'switch' || scene === 'trash-empty' || scene === 'notes' || scene === 'cookie-files'
const client = singleProfileScene ? personal : await api.browser.createProfile('Northwind client')
if (!singleProfileScene) {
  await api.browser.updateProfile(client.id, { notes: 'Launch QA for Northwind. Their staging only accepts the Tokyo gateway.' }, (await api.browser.readProfiles()).profiles.find(value => value.id === client.id)!.revision)
  await api.browser.createProfile('QA de-DE')
  await api.browser.createProfile('Release review')
}
const workspaceId = config.workspaces[0]!.id
const tab = (id: string, title: string, profileId: string, deferred: boolean) => {
  const created = createWorkbenchTab(id, { kind: 'browser', workspaceId, regionId: id + '-region' } as never)
  const region = Object.values(created.regions)[0] as Record<string, unknown>
  Object.assign(region, { browserId: id, profileId, title, url: 'https://app.northwind.example/launch', ...(deferred ? { nativeOwnerDeferred: true } : {}) })
  return created
}
// Agents on globally, so the Profile switch shows its own effect; one Profile keeps Agents out.
config.browser = { ...config.browser, agentAutomation: true, exitCheckUrl: 'https://exit.example.test/' }
await api.browser.updateProfile(client.id, { agentAccess: false }, (await api.browser.readProfiles()).profiles.find(value => value.id === client.id)!.revision)
const tabs = [tab('b-launch', 'Launch board', client.id, false), tab('b-notes', 'Release notes', client.id, true), tab('b-inbox', 'Inbox', personal.id, false)]
useAppStore.setState({ config, loading: false, tabs: Object.fromEntries(tabs.map(item => [item.id, item])) as never })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
const root = createRoot(document.getElementById('root')!)
const readProxySignIn = api.browser.readProfileProxySignIn
const setProxySignIn = api.browser.setProfileProxySignIn
let releaseAccessSave: (() => void) | undefined
let refreshTrash: (() => Promise<void>) | undefined
let finishTrashRead: (() => void) | undefined
const settings = () => flushSync(() => root.render(<DesktopClientUiProvider><SettingsPanel initialSection="browser-profiles" onClose={() => {}} /></DesktopClientUiProvider>))
function BrowserScene() {
  const original = useAppStore(state => state.tabs['b-launch'])!
  const browser = workbenchSurfaces(original).find(surface => surface.kind === 'browser')!
  return <DesktopClientUiProvider><main style={{ width: '100%', height: '100%' }}><BrowserPane tab={browser as never} visible /></main></DesktopClientUiProvider>
}
async function browser(warning?: string) {
  const snapshot = await api.browser.create('b-launch', 'about:blank', workspaceId, client.id)
  useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: warning ? { ...snapshot, activity: { operation: null, control: 'human', warning } } : snapshot })
  flushSync(() => root.render(<BrowserScene />))
}
if (scene === 'trash-empty') {
  const listeners = new Set<Parameters<typeof api.browser.onProfilesChanged>[0]>()
  const subscribe = api.browser.onProfilesChanged
  api.browser.onProfilesChanged = listener => {
    const release = subscribe(listener)
    listeners.add(listener)
    return () => { listeners.delete(listener); release() }
  }
  refreshTrash = async () => {
    const snapshot = await api.browser.readProfiles()
    for (const listener of listeners) listener(snapshot)
  }
  let readAttempt = 0
  api.browser.readProfileTrash = async () => {
    const attempt = ++readAttempt
    if (attempt === 2) throw new Error('Could not read the original archive.')
    if (attempt === 3) await new Promise<void>(resolve => { finishTrashRead = resolve })
    return { revision: attempt, sequence: attempt, entries: [], legacyPendingDeletes: [] }
  }
}
settings()
Object.assign(window, { profilesVisual: {
  appearance: (mode: 'dark' | 'light') => updateThemeSelection({ ...config.appearance, appAppearance: mode }),
  refreshTrash: () => refreshTrash?.(),
  finishTrashRead: () => { finishTrashRead?.(); finishTrashRead = undefined },
  client: client.id,
  async editNotesElsewhere(notes: string) {
    const original = (await api.browser.readProfiles()).profiles.find(value => value.id === client.id)!
    await api.browser.updateProfile(original.id, { notes }, original.revision)
  },
  settings,
  holdAccessSave() {
    const update = api.browser.updateProfile
    const pending = new Promise<void>(resolve => { releaseAccessSave = resolve })
    api.browser.updateProfile = async (...args) => {
      api.browser.updateProfile = update
      await pending
      return update(...args)
    }
  },
  finishAccessSave() { releaseAccessSave?.(); releaseAccessSave = undefined },
  signInReadFailure() {
    api.browser.readProfileProxySignIn = async () => { throw new Error('The system keychain could not be read.') }
    settings()
  },
  restoreSignInRead() { api.browser.readProfileProxySignIn = readProxySignIn },
  partialProxyReconnect() {
    api.browser.setProfileProxySignIn = async (...args) => { await setProxySignIn(...args); return { reconnected: false } }
  },
  browser,
  async environmentNotice() {
    await browser('This Profile’s native environment could not be fully confirmed. The original pages and input remain available. Open Settings → Browser Profiles to review the saved environment. If DevTools is open, close it to reapply without reloading. Subdocument, Worker and first-script scope remain unknown.')
  },
  async serviceNotice() {
    await api.browser.updateProfile(client.id, { network: { mode: 'proxy', server: { scheme: 'http', host: 'gateway.example.test', port: 3128 } } }, (await api.browser.readProfiles()).profiles.find(value => value.id === client.id)!.revision)
    await browser('Profile “Northwind client”: The saved proxy password could not be read from the keychain. Enter it again. Browser controls remain available. Open Settings → Browser Profiles → Northwind client → Proxy sign-in.')
  }
} })
