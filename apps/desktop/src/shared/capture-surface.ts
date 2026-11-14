import { mintObjectId } from '@agentmux/core/object-id'
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

/** Main-only request clock. The physical OS keydown before the registered callback is deliberately not guessed. */
export type CaptureRequestTiming = {
  requestId: string
  startedAt: number
  callbackToPrepareMs: number | null
  prepareMs: number | null
  screenCaptureMs: number | null
  presentMs: number | null
}
export function startCaptureRequestTiming(): CaptureRequestTiming {
  return { requestId: mintObjectId(), startedAt: performance.now(), callbackToPrepareMs: null, prepareMs: null, screenCaptureMs: null, presentMs: null }
}
export type CaptureRendererTiming = { loadMs: number; decodeMs: number; paintMs: number; presentedMs: number }

/** One background of one display, retaining its own capture source. */
export type CaptureSurfaceFrame =
  /** Windows are front to back, in this frozen frame's pixels clipped to the frame. */
  | { status: 'ready'; capturedAt: number; image: BrowserPng; windows: CaptureSurfaceRect[]; engine: string; issue?: undefined }
  | { status: 'pending'; capturedAt: 0; image?: undefined; windows?: undefined; engine?: undefined; issue?: undefined }
  | { status: 'failed'; capturedAt: number; image?: undefined; windows?: undefined; engine?: undefined; issue: string }

/** One display's overlay and both backgrounds frozen for this request. */
export type CaptureSurfaceInput = {
  requestId: string
  /** Atomic snapshot generation; deferred frames never resend the already displayed PNG. */
  revision: number
  displayId: number
  frame: CaptureSurfaceRect
  /** Device pixels per point of the frozen frame. */
  scale: number
  /** Points at the top covered by the display's camera housing; capture chrome stays below it. */
  safeTop: number
  attachToDraft: boolean
  /** Whether ⌘E may move these marks into the window editor. */
  expandable: boolean
  sourceChoices?: boolean
  sequenceMode?: 'scroll'
  theme: ThemeBootstrap
  /** Explicit same-capture Retake geometry in frozen-frame pixels; a fresh capture omits it. */
  initialCrop?: NormalizedRect
  background: CaptureBackground
  backgrounds: Record<CaptureBackground, CaptureSurfaceFrame>
  /** A requested background failed; names the available background actually shown. */
  notice?: string
}

export type ScrollingProgress = {
  preview?: string
  requestId: string
  state: import('./capture-sequence').SequenceSnapshot['state']
  frameCount: number
  issue: string | null
}

export type CaptureSurfaceEvent = { kind: 'locked' } | { kind: 'notice'; message: string } | { kind: 'background'; background: CaptureBackground }
  | { kind: 'snapshot'; requestId: string; revision: number; background: CaptureBackground; frame: CaptureSurfaceFrame }
  | { kind: 'scroll-progress'; input: ScrollingProgress }
  | { kind: 'scrolling'; input: ScrollingProgress; selection: CaptureSurfaceRect; toolbar: CaptureSurfaceRect }

/** The marks ⌘E carries into the window editor; coordinates are this display's frozen-frame pixels. */
export type CaptureSurfaceHandoff = { shapes: ScreenshotShape[]; crop: NormalizedRect; tool: AnnotationTool }

/** Isolated bridge of one overlay; every call is bound to its original request and display. */
export type CaptureSurfaceApi = {
  load(): Promise<CaptureSurfaceInput>
  /** The frozen frame is painted; Main shows every overlay once all displays reported. */
  presented(requestId: string, background: CaptureBackground, timing?: CaptureRendererTiming): Promise<void>
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
  source(requestId: string, mode: 'display' | 'window' | 3 | 5 | 10): Promise<void>
  sequence(requestId: string, background: CaptureBackground, image: BrowserPng, selection: CaptureSurfaceRect, mode: 'scroll' | 'gif', toolbar?: CaptureSurfaceRect): Promise<void>
  liveInput(requestId: string, toolbar: CaptureSurfaceRect): Promise<void>
  cancel(requestId: string): Promise<void>
}
