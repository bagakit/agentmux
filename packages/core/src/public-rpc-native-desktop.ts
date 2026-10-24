import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { NativeDesktopPayloadMap } from './native-desktop-types.js'
export type * from './native-desktop-types.js'

export type NativeDesktopJson = null | boolean | number | string | NativeDesktopJson[] | { [key: string]: NativeDesktopJson }
export interface NativeDesktopScope { hostId: string; instanceId: string }
export interface NativeDesktopAppTarget { pid: number; processStartedAt: number }
export interface NativeDesktopWindowTarget extends NativeDesktopAppTarget { windowId: number }
export type NativeDesktopAction =
  | { kind: 'click'; elementIndex?: number; x?: number; y?: number; mouseButton?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: string }
  | { kind: 'performSecondaryAction'; elementIndex: number; action: string }
  | { kind: 'setValue'; elementIndex: number; value: string }
  | { kind: 'typeText' | 'pasteText'; text: string }
  | { kind: 'pressKey' | 'hotkey'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; pages?: number; elementIndex?: number; x?: number; y?: number }
  | { kind: 'drag'; fromElementIndex?: number; toElementIndex?: number; fromX?: number; fromY?: number; toX?: number; toY?: number }
export type NativeDesktopCapture =
  | { mode: 'selection' }
  | { mode: 'display'; displayId: number }
  | { mode: 'rect'; rect: { x: number; y: number; width: number; height: number } }
  | { mode: 'window'; target: NativeDesktopWindowTarget }
