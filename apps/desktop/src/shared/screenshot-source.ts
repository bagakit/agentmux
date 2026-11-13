import type { ThemeBootstrap } from './theme-bootstrap'

export type ScreenshotCaptureMode = 'selection' | 'display' | 'window'
export const SCREENSHOT_SOURCE_CHANNEL = 'screenshot:source'
export type ScreenshotSourceChoice = { key: string; label: string; detail: string }
export type ScreenshotSourceInput = { requestId: string; kind: 'display' | 'window'; theme: ThemeBootstrap }
export type ScreenshotSourceList = { choices: ScreenshotSourceChoice[]; issues: string[] }
export type ScreenshotSourceApi = {
  load(): Promise<ScreenshotSourceInput>
  list(requestId: string): Promise<ScreenshotSourceList>
  windows(requestId: string, appKey: string): Promise<ScreenshotSourceList>
  select(requestId: string, key: string): Promise<void>
  cancel(requestId: string): Promise<void>
}
