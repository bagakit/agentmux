import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../../../store'
import { api } from '../../../lib/api'
import { BrowserStartPageSettings } from '../BrowserStartPageSettings'
import type { BrowserStartPageConfig } from '../../../../../shared/browser-start-page'
import type { SettingsModule } from '../settings-catalog'

const ThemeActionSearchIcon = semanticIconComponent('action.search')


export const surveySettingsModule = {
  id: 'survey', group: 'work', title: 'Survey', icon: ThemeActionSearchIcon,
  description: 'Personalize your browser start page and continue research.',
  keywords: 'work survey research browser browsing exploration start page title subtitle icon background history cards',
  savedSummary: config => config.browser.startPage?.title ?? 'AMUX - Survey',
  Pane({ config, onClose }) {
    return <BrowserStartPageSettings config={config.browser.startPage} onSave={saveStartPage}
      onOpen={() => { onClose(); useAppStore.getState().setMainSurface('survey') }} />
  }
} as const satisfies SettingsModule

async function saveStartPage(value: Required<BrowserStartPageConfig>, expected: Required<BrowserStartPageConfig>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your start page choices are kept; reload configuration and retry saving.')
  await api.config.save({ ...current, browser: { ...current.browser, startPage: value } },
    { ...current, browser: { ...current.browser, startPage: expected } })
}
