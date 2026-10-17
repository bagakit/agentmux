import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { BrowserSettingsPane, type BrowserPreferences } from '../BrowserSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')


async function saveBrowser(value: BrowserPreferences, expected: BrowserPreferences): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save(
    { ...current, browser: { ...current.browser, ...value } },
    { ...current, browser: { ...current.browser, ...expected } }
  )
}

export const browserSettingsModule = {
  id: 'browser',
  group: 'browser-use',
  title: 'Browser',
  description: 'Manage browser resources and agent access.',
  icon: ThemeObjectBrowserIcon,
  keywords: 'browser resources memory release restore process idle agent automation drive page permission',
  searchTargets: [
    { id: 'agent-automation', title: 'Agent automation', keywords: 'browser script page permission enable disable' },
    { id: 'browser-resources', title: 'Browser resources', keywords: 'memory process release restore idle pages' },
  ],
  savedSummary: (config) => config.browser.agentAutomation === true ? 'Automation on' : 'Automation off',
  Pane({ config, active }) {
    return <BrowserSettingsPane active={active} browser={config.browser} onSave={saveBrowser} onForget={api.browser.forgetAppLinkScheme} />
  }
} as const satisfies SettingsModule
