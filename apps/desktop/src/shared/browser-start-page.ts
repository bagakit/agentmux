/** Presentation preferences only; page, navigation and history remain Browser-owned. */
export type BrowserStartPageConfig = {
  title: string
  subtitle: string
  icon?: string
  backgroundImage?: string
  showHistory: boolean
  historyLimit?: number
  interactiveBackground?: boolean
}

export const DEFAULT_BROWSER_START_PAGE: Required<BrowserStartPageConfig> = {
  title: 'AMUX - Survey',
  subtitle: 'Follow a question. Keep what you find.',
  icon: '',
  backgroundImage: '',
  showHistory: true,
  historyLimit: 12,
  interactiveBackground: true
}

export const BROWSER_START_PAGE_TITLE_LIMIT = 200
export const BROWSER_START_PAGE_SUBTITLE_LIMIT = 500
// This is the initial display count only; the existing history owner retains at most 50 inputs.
export const BROWSER_START_PAGE_HISTORY_LIMIT = { min: 1, max: 50 } as const
// Bound inline presentation data; larger images can use ordinary image URLs.
export const BROWSER_START_PAGE_IMAGE_LIMIT = 2 * 1024 * 1024

export function resolveBrowserStartPage(config?: Partial<BrowserStartPageConfig>): Required<BrowserStartPageConfig> {
  return { ...DEFAULT_BROWSER_START_PAGE, ...config, icon: config?.icon ?? '', backgroundImage: config?.backgroundImage ?? '',
    historyLimit: config?.historyLimit ?? DEFAULT_BROWSER_START_PAGE.historyLimit,
    interactiveBackground: config?.interactiveBackground ?? DEFAULT_BROWSER_START_PAGE.interactiveBackground }
}

export function validBrowserStartPageHistoryLimit(value: number): boolean {
  return Number.isInteger(value) && value >= BROWSER_START_PAGE_HISTORY_LIMIT.min && value <= BROWSER_START_PAGE_HISTORY_LIMIT.max
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
