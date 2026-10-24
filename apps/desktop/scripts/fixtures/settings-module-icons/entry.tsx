import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection, previewTheme, GRAPHITE_THEME } from '@agentmux/client-ui/theme'
import { settingsModules } from '../../../src/renderer/src/components/settings/settings-modules'
import '../../../src/renderer/src/monaco'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { resolveUserProfile } from '../../../src/shared/user-profile'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
await api.config.save({ ...config, profile: { ...resolveUserProfile(config.profile), displayName: 'Workspace author' } }, config)
await useAppStore.getState().initialize()
mountThemeRuntime(window, { appAppearance: 'dark' })
const root = createRoot(document.getElementById('root')!)
root.render(<><SettingsPanel onClose={() => {}} initialSection="overview" /><WindowOverlayHost /></>)
Object.assign(window, { moduleIconsScene: {
  ready: true, modules: settingsModules.map(module => ({ id: module.id, title: module.title, sharedBrand: 'channel' in module && module.icon === module.channel.icon })),
  theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
  preview: (choice: 'glyph' | 'paths' | 'old' | 'restore') => previewTheme(choice === 'restore' ? undefined : {
    ...GRAPHITE_THEME, icons: choice === 'old' ? { 'object.inbox': { kind: 'glyph', glyph: 'plus' } } : {
      'object.capsule': choice === 'glyph' ? { kind: 'glyph', glyph: 'plus' } : { kind: 'paths', paths: [{ d: 'M4 6H20V18H4Z' }] }
    }
  })
} })
