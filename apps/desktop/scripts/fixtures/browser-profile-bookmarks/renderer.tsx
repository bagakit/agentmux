import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { BrowserProfileBookmarks } from '../../../src/renderer/src/components/settings/BrowserProfileBookmarks'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { BrowserProfileSummary } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/components/settings/settings-browser-profiles.css'
// Real IPC/preload and production component. Main owns all records and mutations in this fixture.
const root = createRoot(document.getElementById('root')!, { onUncaughtError: error => console.error('bookmarks-native-renderer-error', error instanceof Error ? error.message : String(error)) })
let selected: BrowserProfileSummary | null = null
mountThemeRuntime(window, { appAppearance: 'dark' } as never)
function setProfile(profile: BrowserProfileSummary) {
  selected = profile
  flushSync(() => root.render(<main className="browser-profile-editor bookmarks-native-editor"><h2>{profile.label}</h2><p className="browser-profile-editor__quiet">Browser Profile · original native owner</p><BrowserProfileBookmarks key={profile.id} profile={profile} /></main>))
}
Object.assign(window, { bookmarksNative: { api, setProfile, read: () => ({ text: document.body.innerText, profileId: selected?.id ?? null }), appearance: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode } as never) } })
