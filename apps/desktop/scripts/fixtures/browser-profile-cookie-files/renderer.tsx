import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { BrowserProfileCookieFiles } from '../../../src/renderer/src/components/settings/BrowserProfileCookieFiles'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { BrowserProfileSummary } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/components/settings/settings-browser-profiles.css'
// Production IPC/preload and component: Main owns file effects and native confirmation.
const root = createRoot(document.getElementById('root')!)
let selected: BrowserProfileSummary | null = null
mountThemeRuntime(window, { appAppearance: 'dark' } as never)
function setProfile(profile: BrowserProfileSummary) {
  selected = profile
  flushSync(() => root.render(<main className="settings-page"><div className="browser-profile-editor cookie-files-native-editor"><h2>{profile.label}</h2><p className="browser-profile-editor__quiet">Browser Profile · original native owner</p><BrowserProfileCookieFiles key={profile.id} profile={profile} /></div></main>))
}
Object.assign(window, { cookieFilesNative: { api, setProfile, read: () => ({ text: document.body.innerText, profileId: selected?.id ?? null }), appearance: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode } as never) } })
