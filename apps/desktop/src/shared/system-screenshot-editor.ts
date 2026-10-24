import type { BrowserPng } from './contracts'
import type { ThemeBootstrap } from './theme-bootstrap'

export const SYSTEM_SCREENSHOT_EDITOR_CHANNEL = 'screenshot:editor'

export type SystemScreenshotEditorInput = {
  requestId: string
  image: BrowserPng
  attachToDraft: boolean
  theme: ThemeBootstrap
  initialIssue?: string
}
export type SystemScreenshotEditorFinish = { status: 'completed' } | { status: 'failed'; message: string }

/** This isolated window can only edit its original image and finish or cancel that request. */
export type SystemScreenshotEditorApi = {
  load(): Promise<SystemScreenshotEditorInput>
  finish(requestId: string, operationId: string, image: BrowserPng): Promise<SystemScreenshotEditorFinish>
  cancel(requestId: string): Promise<void>
}
