import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../../../store'
import { api } from '../../../lib/api'
import { BrowserStartPageSettings } from '../BrowserStartPageSettings'
import { DefaultBrowserSetting } from '../DefaultBrowserSetting'
import type { BrowserStartPageConfig } from '../../../../../shared/browser-start-page'
import type { SettingsModule } from '../settings-catalog'

const SurveyIcon = semanticIconComponent('navigation.survey')


export const surveySettingsModule = {
  id: 'survey', group: 'work', title: 'Survey', icon: SurveyIcon,
  description: 'Personalize your browser start page and continue research.',
  keywords: 'work survey research browser default system http https browsing exploration start page title subtitle icon background history cards',
  searchTargets: [
    { id: 'default-browser', title: 'Default browser', keywords: 'http https system settings', kind: 'action' },
    { id: 'start-title', title: 'Start page title', keywords: 'survey browser title' },
    { id: 'start-subtitle', title: 'Start page subtitle', keywords: 'survey browser subtitle' },
    { id: 'start-icon', title: 'Start page icon', keywords: 'survey image url' },
    { id: 'start-background', title: 'Start page background image', keywords: 'survey image url' },
    { id: 'start-history', title: 'Show recent addresses and searches', keywords: 'browser history cards' },
  ],
  savedSummary: config => config.browser.startPage?.title ?? 'AMUX - Survey',
  Pane({ config, onClose, active }) {
    return <BrowserStartPageSettings config={config.browser.startPage} onSave={saveStartPage}
      onOpen={() => { onClose(); useAppStore.getState().setMainSurface('survey') }}><DefaultBrowserSetting active={active} /></BrowserStartPageSettings>
  }
} as const satisfies SettingsModule

async function saveStartPage(value: Required<BrowserStartPageConfig>, expected: Required<BrowserStartPageConfig>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your start page choices are kept; reload configuration and retry saving.')
  await api.config.save({ ...current, browser: { ...current.browser, startPage: value } },
    { ...current, browser: { ...current.browser, startPage: expected } })
}
