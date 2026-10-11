export const BROWSER_VIEWPORT_PRESETS = {
  responsive: null,
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 }
} as const

export type BrowserViewportPreset = keyof typeof BROWSER_VIEWPORT_PRESETS
export type BrowserViewportSize = {
  readonly width: number
  readonly height: number
  readonly screenPosition: 'mobile' | 'desktop'
}
export type BrowserViewport = BrowserViewportPreset | BrowserViewportSize

// Electron converts screenSize/viewSize through gfx::Size's signed 32-bit ints.
// This is a native protocol boundary, independent of screenshot export limits.
export const BROWSER_VIEWPORT_MAX_DIMENSION = 2_147_483_647

export function isBrowserViewport(value: unknown): value is BrowserViewport {
  if (typeof value === 'string') return Object.hasOwn(BROWSER_VIEWPORT_PRESETS, value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const size = value as Partial<BrowserViewportSize>
  return (size.screenPosition === 'mobile' || size.screenPosition === 'desktop') &&
    [size.width, size.height].every(dimension => typeof dimension === 'number' &&
      Number.isInteger(dimension) && dimension > 0 && dimension <= BROWSER_VIEWPORT_MAX_DIMENSION)
}

/** Own custom dimensions without retaining a mutable caller's request object. */
export function cloneBrowserViewport(viewport: BrowserViewport): BrowserViewport {
  return typeof viewport === 'string' ? viewport : Object.freeze({
    width: viewport.width, height: viewport.height, screenPosition: viewport.screenPosition
  })
}

/** Responsive has no fixed dimensions; preset names resolve at the same boundary as custom sizes. */
export function browserViewportSize(viewport: BrowserViewport): BrowserViewportSize | null {
  if (typeof viewport !== 'string') return viewport
  const size = BROWSER_VIEWPORT_PRESETS[viewport]
  return size ? { ...size, screenPosition: viewport === 'desktop' ? 'desktop' : 'mobile' } : null
}

export function browserViewportsEqual(a: BrowserViewport, b: BrowserViewport): boolean {
  return a === b || typeof a !== 'string' && typeof b !== 'string' &&
    a.width === b.width && a.height === b.height && a.screenPosition === b.screenPosition
}
