import type { BrowserPng } from './contracts'
import type { ThemeBootstrap } from './theme-bootstrap'
import type { ScreenshotFileResult } from './screenshot-output'

export const SCREENSHOT_PIN_CHANNEL = 'screenshot:pin'
/** `logicalScale` is image pixels per on-screen point of the pin's origin; above 1 the pin offers "Save PNG at 1×". */
export type ScreenshotPinInput = { pinId: string; image: BrowserPng; theme: ThemeBootstrap; logicalScale: number }
export type ScreenshotPinApi = {
  load(): Promise<ScreenshotPinInput>
  copy(pinId: string, operationId: string): Promise<{ status: 'completed' } | { status: 'failed'; message: string }>
  save(pinId: string, operationId: string, options?: { logicalSize?: boolean }): Promise<ScreenshotFileResult>
  close(pinId: string): Promise<void>
  /** Resize by `factor`, keeping `point` (window coordinates) under the pointer. */
  zoom(pinId: string, factor: number, point: { x: number; y: number }): Promise<void>
  /** Move the window to `position` (screen points); the page drives this from its grip. */
  move(pinId: string, position: { x: number; y: number }): Promise<void>
  /** Window opacity from 0.2 to 1. */
  opacity(pinId: string, opacity: number): Promise<void>
  clickThrough(pinId: string, enabled: boolean): Promise<void>
  /** Start dragging this pin's PNG file out to another app. */
  drag(pinId: string): Promise<void>
}
