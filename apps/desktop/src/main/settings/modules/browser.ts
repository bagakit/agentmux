import { BROWSER_TOOLBAR_ITEM_ORDER } from '../../../shared/browser-toolbar.js'
import { DEFAULT_CONFIG } from '../../config-store.js'
import { booleanSetting } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'

export const browserSettings = [
  booleanSetting('browser.agentAutomation', DEFAULT_CONFIG.browser.agentAutomation === true,
    (config) => config.browser.agentAutomation === true,
    (config, agentAutomation) => ({ ...config, browser: { ...config.browser, agentAutomation } })),
  ...BROWSER_TOOLBAR_ITEM_ORDER.map((item) => booleanSetting(`browser.toolbar.${item}`, DEFAULT_CONFIG.browser.toolbar[item],
    (config) => config.browser.toolbar[item],
    (config, shown) => ({ ...config, browser: { ...config.browser, toolbar: { ...config.browser.toolbar, [item]: shown } } }))),
] satisfies readonly ScalarSetting[]
