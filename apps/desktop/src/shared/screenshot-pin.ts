import type { BrowserPng } from './contracts'
import type { ThemeBootstrap } from './theme-bootstrap'
import type { ScreenshotFileResult } from './screenshot-output'

export const SCREENSHOT_PIN_CHANNEL = 'screenshot:pin'
export type ScreenshotPinInput = { pinId: string; image: BrowserPng; theme: ThemeBootstrap }
export type ScreenshotPinApi = {
  load(): Promise<ScreenshotPinInput>
  copy(pinId: string, operationId: string): Promise<{ status: 'completed' } | { status: 'failed'; message: string }>
  save(pinId: string, operationId: string): Promise<ScreenshotFileResult>
  close(pinId: string): Promise<void>
  layout(pinId: string, chromeHeight: number): Promise<void>
}
