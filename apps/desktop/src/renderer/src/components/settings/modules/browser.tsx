import { Globe } from 'lucide-react'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { BrowserSettingsPane } from '../BrowserSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveBrowser(agentAutomation: boolean, expected: boolean): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save(
    { ...current, browser: { ...current.browser, agentAutomation } },
    { ...current, browser: { ...current.browser, agentAutomation: expected } }
  )
}

export const browserSettingsModule = {
  id: 'browser',
  group: 'preferences',
  title: 'Browser',
  description: 'Choose how agents interact with your pages.',
  icon: Globe,
  keywords: 'browser agent automation drive page script run snapshot click permission enable disable',
  savedSummary: (config) => config.browser.agentAutomation === true ? 'Automation on' : 'Automation off',
  Pane({ config }) {
    return <BrowserSettingsPane browser={config.browser} onSave={saveBrowser} onForget={api.browser.forgetAppLinkScheme} />
  }
} as const satisfies SettingsModule
