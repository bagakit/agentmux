import type { BrowserBounds } from './contracts'

/** Chrome and contained stage geometry only; never page DOM, payload or executable content. */
export interface NativeOverlayRegion {
  id: string
  bounds: BrowserBounds
  radius: number
  /** An empty modal scrim is a colour plane, never a screenshot of the covered Browser. */
  scrim?: string
  /** Original BrowserPane stages physically contained by this open float. Main verifies owners. */
  browserStages?: { browserId: string; bounds: BrowserBounds }[]
}

export interface NativeOverlayReceipt {
  projected: number
  capturedPixels: number
  warning?: string
}

/** Native page notices for its original DOM float; never duplicate page clicks, text or focus. */
export type NativeBrowserInput = {
  type: 'pointerDown' | 'pointerMove' | 'pointerLeave'
  browserId: string
  overlayId?: string
  x: number
  y: number
  button: number
} | { type: 'escape'; browserId: string; overlayId: string }

export const NATIVE_OVERLAY_LIMIT = 8
export const NATIVE_OVERLAY_PIXEL_LIMIT = 2_000_000

export function boundsOverlap(a: BrowserBounds, b: BrowserBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height
}
