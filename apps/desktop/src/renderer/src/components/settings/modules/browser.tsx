import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { BrowserSettingsPane, type BrowserPreferences } from '../BrowserSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')


/** An empty check address is no check at all, so it is stored as absent rather than as an empty string. */
function withPreferences(browser: import('../../../../../shared/contracts').BrowserConfig, value: BrowserPreferences) {
  const { exitCheckUrl, ...rest } = value
  const { exitCheckUrl: _old, ...kept } = browser
  const url = exitCheckUrl.trim()
  return { ...kept, ...rest, ...(url ? { exitCheckUrl: url } : {}) }
}

async function saveBrowser(value: BrowserPreferences, expected: BrowserPreferences): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save(
    { ...current, browser: withPreferences(current.browser, value) },
    { ...current, browser: withPreferences(current.browser, expected) }
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
    { id: 'exit-check', title: 'Exit check', keywords: 'proxy exit ip address route network check' },
  ],
  savedSummary: (config) => config.browser.agentAutomation === true ? 'Automation on' : 'Automation off',
  Pane({ config, active }) {
    return <BrowserSettingsPane active={active} browser={config.browser} onSave={saveBrowser} onForget={api.browser.forgetAppLinkScheme} />
  }
} as const satisfies SettingsModule
