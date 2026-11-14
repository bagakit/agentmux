import type { ThemeBootstrap } from './theme-bootstrap'

export type ScreenshotCaptureMode = 'selection' | 'display' | 'window' | 'scroll' | 'gif'
/** Region capture may wait 3, 5 or 10 seconds so the user can set up the screen first. */
export type ScreenshotCaptureOptions = { delaySeconds?: import('./screenshot-countdown').ScreenshotDelaySeconds }
export const SCREENSHOT_SOURCE_CHANNEL = 'screenshot:source'
/** `preview` says whether a thumbnail may be requested for this choice; app rows have none. */
export type ScreenshotSourceChoice = { key: string; label: string; detail: string; preview: boolean }
/** Windows past this many in a list show no thumbnail; each preview costs a native screenshot. */
export const WINDOW_PREVIEW_LIMIT = 12
/** A 240 px wide PNG data URL, or null when this source could not be previewed. */
export type ScreenshotSourceThumbnail = { dataUrl: string; width: number; height: number } | null
export type ScreenshotSourceInput = { requestId: string; kind: 'display' | 'window'; theme: ThemeBootstrap }
export type ScreenshotSourceList = { choices: ScreenshotSourceChoice[]; issues: string[] }
export type ScreenshotSourceApi = {
  load(): Promise<ScreenshotSourceInput>
  list(requestId: string): Promise<ScreenshotSourceList>
  windows(requestId: string, appKey: string): Promise<ScreenshotSourceList>
  /** Preview of one listed choice; failures resolve null so the choice stays selectable. */
  thumbnail(requestId: string, key: string): Promise<ScreenshotSourceThumbnail>
  select(requestId: string, key: string): Promise<void>
  cancel(requestId: string): Promise<void>
}
