export const NATIVE_PROTOCOL_VERSION = 1
export const NATIVE_PROVIDER = 'agentmux-native-macos'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
export const NATIVE_METHODS = [
  'handshake', 'listApps', 'listWindows', 'listDisplays', 'getAppState', 'permissionStatus',
  'captureScreenshot', 'clipboardRead', 'clipboardWrite', 'click', 'performSecondaryAction',
  'setValue', 'typeText', 'pressKey', 'hotkey', 'pasteText', 'scroll', 'drag', 'releaseSelectionBackdrop'
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
export const CAPTURE_EDIT_TOOLS = ['rect', 'arrow', 'note', 'pixelate', 'text'] as const
export type CaptureEditTool = typeof CAPTURE_EDIT_TOOLS[number]
export type CaptureParams =
  /**
   * `initialRect` seeds the selection in global Quartz points; it must touch an active display.
   * `inlineEditing` (requires `allowEditing`) keeps the selected display frozen behind the host editor.
   */
  | { mode: 'selection'; allowEditing?: boolean; inlineEditing?: boolean; initialRect?: { x: number; y: number; width: number; height: number } }
  | { mode: 'display'; displayId: number }
  | { mode: 'window'; windowId: number; app: string; processStartedAt: number }
  | { mode: 'rect'; rect: { x: number; y: number; width: number; height: number }; displayId?: number }
export interface CaptureResult {
  state: 'captured' | 'cancelled' | 'failed'
  screenshot?: { format: 'png'; data: string; width: number; height: number; scale: number }
  engine?: string
  selectionRect?: { x: number; y: number; width: number; height: number }
  /** Host opt-in selection intent; no editing or output delivery happens in Native. */
  completionAction?: 'capture' | 'edit'
  /** Quick-mark tool the editor starts with; only on an editable selection whose intent is `edit`. */
  editTool?: CaptureEditTool
  /** Frozen display kept behind an inline editor; release it with `releaseSelectionBackdrop`. */
  backdrop?: { id: string }
  error?: NativeErrorData
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
