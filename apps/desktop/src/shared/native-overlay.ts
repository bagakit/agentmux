import type { BrowserBounds } from './contracts'
import type { WorkbenchWindowDocument } from './workbench-windows'

/** Synchronous observation of an attached Chrome projection in its focused App window. */
export const NATIVE_OVERLAY_FOCUS_CHANNEL = 'ui:nativeOverlayFocus'

/** Main-owned physically visible Browser rectangles; revision orders initial/read-event races. */
export interface NativeBrowserVisibility {
  revision: number
  bounds: BrowserBounds[]
  /** Actual native document scale, independent of the Root Renderer. */
  zoomFactor?: number
  document?: WorkbenchWindowDocument
}
export type NativeOverlayWarning = { message: string; document?: WorkbenchWindowDocument }

export function sameNativeOverlayDocument(a?: WorkbenchWindowDocument, b?: WorkbenchWindowDocument): boolean {
  return a === undefined && b === undefined || a !== undefined && b !== undefined &&
    a.windowId === b.windowId && a.documentGeneration === b.documentGeneration
}

/** Only an observed projection in this actual native window delays ordinary menu dismissal. */
export function guardNativeOverlayBlur(target: Window, focused: () => boolean): () => void {
  const observe = (event: Event): void => {
    if (event.target !== target || !event.isTrusted) return
    try { if (focused() === true) event.stopImmediatePropagation() } catch { /* Unknown preserves ordinary dismissal. */ }
  }
  target.addEventListener('blur', observe, true)
  return () => target.removeEventListener('blur', observe, true)
}

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
export type NativeBrowserInput = ({
  type: 'pointerDown' | 'pointerMove' | 'pointerLeave'
  browserId: string
  overlayId?: string
  x: number
  y: number
  button: number
} | { type: 'escape'; browserId: string; overlayId: string }) & { document?: WorkbenchWindowDocument }

export const NATIVE_OVERLAY_LIMIT = 8
export const NATIVE_OVERLAY_PIXEL_LIMIT = 2_000_000

export function boundsOverlap(a: BrowserBounds, b: BrowserBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height
}
