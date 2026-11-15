import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../../../lib/api'
import { BrowserSettingsPane, type BrowserPreferences } from '../BrowserSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')


/** An empty check address is no check at all, so it is stored as absent rather than as an empty string. */
function withPreferences(browser: import('../../../../../shared/contracts').BrowserConfig, value: BrowserPreferences) {
  const { exitCheckUrl, newPageSpace, newPageFocus, newPageSurvey, ...rest } = value
  const { exitCheckUrl: _old, ...kept } = browser
  const url = exitCheckUrl.trim()
  return { ...kept, ...rest, newPagePlacement: { ...browser.newPagePlacement, space: newPageSpace, focus: newPageFocus, survey: newPageSurvey }, ...(url ? { exitCheckUrl: url } : {}) }
}

async function saveBrowser(value: BrowserPreferences, expected: BrowserPreferences): Promise<void> {
  await saveConfigSlice((current, preferences: BrowserPreferences) => ({ ...current, browser: withPreferences(current.browser, preferences) }), value, expected)
}

export const browserSettingsModule = {
  id: 'browser', archetype: 'preference',
  group: 'browser-use',
  title: 'Browser',
  description: 'Choose where new pages open and manage memory and agent access.',
  icon: ThemeObjectBrowserIcon,
  keywords: 'browser resources memory release restore process idle agent automation drive page permission website new page window tab region space focus survey popup',
  searchTargets: [
    { id: 'new-page-space', title: 'New webpages in Space', keywords: 'website new page window tab region destination' },
    { id: 'new-page-focus', title: 'New webpages in Focus', keywords: 'website new page window tab region destination' },
    { id: 'new-page-survey', title: 'New webpages in Survey', keywords: 'website new page window tab region destination' },
    { id: 'agent-automation', title: 'Agent automation', keywords: 'browser script page permission enable disable' },
    { id: 'automatic-memory-release', title: 'Automatically release safe idle pages', keywords: 'browser resources memory release restore idle pages' },
    { id: 'browser-resources', title: 'Browser resources', keywords: 'memory process release restore idle pages' },
    { id: 'exit-check', title: 'Exit check', keywords: 'proxy exit ip address route network check' },
  ],
  savedSummary: (config) => config.browser.agentAutomation === true ? 'Automation on' : 'Automation off',
  Pane({ config, active }) {
    return <BrowserSettingsPane active={active} browser={config.browser} onSave={saveBrowser} onForget={api.browser.forgetAppLinkScheme} />
  }
} as const satisfies SettingsModule
