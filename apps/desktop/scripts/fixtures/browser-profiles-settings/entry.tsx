import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Real Settings › Browser Profiles over the web-preview Profile owner. The Profiles, Tabs and
// Browsers below are preview data in this document only; Main persistence is proved by its tests.
const config = await api.config.get()
const list = await api.browser.readProfiles()
const personal = list.profiles[0]!
await api.browser.updateProfile(personal.id, { label: 'Personal', notes: '' }, list.revision)
const client = await api.browser.createProfile('Northwind client')
await api.browser.updateProfile(client.id, { notes: 'Launch QA for Northwind. Their staging only accepts the Tokyo gateway.' }, (await api.browser.readProfiles()).revision)
await api.browser.createProfile('QA de-DE')
await api.browser.createProfile('Release review')
const workspaceId = config.workspaces[0]!.id
const tab = (id: string, title: string, profileId: string, deferred: boolean) => {
  const created = createWorkbenchTab(id, { kind: 'browser', workspaceId, regionId: id + '-region' } as never)
  const region = Object.values(created.regions)[0] as Record<string, unknown>
  Object.assign(region, { browserId: id, profileId, title, url: 'https://app.northwind.example/launch', ...(deferred ? { nativeOwnerDeferred: true } : {}) })
  return created
}
// Agents on globally, so the Profile switch shows its own effect; one Profile keeps Agents out.
config.browser = { ...config.browser, agentAutomation: true }
await api.browser.updateProfile(client.id, { agentAccess: false }, (await api.browser.readProfiles()).revision)
useAppStore.setState({ config, loading: false, tabs: {
  a: tab('b-launch', 'Launch board', client.id, false), b: tab('b-notes', 'Release notes', client.id, true), c: tab('b-inbox', 'Inbox', personal.id, false)
} as never })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(<DesktopClientUiProvider><SettingsPanel initialSection="browser-profiles" onClose={() => {}} /></DesktopClientUiProvider>))
Object.assign(window, { profilesVisual: { appearance: (mode: 'dark' | 'light') => updateThemeSelection({ ...config.appearance, appAppearance: mode }), client: client.id } })
