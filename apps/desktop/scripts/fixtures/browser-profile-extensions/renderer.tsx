import { createRoot } from 'react-dom/client'
import { BrowserProfileExtensions } from '../../../src/renderer/src/components/settings/BrowserProfileExtensions'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
// The real Desktop API consumes the actual production preload and Profile IPC owner. No API mock.
const list = await api.browser.readProfiles()
const profile = list.profiles[0]!
createRoot(document.getElementById('root')!).render(<BrowserProfileExtensions profile={profile} />)
Object.assign(window, { extensionsNative: { api: api.browser, profileId: profile.id } })
