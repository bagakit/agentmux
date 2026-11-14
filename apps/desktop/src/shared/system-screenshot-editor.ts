import type { BrowserPng } from './contracts'
import type { ThemeBootstrap } from './theme-bootstrap'
import type { CaptureSurfaceHandoff } from './capture-surface'

export const SYSTEM_SCREENSHOT_EDITOR_CHANNEL = 'screenshot:editor'
/** Main to editor: a short status, for example when the capture shortcut is pressed while this editor is open. */
export const SYSTEM_SCREENSHOT_EDITOR_NOTICE = 'screenshot:editor-notice'

/** Where and when the image was captured. `rect` is in global logical points (Electron DIP on macOS). */
export type ScreenshotCaptureSource = {
  rect: { x: number; y: number; width: number; height: number }
  /** Device pixels per point of the captured image. */
  scale: number
  /** Epoch milliseconds when capture started. */
  capturedAt: number
}
/** The marks a capture surface hands over on ⌘E, on that display's full frozen frame. */
export type ScreenshotEditMarks = { initialState: Pick<CaptureSurfaceHandoff, 'shapes' | 'crop'>; initialTool: CaptureSurfaceHandoff['tool'] }
/** Optional facts of one edit: where the image came from, marks to continue, and `returnFocus` when another app
 * was active at capture start, so closing the editor goes back to it. Main only: `retake` hands this capture's own
 * consumer back to the capture surface and resolves how that new capture ended. */
export type ScreenshotEditContext = { source?: ScreenshotCaptureSource; returnFocus?: boolean; retake?(): Promise<'completed' | 'cancelled' | 'expanded'> }
  & (ScreenshotEditMarks | { initialState?: undefined; initialTool?: undefined })

export type SystemScreenshotEditorInput = {
  requestId: string
  image: BrowserPng
  attachToDraft: boolean
  theme: ThemeBootstrap
  source?: ScreenshotCaptureSource
  /** The image came from the capture surface, so Retake can take it again for the same consumer. */
  retakable?: true
  textUnavailableReason?: string
} & (ScreenshotEditMarks | { initialState?: undefined; initialTool?: undefined })
export type SystemScreenshotEditorFinish = { status: 'completed' } | { status: 'failed'; message: string }
/** completed: the new capture took over and this editor closes; cancelled: this editor is back with its marks. */
export type SystemScreenshotEditorRetake = { status: 'completed' } | { status: 'cancelled' } | { status: 'failed'; message: string }

/** This isolated bridge binds image outputs, file grants and completion to the original editor request. */
export type SystemScreenshotEditorApi = {
  load(): Promise<SystemScreenshotEditorInput>
  recognizeText(requestId: string, image: BrowserPng): Promise<import('@agentmux/native-desktop').NativeRecognizedText>
  /** Listen for Main notices; returns the unsubscribe. */
  onNotice(listener: (message: string) => void): () => void
  finish(requestId: string, operationId: string, image: BrowserPng): Promise<SystemScreenshotEditorFinish>
  cancel(requestId: string): Promise<void>
  /** Steps this editor aside and opens the capture surface for the same consumer. */
  retake(requestId: string): Promise<SystemScreenshotEditorRetake>
  /** Each call opens one save sheet. `logicalSize` saves at 1× logical points using `source.scale`. */
  savePng(requestId: string, image: BrowserPng, options?: { logicalSize?: boolean }): Promise<import('./screenshot-output').ScreenshotFileResult>
  pin(requestId: string, operationId: string, image: BrowserPng): Promise<import('@agentmux/core').ImageResult>
  inspectPin(requestId: string, operationId: string): Promise<import('@agentmux/core').ImageResult>
  copyContext(requestId: string, operationId: string, text: string): Promise<SystemScreenshotEditorFinish>
  openOriginal(requestId: string, operationId: string): Promise<import('./screenshot-original').ScreenshotOriginalReadResult>
  saveOriginal(requestId: string, operationId: string, input: import('./screenshot-original').ScreenshotOriginalSaveInput): Promise<import('./screenshot-original').ScreenshotOriginalSaveResult>
  inspectOriginal(requestId: string, grantId: string): Promise<import('./screenshot-original').ScreenshotOriginalInspectResult>
  inspectOriginalOperation(requestId: string, operationId: string): Promise<import('./screenshot-original').ScreenshotOriginalSaveResult | { status: 'pending' } | null>
}
