import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { readNoteMarkdownHeader, NOTE_FILE_EXTENSION, type NoteSharedOrigin } from './note-format.js'
import { fileUploadRevision, parseFileWriteParams, parseFileCreateParams, parseFileWriteResult, parseFileReadResult, parseFileReadParams, type FileWriteParams, type FileReadParams, type FileReadResource, type FileWriteResult, type FileReadResult, type FileWriteContext } from './public-rpc-files.js'

/** A first reuse is staged in the editor; only an explicit save submits these original bytes. */
export type FileShareTarget = Omit<FileReadParams, 'maxBytes' | 'expectedResource'> & { expectedResource: FileReadResource; noteId: string; title?: string }
export type FileSharePromotion = { operationId: string; source: FileWriteParams; sourceNoteId: string; sourceBlockId: string; shared: FileShareTarget; referenceId: string }
export type FileShareParams = { operationId: string; destination: FileWriteParams; promotions: FileSharePromotion[] }
/** null is no confirmed receipt. Current reads never stand in for an original commit receipt. */
export type FileShareProgress = { operationId: string; shared: FileWriteResult | null; source: FileWriteResult | null; currentShared?: FileReadResult; currentSource?: FileReadResult }
export type FileShareResult = { operationId: string; status: 'committed' | 'partial' | 'conflict' | 'unknown' | 'error'; promotions: FileShareProgress[]; destination: FileWriteResult | null; currentDestination?: FileReadResult; code?: string; message?: string }
export type FileShareInspectParams = { mode: 'request'; request: FileShareParams } | { mode: 'shared'; shared: FileReadParams }
export type FileShareEventObservation = { status: 'unknown'; code: string; message: string } | { status: 'missing' } | { status: 'read'; event: { eventId: string; noteId: string; resource: import('./notebook-catalog.js').NoteResource; status: import('./note-history.js').NoteHistoryRecord['status']; baseRevision: string | null; revision: string } }
export type FileSharedInspection = { mode: 'shared'; current: FileReadResult; declaration: { status: 'confirmed'; noteId: string; origin: NoteSharedOrigin } | { status: 'unconfirmed'; message: string }; create: FileShareEventObservation; source: FileShareEventObservation; destination: FileShareEventObservation; batch: { status: 'unknown'; message: string } }
export type FileShareInspectResult = { mode: 'request'; result: FileShareResult } | FileSharedInspection
export interface AgentMuxRpcFileShareOwner { share(params: FileShareParams, context?: FileWriteContext): Promise<FileShareResult>; inspectShare(params: FileShareInspectParams, context?: FileWriteContext): Promise<FileShareInspectResult> }
const text = (value: unknown, code = 'INVALID_CONTROL_REQUEST') => { if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) throw new AgentMuxError('The exact original shared-block identity is required.', code) }
export function fileShareSourceOperation(params: FileShareParams, source: FileWriteParams): string {
  return params.operationId + ':source:' + fileUploadRevision(new TextEncoder().encode(JSON.stringify([source.expectedResource.hostId, source.expectedResource.workspaceId, source.expectedResource.workspacePath, source.expectedResource.path]))).slice(7)
}
export const fileShareCreateOperation = (promotion: FileSharePromotion) => promotion.operationId + ':create'
export function parseFileShareParams(value: unknown): FileShareParams {
  const p = rpcRecord(value, ['operationId', 'destination', 'promotions'], 'INVALID_CONTROL_REQUEST')
  text(p.operationId)
  const destination = parseFileWriteParams(p.destination)
  if (destination.baseContent === undefined || destination.operationId === undefined || !destination.path.endsWith(NOTE_FILE_EXTENSION)) throw new AgentMuxError('A shared save requires the original Note destination baseline and operation.', 'INVALID_CONTROL_REQUEST')
  if (!Array.isArray(p.promotions) || !p.promotions.length) throw new AgentMuxError('Submit the surviving staged shared-block occurrences with this save.', 'INVALID_CONTROL_REQUEST')
  const ids = new Set<string>(), blocks = new Set<string>(), targets = new Set<string>()
  for (const raw of p.promotions) {
    const item = rpcRecord(raw, ['operationId', 'source', 'sourceNoteId', 'sourceBlockId', 'shared', 'referenceId'], 'INVALID_CONTROL_REQUEST')
    for (const field of ['operationId', 'sourceNoteId', 'sourceBlockId', 'referenceId']) text(item[field])
    if (ids.has(item.operationId as string)) throw new AgentMuxError('A promotion operation must identify one original shared file.', 'INVALID_CONTROL_REQUEST')
    ids.add(item.operationId as string)
    const source = parseFileWriteParams(item.source)
    if (source.baseContent === undefined || !source.path.endsWith(NOTE_FILE_EXTENSION)) throw new AgentMuxError('Preserve the exact original source Note baseline, including unsaved proposed edits.', 'INVALID_CONTROL_REQUEST')
    const shared = rpcRecord(item.shared, ['zoneId', 'spaceId', 'path', 'expectedResource', 'noteId', 'title'], 'INVALID_CONTROL_REQUEST')
    text(shared.noteId); if (shared.title !== undefined) text(shared.title)
    const { noteId: _id, title: _title, ...mapping } = shared
    parseFileCreateParams({ ...mapping, content: '', expectedRevision: null })
    if (!(shared.path as string).endsWith(NOTE_FILE_EXTENSION)) throw new AgentMuxError('A shared block is one original .note.md file.', 'INVALID_CONTROL_REQUEST')
    const block = JSON.stringify([source.expectedResource.hostId, source.expectedResource.workspaceId, source.expectedResource.workspacePath, source.expectedResource.path, item.sourceBlockId])
    const targetResource = shared.expectedResource as FileReadResource
    const target = JSON.stringify([targetResource.hostId, targetResource.workspaceId, targetResource.workspacePath, targetResource.path])
    if (blocks.has(block) || targets.has(target)) throw new AgentMuxError('Group repeated uses of one staged source into one shared Markdown entity.', 'INVALID_CONTROL_REQUEST')
    blocks.add(block); targets.add(target)
    const header = readNoteMarkdownHeader(source.content), baseline = readNoteMarkdownHeader(source.baseContent)
    if (header.status !== 'valid' || baseline.status !== 'valid' || header.noteId !== item.sourceNoteId || baseline.noteId !== item.sourceNoteId) throw new AgentMuxError('The proposed source and baseline must retain the original Note identity.', 'INVALID_CONTROL_REQUEST')
  }
  return p as FileShareParams
}
export function parseFileShareResult(value: unknown, params: FileShareParams): FileShareResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'status', 'promotions', 'destination', 'currentDestination', 'code', 'message'], code)
  if (p.operationId !== params.operationId || !['committed', 'partial', 'conflict', 'unknown', 'error'].includes(p.status as string) || !Array.isArray(p.promotions) || p.promotions.length !== params.promotions.length) throw new AgentMuxError('The original shared save receipt is unconfirmed.', code)
  const check = (receipt: unknown, target: FileWriteParams | FileShareTarget, noteId: string, operationId: string) => {
    if (receipt === null) return
    const r = rpcRecord(receipt, ['resource', 'result'], code), body = rpcRecord(r.result, undefined, code)
    // The owner derives the canonical source/include bytes. Preserve its full original Files receipt,
    // while checking the original resource, operation, Note identity and canonical byte digest.
    const conflict = body.noteConflict as { baseContent: string; proposedContent: string } | undefined
    const content = typeof body.content === 'string' ? body.content : conflict?.proposedContent ?? ('content' in target ? target.content : '---\nschema: agentmux.note.md.v1\nnote-id: ' + JSON.stringify(noteId) + '\n---\n')
    const request = { ...target, content, expectedRevision: 'expectedRevision' in target ? target.expectedRevision : 'sha256:' + '0'.repeat(64),
      ...(conflict ? { baseContent: conflict.baseContent } : {}), operationId }
    parseFileWriteResult(receipt, request as FileWriteParams)
    if (body.status === 'written' && body.contentUnavailable === undefined) {
      const header = readNoteMarkdownHeader(content)
      if (header.status !== 'valid' || header.noteId !== noteId) throw new AgentMuxError('A shared save returned another original Note.', code)
    }
  }
  for (const [index, raw] of p.promotions.entries()) {
    const item = rpcRecord(raw, ['operationId', 'shared', 'source', 'currentShared', 'currentSource'], code), original = params.promotions[index]!
    if (item.operationId !== original.operationId) throw new AgentMuxError('The shared save returned another promotion.', code)
    check(item.shared, original.shared, original.shared.noteId, fileShareCreateOperation(original))
    check(item.source, original.source, original.sourceNoteId, original.source.expectedResource.hostId === params.destination.expectedResource.hostId && original.source.expectedResource.workspaceId === params.destination.expectedResource.workspaceId && original.source.expectedResource.workspacePath === params.destination.expectedResource.workspacePath && original.source.expectedResource.path === params.destination.expectedResource.path ? params.destination.operationId! : fileShareSourceOperation(params, original.source))
    if (item.currentShared !== undefined) parseFileReadResult(item.currentShared, original.shared)
    if (item.currentSource !== undefined) parseFileReadResult(item.currentSource, original.source)
  }
  const destinationHeader = readNoteMarkdownHeader(params.destination.content)
  check(p.destination, params.destination, destinationHeader.status === 'valid' ? destinationHeader.noteId : '', params.destination.operationId!)
  if (p.currentDestination !== undefined) parseFileReadResult(p.currentDestination, params.destination)
  if (p.code !== undefined) text(p.code, code)
  if (p.message !== undefined && typeof p.message !== 'string') throw new AgentMuxError('The original shared save diagnostic must remain text.', code)
  if (p.status === 'committed' && (p.destination === null || (p.destination as FileWriteResult).result.status !== 'written' || (p.destination as FileWriteResult).result.noteHistory?.status !== 'committed' || (p.promotions as FileShareProgress[]).some(x => x.shared?.result.status !== 'written' || x.shared.result.noteHistory?.status !== 'committed' || x.source?.result.status !== 'written' || x.source.result.noteHistory?.status !== 'committed'))) throw new AgentMuxError('A multi-file commit requires each original resource receipt.', code)
  return p as FileShareResult
}

