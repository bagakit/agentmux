export const NATIVE_PROTOCOL_VERSION = 1
export const NATIVE_PROVIDER = 'agentmux-native-macos'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
export const NATIVE_METHODS = [
  'handshake', 'listApps', 'listWindows', 'listDisplays', 'getAppState', 'permissionStatus',
  'captureScreenshot', 'clipboardRead', 'clipboardWrite', 'click', 'performSecondaryAction',
  'setValue', 'typeText', 'pressKey', 'hotkey', 'pasteText', 'scroll', 'drag', 'captureDisplays'
] as const
export type NativeMethod = typeof NATIVE_METHODS[number]
export const NATIVE_MUTATIONS = new Set<NativeMethod>([
  'captureScreenshot', 'clipboardWrite', 'click', 'performSecondaryAction', 'setValue',
  'typeText', 'pressKey', 'hotkey', 'pasteText', 'scroll', 'drag'
])
export function isNativeMutation(method: NativeMethod, params: JsonObject): boolean {
  return NATIVE_MUTATIONS.has(method) || (method === 'getAppState' && params.noScreenshot === false)
}
export interface NativeErrorData { code: string; message: string }
export interface NativeResponse {
  id: number
  ok: boolean
  instanceId: string
  operationId?: string
  result?: Json
  error?: NativeErrorData
}
export interface NativeOperation {
  operationId: string
  requestId: number
  instanceId: string
  method: NativeMethod
  state: 'pending' | 'completed' | 'failed' | 'unknown'
  error?: NativeErrorData
  /** Completion is receipt of this native request, not proof of an input's effect. */
  resultAvailability?: 'retained' | 'expired'
  result?: Json
}
export type CaptureParams =
  | { mode: 'display'; displayId: number }
  | { mode: 'window'; windowId: number; app: string; processStartedAt: number }
  | { mode: 'rect'; rect: { x: number; y: number; width: number; height: number }; displayId?: number; excludeWindowIds?: number[] }
export interface CaptureResult {
  state: 'captured' | 'failed'
  screenshot?: { format: 'png'; data: string; width: number; height: number; scale: number }
  engine?: string
  selectionRect?: { x: number; y: number; width: number; height: number }
  error?: NativeErrorData
}
/** One active display: its exact pixels from one grab, or the reason they are missing. */
/** An on-screen normal-layer window over a display, read beside its grab. */
export interface NativeDisplayWindow {
  windowId: number
  /** Global Quartz points, the same space as the display frame; may extend past the display. */
  frame: { x: number; y: number; width: number; height: number }
  /** The owning application's name, when the window server reports one. Presentation only. */
  owner?: string
}
export interface NativeDisplayFrameTiming {
  /** Monotonic milliseconds for this display's native pixel grab. */
  captureMs: number
  /** Monotonic milliseconds for native PNG encoding, separate from base64. */
  pngMs: number
  /** Monotonic milliseconds for PNG base64 encoding; no extra JSON serialization. */
  base64Ms: number
  /** Monotonic milliseconds for this display's complete native processing. */
  totalMs: number
}
export interface NativeDisplayFramesTiming {
  /** ScreenCaptureKit content enumeration; 0 on the CoreGraphics path. */
  contentMs: number
  /** The one native window-server list read. */
  windowListMs: number
  /** Whole native captureDisplays operation, before response JSON serialization. */
  totalMs: number
  /** The one actual native response JSON encoding, excluding socket writes. */
  responseSerializationMs: number
  /** NativeDesktop lazy launch/authenticated connection work; 0 when already connected. */
  lazyConnectionMs: number
  /** Actual NDJSON buffering and UTF-8 decoding for this response, including fragments. */
  socketReadMs: number
  /** Actual JSON.parse and response envelope decoding for this response. */
  jsonParseMs: number
  /** Node request round trip, including transport and native work. */
  requestMs: number
  /** Node result validation, excluding the request. */
  validationMs: number
}
export type NativeDisplayFrame = {
  displayId: number
  /** Global Quartz points. */
  frame: { x: number; y: number; width: number; height: number }
  scale: number
  /** Points at the display's top covered by a camera housing; 0 without one. */
  safeTop: number
  /** Windows intersecting this display, front to back; helper and host follow the same PID filter as pixels. */
  windows: NativeDisplayWindow[]
  /** Bounded native stage timings, present for captured and issue displays. */
  timing: NativeDisplayFrameTiming
} & (
  | { png: string; width: number; height: number; engine: string; issue?: never }
  | { issue: string; png?: never; width?: never; height?: never; engine?: never }
)
export interface NativeDisplayFrames {
  state: 'captured'
  /** Milliseconds since the Unix epoch, taken before the first display grab. */
  capturedAt: number
  /** Every active display; at least one carries pixels. */
  displays: NativeDisplayFrame[]
  /** Bounded native and Node stage timings; no pixels, paths or draft text. */
  timing: NativeDisplayFramesTiming
}

export function decodeResponse(input: unknown): NativeResponse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Native response must be an object')
  const value = input as Record<string, unknown>
  const keys = new Set(['id', 'ok', 'instanceId', 'operationId', 'result', 'error'])
  if (Object.keys(value).some(key => !keys.has(key)) || !Number.isSafeInteger(value.id) || (value.id as number) < 1 ||
      typeof value.ok !== 'boolean' || typeof value.instanceId !== 'string' || !value.instanceId ||
      (value.operationId !== undefined && (typeof value.operationId !== 'string' || !value.operationId))) throw new Error('Invalid native response identity')
  if (value.ok) {
    if (!Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')) throw new Error('Invalid native success response')
  } else {
    const error = value.error as Record<string, unknown> | undefined
    if (Object.hasOwn(value, 'result') || !error || typeof error.code !== 'string' || !error.code ||
        typeof error.message !== 'string' || Object.keys(error).some(k => k !== 'code' && k !== 'message')) throw new Error('Invalid native failure response')
  }
  return value as unknown as NativeResponse
}
