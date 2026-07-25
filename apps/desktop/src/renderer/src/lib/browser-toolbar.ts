import type { AppConfig, BrowserToolbarConfig } from '../../../shared/contracts'

export const BROWSER_TOOLBAR_ITEM_ORDER = [
  'selectElement',
  'screenshot',
  'devTools',
  'viewport',
  'more'
] as const satisfies readonly (keyof BrowserToolbarConfig)[]

export type BrowserToolbarItem = (typeof BROWSER_TOOLBAR_ITEM_ORDER)[number]

export const BROWSER_TOOLBAR_ITEM_LABELS: Record<BrowserToolbarItem, string> = {
  selectElement: 'Select element',
  screenshot: 'Screenshot',
  devTools: 'DevTools',
  viewport: 'Viewport',
  more: 'More'
}

export function withBrowserToolbarItem(
  config: AppConfig,
  item: BrowserToolbarItem,
  visible: boolean
): AppConfig {
  return {
    ...config,
    browser: {
      toolbar: {
        ...config.browser.toolbar,
        [item]: visible
      }
    }
  }
}
