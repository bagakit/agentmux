/** Presentation preferences only; page, navigation and history remain Browser-owned. */
export type BrowserStartPageConfig = {
  title: string
  subtitle: string
  icon?: string
  backgroundImage?: string
  showHistory: boolean
}

export const DEFAULT_BROWSER_START_PAGE: Required<BrowserStartPageConfig> = {
  title: 'AMUX - Survey',
  subtitle: 'Follow a question. Keep what you find.',
  icon: '',
  backgroundImage: '',
  showHistory: true
}

export const BROWSER_START_PAGE_TITLE_LIMIT = 200
export const BROWSER_START_PAGE_SUBTITLE_LIMIT = 500
// Bound inline presentation data; larger images can use ordinary image URLs.
export const BROWSER_START_PAGE_IMAGE_LIMIT = 2 * 1024 * 1024

export function resolveBrowserStartPage(config?: Partial<BrowserStartPageConfig>): Required<BrowserStartPageConfig> {
  return { ...DEFAULT_BROWSER_START_PAGE, ...config, icon: config?.icon ?? '', backgroundImage: config?.backgroundImage ?? '' }
}

export function validBrowserStartPageText(value: string, limit: number): boolean {
  return value.length <= limit && !/[\x00-\x1f\x7f]/.test(value)
}

export function validBrowserStartPageImage(value: string): boolean {
  if (!value) return true
  if (value.length > BROWSER_START_PAGE_IMAGE_LIMIT) return false
  if (/^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return true
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch { return false }
}
