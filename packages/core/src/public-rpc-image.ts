import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parsePngImage } from './png-image.js'
import type { NativeDesktopPng } from './native-desktop-types.js'

export type ImageActor = { kind: 'user' | 'device' | 'agent'; id: string }
export type ImageParamsMap = {
  'image.pin': { hostId: string; operationId: string; image: NativeDesktopPng }
  'image.inspect': { hostId: string } & ({ pinId: string; operationId?: never } | { operationId: string; pinId?: never })
  'image.close': { hostId: string; pinId: string; operationId: string }
}
export type ImageMethod = keyof ImageParamsMap
export type ImageOperation = {
  operationId: string
  method: 'image.pin' | 'image.close'
  actor: ImageActor
  pinId: string | null
  state: 'pending' | 'completed' | 'failed' | 'unknown'
  /** Original effect, independent of the window's current state. */
  effect: 'opened' | 'closed' | 'missing' | null
  message: string | null
}
export type ImageResult = {
  hostId: string
  pinId: string | null
  state: 'open' | 'closed' | 'unknown' | 'missing'
  creationOperationId: string | null
  recordedOperation: ImageOperation | null
}
export type ImageResultMap = { [M in ImageMethod]: ImageResult }
export type ImageCallContext = { actor: ImageActor; signal?: AbortSignal; assertCurrent?(): void | Promise<void> }
/** Borrow the original client presentation owner. Core stores no image or window. */
export interface AgentMuxRpcImageOwner {
  call<M extends ImageMethod>(method: M, input: ImageParamsMap[M], context: ImageCallContext): Promise<ImageResultMap[M]>
}
export const AGENTMUX_RPC_IMAGE_METHODS = {
  'image.pin': 'long', 'image.inspect': 'short', 'image.close': 'long'
} as const satisfies Record<ImageMethod, 'short' | 'long'>
export function isImageMethod(value: unknown): value is ImageMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_IMAGE_METHODS, value)
}
function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function identity(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid('An exact image identity is required.', code)
  return value
}
export function parseImageParams<M extends ImageMethod>(method: M, value: unknown, code = 'INVALID_CONTROL_REQUEST'): ImageParamsMap[M] {
  const p = rpcRecord(value, method === 'image.pin' ? ['hostId', 'operationId', 'image'] : ['hostId', 'operationId', 'pinId'], code)
  const hostId = identity(p.hostId, code)
  if (method === 'image.pin') {
    const image = parsePngImage(p.image, code)
    if (image.scale !== 1) invalid('A pinned image uses its actual PNG pixels with scale 1.', code)
    return { hostId, operationId: identity(p.operationId, code), image } as ImageParamsMap[M]
  }
  if (method === 'image.inspect') {
    if ((p.operationId === undefined) === (p.pinId === undefined)) invalid('Inspect one original image operation or one exact pin.', code)
    return { hostId, ...(p.pinId === undefined ? { operationId: identity(p.operationId, code) } : { pinId: identity(p.pinId, code) }) } as ImageParamsMap[M]
  }
  return { hostId, operationId: identity(p.operationId, code), pinId: identity(p.pinId, code) } as ImageParamsMap[M]
}
export function parseImageOperation(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ImageOperation {
  const p = rpcRecord(value, ['operationId', 'method', 'actor', 'pinId', 'state', 'effect', 'message'], code)
  const operationId = identity(p.operationId, code), pinId = p.pinId === null ? null : identity(p.pinId, code)
  const actor = rpcRecord(p.actor, ['kind', 'id'], code)
  if (!['user', 'device', 'agent'].includes(String(actor.kind)) || !['image.pin', 'image.close'].includes(String(p.method)) ||
      !['pending', 'completed', 'failed', 'unknown'].includes(String(p.state))) invalid('The original image operation is invalid.', code)
  if (p.message !== null && (typeof p.message !== 'string' || !p.message.trim())) invalid('The image operation explanation is invalid.', code)
  if (p.state === 'completed') {
    if (pinId === null || (p.method === 'image.pin' ? p.effect !== 'opened' : p.effect !== 'closed' && p.effect !== 'missing'))
      invalid('The original image effect does not match its operation.', code)
  } else if (p.effect !== null) invalid('An unconfirmed image operation cannot claim an effect.', code)
  if ((p.state === 'failed' || p.state === 'unknown') && p.message === null) invalid('The original image failure or unknown needs its explanation.', code)
  return { operationId, method: p.method as ImageOperation['method'], actor: { kind: actor.kind as ImageActor['kind'], id: identity(actor.id, code) },
    pinId, state: p.state as ImageOperation['state'], effect: p.effect as ImageOperation['effect'], message: p.message as string | null }
}
export function parseImageResult<M extends ImageMethod>(method: M, value: unknown, params: ImageParamsMap[M], actor?: ImageActor): ImageResult {
  const code = 'CONTROL_PROTOCOL_ERROR', input = parseImageParams(method, params, code)
  const p = rpcRecord(value, ['hostId', 'pinId', 'state', 'creationOperationId', 'recordedOperation'], code)
  if (p.hostId !== input.hostId) invalid('The image receipt belongs to another Host.', code)
  const pinId = p.pinId === null ? null : identity(p.pinId, code)
  const creationOperationId = p.creationOperationId === null ? null : identity(p.creationOperationId, code)
  if (!['open', 'closed', 'unknown', 'missing'].includes(String(p.state))) invalid('The current image state is invalid.', code)
  if ((p.state === 'open' || p.state === 'closed') && (pinId === null || creationOperationId === null)) invalid('An observed image needs its original identity and creation.', code)
  if ('pinId' in input && pinId !== input.pinId) invalid('The image receipt belongs to another pin.', code)
  const operation = p.recordedOperation === null ? null : parseImageOperation(p.recordedOperation, code)
  if (operation && (operation.operationId !== input.operationId || operation.pinId !== pinId)) invalid('The image receipt changed the original operation or pin.', code)
  if (operation && actor && (operation.actor.kind !== actor.kind || operation.actor.id !== actor.id)) invalid('The image receipt belongs to another actor.', code)
  if (method !== 'image.inspect') {
    if (!operation || operation.method !== method) invalid('The image mutation lost its original operation.', code)
    if (method === 'image.pin' && creationOperationId !== null && creationOperationId !== input.operationId) invalid('The pinned image belongs to another creation.', code)
  }
  if (operation?.method === 'image.pin' && operation.state === 'completed' && creationOperationId !== operation.operationId)
    invalid('The image creation receipt lost its original operation.', code)
  if (operation?.effect === 'missing' && p.state !== 'missing') invalid('An absent image effect cannot claim a current window.', code)
  return { hostId: input.hostId, pinId, state: p.state as ImageResult['state'], creationOperationId, recordedOperation: operation }
}
