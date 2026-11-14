import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseFileReadParams, parseFileReadResource, parseFileReadResult, type FileReadParams, type FileReadResource } from './public-rpc-files.js'
import { parseFileMkdirParams, parseFileMkdirResult, parseFileMoveParams, parseFileMoveResult, parseFileDeleteParams, parseFileDeleteResult,
  type FileMkdirParams, type FileMkdirResult, type FileMoveParams, type FileMoveResult, type FileDeleteParams, type FileDeleteResult, type FilePathMutationContext } from './public-rpc-file-path.js'

/** Live observations of the original Files owner; no history or replay guarantee. */
export type FileMutationWatchParams = Omit<FileReadParams, 'maxBytes'>
export type FileMutationWatchOpening = { resource: FileReadResource; delivery: 'live-only' }
export type FileMutationEffect =
  | { type: 'path-mutation'; action: 'mkdir'; request: FileMkdirParams; receipt: FileMkdirResult }
  | { type: 'path-mutation'; action: 'move'; request: FileMoveParams; receipt: FileMoveResult }
  | { type: 'path-mutation'; action: 'delete'; request: FileDeleteParams; receipt: FileDeleteResult }
  | { type: 'created-file'; resource: FileReadResource; revision: string }
/** One bounded live frame. Ordinary file bodies are never carried on this channel. */
export const FILE_MUTATION_EFFECT_MAX_BYTES = 256 * 1024
export interface FileMutationWatchOwner {
  watchMutations(params: FileMutationWatchParams, onEffect: (effect: FileMutationEffect) => void | Promise<void>,
    onEnd: (error?: Error) => void | Promise<void>, signal: AbortSignal,
    context: FilePathMutationContext & { assertCurrent?(): void | Promise<void> }): Promise<{ initial: FileMutationWatchOpening; start(): void; dispose(): void }>
}
export function parseFileMutationWatchParams(value: unknown): FileMutationWatchParams {
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource'])
  return parseFileReadParams(p)
}
export function parseFileMutationWatchOpening(value: unknown, params: FileMutationWatchParams): FileMutationWatchOpening {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'delivery'], code)
  const resource = parseFileReadResource(p.resource, code)
  parseFileReadResult({ resource, result: { status: 'directory' } }, params)
  if (p.delivery !== 'live-only' || resource.zoneId !== params.zoneId ||
      (['hostId', 'workspaceId', 'workspacePath'] as const).some(key => resource[key] !== params.expectedResource[key]))
    throw new AgentMuxError('The original Files observation scope is unconfirmed.', code)
  return { resource, delivery: 'live-only' }
}
export function fileMutationMatchesScope(effect: FileMutationEffect, scope: FileReadResource): boolean {
  const within = (resource: FileReadResource | null): boolean => Boolean(resource &&
    resource.hostId === scope.hostId && resource.workspaceId === scope.workspaceId && resource.workspacePath === scope.workspacePath &&
    (scope.path === '.' || resource.path === scope.path || resource.path.startsWith(scope.path + '/')))
  return effect.type === 'created-file' ? within(effect.resource) : within(effect.receipt.resource) || effect.action === 'move' && within(effect.receipt.destination)
}
export function parseFileMutationEffect(value: unknown, scope?: FileReadResource): FileMutationEffect {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, undefined, code)
  let effect: FileMutationEffect
  if (p.type === 'created-file') {
    rpcRecord(p, ['type', 'resource', 'revision'], code)
    if (typeof p.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.revision)) throw new AgentMuxError('The original file creation revision is unconfirmed.', code)
    effect = { type: 'created-file', resource: parseFileReadResource(p.resource, code), revision: p.revision }
  } else {
    rpcRecord(p, ['type', 'action', 'request', 'receipt'], code)
    if (p.type !== 'path-mutation') throw new AgentMuxError('The original Files effect type is unconfirmed.', code)
    if (p.action === 'mkdir') {
      const request = parseFileMkdirParams(p.request), receipt = parseFileMkdirResult(p.receipt, request)
      if (receipt.result.filesystem !== 'created') throw new AgentMuxError('A directory observation requires the original positive creation ACK.', code)
      effect = { type: 'path-mutation', action: 'mkdir', request, receipt }
    } else if (p.action === 'move') {
      const request = parseFileMoveParams(p.request), receipt = parseFileMoveResult(p.receipt, request)
      if (receipt.result.filesystem !== 'moved') throw new AgentMuxError('A move observation requires the original positive move ACK.', code)
      effect = { type: 'path-mutation', action: 'move', request, receipt }
    } else if (p.action === 'delete') {
      const request = parseFileDeleteParams(p.request), receipt = parseFileDeleteResult(p.receipt, request)
      if (receipt.result.filesystem !== 'deleted') throw new AgentMuxError('A deletion observation requires the original positive deletion ACK.', code)
      effect = { type: 'path-mutation', action: 'delete', request, receipt }
    } else throw new AgentMuxError('The original Files action is unconfirmed.', code)
  }
  if (new TextEncoder().encode(JSON.stringify(effect)).byteLength > FILE_MUTATION_EFFECT_MAX_BYTES || scope && !fileMutationMatchesScope(effect, scope))
    throw new AgentMuxError('The Files observation exceeds its bounded original scope.', code)
  return effect
}
