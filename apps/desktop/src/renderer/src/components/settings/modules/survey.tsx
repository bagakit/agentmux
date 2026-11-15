import { presentKnowledgeSurface } from '../../../lib/knowledge-surface-navigation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../../../store'
import { BrowserStartPageSettings } from '../BrowserStartPageSettings'
import { DefaultBrowserSetting } from '../DefaultBrowserSetting'
import type { BrowserStartPageConfig } from '../../../../../shared/browser-start-page'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'
import { SurveyThumbnailSettings } from '../SurveyThumbnailSettings'
import { clampSurveySidebarWidth } from '../../../lib/survey-sidebar-width'
import type { SurveyThumbnailLayout } from '../../../../../shared/survey-thumbnail-layout'
import type { SurveyBrowsingPreferences } from '../../../../../shared/survey-browsing'
import { SurveyBrowsingSettings } from '../SurveyBrowsingSettings'
import { SettingsDisclosure } from '../SettingsDisclosure'

const SurveyIcon = semanticIconComponent('navigation.survey')


export const surveySettingsModule = {
  id: 'survey', archetype: 'preference', group: 'know', title: 'Survey', icon: SurveyIcon,
  selectionAnimation: true,
  description: 'Organize saved webpages and customize your research workspace.',
  keywords: 'work survey research browser default system http https browsing exploration start page title subtitle icon background history cards count motion interactive thumbnail height columns density size preview 缩略图 高度 每行',
  searchTargets: [
    { id: 'reuse-open-pages', title: 'Switch to an already open page', keywords: 'survey duplicate reuse link 重复链接 复用' },
    { id: 'page-grouping', title: 'Group saved webpages', keywords: 'survey site time interval 网页 站点 时间 自动分组' },
    { id: 'thumbnail-height', title: 'Research thumbnail height', keywords: 'survey size px preview 缩略图 高度' },
    { id: 'thumbnail-columns', title: 'Maximum thumbnails per row', keywords: 'survey columns count density preview 每行 上限' },
    { id: 'default-browser', title: 'Default browser', keywords: 'http https system settings', kind: 'action' },
    { id: 'start-title', title: 'Start page title', keywords: 'survey browser title' },
    { id: 'start-subtitle', title: 'Start page subtitle', keywords: 'survey browser subtitle' },
    { id: 'start-icon', title: 'Start page icon', keywords: 'survey image url' },
    { id: 'start-background', title: 'Start page background image', keywords: 'survey image url' },
    { id: 'start-history', title: 'Show recent addresses and searches', keywords: 'browser history cards' },
    { id: 'start-history-limit', title: 'Cards on first view', keywords: 'browser history quantity count number' },
    { id: 'start-interactive-background', title: 'Interactive background', keywords: 'browser start page pointer light motion animation' },
  ],
  savedSummary: config => config.browser.startPage?.title ?? 'AMUX - Survey',
  Pane({ config, onClose, active }) {
    const sidebarWidth = useAppStore(state => state.surveySidebarWidth)
    return <div className="settings-pane-stack settings-preference-surface settings-survey-pane">
      <SurveyBrowsingSettings preferences={config.browser.surveyBrowsing} onSave={saveBrowsing} />
      <div>
        <SettingsDisclosure title="Research thumbnails" description="Adjust the size and density of research previews in the sidebar.">
          <SurveyThumbnailSettings preferences={config.browser.surveyThumbnails} navigationWidth={clampSurveySidebarWidth(sidebarWidth)} onSave={saveThumbnails} />
        </SettingsDisclosure>
        <SettingsDisclosure title="Start page" description="Edit the welcome text, images and recent addresses.">
          <BrowserStartPageSettings config={config.browser.startPage} onSave={saveStartPage}
            onOpen={() => { onClose(); void presentKnowledgeSurface('survey', useAppStore.getState().setMainSurface, { inputPolicy: 'target' }) }} />
        </SettingsDisclosure>
      </div>
      <DefaultBrowserSetting active={active} />
    </div>
  }
} as const satisfies SettingsModule

async function saveBrowsing(value: SurveyBrowsingPreferences, expected: SurveyBrowsingPreferences): Promise<void> {
  await saveConfigSlice((current, surveyBrowsing: SurveyBrowsingPreferences) => ({ ...current, browser: { ...current.browser, surveyBrowsing } }), value, expected)
}

async function saveStartPage(value: Required<BrowserStartPageConfig>, expected: Required<BrowserStartPageConfig>): Promise<void> {
  await saveConfigSlice((current, startPage: Required<BrowserStartPageConfig>) => ({ ...current, browser: { ...current.browser, startPage } }), value, expected)
}

async function saveThumbnails(value: SurveyThumbnailLayout, expected: SurveyThumbnailLayout): Promise<void> {
  await saveConfigSlice((current, surveyThumbnails: SurveyThumbnailLayout) => ({ ...current, browser: { ...current.browser, surveyThumbnails } }), value, expected)
}
