import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { BrowserProfilesSettingsPane } from '../BrowserProfilesSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectProfilesIcon = semanticIconComponent('object.contact')

export const browserProfilesSettingsModule = {
  id: 'browser-profiles',
  group: 'browser-use',
  title: 'Browser Profiles',
  description: 'Each Profile keeps its own sign-ins and site data. Device, fonts and user agent are the same in every Profile.',
  icon: ThemeObjectProfilesIcon,
  keywords: 'browser profile profiles sign-in signin login cookies site data identity account import chrome default proxy',
  searchTargets: [
    { id: 'browser-profiles', title: 'Browser Profiles', keywords: 'profile sign-in cookies import default rename color' },
  ],
  savedSummary: () => '',
  Pane({ active }) {
    return <BrowserProfilesSettingsPane active={active} />
  }
} as const satisfies SettingsModule