export type NativeDesktopParamsMap = {
  'native.capabilities': { hostId: string }
  'native.apps.list': NativeDesktopScope
  'native.displays.list': NativeDesktopScope
  'native.windows.list': NativeDesktopScope & { target: NativeDesktopAppTarget }
  'native.snapshot': NativeDesktopScope & { target: NativeDesktopWindowTarget }
  'native.permissions.inspect': NativeDesktopScope
  'native.capture': NativeDesktopScope & { operationId: string; capture: NativeDesktopCapture }
  'native.clipboard.read': NativeDesktopScope & { format: 'text' | 'png' }
  'native.clipboard.write': NativeDesktopScope & { operationId: string; format: 'text' | 'png'; data: string }
  'native.action': NativeDesktopScope & { operationId: string; target: NativeDesktopWindowTarget; snapshotId: string; action: NativeDesktopAction }
  'native.operation.inspect': NativeDesktopScope & { operationId: string }
}
export interface NativeDesktopReply {
  hostId: string
  instanceId: string
  /** Response received does not certify an action's effect or OS permission. */
  state: 'responded' | 'unknown'
  operationId?: string
  result?: NativeDesktopJson
  error?: { code: string; message: string }
  operation?: NativeDesktopJson
}
export type NativeDesktopMethod = keyof NativeDesktopParamsMap
export type NativeDesktopResultMap = { [M in NativeDesktopMethod]: Omit<NativeDesktopReply, 'result'> & { result?: NativeDesktopPayloadMap[M] } }
export interface AgentMuxRpcNativeDesktopOwner {
  call<M extends NativeDesktopMethod>(method: M, params: NativeDesktopParamsMap[M], context?: AgentMuxRpcCallContext): Promise<NativeDesktopReply>
}
export const AGENTMUX_RPC_DESKTOP_NATIVE_METHODS = {
  'native.capabilities': 'short', 'native.apps.list': 'short', 'native.displays.list': 'short',
  'native.windows.list': 'short', 'native.snapshot': 'long', 'native.permissions.inspect': 'short',
  'native.capture': 'long', 'native.clipboard.read': 'short', 'native.clipboard.write': 'long',
  'native.action': 'long', 'native.operation.inspect': 'short'
} as const satisfies Record<NativeDesktopMethod, 'short' | 'long'>
export const NATIVE_DESKTOP_WRITES = new Set<NativeDesktopMethod>(['native.capture', 'native.clipboard.write', 'native.action'])
export function isNativeDesktopMethod(value: unknown): value is NativeDesktopMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_DESKTOP_NATIVE_METHODS, value)
}
function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function text(value: unknown, code: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.length)) invalid('An exact native identity or UTF-8 string is required.', code)
}
function number(value: unknown, code: string, positive = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || positive && value <= 0) invalid('A finite native coordinate or process birth is required.', code)
}
function integer(value: unknown, code: string, min = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid('A native OS or element identity is invalid.', code)
}
function target(value: unknown, window: boolean, code: string): Record<string, unknown> {
  const p = rpcRecord(value, window ? ['pid', 'processStartedAt', 'windowId'] : ['pid', 'processStartedAt'], code)
  integer(p.pid, code); number(p.processStartedAt, code, true)
  if ((p.pid as number) > 2_147_483_647) invalid('The native PID is out of range.', code)
  if (window) integer(p.windowId, code)
  return p
}
function elementOrPoint(p: Record<string, unknown>, code: string): void {
  if (p.elementIndex !== undefined) {
    integer(p.elementIndex, code, 0)
    if (p.x !== undefined || p.y !== undefined) invalid('Choose an original element reference or one exact point.', code)
  } else { number(p.x, code); number(p.y, code) }
}
function parseAction(value: unknown, code: string): void {
  const action = rpcRecord(value, undefined, code)
  const fields: Record<string, string[]> = {
    click: ['elementIndex', 'x', 'y', 'mouseButton', 'clickCount', 'modifiers'],
    performSecondaryAction: ['elementIndex', 'action'], setValue: ['elementIndex', 'value'],
    typeText: ['text'], pasteText: ['text'], pressKey: ['key'], hotkey: ['key'],
    scroll: ['direction', 'pages', 'elementIndex', 'x', 'y'],
    drag: ['fromElementIndex', 'toElementIndex', 'fromX', 'fromY', 'toX', 'toY']
  }
  text(action.kind, code)
  if (!Object.hasOwn(fields, action.kind)) invalid('Choose a registered typed native action.', code)
  rpcRecord(action, ['kind', ...fields[action.kind]!], code)
  if (action.kind === 'click' || action.kind === 'scroll') elementOrPoint(action, code)
  if (action.kind === 'click') {
    if (action.clickCount !== undefined) integer(action.clickCount, code)
    if (action.mouseButton !== undefined && !['left', 'right', 'middle'].includes(action.mouseButton as string)) invalid('Invalid native mouse button.', code)
    if (action.modifiers !== undefined) text(action.modifiers, code, true)
  } else if (action.kind === 'performSecondaryAction' || action.kind === 'setValue') {
    integer(action.elementIndex, code, 0)
    text(action[action.kind === 'setValue' ? 'value' : 'action'], code, action.kind === 'setValue')
  } else if (action.kind === 'typeText' || action.kind === 'pasteText') text(action.text, code)
  else if (action.kind === 'pressKey' || action.kind === 'hotkey') text(action.key, code)
  else if (action.kind === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(action.direction as string)) invalid('Invalid native scroll direction.', code)
    if (action.pages !== undefined) number(action.pages, code, true)
  } else if (action.kind === 'drag') {
    if (action.fromElementIndex !== undefined || action.toElementIndex !== undefined) {
      integer(action.fromElementIndex, code, 0); integer(action.toElementIndex, code, 0)
      if (['fromX', 'fromY', 'toX', 'toY'].some(key => action[key] !== undefined)) invalid('Choose exact drag elements or coordinates.', code)
    } else for (const key of ['fromX', 'fromY', 'toX', 'toY']) number(action[key], code)
  }
}
export function parseNativeDesktopParams<M extends NativeDesktopMethod>(method: M, value: unknown): NativeDesktopParamsMap[M] {
  const code = 'INVALID_CONTROL_REQUEST'
  const extra: Record<NativeDesktopMethod, string[]> = {
    'native.capabilities': [], 'native.apps.list': [], 'native.displays.list': [],
    'native.windows.list': ['target'], 'native.snapshot': ['target'],
    'native.permissions.inspect': [], 'native.capture': ['operationId', 'capture'],
    'native.clipboard.read': ['format'], 'native.clipboard.write': ['operationId', 'format', 'data'],
    'native.action': ['operationId', 'target', 'snapshotId', 'action'], 'native.operation.inspect': ['operationId']
  }
  const p = rpcRecord(value, ['hostId', ...(method === 'native.capabilities' ? [] : ['instanceId']), ...extra[method]], code)
  text(p.hostId, code)
  if (method !== 'native.capabilities') text(p.instanceId, code)
  if (NATIVE_DESKTOP_WRITES.has(method) || method === 'native.operation.inspect') text(p.operationId, code)
  for (const key of ['hostId', 'instanceId', 'operationId', 'snapshotId']) if (typeof p[key] === 'string' && (p[key] as string).includes('\0')) invalid('Native identities cannot contain NUL.', code)
  if (method === 'native.windows.list' || method === 'native.snapshot' || method === 'native.action') target(p.target, method !== 'native.windows.list', code)
  if (method === 'native.action') { text(p.snapshotId, code); parseAction(p.action, code) }
  if (method.startsWith('native.clipboard.')) {
    if (p.format !== 'text' && p.format !== 'png') invalid('Clipboard format must be text or png.', code)
    if (method === 'native.clipboard.write') text(p.data, code, p.format === 'text')
    if (method === 'native.clipboard.write' && p.format === 'png') pngPayload(p.data, code)
  }
  if (method === 'native.capture') {
    const capture = rpcRecord(p.capture, undefined, code)
    if (!['selection', 'display', 'rect', 'window'].includes(capture.mode as string)) invalid('Choose a typed capture mode.', code)
    rpcRecord(capture, capture.mode === 'selection' ? ['mode'] : capture.mode === 'display' ? ['mode', 'displayId'] : capture.mode === 'window' ? ['mode', 'target'] : ['mode', 'rect'], code)
    if (capture.mode === 'display') integer(capture.displayId, code)
    if (capture.mode === 'window') target(capture.target, true, code)
    if (capture.mode === 'rect') {
      const rect = rpcRecord(capture.rect, ['x', 'y', 'width', 'height'], code)
      number(rect.x, code); number(rect.y, code); number(rect.width, code, true); number(rect.height, code, true)
    }
  }
  return structuredClone(p) as NativeDesktopParamsMap[M]
}