export function parseFileShareInspectParams(value: unknown): FileShareInspectParams {
  const p = rpcRecord(value, undefined, 'INVALID_CONTROL_REQUEST')
  if (p.mode === 'request') { rpcRecord(p, ['mode', 'request'], 'INVALID_CONTROL_REQUEST'); parseFileShareParams(p.request) }
  else if (p.mode === 'shared') { rpcRecord(p, ['mode', 'shared'], 'INVALID_CONTROL_REQUEST'); parseFileReadParams(p.shared) }
  else throw new AgentMuxError('Choose request inspection or one exact shared Markdown file.', 'INVALID_CONTROL_REQUEST')
  return p as FileShareInspectParams
}
export function parseFileShareInspectResult(value: unknown, params: FileShareInspectParams): FileShareInspectResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, undefined, code)
  if (params.mode === 'request') {
    rpcRecord(p, ['mode', 'result'], code)
    if (p.mode !== 'request') throw new AgentMuxError('The original shared-save inspection mode changed.', code)
    parseFileShareResult(p.result, params.request); return p as FileShareInspectResult
  }
  rpcRecord(p, ['mode', 'current', 'declaration', 'create', 'source', 'destination', 'batch'], code)
  if (p.mode !== 'shared') throw new AgentMuxError('The original shared-file inspection mode changed.', code)
  parseFileReadResult(p.current, params.shared)
  const declaration = rpcRecord(p.declaration, undefined, code)
  if (declaration.status === 'confirmed') {
    rpcRecord(declaration, ['status', 'noteId', 'origin'], code); text(declaration.noteId, code)
    const current = p.current as FileReadResult
    if (current.result.status !== 'read') throw new AgentMuxError('A shared declaration requires its exact current Markdown.', code)
    const header = readNoteMarkdownHeader(current.result.document.content)
    if (header.status !== 'valid' || header.kind !== 'shared-block' || header.noteId !== declaration.noteId || JSON.stringify(header.origin) !== JSON.stringify(declaration.origin)) throw new AgentMuxError('The confirmed declaration must retain the exact current Markdown identity and origin.', code)
  } else {
    rpcRecord(declaration, ['status', 'message'], code)
    if (declaration.status !== 'unconfirmed' || typeof declaration.message !== 'string' || !declaration.message) throw new AgentMuxError('The original shared declaration status is invalid.', code)
  }
  for (const field of ['create', 'source', 'destination'] as const) {
    const stage = rpcRecord(p[field], undefined, code)
    if (stage.status === 'unknown') { rpcRecord(stage, ['status', 'code', 'message'], code); text(stage.code, code); if (typeof stage.message !== 'string') throw new AgentMuxError('Keep the original phase diagnostic.', code) }
    else if (stage.status === 'missing') rpcRecord(stage, ['status'], code)
    else if (stage.status === 'read') {
      rpcRecord(stage, ['status', 'event'], code)
      const event = rpcRecord(stage.event, ['eventId', 'noteId', 'resource', 'status', 'baseRevision', 'revision'], code), resource = rpcRecord(event.resource, ['hostId', 'workspaceId', 'workspacePath', 'path'], code)
      text(event.eventId, code); text(event.noteId, code); for (const v of Object.values(resource)) text(v, code)
      if (!['prepared', 'committed', 'unconfirmed', 'not-applied'].includes(event.status as string) || !/^sha256:[a-f0-9]{64}$/u.test(String(event.revision)) || event.baseRevision !== null && !/^sha256:[a-f0-9]{64}$/u.test(String(event.baseRevision))) throw new AgentMuxError('The original per-file history observation is invalid.', code)
    } else throw new AgentMuxError('The original phase observation status is invalid.', code)
  }
  const batch = rpcRecord(p.batch, ['status', 'message'], code)
  if (batch.status !== 'unknown' || typeof batch.message !== 'string' || !batch.message) throw new AgentMuxError('One shared file cannot certify an entire missing save payload.', code)
  if (declaration.status === 'confirmed') {
    const shared = p as FileSharedInspection
    if (shared.create.status !== 'read' || shared.create.event.status !== 'committed' || shared.create.event.noteId !== declaration.noteId || shared.create.event.baseRevision !== null) throw new AgentMuxError('A confirmed declaration requires its original committed creation.', code)
  }
  return p as FileShareInspectResult
}
