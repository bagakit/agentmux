import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { BrowserProfilesSettingsPane } from '../BrowserProfilesSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectProfilesIcon = semanticIconComponent('object.contact')

export const browserProfilesSettingsModule = {
  id: 'browser-profiles', archetype: 'library',
  group: 'browser-use',
  title: 'Browser Profiles',
  description: 'Each Profile keeps its own sign-ins, site data and saved settings.',
  icon: ThemeObjectProfilesIcon,
  keywords: 'browser profile profiles sign-in signin login cookies site data identity account import chrome default proxy network route environment fingerprint language locale timezone location screen hardware client hints',
  searchTargets: [
    { id: 'browser-profiles', title: 'Browser Profiles', keywords: 'profile sign-in cookies import default rename color proxy network route environment fingerprint language locale timezone location screen hardware client hints' },
  ],
  savedSummary: () => '',
  Pane({ active, onClose }) {
    return <BrowserProfilesSettingsPane active={active} onClose={onClose} />
  }
} as const satisfies SettingsModule
