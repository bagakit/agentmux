import type { AppConfig } from '../../../shared/contracts'
import type { BrowserToolbarItem } from '../../../shared/browser-toolbar'

export const BROWSER_TOOLBAR_ITEM_LABELS: Record<BrowserToolbarItem, string> = {
  selectElement: 'Select element',
  screenshot: 'Screenshot',
  devTools: 'DevTools',
  viewport: 'Viewport',
  saveBookmark: 'Save bookmark',
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
