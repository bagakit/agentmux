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

/** This isolated bridge binds image outputs, file grants and completion to the original editor request. */
export type SystemScreenshotEditorApi = {
  load(): Promise<SystemScreenshotEditorInput>
  finish(requestId: string, operationId: string, image: BrowserPng): Promise<SystemScreenshotEditorFinish>
  cancel(requestId: string): Promise<void>
  savePng(requestId: string, operationId: string, image: BrowserPng): Promise<import('./screenshot-output').ScreenshotFileResult>
  pin(requestId: string, operationId: string, image: BrowserPng): Promise<import('@agentmux/core').ImageResult>
  inspectPin(requestId: string, operationId: string): Promise<import('@agentmux/core').ImageResult>
  copyContext(requestId: string, operationId: string, text: string): Promise<SystemScreenshotEditorFinish>
  openOriginal(requestId: string, operationId: string): Promise<import('./screenshot-original').ScreenshotOriginalReadResult>
  saveOriginal(requestId: string, operationId: string, input: import('./screenshot-original').ScreenshotOriginalSaveInput): Promise<import('./screenshot-original').ScreenshotOriginalSaveResult>
  inspectOriginal(requestId: string, grantId: string): Promise<import('./screenshot-original').ScreenshotOriginalInspectResult>
  inspectOriginalOperation(requestId: string, operationId: string): Promise<import('./screenshot-original').ScreenshotOriginalSaveResult | { status: 'pending' } | null>
}