function errorData(value: unknown, code: string): void {
  const error = rpcRecord(value, ['code', 'message'], code)
  text(error.code, code); text(error.message, code, true)
}
function app(value: unknown, code: string): Record<string, unknown> {
  const p = rpcRecord(value, ['name', 'bundleId', 'pid', 'processStartedAt', 'isRunning', 'lastUsedAt', 'useCount'], code)
  text(p.name, code); integer(p.pid, code)
  if (p.bundleId !== null) text(p.bundleId, code)
  if (p.processStartedAt !== null) number(p.processStartedAt, code, true)
  if (p.isRunning !== undefined && typeof p.isRunning !== 'boolean') invalid('Native process running state is invalid.', code)
  if (p.lastUsedAt !== undefined && p.lastUsedAt !== null || p.useCount !== undefined && p.useCount !== null) invalid('Native discovery cannot invent usage history.', code)
  return p
}
function window(value: unknown, code: string): Record<string, unknown> {
  const p = rpcRecord(value, ['index', 'app', 'id', 'title', 'x', 'y', 'width', 'height', 'isMinimized', 'isOffscreen', 'screenIndex', 'isMain', 'platform'], code)
  integer(p.id, code); text(p.title, code, true)
  for (const key of ['x', 'y', 'width', 'height']) number(p[key], code)
  for (const key of ['isMinimized', 'isOffscreen']) if (p[key] !== undefined && typeof p[key] !== 'boolean') invalid('Native window state is invalid.', code)
  if (p.screenIndex !== undefined && p.screenIndex !== null) integer(p.screenIndex, code, 0)
  return p
}
function boundedArray(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value) || value.length > 16_384) invalid('Native discovery result is not bounded.', code)
  return value
}
function matchesTarget(actual: Record<string, unknown>, expected: NativeDesktopAppTarget, code: string): void {
  if (actual.pid !== expected.pid || actual.processStartedAt !== expected.processStartedAt) invalid('Native result belongs to another OS process.', code)
}
function pngPayload(data: unknown, code: string): { width: number; height: number } {
  text(data, code)
  if (data.length > 24 * 1024 * 1024 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid('Native PNG exceeds its image contract.', code)
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length < 33 || bytes.length > 18 * 1024 * 1024 || bytes.toString('base64') !== data ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid('Native payload is not a canonical bounded PNG.', code)
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) invalid('Native PNG dimensions exceed its image contract.', code)
  return { width, height }
}
function png(value: unknown, code: string): void {
  const p = rpcRecord(value, ['data', 'format', 'width', 'height', 'scale'], code)
  const size = pngPayload(p.data, code)
  integer(p.width, code); integer(p.height, code); number(p.scale, code, true)
  if (p.format !== 'png' || size.width !== p.width || size.height !== p.height) invalid('Native PNG bytes do not match their dimensions.', code)
}

