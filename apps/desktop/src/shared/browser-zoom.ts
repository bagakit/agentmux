import type { BrowserZoomStep } from './contracts.js'

export const DEFAULT_BROWSER_ZOOM_FACTOR = 0.9
/** Chromium's preset page zoom factors, which a common browser's Zoom In and Zoom Out step through. */
const BROWSER_ZOOM_PRESETS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

/** The next preset beyond the applied zoom, or the product default on reset; either end of the presets stays put. */
export function steppedBrowserZoom(current: number, step: BrowserZoomStep): number {
  if (step === 'reset') return DEFAULT_BROWSER_ZOOM_FACTOR
  const levels = step === 'in' ? BROWSER_ZOOM_PRESETS : [...BROWSER_ZOOM_PRESETS].reverse()
  return levels.find(level => step === 'in' ? level > current + 0.001 : level < current - 0.001) ?? current
}
