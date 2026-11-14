import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { avatarSeriesCanonical } from './mote-avatar-series.js'

/** Portable image contract; paths and object authority remain with the original Host. */
export const AVATAR_INPUT_MAX_BYTES = 8 * 1024 * 1024
export const AVATAR_MAX_DIMENSION = 4096
export const AVATAR_MAX_PIXELS = 16 * 1024 * 1024
export const AVATAR_EDGE = 256
export const AVATAR_OUTPUT_MAX_BYTES = 512 * 1024
export const AVATAR_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
export type ObjectAvatarRef = { kind: 'image'; fileName: string }
export type ObjectAvatarInput = { mimeType: 'image/png' | 'image/jpeg'; dataUrl: string }
export type ObjectAvatarImage = { dataUrl: string; width: number; height: number }
export type SpaceObjectImageTarget = { kind: 'category'; categoryId: string; objectKey: string } |
  { kind: 'topic'; workspaceId: string; topicId: string; objectKey: string }
export type SpaceObjectAppearance = { icon: string | null; local: boolean }
export function isObjectAvatarRef(value: unknown): value is ObjectAvatarRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<ObjectAvatarRef>
  return ref.kind === 'image' && typeof ref.fileName === 'string' && /^[a-f0-9]{64}\.png$/u.test(ref.fileName) && Object.keys(ref).length === 2
}
export function requireSpaceObjectImageTarget(value: unknown): asserts value is SpaceObjectImageTarget {
  const target = rpcRecord(value, undefined, 'INVALID_CONTROL_REQUEST')
  const keys = target.kind === 'category' ? ['kind', 'categoryId', 'objectKey'] : target.kind === 'topic' ? ['kind', 'workspaceId', 'topicId', 'objectKey'] : []
  if (!keys.length || Object.keys(target).length !== keys.length || keys.some(key => !Object.hasOwn(target, key) || typeof target[key] !== 'string' || !target[key] || (target[key] as string).includes('\0')))
    throw new AgentMuxError('Choose an exact Category or Topic image target.', 'INVALID_CONTROL_REQUEST')
}

