import type { BrowserBounds } from './contracts'

/** Chrome geometry only. No page DOM, payload, credentials or executable content crosses this boundary. */
export interface NativeOverlayRegion {
  id: string
  bounds: BrowserBounds
  radius: number
  /** An empty modal scrim is a colour plane, never a screenshot of the covered Browser. */
  scrim?: string
}

export interface NativeOverlayReceipt {
  projected: number
  capturedPixels: number
  warning?: string
}

/** A native page's ordinary outside pointer; never a click, approval or keyboard input. */
export interface NativeBrowserPointer {
  x: number
  y: number
  button: number
}

export const NATIVE_OVERLAY_LIMIT = 8
export const NATIVE_OVERLAY_PIXEL_LIMIT = 2_000_000

export function boundsOverlap(a: BrowserBounds, b: BrowserBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height
}