export function parseNativeDesktopResult<M extends NativeDesktopMethod>(method: M, value: unknown, input: NativeDesktopParamsMap[M]): NativeDesktopReply {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['hostId', 'instanceId', 'state', 'operationId', 'result', 'error', 'operation'], code)
  text(p.instanceId, code)
  if (p.hostId !== input.hostId || ('instanceId' in input && p.instanceId !== input.instanceId)) invalid('Native receipt belongs to another Host or instance.', code)
  if (NATIVE_DESKTOP_WRITES.has(method) && p.operationId !== (input as { operationId: string }).operationId) invalid('Native receipt lost its original operation.', code)
  if (p.operation !== undefined) {
    const operation = rpcRecord(p.operation, undefined, code)
    if (!NATIVE_DESKTOP_WRITES.has(method) || operation.operationId !== p.operationId || operation.instanceId !== p.instanceId) invalid('Native receipt contains another operation.', code)
  }
  if (p.state !== 'responded' && p.state !== 'unknown') invalid('Native receipt state is invalid.', code)
  if (p.error !== undefined) errorData(p.error, code)
  if (p.state === 'unknown') {
    const operation = rpcRecord(p.operation, undefined, code)
    if (!NATIVE_DESKTOP_WRITES.has(method) || p.error === undefined || operation.operationId !== p.operationId || operation.instanceId !== p.instanceId || operation.state !== 'unknown') invalid('Unknown native operation lost its original identity.', code)
    if (p.result !== undefined) invalid('Unknown native operation cannot claim a result.', code)
    return p as unknown as NativeDesktopReply
  }
  if ((p.result === undefined) === (p.error === undefined)) invalid('Native response must contain a result or an error.', code)
  if (p.error !== undefined) return p as unknown as NativeDesktopReply
  const result = rpcRecord(p.result, undefined, code)
  if (method === 'native.capabilities') {
    rpcRecord(result, ['platform', 'provider', 'providerVersion', 'protocolVersion', 'instanceId', 'supports'], code)
    if (result.provider !== 'agentmux-native-macos' || result.protocolVersion !== 1 || result.instanceId !== p.instanceId || result.platform !== 'darwin') invalid('Native protocol identity is incompatible.', code)
    text(result.providerVersion, code); rpcRecord(result.supports, undefined, code)
  } else if (method === 'native.apps.list') {
    rpcRecord(result, ['apps'], code); boundedArray(result.apps, code).forEach(item => app(item, code))
  } else if (method === 'native.displays.list') {
    rpcRecord(result, ['displays'], code)
    for (const item of boundedArray(result.displays, code)) {
      const d = rpcRecord(item, ['id', 'x', 'y', 'width', 'height', 'scale', 'isMain'], code)
      integer(d.id, code); number(d.x, code); number(d.y, code)
      for (const key of ['width', 'height', 'scale']) number(d[key], code, true)
      if (typeof d.isMain !== 'boolean') invalid('Display main state is invalid.', code)
    }
  } else if (method === 'native.windows.list') {
    rpcRecord(result, ['app', 'windows'], code)
    matchesTarget(app(result.app, code), (input as NativeDesktopParamsMap['native.windows.list']).target, code)
    for (const item of boundedArray(result.windows, code)) {
      const itemWindow = window(item, code)
      integer(itemWindow.index, code, 0)
      matchesTarget(app(itemWindow.app, code), (input as NativeDesktopParamsMap['native.windows.list']).target, code)
    }
  } else if (method === 'native.snapshot' || method === 'native.action') {
    const expected = (input as NativeDesktopParamsMap['native.snapshot']).target
    rpcRecord(result, ['snapshotId', 'snapshot', 'screenshot', 'screenshotStatus', 'action', 'observation'], code)
    if (result.snapshot !== undefined) {
      const snapshot = rpcRecord(result.snapshot, ['id', 'app', 'window', 'coordinateSpace', 'treeText', 'elementCount', 'elements', 'focusedElementId', 'truncation'], code)
      matchesTarget(app(snapshot.app, code), expected, code)
      if (window(snapshot.window, code).id !== expected.windowId || snapshot.id !== result.snapshotId || snapshot.coordinateSpace !== 'window') invalid('Native observation returned another window or snapshot.', code)
      text(snapshot.id, code); text(snapshot.treeText, code, true)
      integer(snapshot.elementCount, code, 0)
      const elements = boundedArray(snapshot.elements, code)
      if (elements.length !== snapshot.elementCount) invalid('Native element count does not match its exact references.', code)
      for (const item of elements) {
        const element = rpcRecord(item, ['index', 'actions', 'frame'], code)
        integer(element.index, code, 0)
        boundedArray(element.actions, code).forEach(name => text(name, code))
        if (element.frame !== null) {
          const frame = rpcRecord(element.frame, ['x', 'y', 'width', 'height'], code)
          for (const key of ['x', 'y', 'width', 'height']) number(frame[key], code)
        }
      }
      if (snapshot.focusedElementId !== null) integer(snapshot.focusedElementId, code, 0)
      const truncation = rpcRecord(snapshot.truncation, ['truncated', 'maxNodes', 'maxDepth', 'maxDepthReached'], code)
      if (typeof truncation.truncated !== 'boolean' || typeof truncation.maxDepthReached !== 'boolean') invalid('Native tree coverage is unconfirmed.', code)
      integer(truncation.maxNodes, code); integer(truncation.maxDepth, code)
      const status = rpcRecord(result.screenshotStatus, ['state', 'metadata', 'reason', 'code', 'message'], code)
      if (status.state === 'captured') png(result.screenshot, code)
      else if (status.state !== 'skipped' && status.state !== 'failed') invalid('Native screenshot status is invalid.', code)
      else if (result.screenshot !== null) invalid('Uncaptured snapshot contains screenshot pixels.', code)
    } else if (method === 'native.snapshot') invalid('Native snapshot is missing.', code)
    if (method === 'native.action') {
      const action = rpcRecord(result.action, ['path', 'actionName', 'fallbackReason', 'verification', 'targetWindowId'], code)
      if (action.targetWindowId !== expected.windowId) invalid('Native action receipt changed its original window.', code)
      text(action.path, code)
      if (!['accessibility', 'synthetic', 'clipboard'].includes(action.path)) invalid('Native action delivery path is invalid.', code)
      for (const key of ['actionName', 'fallbackReason']) if (action[key] !== null) text(action[key], code)
      if (action.verification !== undefined) {
        const verification = rpcRecord(action.verification, ['state', 'property', 'reason', 'expected', 'actualPreview', 'completedPages', 'requestedPages', 'error', 'clipboardRestoration', 'clipboardChangeCount'], code)
        if (!['verified', 'unverified', 'accepted', 'failed'].includes(verification.state as string)) invalid('Native action verification state is invalid.', code)
        if (verification.error !== undefined) errorData(verification.error, code)
        if (verification.completedPages !== undefined || verification.requestedPages !== undefined) {
          integer(verification.completedPages, code, 0); integer(verification.requestedPages, code)
          if (verification.completedPages > verification.requestedPages) invalid('Native scroll receipt exceeds its requested work.', code)
        }
        if (verification.clipboardRestoration !== undefined && verification.clipboardRestoration !== 'retained_for_paste') invalid('Native clipboard restoration receipt is invalid.', code)
        if (verification.clipboardChangeCount !== undefined) integer(verification.clipboardChangeCount, code, 0)
      }
      if (result.snapshot === undefined) {
        const observation = rpcRecord(result.observation, ['state', 'error'], code)
        if (observation.state !== 'failed') invalid('Native follow-up observation state is invalid.', code)
        errorData(observation.error, code)
      }
    }
  } else if (method === 'native.capture') {
    rpcRecord(result, ['state', 'screenshot', 'engine', 'selectionRect', 'error'], code)
    if (result.state === 'captured') { png(result.screenshot, code); if (result.error !== undefined) invalid('Captured result also claims failure.', code) }
    else if (result.state === 'failed') errorData(result.error, code)
    else if (result.state !== 'cancelled' || result.error !== undefined) invalid('Native capture must return a typed outcome.', code)
    if (result.state !== 'captured' && result.screenshot !== undefined) invalid('Uncaptured native result contains pixels.', code)
  } else if (method.startsWith('native.clipboard.')) {
    rpcRecord(result, ['format', 'state', 'data', 'changeCount', 'byteLength'], code)
    const requested = input as NativeDesktopParamsMap['native.clipboard.read']
    if (result.format !== requested.format) invalid('Clipboard receipt changed its original format.', code)
    integer(result.changeCount, code, 0)
    if (method === 'native.clipboard.write') {
      if (result.state !== 'written') invalid('Clipboard write is unconfirmed.', code)
      integer(result.byteLength, code, 0)
    } else {
      if (result.state !== 'read' && result.state !== 'empty') invalid('Clipboard read state is invalid.', code)
      if (result.state === 'empty' ? result.data !== null : typeof result.data !== 'string') invalid('Clipboard read is missing its exact data.', code)
      if (requested.format === 'png' && result.state === 'read') pngPayload(result.data, code)
    }
  } else if (method === 'native.permissions.inspect') {
    rpcRecord(result, ['accessibility', 'screenshots', 'source', 'authoritativeForOperation'], code)
    if (!['granted', 'not-granted'].includes(result.accessibility as string) || !['granted', 'not-granted'].includes(result.screenshots as string) || result.authoritativeForOperation !== false || result.source !== 'macOS-preflight') invalid('Permission query cannot certify operation authorization.', code)
  } else if (method === 'native.operation.inspect') {
    const operation = rpcRecord(result, undefined, code)
    if (operation.operationId !== (input as NativeDesktopParamsMap['native.operation.inspect']).operationId || operation.instanceId !== p.instanceId || !['pending', 'completed', 'failed', 'unknown'].includes(operation.state as string)) invalid('Operation inspection lost its original identity.', code)
  }
  return p as unknown as NativeDesktopReply
}
