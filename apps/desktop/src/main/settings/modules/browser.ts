import { BROWSER_TOOLBAR_ITEM_ORDER } from '../../../shared/browser-toolbar.js'
import { DEFAULT_CONFIG } from '../../config-store.js'
import { booleanSetting, textSetting } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'
import { DEFAULT_BROWSER_START_PAGE, BROWSER_START_PAGE_TITLE_LIMIT, BROWSER_START_PAGE_SUBTITLE_LIMIT, resolveBrowserStartPage, validBrowserStartPageText, validBrowserStartPageImage, type BrowserStartPageConfig } from '../../../shared/browser-start-page.js'

const writeStartPage = <K extends keyof BrowserStartPageConfig>(config: Parameters<ScalarSetting['entry']>[0], key: K, value: BrowserStartPageConfig[K]) =>
  ({ ...config, browser: { ...config.browser, startPage: { ...resolveBrowserStartPage(config.browser.startPage), [key]: value } } })

export const browserSettings = [
  textSetting('browser.startPage.title', config => resolveBrowserStartPage(config.browser.startPage).title,
    (config, value) => writeStartPage(config, 'title', value), value => validBrowserStartPageText(value, BROWSER_START_PAGE_TITLE_LIMIT), DEFAULT_BROWSER_START_PAGE.title),
  textSetting('browser.startPage.subtitle', config => resolveBrowserStartPage(config.browser.startPage).subtitle,
    (config, value) => writeStartPage(config, 'subtitle', value), value => validBrowserStartPageText(value, BROWSER_START_PAGE_SUBTITLE_LIMIT), DEFAULT_BROWSER_START_PAGE.subtitle),
  ...(['icon', 'backgroundImage'] as const).map(key => textSetting(`browser.startPage.${key}`,
    config => resolveBrowserStartPage(config.browser.startPage)[key], (config, value) => writeStartPage(config, key, value), validBrowserStartPageImage)),
  booleanSetting('browser.startPage.showHistory', DEFAULT_BROWSER_START_PAGE.showHistory,
    config => resolveBrowserStartPage(config.browser.startPage).showHistory, (config, value) => writeStartPage(config, 'showHistory', value)),
  booleanSetting('browser.agentAutomation', DEFAULT_CONFIG.browser.agentAutomation === true,
    (config) => config.browser.agentAutomation === true,
    (config, agentAutomation) => ({ ...config, browser: { ...config.browser, agentAutomation } })),
  ...BROWSER_TOOLBAR_ITEM_ORDER.map((item) => booleanSetting(`browser.toolbar.${item}`, DEFAULT_CONFIG.browser.toolbar[item],
    (config) => config.browser.toolbar[item],
    (config, shown) => ({ ...config, browser: { ...config.browser, toolbar: { ...config.browser.toolbar, [item]: shown } } }))),
] satisfies readonly ScalarSetting[]
