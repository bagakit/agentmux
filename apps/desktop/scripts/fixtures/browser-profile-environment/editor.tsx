import { createRoot } from 'react-dom/client'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { browserProfiles } from '../../../src/renderer/src/lib/browser-profiles'
import { desktopUserDocument } from '../../../src/renderer/src/lib/desktop-user-state'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Shipping API mode and the original preload are used. Only test observation is exposed.
const config = await api.config.get()
useAppStore.setState({ config, loading: false })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
createRoot(document.getElementById('root')!).render(
  <SettingsPanel initialSection="browser-profiles" onClose={() => {}} />
)
Object.assign(window, {
  environmentEditorProof: {
    snapshot: () => browserProfiles.get(),
    refresh: () => browserProfiles.refresh(),
    checkpoint: () => desktopUserDocument.checkpoint('profileEnvironmentDrafts'),
    appearance: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
    apiMode: 'shipping',
    preloadAvailable: Boolean(window.agentmux),
    async saved() {
      return await api.browser.readProfiles()
    }
  }
})
