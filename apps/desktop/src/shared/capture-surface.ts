import type { BrowserPng } from './contracts'
import type { ThemeBootstrap } from './theme-bootstrap'
import type { ScreenshotFileResult } from './screenshot-output'
import type { SystemScreenshotEditorFinish } from './system-screenshot-editor'
import type { NormalizedRect, ScreenshotShape } from '../renderer/src/components/image-annotation/drawing-model'
import type { AnnotationTool } from '../renderer/src/components/image-annotation/AnnotationToolbar'

export const CAPTURE_SURFACE_CHANNEL = 'screenshot:capture-surface'
/** Main to one overlay: another display took the selection, or a short status. */
export const CAPTURE_SURFACE_EVENT = 'screenshot:capture-surface-event'

/** Global logical points (Electron DIP on macOS). */
export type CaptureSurfaceRect = { x: number; y: number; width: number; height: number }

/** One display's overlay: its frozen frame, or the reason that display has none. */
export type CaptureSurfaceInput = {
  requestId: string
  displayId: number
  frame: CaptureSurfaceRect
  /** Device pixels per point of the frozen frame. */
  scale: number
  attachToDraft: boolean
  /** Whether ⌘E may move these marks into the window editor. */
  expandable: boolean
  theme: ThemeBootstrap
  /** The selection last delivered on this display while its frame and scale stay the same, in frozen-frame pixels; only a starting point. */
  initialCrop?: NormalizedRect
} & (
  /** `windows`: the application windows on this display when it froze, front to back, in frozen-frame pixels clipped to the frame. */
  | { image: BrowserPng; windows: CaptureSurfaceRect[]; issue?: undefined }
  | { image?: undefined; windows?: undefined; issue: string })

export type CaptureSurfaceEvent = { kind: 'locked' } | { kind: 'notice'; message: string }

/** The marks ⌘E carries into the window editor; coordinates are this display's frozen-frame pixels. */
export type CaptureSurfaceHandoff = { shapes: ScreenshotShape[]; crop: NormalizedRect; tool: AnnotationTool }

/** Isolated bridge of one overlay; every call is bound to its original request and display. */
export type CaptureSurfaceApi = {
  load(): Promise<CaptureSurfaceInput>
  /** The frozen frame is painted; Main shows every overlay once all displays reported. */
  presented(requestId: string): Promise<void>
  /** A selection starts here. False when another display already owns the selection. */
  select(requestId: string): Promise<boolean>
  onEvent(listener: (event: CaptureSurfaceEvent) => void): () => void
  /** Primary delivery of the processed selection in this display's frozen-frame pixels; a completed delivery closes every overlay. */
  finish(requestId: string, image: BrowserPng, selection: CaptureSurfaceRect): Promise<SystemScreenshotEditorFinish>
  /** `selection` is in this display's frozen-frame pixels; Main places the pin there. */
  pin(requestId: string, operationId: string, image: BrowserPng, selection: CaptureSurfaceRect): Promise<import('@agentmux/core').ImageResult>
  savePng(requestId: string, image: BrowserPng): Promise<ScreenshotFileResult>
  copyText(requestId: string, text: string): Promise<SystemScreenshotEditorFinish>
  expand(requestId: string, handoff: CaptureSurfaceHandoff): Promise<void>
  cancel(requestId: string): Promise<void>
}
