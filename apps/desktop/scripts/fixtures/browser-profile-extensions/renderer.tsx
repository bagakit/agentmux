import { mountThemeRuntime } from "../../../../../packages/client-ui/src/theme/runtime"
import { createRoot } from 'react-dom/client'
import { BrowserProfileExtensions } from '../../../src/renderer/src/components/settings/BrowserProfileExtensions'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/components/settings/settings-browser-profiles.css'
// The real Desktop API consumes the actual production preload and Profile IPC owner. No API mock.
mountThemeRuntime(window, { appAppearance: "dark" })
const list = await api.browser.readProfiles()
const profile = list.profiles[0]!
createRoot(document.getElementById('root')!).render(<main className="browser-profile-editor" style={{ padding: 20, fontSize: 'var(--fs-body)', height: '100%', boxSizing: 'border-box', overflow: 'auto' }}><BrowserProfileExtensions profile={profile} /></main>)
Object.assign(window, { extensionsNative: { api: api.browser, profileId: profile.id } })
