import { BROWSER_TOOLBAR_ITEM_ORDER } from '../../../shared/browser-toolbar.js'
import { DEFAULT_CONFIG } from '../../config-store.js'
import { booleanSetting, textSetting, invalid } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'
import { browserAgentControlSettings } from './browser-agent-control.js'
import { DEFAULT_BROWSER_START_PAGE, BROWSER_START_PAGE_TITLE_LIMIT, BROWSER_START_PAGE_SUBTITLE_LIMIT, BROWSER_START_PAGE_HISTORY_LIMIT, resolveBrowserStartPage, validBrowserStartPageText, validBrowserStartPageImage, validBrowserStartPageHistoryLimit, type BrowserStartPageConfig } from '../../../shared/browser-start-page.js'

const writeStartPage = <K extends keyof BrowserStartPageConfig>(config: Parameters<ScalarSetting['entry']>[0], key: K, value: BrowserStartPageConfig[K]) =>
  ({ ...config, browser: { ...config.browser, startPage: { ...resolveBrowserStartPage(config.browser.startPage), [key]: value } } })

export const browserSettings = [
  booleanSetting('browser.automaticMemoryRelease', DEFAULT_CONFIG.browser.automaticMemoryRelease !== false,
    config => config.browser.automaticMemoryRelease !== false,
    (config, automaticMemoryRelease) => ({ ...config, browser: { ...config.browser, automaticMemoryRelease } })),
  ...browserAgentControlSettings,
  textSetting('browser.startPage.title', config => resolveBrowserStartPage(config.browser.startPage).title,
    (config, value) => writeStartPage(config, 'title', value), value => validBrowserStartPageText(value, BROWSER_START_PAGE_TITLE_LIMIT), DEFAULT_BROWSER_START_PAGE.title),
  textSetting('browser.startPage.subtitle', config => resolveBrowserStartPage(config.browser.startPage).subtitle,
    (config, value) => writeStartPage(config, 'subtitle', value), value => validBrowserStartPageText(value, BROWSER_START_PAGE_SUBTITLE_LIMIT), DEFAULT_BROWSER_START_PAGE.subtitle),
  ...(['icon', 'backgroundImage'] as const).map(key => textSetting(`browser.startPage.${key}`,
    config => resolveBrowserStartPage(config.browser.startPage)[key], (config, value) => writeStartPage(config, key, value), validBrowserStartPageImage)),
  booleanSetting('browser.startPage.showHistory', DEFAULT_BROWSER_START_PAGE.showHistory,
    config => resolveBrowserStartPage(config.browser.startPage).showHistory, (config, value) => writeStartPage(config, 'showHistory', value)),
  {
    key: 'browser.startPage.historyLimit',
    entry(config) { return { key: this.key, kind: 'number' as const, value: resolveBrowserStartPage(config.browser.startPage).historyLimit,
      default: DEFAULT_BROWSER_START_PAGE.historyLimit,
      enum: Array.from({ length: BROWSER_START_PAGE_HISTORY_LIMIT.max - BROWSER_START_PAGE_HISTORY_LIMIT.min + 1 }, (_, index) => index + BROWSER_START_PAGE_HISTORY_LIMIT.min) } },
    apply(config, text) {
      const value = Number(text)
      if (String(value) !== text || !validBrowserStartPageHistoryLimit(value)) throw invalid(this.key, text)
      return this.entry(config).value === value ? config : writeStartPage(config, 'historyLimit', value)
    }
  },
  booleanSetting('browser.startPage.interactiveBackground', DEFAULT_BROWSER_START_PAGE.interactiveBackground,
    config => resolveBrowserStartPage(config.browser.startPage).interactiveBackground, (config, value) => writeStartPage(config, 'interactiveBackground', value)),
  booleanSetting('browser.agentAutomation', DEFAULT_CONFIG.browser.agentAutomation === true,
    (config) => config.browser.agentAutomation === true,
    (config, agentAutomation) => ({ ...config, browser: { ...config.browser, agentAutomation } })),
  ...BROWSER_TOOLBAR_ITEM_ORDER.map((item) => booleanSetting(`browser.toolbar.${item}`, DEFAULT_CONFIG.browser.toolbar[item],
    (config) => config.browser.toolbar[item],
    (config, shown) => ({ ...config, browser: { ...config.browser, toolbar: { ...config.browser.toolbar, [item]: shown } } }))),
] satisfies readonly ScalarSetting[]
