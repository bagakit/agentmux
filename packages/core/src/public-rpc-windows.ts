import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Client presentation of one original occurrence; never a new Core spatial entity. */
export type AppWindowTarget =
  | { kind: 'tab'; displayWorkspaceId: string; groupId: string; tabId: string }
  | { kind: 'region'; displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
export type AppWindowBounds = { x: number; y: number; width: number; height: number }
export type AppWindowDescriptor = {
  windowId: string
  /** Opaque identity of this native document, replaced after a real document restart. */
  documentGeneration: string | null
  /** Only the original main window has no borrowed workface. */
  target: AppWindowTarget | null
  presentation: 'pending' | 'visible' | 'hidden' | 'unknown'
  bounds: AppWindowBounds | null
  focused: boolean | null
}
export type AppWindowActor = { kind: 'user' | 'device' | 'agent'; id: string }
export type AppWindowParamsMap = {
  'app.window.ls': { operationId?: string }
  'app.window.open': { operationId: string; target: AppWindowTarget; focus?: boolean }
  'app.window.focus': { operationId: string; windowId: string; documentGeneration: string }
  'app.window.return': { operationId: string; windowId: string; documentGeneration: string }
}
export type AppWindowMethod = keyof AppWindowParamsMap
export type AppWindowWriteMethod = Exclude<AppWindowMethod, 'app.window.ls'>
export type AppWindowOperation = {
  [M in AppWindowWriteMethod]: {
    method: M
    input: AppWindowParamsMap[M]
    actor: AppWindowActor
    state: 'pending' | 'confirmed' | 'rejected' | 'unknown'
    windowId: string | null
    documentGeneration: string | null
    message: string | null
  }
}[AppWindowWriteMethod]
export type AppWindowPage = { windows: AppWindowDescriptor[]; recordedOperation: AppWindowOperation | null }
export type AppWindowResultMap = { [M in AppWindowMethod]: AppWindowPage }
export type AppWindowCallContext = {
  actor: AppWindowActor
  signal?: AbortSignal
  assertCurrent?(): void | Promise<void>
}
/** Borrow the original client owner. Core creates no window, store or native process. */
export interface AgentMuxRpcWindowsOwner {
  call<M extends AppWindowMethod>(method: M, input: AppWindowParamsMap[M], context: AppWindowCallContext): Promise<AppWindowResultMap[M]>
}
export const AGENTMUX_RPC_WINDOW_METHODS = {
  'app.window.ls': 'short', 'app.window.open': 'long',
  'app.window.focus': 'long', 'app.window.return': 'long'
} as const satisfies Record<AppWindowMethod, 'short' | 'long'>
export function isAppWindowMethod(value: unknown): value is AppWindowMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_WINDOW_METHODS, value)
}
function invalid(message: string, code: string): never {
  throw new AgentMuxError(message + ' Original workfaces and Agents are retained.', code)
}
function identity(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value === 'self' || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid('An exact original presentation identity is required.', code)
  }
  return value
}
export function parseAppWindowTarget(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AppWindowTarget {
  const p = rpcRecord(value, ['kind', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'], code)
  const common = { displayWorkspaceId: identity(p.displayWorkspaceId, code), groupId: identity(p.groupId, code), tabId: identity(p.tabId, code) }
  if (p.kind === 'region') return { kind: 'region', ...common, regionId: identity(p.regionId, code) }
  if (p.kind !== 'tab' || p.regionId !== undefined) invalid('Choose an exact original Tab or Region occurrence.', code)
  return { kind: 'tab', ...common }
}
export function parseAppWindowParams<M extends AppWindowMethod>(method: M, value: unknown, code = 'INVALID_CONTROL_REQUEST'): AppWindowParamsMap[M] {
  const fields = method === 'app.window.ls' ? ['operationId'] : method === 'app.window.open'
    ? ['operationId', 'target', 'focus'] : ['operationId', 'windowId', 'documentGeneration']
  const p = rpcRecord(value, fields, code)
  if (method === 'app.window.ls') return (p.operationId === undefined ? {} : { operationId: identity(p.operationId, code) }) as AppWindowParamsMap[M]
  const operationId = identity(p.operationId, code)
  if (method === 'app.window.open' && p.focus !== undefined && typeof p.focus !== 'boolean') invalid('Window focus must be an explicit boolean.', code)
  return (method === 'app.window.open' ? { operationId, target: parseAppWindowTarget(p.target, code), ...(p.focus === undefined ? {} : { focus: p.focus }) }
    : { operationId, windowId: identity(p.windowId, code), documentGeneration: identity(p.documentGeneration, code) }) as AppWindowParamsMap[M]
}
export function parseAppWindowDescriptor(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): AppWindowDescriptor {
  const p = rpcRecord(value, ['windowId', 'documentGeneration', 'target', 'presentation', 'bounds', 'focused'], code)
  const windowId = identity(p.windowId, code), documentGeneration = p.documentGeneration === null ? null : identity(p.documentGeneration, code)
  const target = p.target === null ? null : parseAppWindowTarget(p.target, code)
  if (!['pending', 'visible', 'hidden', 'unknown'].includes(String(p.presentation))) invalid('The native window observation is unconfirmed.', code)
  if (p.focused !== null && typeof p.focused !== 'boolean') invalid('Native window focus must remain observed or unknown.', code)
  let bounds: AppWindowBounds | null = null
  if (p.bounds !== null) {
    const b = rpcRecord(p.bounds, ['x', 'y', 'width', 'height'], code)
    if (!['x', 'y', 'width', 'height'].every(key => typeof b[key] === 'number' && Number.isFinite(b[key])) || Number(b.width) <= 0 || Number(b.height) <= 0) {
      invalid('The original native window bounds are unconfirmed.', code)
    }
    bounds = { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
  }
  if ((p.presentation === 'visible' || p.presentation === 'hidden') && (documentGeneration === null || bounds === null || p.focused === null)) {
    invalid('A confirmed native presentation needs its exact document and observation.', code)
  }
  return { windowId, documentGeneration, target, presentation: p.presentation as AppWindowDescriptor['presentation'], bounds, focused: p.focused as boolean | null }
}
export function parseAppWindowOperation(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): AppWindowOperation {
  const p = rpcRecord(value, ['method', 'input', 'actor', 'state', 'windowId', 'documentGeneration', 'message'], code)
  if (!isAppWindowMethod(p.method) || p.method === 'app.window.ls') invalid('The original window operation is unconfirmed.', code)
  const method = p.method, input = parseAppWindowParams(method, p.input, code), a = rpcRecord(p.actor, ['kind', 'id'], code)
  if (!['user', 'device', 'agent'].includes(String(a.kind))) invalid('The original window actor is unconfirmed.', code)
  const actor: AppWindowActor = { kind: a.kind as AppWindowActor['kind'], id: identity(a.id, code) }
  if (!['pending', 'confirmed', 'rejected', 'unknown'].includes(String(p.state))) invalid('The original window operation state is unconfirmed.', code)
  const windowId = p.windowId === null ? null : identity(p.windowId, code)
  const documentGeneration = p.documentGeneration === null ? null : identity(p.documentGeneration, code)
  if (p.message !== null && (typeof p.message !== 'string' || !p.message.trim())) invalid('The original operation explanation is invalid.', code)
  if (p.state === 'confirmed' && (windowId === null || documentGeneration === null)) invalid('A confirmed original operation needs its window and document.', code)
  if (method !== 'app.window.open') {
    const requested = input as AppWindowParamsMap['app.window.focus']
    if (windowId !== null && windowId !== requested.windowId || documentGeneration !== null && documentGeneration !== requested.documentGeneration) {
      invalid('The receipt describes a different native window or document.', code)
    }
  }
  return { method, input, actor, state: p.state, windowId, documentGeneration, message: p.message } as AppWindowOperation
}
export function parseAppWindowPage<M extends AppWindowMethod>(method: M, value: unknown, params: AppWindowParamsMap[M], actor?: AppWindowActor): AppWindowPage {
  const code = 'CONTROL_PROTOCOL_ERROR', input = parseAppWindowParams(method, params, code)
  const p = rpcRecord(value, ['windows', 'recordedOperation'], code)
  if (!Array.isArray(p.windows)) invalid('The original native window catalog is unconfirmed.', code)
  const windows = p.windows.map(item => parseAppWindowDescriptor(item, code))
  const borrowed = windows.flatMap(w => w.target === null ? [] : [JSON.stringify(w.target)])
  if (new Set(windows.map(w => w.windowId)).size !== windows.length || new Set(borrowed).size !== borrowed.length || windows.filter(w => w.target === null).length > 1) {
    invalid('The original native window identities are ambiguous.', code)
  }
  const operation = p.recordedOperation === null ? null : parseAppWindowOperation(p.recordedOperation, code)
  if (operation && operation.input.operationId !== input.operationId) invalid('The receipt belongs to another original window operation.', code)
  if (method !== 'app.window.ls') {
    if (!operation || operation.method !== method || JSON.stringify(operation.input) !== JSON.stringify(input)) invalid('The receipt changed the original window intent.', code)
    if (actor && (operation.actor.kind !== actor.kind || operation.actor.id !== actor.id)) invalid('The receipt belongs to another original window actor.', code)
  }
  if (operation?.method === 'app.window.open' && operation.state === 'confirmed') {
    const sameDocument = windows.find(w => w.windowId === operation.windowId && w.documentGeneration === operation.documentGeneration)
    if (sameDocument && JSON.stringify(sameDocument.target) !== JSON.stringify(operation.input.target)) invalid('The observed document contains another original workface.', code)
  }
  return { windows, recordedOperation: operation }
}