/** Trusted attribution is supplied only by transport/SDK context, never business JSON. */
export type AvatarActor = { kind: 'agent' | 'user' | 'device'; id: string; hostId?: string; runtimeId?: string; runId?: string }
export type AvatarExecutionContext = { actor: AvatarActor; signal?: AbortSignal; assertCurrent(): Promise<void> }
export function parseAvatarActor(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): AvatarActor {
  const p = rpcRecord(value, ['kind', 'id', 'hostId', 'runtimeId', 'runId'], code)
  if (!['agent', 'user', 'device'].includes(p.kind as string) || typeof p.id !== 'string' || !p.id || p.id.includes('\0') ||
    ['hostId', 'runtimeId', 'runId'].some(key => p[key] !== undefined && (typeof p[key] !== 'string' || !p[key] || (p[key] as string).includes('\0'))))
    throw new AgentMuxError('The original avatar actor is unavailable.', code)
  return structuredClone(p) as AvatarActor
}
/** Run is original attribution, not a perpetual live-Run gate on an existing operation. */
export type AvatarActorIdentity = Omit<AvatarActor, 'runId'>
export function avatarActorIdentity(actor: AvatarActor): AvatarActorIdentity {
  const p = parseAvatarActor(actor)
  return { kind: p.kind, id: p.id, ...(p.hostId === undefined ? {} : { hostId: p.hostId }), ...(p.runtimeId === undefined ? {} : { runtimeId: p.runtimeId }) }
}
export function parseAvatarActorIdentity(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): AvatarActorIdentity {
  return parseAvatarActor(rpcRecord(value, ['kind', 'id', 'hostId', 'runtimeId'], code), code)
}
export function avatarPublicationRequest(actor: AvatarActor, request: unknown): string {
  return avatarSeriesCanonical({ actor: avatarActorIdentity(actor), request })
}
/** Actorless hashing is solely the original legacy record format, never a new-write ACK. */
export function avatarRequestHash(request: unknown, actor?: AvatarActor): string {
  const canonical = actor ? avatarPublicationRequest(actor, request) : avatarSeriesCanonical(request)
  return 'sha256:' + bytesToHex(sha256(new TextEncoder().encode(canonical)))
}
export function avatarSavedReceiptMatches(request: { operationId?: string }, operation: AvatarPublicationOperation<unknown> | undefined,
  readerIdentity: AvatarActorIdentity | undefined): boolean {
  return !!operation?.actor && !!readerIdentity && !!request.operationId && operation.operationId === request.operationId &&
    avatarSeriesCanonical(avatarActorIdentity(operation.actor)) === avatarSeriesCanonical(parseAvatarActorIdentity(readerIdentity)) &&
    operation.requestHash === avatarRequestHash(request, operation.actor)
}
export type AvatarPublicationOperation<Choice = ObjectAvatarRef> = {
  operationId: string; requestHash: string; actor?: AvatarActor; actorAvailability?: 'available' | 'unavailable'
  phase: 'intent' | 'asset' | 'publication-unknown' | 'published'; durability: 'unknown' | 'confirmed'; choice?: Choice; issue?: string
}
export type SpaceObjectAvatarSave = { target: SpaceObjectImageTarget; beforeRevision: string } & (
  { choice: string | null; operationId?: never } | { choice: { kind: 'png'; dataUrl: string }; operationId: string }
)
export type SpaceObjectAvatarRead = {
  target: SpaceObjectImageTarget; readerIdentity: AvatarActorIdentity; revision: string; choice: unknown
  localCapability: { state: 'available' | 'unsupported' | 'unknown'; issue?: string }
  image?: ObjectAvatarImage; operation?: AvatarPublicationOperation; issues: string[]
}
export type SpaceObjectAvatarResult = { state: 'saved' | 'refused' | 'unknown'; issue?: string; current: SpaceObjectAvatarRead } & (
  { mode: 'configuration-only' } | { mode: 'asset-publication'; operation?: AvatarPublicationOperation }
)
export type ObjectAvatarParamsMap = {
  'space.object.avatar.read': { target: SpaceObjectImageTarget; operationId?: string }
  'space.object.avatar.save': SpaceObjectAvatarSave
}
export type ObjectAvatarResultMap = { 'space.object.avatar.read': SpaceObjectAvatarRead; 'space.object.avatar.save': SpaceObjectAvatarResult }
export type ObjectAvatarMethod = keyof ObjectAvatarParamsMap
export type ObjectAvatarPort = { call<M extends ObjectAvatarMethod>(method: M, input: ObjectAvatarParamsMap[M], context: AvatarExecutionContext): Promise<ObjectAvatarResultMap[M]> }
export const OBJECT_AVATAR_METHODS = { 'space.object.avatar.read': 'long', 'space.object.avatar.save': 'long' } as const
export function isObjectAvatarMethod(value: unknown): value is ObjectAvatarMethod { return typeof value === 'string' && Object.hasOwn(OBJECT_AVATAR_METHODS, value) }
export function parseAvatarOperationId(value: unknown, code = 'INVALID_CONTROL_REQUEST'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new AgentMuxError('Keep the original path-safe avatar operation ID.', code)
}
export function parseObjectAvatarParams<M extends ObjectAvatarMethod>(method: M, raw: unknown): ObjectAvatarParamsMap[M] {
  const p = rpcRecord(raw, method === 'space.object.avatar.read' ? ['target', 'operationId'] : ['target', 'operationId', 'beforeRevision', 'choice'])
  requireSpaceObjectImageTarget(p.target)
  if (p.operationId !== undefined) parseAvatarOperationId(p.operationId)
  if (method === 'space.object.avatar.read') return structuredClone(p) as ObjectAvatarParamsMap[M]
  if (typeof p.beforeRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.beforeRevision)) throw new AgentMuxError('Read this original object appearance before saving.', 'INVALID_CONTROL_REQUEST')
  if (p.choice !== null && typeof p.choice !== 'string') {
    const png = rpcRecord(p.choice, ['kind', 'dataUrl'])
    parseAvatarOperationId(p.operationId)
    if (png.kind !== 'png' || typeof png.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(png.dataUrl) || png.dataUrl.length > Math.ceil(AVATAR_OUTPUT_MAX_BYTES / 3) * 4 + 22 || (png.dataUrl.length - 22) % 4)
      throw new AgentMuxError('Save the exact bounded static PNG crop.', 'INVALID_CONTROL_REQUEST')
  } else if (p.operationId !== undefined) throw new AgentMuxError('An icon/reset is a configuration-only CAS, without an asset publication operation.', 'INVALID_CONTROL_REQUEST')
  return structuredClone(p) as ObjectAvatarParamsMap[M]
}

