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

/** Which already frozen desktop is displayed; switching never captures again. */
export type CaptureBackground = 'included' | 'excluded'

/** One background of one display, retaining its own capture source. */
export type CaptureSurfaceFrame = { capturedAt: number } & (
  /** Windows are front to back, in this frozen frame's pixels clipped to the frame. */
  | { image: BrowserPng; windows: CaptureSurfaceRect[]; engine: string; issue?: undefined }
  | { image?: undefined; windows?: undefined; engine?: undefined; issue: string })

/** One display's overlay and both backgrounds frozen for this request. */
export type CaptureSurfaceInput = {
  requestId: string
  displayId: number
  frame: CaptureSurfaceRect
  /** Device pixels per point of the frozen frame. */
  scale: number
  /** Points at the top covered by the display's camera housing; capture chrome stays below it. */
  safeTop: number
  attachToDraft: boolean
  /** Whether ⌘E may move these marks into the window editor. */
  expandable: boolean
  theme: ThemeBootstrap
  /** Explicit same-capture Retake geometry in frozen-frame pixels; a fresh capture omits it. */
  initialCrop?: NormalizedRect
  background: CaptureBackground
  backgrounds: Record<CaptureBackground, CaptureSurfaceFrame>
  /** A requested background failed; names the available background actually shown. */
  notice?: string
}

export type CaptureSurfaceEvent = { kind: 'locked' } | { kind: 'notice'; message: string } | { kind: 'background'; background: CaptureBackground }

/** The marks ⌘E carries into the window editor; coordinates are this display's frozen-frame pixels. */
export type CaptureSurfaceHandoff = { shapes: ScreenshotShape[]; crop: NormalizedRect; tool: AnnotationTool }

/** Isolated bridge of one overlay; every call is bound to its original request and display. */
export type CaptureSurfaceApi = {
  load(): Promise<CaptureSurfaceInput>
  /** The frozen frame is painted; Main shows every overlay once all displays reported. */
  presented(requestId: string, background: CaptureBackground): Promise<void>
  /** A selection starts here. False when another display already owns the selection. */
  select(requestId: string): Promise<boolean>
  /** Explicitly selects the named already frozen background; never recaptures. */
  switchBackground(requestId: string, background: CaptureBackground): Promise<void>
  onEvent(listener: (event: CaptureSurfaceEvent) => void): () => void
  /** Primary delivery of the processed selection in this display's frozen-frame pixels; a completed delivery closes every overlay. */
  finish(requestId: string, background: CaptureBackground, image: BrowserPng, selection: CaptureSurfaceRect): Promise<SystemScreenshotEditorFinish>
  /** `selection` is in this display's frozen-frame pixels; Main places the pin there. */
  pin(requestId: string, background: CaptureBackground, operationId: string, image: BrowserPng, selection: CaptureSurfaceRect): Promise<import('@agentmux/core').ImageResult>
  savePng(requestId: string, background: CaptureBackground, image: BrowserPng, selection: CaptureSurfaceRect): Promise<ScreenshotFileResult>
  copyText(requestId: string, text: string): Promise<SystemScreenshotEditorFinish>
  expand(requestId: string, background: CaptureBackground, handoff: CaptureSurfaceHandoff): Promise<void>
  cancel(requestId: string): Promise<void>
}