export function parseAvatarPublicationOperation(value: unknown, operationId?: string, series = false, code = 'CONTROL_PROTOCOL_ERROR'): AvatarPublicationOperation<unknown> {
  const p = rpcRecord(value, ['operationId', 'requestHash', 'actor', 'actorAvailability', 'phase', 'durability', 'choice', 'issue'], code)
  parseAvatarOperationId(p.operationId, code)
  if (operationId !== undefined && p.operationId !== operationId || typeof p.requestHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.requestHash) ||
    !['intent', 'asset', 'publication-unknown', 'published'].includes(p.phase as string) || !['unknown', 'confirmed'].includes(p.durability as string) ||
    p.durability === 'confirmed' && p.phase !== 'published' || p.issue !== undefined && typeof p.issue !== 'string')
    throw new AgentMuxError('The original avatar publication receipt is invalid.', code)
  // The series-specific choice remains validated by its existing codec.
  if (!series && p.phase !== 'intent' && !isObjectAvatarRef(p.choice)) throw new AgentMuxError('The original immutable avatar reference is invalid.', code)
  const actor = p.actor === undefined ? undefined : parseAvatarActor(p.actor, code)
  if (p.actorAvailability !== undefined && p.actorAvailability !== (actor ? 'available' : 'unavailable')) throw new AgentMuxError('The original avatar attribution contradicts its receipt.', code)
  return { ...p, ...(actor ? { actor } : {}), actorAvailability: actor ? 'available' : 'unavailable' } as AvatarPublicationOperation<unknown>
}
function objectAvatarRead(raw: unknown, target: SpaceObjectImageTarget, operationId: string | undefined): SpaceObjectAvatarRead {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(raw, ['target', 'readerIdentity', 'revision', 'choice', 'localCapability', 'image', 'operation', 'issues'], code)
  requireSpaceObjectImageTarget(p.target)
  const readerIdentity = parseAvatarActorIdentity(p.readerIdentity, code)
  if (avatarSeriesCanonical(p.target) !== avatarSeriesCanonical(target) || typeof p.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.revision) ||
    !Object.hasOwn(p, 'choice') || !Array.isArray(p.issues) || p.issues.some(issue => typeof issue !== 'string')) throw new AgentMuxError('The avatar read belongs to another original object or is incomplete.', code)
  const capability = rpcRecord(p.localCapability, ['state', 'issue'], code)
  if (!['available', 'unsupported', 'unknown'].includes(capability.state as string) || capability.issue !== undefined && typeof capability.issue !== 'string') throw new AgentMuxError('The local avatar capability is invalid.', code)
  if (p.image !== undefined) {
    const image = rpcRecord(p.image, ['dataUrl', 'width', 'height'], code)
    if (image.width !== AVATAR_EDGE || image.height !== AVATAR_EDGE || typeof image.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(image.dataUrl) || image.dataUrl.length > Math.ceil(AVATAR_OUTPUT_MAX_BYTES / 3) * 4 + 22)
      throw new AgentMuxError('The original saved avatar PNG is invalid.', code)
  }
  return { ...p, readerIdentity, ...(p.operation === undefined ? {} : { operation: parseAvatarPublicationOperation(p.operation, operationId) }) } as SpaceObjectAvatarRead
}
export function parseObjectAvatarResult<M extends ObjectAvatarMethod>(method: M, raw: unknown, input: ObjectAvatarParamsMap[M]): ObjectAvatarResultMap[M] {
  if (method === 'space.object.avatar.read') return objectAvatarRead(raw, input.target, (input as ObjectAvatarParamsMap['space.object.avatar.read']).operationId) as ObjectAvatarResultMap[M]
  const request = input as SpaceObjectAvatarSave
  const p = rpcRecord(raw, ['mode', 'state', 'issue', 'operation', 'current'], 'CONTROL_PROTOCOL_ERROR')
  const image = request.choice !== null && typeof request.choice === 'object'
  if (p.mode !== (image ? 'asset-publication' : 'configuration-only') || !['saved', 'refused', 'unknown'].includes(p.state as string) || p.issue !== undefined && typeof p.issue !== 'string' || !image && p.operation !== undefined)
    throw new AgentMuxError('The avatar save returned another publication kind.', 'CONTROL_PROTOCOL_ERROR')
  const operation = p.operation === undefined ? undefined : parseAvatarPublicationOperation(p.operation, request.operationId)
  const current = objectAvatarRead(p.current, request.target, request.operationId)
  if (image && p.state === 'saved' && (operation?.phase !== 'published' || operation.durability !== 'confirmed' ||
    !avatarSavedReceiptMatches(request, operation, current.readerIdentity) ||
    current.operation !== undefined && !avatarSavedReceiptMatches(request, current.operation, current.readerIdentity)))
    throw new AgentMuxError('Saved requires the original actor-bound acknowledged publication and complete request.', 'CONTROL_PROTOCOL_ERROR')
  return { ...p, ...(operation ? { operation } : {}), current } as ObjectAvatarResultMap[M]
}
