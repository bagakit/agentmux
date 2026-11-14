import { createHash } from 'node:crypto'
import { constants, mkdir, open, lstat } from 'node:fs/promises'
import { dirname, join, isAbsolute, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, durableWriteFile, type AgentMuxClient } from '@agentmux/core'
import { parseFileMkdirParams, parseFilePathMutationReceipt, parseFileEntryWitness, parseFileMoveParams, parseFileMoveReceipt, parseFileDeleteParams, parseFileDeleteReceipt, parseFileDeleteSnapshotsParams, type FileDeleteSnapshotsParams, type FileDeleteSnapshotsResult, type FileDeleteSnapshotReference, type FileDeleteParams, type FileDeleteResult, type FileDeleteReceipt, sameFileEntryIdentity, type FileMoveParams, type FileMoveResult, type FileMoveReceipt, type FileMkdirParams, type FileMkdirResult,
  type FileMutationInspectParams, type FileMutationInspectResult, type FilePathMutationContext,
  type FilePathMutationReceipt, type FilePathObservation, type FileEntryWitness } from '@agentmux/core/files'
import type { WorkspaceRecord } from './content-types.js'
import { NameChangeAudit, nameChangeRequests } from './name-change-audit.js'
import { parseNotebookFileRelocationPlan, type NotebookFileRelocationPlan } from '@agentmux/core/notebook-store'
import type { OrdinaryWorkspaceFiles } from './ordinary-files.js'
import type { FileDeleteHistory } from './file-delete-history.js'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { FILE_DELETE_SNAPSHOT_REFERENCE_BYTES } from '@agentmux/core/files'
import type { FileMutationObservations } from './file-mutation-observations.js'

type Actor = NonNullable<FilePathMutationContext['actor']>
type Locator = { root: string; path: string }
type Producer = { stage: FileEntryWitness; entry: FileEntryWitness; location: Locator; destination?: Locator; claimed?: true }
type Base = { schema: 'agentmux.file-path-mutation.v1'; actor: Actor; callerHostId?: string; transport?: string; digest: string; stage: string; producer?: Producer }
type MkdirOriginal = Base & { action: 'mkdir'; request: FileMkdirParams; result?: FilePathMutationReceipt }
type MoveOriginal = Base & { action: 'move'; request: FileMoveParams; notePlan?: NotebookFileRelocationPlan; result?: FileMoveReceipt }
type DeleteOriginal = Base & { action: 'delete'; request: FileDeleteParams; result?: FileDeleteReceipt }
type Original = MkdirOriginal | MoveOriginal | DeleteOriginal
type Admission = { schema: 'agentmux.file-path-admission.v1'; operationId: string; action: Original['action']; digest: string; actor: Actor; callerHostId?: string }

const sameIdentity = sameFileEntryIdentity
const moveUnknown = (cause: unknown, code = 'FILE_MOVE_UNCONFIRMED'): FileMoveReceipt => ({ action: 'move', phase: 'prepared', filesystem: 'unknown', durability: 'unconfirmed', code, message: 'The original move is unconfirmed. Keep its request and claim; inspect without replaying. ' + (cause instanceof Error ? cause.message : String(cause)) })
const deleteUnknown = (cause: unknown, code = 'FILE_DELETE_UNCONFIRMED'): FileDeleteReceipt => ({ action: 'delete', phase: 'prepared', filesystem: 'unknown', durability: 'unconfirmed', code, message: 'The original deletion is unconfirmed. Keep its complete request and private claim; inspect without replaying. ' + (cause instanceof Error ? cause.message : String(cause)) })
const MAX_RECORD_BYTES = 256 * 1024
function actor(context: FilePathMutationContext | undefined): Actor {
  const value = context?.actor
  if (!value || !['agent', 'user', 'device'].includes(value.kind) || typeof value.id !== 'string' || !value.id || value.id.length > 512 || /[\0\r\n]/u.test(value.id) ||
      context?.callerHostId !== undefined && (typeof context.callerHostId !== 'string' || !context.callerHostId || context.callerHostId.length > 512 || /[\0\r\n]/u.test(context.callerHostId)) ||
      value.kind === 'agent' && !context?.callerHostId)
    throw new AgentMuxError('An original transport-approved Files actor and Agent Host scope are required.', 'CONTROL_PERMISSION_DENIED')
  return { kind: value.kind, id: value.id }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value
}
function digest(request: FileMkdirParams | FileMoveParams | FileDeleteParams, original: Actor, callerHostId?: string, action: 'mkdir' | 'move' | 'delete' = 'mkdir'): string {
  return createHash('sha256').update(JSON.stringify(canonical({ action, request, actor: original, ...(callerHostId ? { callerHostId } : {}) }))).digest('hex')
}
function unknown(cause: unknown, code = 'FILE_MKDIR_UNCONFIRMED'): FilePathMutationReceipt {
  return { action: 'mkdir', phase: 'prepared', filesystem: 'unknown', durability: 'unconfirmed', code,
    message: 'The original directory creation is unconfirmed. Its request is retained; inspect that operation without replaying it. ' + (cause instanceof Error ? cause.message : String(cause)) }
}
const targetKeys = ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const

/** Files-path intent/effect only. Note history, names and resource mappings keep their original owners. */
export class FilePathMutations {
  private readonly inFlight = new Map<string, { action: 'mkdir'; digest: string; promise: Promise<FileMkdirResult> } | { action: 'move'; digest: string; promise: Promise<FileMoveResult> } | { action: 'delete'; digest: string; promise: Promise<FileDeleteResult> }>()
  constructor(private readonly ports: {
    effects?: FileMutationObservations
    directory: string
    files: Pick<OrdinaryWorkspaceFiles, 'statPath' | 'mkdirPath' | 'inspectPathMutation' | 'pathMutationLocation' | 'movePath' | 'inspectMovePath' | 'executionDirectoryRelated' | 'deletePath'>
    directoryScope?: (isRelated: (cwd: string) => Promise<boolean>) => ReturnType<AgentMuxClient['retainExecutionDirectoryMutation']>
    retainPaths?(workspace: WorkspaceRecord, paths: readonly string[]): Promise<(physical: readonly Locator[]) => Promise<void>>
    notes?: { plan(from: FileMoveParams['expectedResource'], to: FileMoveParams['expectedResource']): Promise<NotebookFileRelocationPlan>; apply(plan: NotebookFileRelocationPlan, operationId: string, actor: Actor): Promise<void> }
    deleteHistory?(workspace: WorkspaceRecord, input: FileDeleteParams, digest: string, actor: Actor): Pick<FileDeleteHistory, 'snapshot' | 'confirmDeleted'>
    deleteSnapshots?: AgentMuxNotebookStore['fileDeleteSnapshots']
    nameAudit?: NameChangeAudit
    noteLease<T>(work: () => Promise<T>): Promise<T>
  }) {}
  stat(workspace: WorkspaceRecord, path: string, includeRevision = false): Promise<FilePathObservation> { return this.ports.files.statPath(workspace, path, includeRevision) }
  private operationHash(operationId: string) { return createHash('sha256').update(operationId).digest('hex') }
  private operationDirectory(operationId: string) { return join(this.ports.directory, this.operationHash(operationId)) }
  private admissionPath(operationId: string) { return join(dirname(this.ports.directory), 'file-path-admission-' + this.operationHash(operationId) + '.json') }
  private path(operationId: string) { return join(this.operationDirectory(operationId), 'request.json') }
  private async admission(operationId: string): Promise<Admission | null> {
    let handle
    try { handle = await open(this.admissionPath(operationId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > 16384) throw new Error('The original Files once-admission witness is partial or invalid. It cannot be recreated.')
      const value = JSON.parse(await handle.readFile('utf8')) as Admission
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['schema', 'operationId', 'action', 'digest', 'actor', 'callerHostId'].includes(key)) || value.schema !== 'agentmux.file-path-admission.v1' || value.operationId !== operationId || !['mkdir', 'move', 'delete'].includes(value.action) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)) throw new Error('The original Files once-admission identity is unconfirmed.')
      try { actor({ actor: value.actor, ...(value.callerHostId ? { callerHostId: value.callerHostId } : {}) }) }
      catch { throw new Error('The original Files once-admission actor or Host scope is unconfirmed.') }
      return value
    } finally { await handle.close() }
  }
  private async publishAdmission(value: Original): Promise<boolean> {
    const admission: Admission = { schema: 'agentmux.file-path-admission.v1', operationId: value.request.operationId, action: value.action,
      digest: value.digest, actor: value.actor, ...(value.callerHostId ? { callerHostId: value.callerHostId } : {}) }
    let handle
    try { handle = await open(this.admissionPath(admission.operationId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false; throw cause }
    try { await handle.writeFile(JSON.stringify(admission)); await handle.sync() } finally { await handle.close() }
    const base = await open(dirname(this.ports.directory), 'r')
    try { await base.sync() } finally { await base.close() }
    return true
  }
  private async load(operationId: string, expectedDigest?: string, reader?: FilePathMutationContext): Promise<Original | null> {
    const admission = await this.admission(operationId)
    if (admission && expectedDigest !== undefined && admission.digest !== expectedDigest) throw new AgentMuxError('This original Files once-admission belongs to different input, action or actor.', 'FILE_MUTATION_CONFLICT')
    if (admission && reader) this.authorizeRead(admission, reader)
    let handle
    try { handle = await open(this.path(operationId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (admission) throw new Error('The original Files once-admission exists but its member or namespace is missing. It must not be recreated or replayed.')
      try { await lstat(this.operationDirectory(operationId)) }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null; throw missing }
      throw new Error('The original Files admission exists but its request member is missing. It must not be recreated or replayed.')
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > MAX_RECORD_BYTES) throw new Error('The original Files record is not a bounded regular file.')
      const value = JSON.parse(await handle.readFile('utf8')) as Original
      if (!value || value.schema !== 'agentmux.file-path-mutation.v1' || !['mkdir', 'move', 'delete'].includes(value.action) || Object.keys(value).some(key => !['schema', 'action', 'request', 'actor', 'callerHostId', 'transport', 'digest', 'stage', 'producer', 'notePlan', 'result'].includes(key))) throw new Error('The original Files record is unreadable. Its bytes are kept.')
      if (value.transport !== undefined && (typeof value.transport !== 'string' || !value.transport || value.transport.length > 512 || /[\0\r\n]/u.test(value.transport))) throw new Error('The original Files transport observation is invalid.')
      const input = value.action === 'move' ? parseFileMoveParams(value.request) : value.action === 'delete' ? parseFileDeleteParams(value.request) : parseFileMkdirParams(value.request), original = actor({ actor: value.actor, ...(value.callerHostId ? { callerHostId: value.callerHostId } : {}) })
      if (input.operationId !== operationId || value.digest !== digest(input, original, value.callerHostId, value.action) || value.stage !== '.agentmux-' + value.action + '-' + value.digest) throw new Error('The original Files record belongs to another intent.')
      if (admission && (admission.action !== value.action || admission.digest !== value.digest || !isDeepStrictEqual(admission.actor, value.actor) || admission.callerHostId !== value.callerHostId)) throw new Error('The retained request and its original once-admission disagree.')
      if (value.action === 'move' && value.notePlan) parseNotebookFileRelocationPlan(value.notePlan)
      if (value.producer) this.producer(value.producer, input, value.action)
      if (value.result) { if (value.action === 'move') parseFileMoveReceipt(value.result, value.request.expected.entry.witness); else if (value.action === 'delete') parseFileDeleteReceipt(value.result, value.request.expected.entry.witness); else parseFilePathMutationReceipt(value.result) }
      return value
    } finally { await handle.close() }
  }
  private producer(value: unknown, input: FileMkdirParams | FileMoveParams | FileDeleteParams, action: 'mkdir' | 'move' | 'delete' = 'mkdir'): Producer {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['stage', 'entry', 'location', ...(action === 'move' ? ['destination', 'claimed'] : action === 'delete' ? ['claimed'] : [])].includes(key))) throw new Error('The original native producer witness is invalid.')
    const record = value as Record<string, unknown>, stage = parseFileEntryWitness(record.stage), entry = parseFileEntryWitness(record.entry)
    if (stage.device !== input.expected.parent.device || entry.device !== stage.device || stage.inode === entry.inode || stage.birthtimeNs === null || entry.birthtimeNs === null) throw new Error('The original native producer does not identify the exact private claim and original entry on this parent filesystem.')
    const location = record.location as { root: string; path: string }
    if (!location || typeof location !== 'object' || Array.isArray(location) || Object.keys(location).some(key => key !== 'root' && key !== 'path') || typeof location.root !== 'string' || !isAbsolute(location.root) || location.root.length > 16384 || typeof location.path !== 'string' || !location.path || location.path.length > 16384 || isAbsolute(location.path) || /\0/u.test(location.root + location.path) || location.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The original native producer location is invalid.')
    let destination: Locator | undefined
    if (action === 'move') {
      const other = record.destination as Locator
      if (!other || typeof other !== 'object' || Array.isArray(other) || Object.keys(other).some(key => key !== 'root' && key !== 'path') || typeof other.root !== 'string' || !isAbsolute(other.root) || typeof other.path !== 'string' || !other.path || isAbsolute(other.path) || other.root.length > 16384 || other.path.length > 16384 || /\0/u.test(other.root + other.path) || other.path.split('/').some(part => !part || part === '.' || part === '..') || record.claimed !== undefined && record.claimed !== true) throw new Error('The original move destination locator is invalid.')
      destination = other
      const expected = (input as FileMoveParams).expected.entry.witness
      if (!sameIdentity(entry, expected)) throw new Error('The original move producer changed source identity.')
    }
    if (action === 'delete' && (record.claimed !== undefined && record.claimed !== true || !sameIdentity(entry, (input as FileDeleteParams).expected.entry.witness))) throw new Error('The original delete producer changed source identity or phase.')
    return { stage, entry, location, ...(destination ? { destination } : {}), ...(record.claimed ? { claimed: true as const } : {}) }
  }
  private async prepare(value: Original): Promise<boolean> {
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES - 96 * 1024) throw new AgentMuxError('The exact original Files request exceeds the retained request budget. No admission or helper was created.', 'FILE_MUTATION_RECORD_TOO_LARGE')
    if (!await this.publishAdmission(value)) return false
    await mkdir(this.ports.directory, { recursive: true, mode: 0o700 })
    // The containing config directory also confirms the new domain directory.
    const parent = await open(dirname(this.ports.directory), 'r')
    try { await parent.sync() } finally { await parent.close() }
    try { await mkdir(this.operationDirectory(value.request.operationId), { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    const admissions = await open(this.ports.directory, 'r')
    try { await admissions.sync() } finally { await admissions.close() }
    const handle = await open(this.path(value.request.operationId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
    const directory = await open(this.operationDirectory(value.request.operationId), 'r')
    try { await directory.sync() } finally { await directory.close() }
    return true
  }
  private sameTarget(original: FileMutationInspectParams, input: FileMutationInspectParams): void {
    if (original.zoneId !== input.zoneId || original.path !== input.path || input.spaceId !== undefined && original.spaceId !== input.spaceId || targetKeys.some(key => original.expectedResource[key] !== input.expectedResource[key]))
      throw new AgentMuxError('This Files operation belongs to another original target.', 'FILE_MUTATION_CONFLICT')
  }
  private authorizeRead(value: Pick<Original, 'actor' | 'callerHostId'>, context: FilePathMutationContext | undefined): void {
    const reader = actor(context)
    if (reader.kind === 'agent' && (!isDeepStrictEqual(reader, value.actor) || context?.callerHostId !== value.callerHostId))
      throw new AgentMuxError('A managed Agent may inspect only its own original Files mutation.', 'CONTROL_PERMISSION_DENIED')
  }
  async deleteSnapshots(raw: FileDeleteSnapshotsParams, context?: FilePathMutationContext): Promise<FileDeleteSnapshotsResult> {
    const input = structuredClone(parseFileDeleteSnapshotsParams(raw)), originalContext = { actor: actor(context), ...(context?.callerHostId ? { callerHostId: context.callerHostId } : {}) }
    const unknown = (cause: unknown, resource = null as FileDeleteSnapshotsResult['resource']): FileDeleteSnapshotsResult => ({ operationId: input.operationId, resource,
      result: { status: 'unknown', code: (cause as { code?: string })?.code ?? 'FILE_DELETE_SNAPSHOTS_UNCONFIRMED', message: cause instanceof Error ? cause.message : String(cause), cursor: input.cursor ?? null } })
    let original: Original | null
    try { original = await this.load(input.operationId, undefined, originalContext) }
    catch (cause) { if ((cause as { code?: string }).code === 'CONTROL_PERMISSION_DENIED') throw cause; return unknown(cause) }
    if (!original || original.action !== 'delete') return unknown('The original deletion request is unavailable. Keep its complete request; no snapshot absence or filesystem result was inferred.')
    this.authorizeRead(original, originalContext); this.sameTarget(original.request, input)
    const resource = original.request.expectedResource
    try {
      if (!this.ports.deleteSnapshots) throw new Error('The original Notebook snapshot reader is unavailable; saved bodies and the request are retained.')
      let cursor: { schema: string; query: string; root: string; after: { key: string; eventId?: string } } | undefined
      if (input.cursor) {
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (!cursor || typeof cursor !== 'object' || Object.keys(cursor).some(key => !['schema', 'query', 'root', 'after'].includes(key)) || cursor.schema !== 'agentmux.file-delete-snapshots.v1' || cursor.query !== original.digest || !/^[a-f0-9]{64}$/u.test(cursor.root) ||
            !cursor.after || typeof cursor.after !== 'object' || Object.keys(cursor.after).some(key => key !== 'key' && key !== 'eventId') || !/^[a-f0-9]{64}$/u.test(cursor.after.key) || cursor.after.eventId !== undefined && (typeof cursor.after.eventId !== 'string' || !cursor.after.eventId.startsWith(input.operationId + '/note-delete/'))) throw new Error('The original deletion snapshot cursor belongs to another query or generation.')
      }
      const page = await this.ports.deleteSnapshots({ scope: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath, path: resource.path },
        operationId: input.operationId, digest: original.digest, actor: original.actor, limit: input.limit ?? 25, ...(cursor ? { root: cursor.root, after: cursor.after } : {}) })
      const entries: FileDeleteSnapshotReference[] = []; let bytes = 0, cut = false, after = page.after
      for (const entry of page.entries) {
        const reference: FileDeleteSnapshotReference = { ...entry.reference, originalResource: { ...resource, path: entry.reference.originalResource.path },
          historyUnavailable: 'The current history mapping is unconfirmed. Discover or register the original Source resource; the stable event and saved body remain with its owner.' }
        const size = Buffer.byteLength(JSON.stringify(reference))
        // Reserve the other packet share for actual live history mappings/envelope.
        if (bytes + size > FILE_DELETE_SNAPSHOT_REFERENCE_BYTES) {
          if (!entries.length) throw new Error('This reference exceeds the bounded snapshot packet share. The original event and body are retained.')
          cut = true; break
        }
        bytes += size; entries.push(reference)
        after = { key: entry.key, eventId: entry.reference.eventId }
      }
      if (!cut) after = page.after
      const hasMore = cut || page.hasMore
      const next = hasMore && after && page.root ? Buffer.from(JSON.stringify({ schema: 'agentmux.file-delete-snapshots.v1', query: original.digest, root: page.root, after })).toString('base64url') : null
      if (hasMore && !next) throw new Error('The original snapshot continuation is unconfirmed; keep the cursor.')
      return { operationId: input.operationId, resource, result: { status: 'read', entries, hasMore, cursor: next, rootRevision: page.root, filesystem: this.observeDelete(original).filesystem } }
    } catch (cause) { return unknown(cause, resource) }
  }
  private async observe(value: MkdirOriginal, workspace?: WorkspaceRecord): Promise<FilePathMutationReceipt> {
    // Current reads never reconstruct the original directory/storage ACK.
    if (value.result) return { ...value.result, durability: 'unconfirmed' }
    if (!workspace || workspace.id !== value.request.expectedResource.workspaceId || workspace.hostId !== value.request.expectedResource.hostId || workspace.path !== value.request.expectedResource.workspacePath)
      return unknown('The original Host/Workspace mapping is unavailable.', 'FILE_RESOURCE_UNAVAILABLE')
    if (!value.producer) return unknown('The original producer has no durably retained stage identity. Its original request and private stage are kept.', 'FILE_MKDIR_PRODUCER_UNCONFIRMED')
    try {
      return { ...parseFilePathMutationReceipt(await this.ports.files.inspectPathMutation(workspace, {
        path: value.request.expectedResource.path, stage: value.stage, digest: value.digest, expected: value.request.expected, createdWitness: value.producer.entry, location: value.producer.location
      })), durability: 'unconfirmed' }
    } catch (cause) { return unknown(cause) }
  }
  async inspect(input: FileMutationInspectParams, context: FilePathMutationContext | undefined, workspace?: WorkspaceRecord): Promise<FileMutationInspectResult> {
    actor(context)
    let original: Original | null
    try { original = await this.load(input.operationId, undefined, context) }
    catch (cause) { if (cause instanceof AgentMuxError && cause.code === 'CONTROL_PERMISSION_DENIED') throw cause; return { operationId: input.operationId, resource: workspace ? input.expectedResource : null,
      result: { action: 'unknown', phase: 'unavailable', filesystem: 'unknown', durability: 'unconfirmed', code: 'FILE_MUTATION_RECORD_UNAVAILABLE', message: cause instanceof Error ? cause.message : String(cause) } } }
    if (!original) return { operationId: input.operationId, resource: workspace ? input.expectedResource : null,
      result: { action: 'unknown', phase: 'absent', filesystem: 'unknown', durability: 'unconfirmed', code: 'FILE_MUTATION_NOT_OBSERVED', message: 'No original operation record was observed. No filesystem action was replayed.' } }
    this.authorizeRead(original, context); this.sameTarget(original.request, input)
    if (original.action === 'delete') return { operationId: input.operationId, resource: workspace ? original.request.expectedResource : null,
      result: { ...this.observeDelete(original), original: structuredClone(original.request) } }
    if (original.action === 'move') return { operationId: input.operationId, resource: workspace ? original.request.expectedResource : null,
      result: { ...await this.observeMove(original, workspace), original: structuredClone(original.request) } }
    return { operationId: input.operationId, resource: workspace ? original.request.expectedResource : null,
      result: { ...await this.observe(original, workspace), original: structuredClone(original.request) } }
  }
  mkdir(workspace: WorkspaceRecord, raw: FileMkdirParams, context: FilePathMutationContext | undefined): Promise<FileMkdirResult> {
    const input = structuredClone(parseFileMkdirParams(raw)), originalActor = actor(context)
    if (workspace.id !== input.expectedResource.workspaceId || workspace.hostId !== input.expectedResource.hostId || workspace.path !== input.expectedResource.workspacePath)
      throw new AgentMuxError('The original Files Workspace mapping changed before directory creation.', 'FILE_RESOURCE_MISMATCH')
    const fingerprint = digest(input, originalActor, context?.callerHostId), prior = this.inFlight.get(input.operationId)
    if (prior) {
      if (prior.action !== 'mkdir' || prior.digest !== fingerprint) return Promise.reject(new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT'))
      return prior.promise
    }
    const promise = this.execute(workspace, input, originalActor, context?.callerHostId, fingerprint)
    this.inFlight.set(input.operationId, { action: 'mkdir', digest: fingerprint, promise })
    void promise.finally(() => { if (this.inFlight.get(input.operationId)?.promise === promise) this.inFlight.delete(input.operationId) }).catch(() => {})
    return promise
  }
  private async execute(workspace: WorkspaceRecord, input: FileMkdirParams, originalActor: Actor, callerHostId: string | undefined, fingerprint: string): Promise<FileMkdirResult> {
    const result = (receipt: FilePathMutationReceipt): FileMkdirResult => ({ operationId: input.operationId, resource: input.expectedResource, result: receipt })
    const publish = (receipt: FilePathMutationReceipt): FileMkdirResult => { const value = result(receipt); if (receipt.filesystem === 'created') this.ports.effects?.publish({ type: 'path-mutation', action: 'mkdir', request: input, receipt: value }, { actor: originalActor, ...(callerHostId ? { callerHostId } : {}) }); return value }
    let prior
    try { prior = await this.load(input.operationId, fingerprint) } catch (cause) { if (cause instanceof AgentMuxError && cause.code === 'FILE_MUTATION_CONFLICT') throw cause; return result(unknown(cause, 'FILE_MUTATION_RECORD_UNAVAILABLE')) }
    if (prior) {
      if (prior.action !== 'mkdir' || prior.digest !== fingerprint) throw new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT')
      return result(await this.observe(prior, workspace))
    }
    const prepared: MkdirOriginal = { schema: 'agentmux.file-path-mutation.v1', action: 'mkdir', request: input, actor: originalActor,
      ...(callerHostId ? { callerHostId } : {}), digest: fingerprint, stage: '.agentmux-mkdir-' + fingerprint }
    try {
      if (!await this.prepare(prepared)) {
        const retained = await this.load(input.operationId, fingerprint)
        if (!retained || retained.action !== 'mkdir' || retained.digest !== fingerprint) throw new AgentMuxError('The original Files operation belongs to different input or actor.', 'FILE_MUTATION_CONFLICT')
        return result(await this.observe(retained, workspace))
      }
    } catch (cause) {
      if (cause instanceof AgentMuxError && cause.code === 'FILE_MUTATION_CONFLICT') throw cause
      return result(unknown(cause, 'FILE_MUTATION_PREPARE_UNCONFIRMED'))
    }
    // Directory corpus mutations borrow the original Note lease; ordinary reads do not.
    return this.ports.noteLease(async () => {
      let receipt: FilePathMutationReceipt
      try { receipt = parseFilePathMutationReceipt(await this.ports.files.mkdirPath(workspace, {
        path: input.expectedResource.path, stage: prepared.stage, digest: prepared.digest, expected: input.expected,
        retainProducer: async value => {
          const producer = this.producer(value, input), latest = await this.load(input.operationId)
          if (!latest || latest.action !== 'mkdir' || latest.digest !== fingerprint || latest.result || latest.producer) throw new Error('The original Files record changed before native publication.')
          await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, producer }), { mode: 0o600, requireDirectorySync: true })
          prepared.producer = producer
        }
      })) } catch (cause) { return result(unknown(cause)) }
      try {
        await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, result: receipt }), { mode: 0o600, requireDirectorySync: true })
        return publish(receipt)
      } catch (cause) {
        return publish({ ...receipt, durability: 'unconfirmed', code: 'FILE_MUTATION_RESULT_UNCONFIRMED',
          message: 'The filesystem result is separate from its unconfirmed record save. Keep this operation and inspect it without replaying. ' + (cause instanceof Error ? cause.message : String(cause)) })
      }
    })
  }
  private async observeMove(value: MoveOriginal, workspace?: WorkspaceRecord): Promise<FileMoveReceipt> {
    if (value.result && value.result.filesystem !== 'unknown') return { ...value.result, durability: 'unconfirmed' }
    if (!workspace || workspace.id !== value.request.expectedResource.workspaceId || workspace.hostId !== value.request.expectedResource.hostId || workspace.path !== value.request.expectedResource.workspacePath) return moveUnknown('The original Workspace mapping is unavailable.', 'FILE_RESOURCE_UNAVAILABLE')
    if (!value.producer?.destination) return moveUnknown('The original move producer is unconfirmed.')
    try {
      const current = parseFileMoveReceipt(await this.ports.files.inspectMovePath({ request: value.request, stage: value.stage, location: value.producer.location, destination: value.producer.destination, claimed: value.producer.claimed === true }), value.request.expected.entry.witness)
      return { ...value.result, ...current, durability: 'unconfirmed', ...(value.notePlan?.entries.length && current.filesystem === 'moved' && value.result?.noteMetadata?.status !== 'recorded' ? { noteMetadata: { status: 'unconfirmed', message: 'The original Note relocation plan is retained, but this read does not confirm its publication.' } } : {}) }
    }
    catch (cause) { return moveUnknown(cause) }
  }
  move(workspace: WorkspaceRecord, raw: FileMoveParams, context: FilePathMutationContext | undefined): Promise<FileMoveResult> {
    const input = structuredClone(parseFileMoveParams(raw)), originalActor = actor(context)
    context = context && { ...context, actor: originalActor }
    if (workspace.id !== input.expectedResource.workspaceId || workspace.hostId !== input.expectedResource.hostId || workspace.path !== input.expectedResource.workspacePath) throw new AgentMuxError('The original move Workspace mapping changed.', 'FILE_RESOURCE_MISMATCH')
    const fingerprint = digest(input, originalActor, context?.callerHostId, 'move'), prior = this.inFlight.get(input.operationId)
    if (prior) {
      if (prior.action !== 'move' || prior.digest !== fingerprint) return Promise.reject(new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT'))
      return prior.promise
    }
    const promise = this.executeMove(workspace, input, originalActor, context, fingerprint)
    this.inFlight.set(input.operationId, { action: 'move', digest: fingerprint, promise })
    void promise.finally(() => { if (this.inFlight.get(input.operationId)?.promise === promise) this.inFlight.delete(input.operationId) }).catch(() => {})
    return promise
  }
  private async executeMove(workspace: WorkspaceRecord, input: FileMoveParams, originalActor: Actor, context: FilePathMutationContext | undefined, fingerprint: string): Promise<FileMoveResult> {
    const callerHostId = context?.callerHostId
    const result = (receipt: FileMoveReceipt): FileMoveResult => ({ operationId: input.operationId, resource: input.expectedResource, destination: input.destination.expectedResource, result: receipt })
    const publish = (receipt: FileMoveReceipt): FileMoveResult => { const value = result(receipt); if (receipt.filesystem === 'moved') this.ports.effects?.publish({ type: 'path-mutation', action: 'move', request: input, receipt: value }, { actor: originalActor, ...(callerHostId ? { callerHostId } : {}) }); return value }
    let prior: Original | null
    try { prior = await this.load(input.operationId, fingerprint) } catch (cause) { if (cause instanceof AgentMuxError && cause.code === 'FILE_MUTATION_CONFLICT') throw cause; return result(moveUnknown(cause, 'FILE_MUTATION_RECORD_UNAVAILABLE')) }
    if (prior) {
      if (prior.action !== 'move' || prior.digest !== fingerprint) throw new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT')
      return result(await this.observeMove(prior, workspace))
    }
    const prepared: MoveOriginal = { schema: 'agentmux.file-path-mutation.v1', action: 'move', request: input, actor: originalActor,
      ...(context?.callerHostId ? { callerHostId: context.callerHostId } : {}), ...(context?.transport ? { transport: context.transport } : {}), digest: fingerprint, stage: '.agentmux-move-' + fingerprint }
    try {
      if (!await this.prepare(prepared)) {
        const retained = await this.load(input.operationId, fingerprint)
        if (!retained || retained.action !== 'move' || retained.digest !== fingerprint) throw new AgentMuxError('This original Files operation belongs to different input or actor.', 'FILE_MUTATION_CONFLICT')
        return result(await this.observeMove(retained, workspace))
      }
    } catch (cause) { if (cause instanceof AgentMuxError && cause.code === 'FILE_MUTATION_CONFLICT') throw cause; return result(moveUnknown(cause, 'FILE_MUTATION_PREPARE_UNCONFIRMED')) }
    const apply = async (): Promise<FileMoveReceipt> => {
      if (!this.ports.directoryScope || !this.ports.nameAudit) return moveUnknown('The original Core directory admission or name owner is unavailable.', 'FILE_MOVE_OWNER_UNAVAILABLE')
      let retained: ((physical: readonly Locator[]) => Promise<void>) | undefined
      if (this.ports.retainPaths) try {
        retained = await this.ports.retainPaths(workspace, [input.expectedResource.path, input.destination.expectedResource.path])
      } catch (cause) {
        const refusal = cause as { definitelyUnchanged?: boolean; code?: string; message?: string }
        if (refusal.definitelyUnchanged === true) return { action: 'move', phase: 'settled', filesystem: 'not-applied', durability: 'confirmed', code: refusal.code ?? 'FILE_MOVE_REFUSED', message: refusal.message ?? 'The original path owner refused this move before any helper was dispatched.' }
        throw cause
      }
      const current = await this.ports.files.statPath(workspace, input.expectedResource.path)
      const sourceConflict: FileMoveReceipt = { action: 'move', phase: 'settled', filesystem: 'not-applied', durability: 'confirmed', code: 'FILE_MOVE_SOURCE_CONFLICT', message: 'The original source generation changed; no helper was dispatched.' }
      if (current.entry.kind === 'absent' || current.entry.kind !== input.expected.entry.kind) return sourceConflict
      if ([current.root, current.parent, current.entry.witness, input.expected.root, input.expected.parent, input.expected.entry.witness].some(witness => witness.birthtimeNs === null)) return { action: 'move', phase: 'settled', filesystem: 'not-applied', durability: 'confirmed', code: 'FILE_PATH_GENERATION_UNAVAILABLE', message: 'The original native source or scope generation is unobserved; no helper was dispatched. Original files and ordinary reads remain available.' }
      if (!sameIdentity(current.entry.witness, input.expected.entry.witness)) return sourceConflict
      const location = await this.ports.files.pathMutationLocation(workspace, input.expectedResource.path)
      const names = [resolve(workspace.path, input.expectedResource.path), resolve(location.root, location.requested)]
      const scope = this.ports.directoryScope(async cwd => {
        if (!isAbsolute(cwd)) throw new AgentMuxError('An original execution directory is not an absolute physical observation.', 'EXECUTION_DIRECTORY_REFERENCES_UNCONFIRMED')
        if (names.some(name => cwd === name || cwd.startsWith(name + sep))) return true
        const related = await this.ports.files.executionDirectoryRelated(cwd, current.entry.kind === 'absent' ? input.expected.entry.witness : current.entry.witness)
        if (related === 'unavailable') throw new AgentMuxError('An original execution directory relation could not be observed.', 'EXECUTION_DIRECTORY_REFERENCES_UNCONFIRMED')
        return related === 'related'
      })
      try {
        try { await scope.assertUnreferenced() }
        catch (cause) {
          if ((cause as { code?: string }).code === 'EXECUTION_DIRECTORY_REFERENCED') return { action: 'move', phase: 'settled', filesystem: 'not-applied', durability: 'confirmed', code: 'EXECUTION_DIRECTORY_REFERENCED', message: 'The original directory is retained by execution or recovery. No move helper was dispatched; existing work remains available.' }
          throw cause
        }
        return parseFileMoveReceipt(await this.ports.files.movePath(workspace, { request: input, stage: prepared.stage, spawnFileProducer: scope.spawnFileProducer,
          retainProducer: async raw => {
            const frame = raw as Producer & { phase: 'staged' | 'claimed' }, { phase, ...candidate } = frame
            const producer = this.producer({ ...candidate, ...(phase === 'claimed' ? { claimed: true } : {}) }, input, 'move')
            const latest = await this.load(input.operationId)
            if (!latest || latest.action !== 'move' || latest.digest !== fingerprint || latest.result ||
                phase === 'staged' && latest.producer || phase === 'claimed' && (!latest.producer || latest.producer.claimed || !sameIdentity(latest.producer.stage, producer.stage) || !sameIdentity(latest.producer.entry, producer.entry))) throw new Error('The original move phase changed before publication.')
            await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, producer }), { mode: 0o600, requireDirectorySync: true })
            prepared.producer = producer
            if (retained) await retained([producer.location, ...(producer.destination ? [producer.destination] : [])])
            await scope.assertUnreferenced()
          }
        }), input.expected.entry.witness)
      } finally { scope.release() } // The worker resolves/rejects only after its original child close.
    }
    const named = async (): Promise<FileMoveReceipt> => {
      let effect: FileMoveReceipt | undefined
      const nameOperation = input.operationId + '/name/0'
      try {
        if (!this.ports.nameAudit) return moveUnknown('The original name owner is unavailable.', 'FILE_MOVE_OWNER_UNAVAILABLE')
        const receipt = await nameChangeRequests.run({ operationId: input.operationId, context: { actor: { ...prepared.actor, verified: true }, source: 'explicit-edit', entryPoint: 'file.move', transport: prepared.transport ?? null, location: { callerHostId: prepared.callerHostId ?? null } } }, () => this.ports.nameAudit!.run([{
          target: { kind: 'workspace-path', id: JSON.stringify([workspace.id, input.expectedResource.path]) }, before: input.expectedResource.path, requested: input.destination.expectedResource.path,
          location: { workspaceId: workspace.id, hostId: workspace.hostId, cwd: workspace.path, destinationWorkspaceId: workspace.id }
        }], async () => effect = await apply(), receipt => receipt.filesystem === 'moved' ? { actual: input.destination.expectedResource.path } : { actual: receipt.filesystem === 'not-applied' ? input.expectedResource.path : null, status: receipt.filesystem === 'not-applied' ? 'failed' : 'unknown', reason: receipt.message ?? null }))
        return { ...receipt, nameAudit: { operationId: nameOperation, status: 'recorded' } }
      } catch (cause) { return { ...(effect ?? moveUnknown(cause)), nameAudit: { operationId: nameOperation, status: 'unconfirmed', message: cause instanceof Error ? cause.message : String(cause) } } }
    }
    let receipt: FileMoveReceipt
    try { receipt = await this.ports.noteLease(async () => {
      if (!this.ports.notes) return moveUnknown('The original Note metadata owner is unavailable.', 'FILE_MOVE_OWNER_UNAVAILABLE')
      const notePlan = parseNotebookFileRelocationPlan(await this.ports.notes.plan(input.expectedResource, input.destination.expectedResource))
      // Retain only resource identities, never Note bodies/history in Files.
      // A rejected oversized plan must not replace the bounded original request.
      const record = JSON.stringify({ ...prepared, notePlan })
      if (Buffer.byteLength(record) > MAX_RECORD_BYTES - 96 * 1024) return moveUnknown('The original Note relocation plan exceeds this Files request bound; no helper was dispatched.', 'FILE_MUTATION_RECORD_TOO_LARGE')
      prepared.notePlan = notePlan
      await durableWriteFile(this.path(input.operationId), record, { mode: 0o600, requireDirectorySync: true })
      const effect = await named()
      if (effect.filesystem !== 'moved') return effect
      try { await this.ports.notes.apply(prepared.notePlan, input.operationId, originalActor); return { ...effect, noteMetadata: { status: 'recorded' as const } } }
      catch (cause) { return { ...effect, noteMetadata: { status: 'unconfirmed' as const, message: cause instanceof Error ? cause.message : String(cause) } } }
    }) } catch (cause) { receipt = moveUnknown(cause) }
    try { await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, result: receipt }), { mode: 0o600, requireDirectorySync: true }); return publish(receipt) }
    catch (cause) { return publish({ ...receipt, durability: 'unconfirmed', code: 'FILE_MUTATION_RESULT_UNCONFIRMED', message: 'The original move result save is unconfirmed; no action may be replayed. ' + (cause instanceof Error ? cause.message : String(cause)) }) }
  }

  private observeDelete(value: DeleteOriginal): FileDeleteReceipt {
    if (value.result) return { ...value.result, durability: 'unconfirmed' }
    const receipt = deleteUnknown('The original producer has no confirmed final deletion receipt. Current absence is not an earlier acknowledgement.')
    if (!value.producer) return receipt
    return { ...receipt, phase: value.producer.claimed ? 'claimed' : 'prepared',
      retainedPath: join(dirname(value.producer.location.path), value.stage, 'entry') }
  }
  delete(workspace: WorkspaceRecord, raw: FileDeleteParams, context: FilePathMutationContext | undefined): Promise<FileDeleteResult> {
    const input = structuredClone(parseFileDeleteParams(raw)), originalActor = actor(context)
    if (workspace.id !== input.expectedResource.workspaceId || workspace.hostId !== input.expectedResource.hostId || workspace.path !== input.expectedResource.workspacePath) throw new AgentMuxError('The original deletion Workspace mapping changed.', 'FILE_RESOURCE_MISMATCH')
    const fingerprint = digest(input, originalActor, context?.callerHostId, 'delete'), prior = this.inFlight.get(input.operationId)
    if (prior) {
      if (prior.action !== 'delete' || prior.digest !== fingerprint) return Promise.reject(new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT'))
      return prior.promise
    }
    const promise = this.executeDelete(workspace, input, originalActor, context?.callerHostId, fingerprint)
    this.inFlight.set(input.operationId, { action: 'delete', digest: fingerprint, promise })
    void promise.finally(() => { if (this.inFlight.get(input.operationId)?.promise === promise) this.inFlight.delete(input.operationId) }).catch(() => {})
    return promise
  }
  private async executeDelete(workspace: WorkspaceRecord, input: FileDeleteParams, originalActor: Actor, callerHostId: string | undefined, fingerprint: string): Promise<FileDeleteResult> {
    const result = (receipt: FileDeleteReceipt): FileDeleteResult => ({ operationId: input.operationId, resource: input.expectedResource, result: receipt })
    const publish = (receipt: FileDeleteReceipt): FileDeleteResult => { const value = result(receipt); if (receipt.filesystem === 'deleted') this.ports.effects?.publish({ type: 'path-mutation', action: 'delete', request: input, receipt: value }, { actor: originalActor, ...(callerHostId ? { callerHostId } : {}) }); return value }
    let prior: Original | null
    try { prior = await this.load(input.operationId, fingerprint) } catch (cause) { if (cause instanceof AgentMuxError && cause.code === 'FILE_MUTATION_CONFLICT') throw cause; return result(deleteUnknown(cause, 'FILE_MUTATION_RECORD_UNAVAILABLE')) }
    if (prior) {
      if (prior.action !== 'delete' || prior.digest !== fingerprint) throw new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT')
      return result(this.observeDelete(prior))
    }
    const prepared: DeleteOriginal = { schema: 'agentmux.file-path-mutation.v1', action: 'delete', request: input, actor: originalActor,
      ...(callerHostId ? { callerHostId } : {}), digest: fingerprint, stage: '.agentmux-delete-' + fingerprint }
    try {
      if (!await this.prepare(prepared)) {
        const retained = await this.load(input.operationId, fingerprint)
        if (!retained || retained.action !== 'delete' || retained.digest !== fingerprint) throw new AgentMuxError('The original Files operation belongs to different input or actor.', 'FILE_MUTATION_CONFLICT')
        return result(this.observeDelete(retained))
      }
    } catch (cause) { if (cause instanceof AgentMuxError && cause.code === 'FILE_MUTATION_CONFLICT') throw cause; return result(deleteUnknown(cause, 'FILE_MUTATION_PREPARE_UNCONFIRMED')) }
    let receipt: FileDeleteReceipt
    try { receipt = await this.ports.noteLease(async () => {
      if (!this.ports.directoryScope || !this.ports.deleteHistory) return deleteUnknown('The original Core directory or Note history owner is unavailable.', 'FILE_DELETE_OWNER_UNAVAILABLE')
      let retained: ((physical: readonly Locator[]) => Promise<void>) | undefined
      if (this.ports.retainPaths) try { retained = await this.ports.retainPaths(workspace, [input.expectedResource.path]) }
      catch (cause) {
        const refusal = cause as { definitelyUnchanged?: boolean; code?: string; message?: string }
        if (refusal.definitelyUnchanged === true) return { action: 'delete', phase: 'settled', filesystem: 'not-applied', durability: 'confirmed', code: refusal.code ?? 'FILE_DELETE_REFUSED', message: refusal.message ?? 'The original path owner refused this deletion before Native dispatch.' }
        throw cause
      }
      const current = await this.ports.files.statPath(workspace, input.expectedResource.path)
      const conflict: FileDeleteReceipt = { action: 'delete', phase: 'settled', filesystem: 'not-applied', durability: 'confirmed', code: 'FILE_DELETE_SOURCE_CONFLICT', message: 'The original source entry changed. No delete helper was dispatched.' }
      if (current.entry.kind === 'absent' || current.entry.kind !== input.expected.entry.kind) return conflict
      if ([current.root, current.parent, current.entry.witness, input.expected.root, input.expected.parent, input.expected.entry.witness].some(witness => witness.birthtimeNs === null)) return { ...conflict, code: 'FILE_PATH_GENERATION_UNAVAILABLE', message: 'The original source or scope generation is unavailable; files and ordinary reads remain available.' }
      if (!sameIdentity(current.entry.witness, input.expected.entry.witness)) return conflict
      const location = await this.ports.files.pathMutationLocation(workspace, input.expectedResource.path), sourceWitness = current.entry.witness
      const names = [resolve(workspace.path, input.expectedResource.path), resolve(location.root, location.requested)]
      const scope = this.ports.directoryScope(async cwd => {
        if (!isAbsolute(cwd)) throw new AgentMuxError('The original execution directory observation is not absolute.', 'EXECUTION_DIRECTORY_REFERENCES_UNCONFIRMED')
        if (names.some(name => cwd === name || cwd.startsWith(name + sep))) return true
        const related = await this.ports.files.executionDirectoryRelated(cwd, sourceWitness)
        if (related === 'unavailable') throw new AgentMuxError('The original execution directory relation could not be observed.', 'EXECUTION_DIRECTORY_REFERENCES_UNCONFIRMED')
        return related === 'related'
      })
      const history = this.ports.deleteHistory(workspace, input, fingerprint, originalActor)
      try {
        try { await scope.assertUnreferenced() }
        catch (cause) { if ((cause as { code?: string }).code === 'EXECUTION_DIRECTORY_REFERENCED') return { ...conflict, code: 'EXECUTION_DIRECTORY_REFERENCED', message: 'The original directory is retained by execution or recovery; no delete helper was dispatched and existing work remains available.' }; throw cause }
        let effect: FileDeleteReceipt
        try { effect = parseFileDeleteReceipt(await this.ports.files.deletePath(workspace, { request: input, stage: prepared.stage, spawnFileProducer: scope.spawnFileProducer,
          retainProducer: async raw => {
            const frame = raw as Producer & { phase: 'staged' | 'claimed' }, { phase, ...candidate } = frame
            if (!['staged', 'claimed'].includes(phase)) throw new Error('The original delete producer phase is invalid.')
            const producer = this.producer({ ...candidate, ...(phase === 'claimed' ? { claimed: true } : {}) }, input, 'delete'), latest = await this.load(input.operationId)
            if (!latest || latest.action !== 'delete' || latest.digest !== fingerprint || latest.result ||
                phase === 'staged' && latest.producer || phase === 'claimed' && (!latest.producer || latest.producer.claimed || !sameIdentity(latest.producer.stage, producer.stage) || !sameIdentity(latest.producer.entry, producer.entry))) throw new Error('The original delete phase changed before its physical effect.')
            await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, producer }), { mode: 0o600, requireDirectorySync: true })
            prepared.producer = producer
            if (retained) await retained([producer.location])
            await scope.assertUnreferenced()
          }, snapshot: value => history.snapshot(value)
        }), input.expected.entry.witness) }
        catch (cause) { return { ...deleteUnknown(cause), phase: prepared.producer?.claimed ? 'claimed' : 'prepared',
          ...(typeof (cause as { retainedPath?: unknown }).retainedPath === 'string' ? { retainedPath: (cause as { retainedPath: string }).retainedPath } : prepared.producer ? { retainedPath: join(dirname(prepared.producer.location.path), prepared.stage, 'entry') } : {}),
          noteHistory: { status: 'unconfirmed', message: 'Any original prepared history is retained. No final Native deletion acknowledgement was received; a recorded claim address does not prove its current location or existence.' } } }
        if (effect.filesystem !== 'deleted') return effect
        try { await history.confirmDeleted(); return { ...effect, noteHistory: { status: 'recorded' } } }
        catch (cause) { return { ...effect, noteHistory: { status: 'unconfirmed', message: cause instanceof Error ? cause.message : String(cause) } } }
      } finally { scope.release() } // The original finite worker has actually closed.
    }) } catch (cause) { receipt = deleteUnknown(cause) }
    try { await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, result: receipt }), { mode: 0o600, requireDirectorySync: true }); return publish(receipt) }
    catch (cause) { return publish({ ...receipt, durability: 'unconfirmed', code: 'FILE_MUTATION_RESULT_UNCONFIRMED', message: 'The original delete result save is unconfirmed. Keep the original request and inspect without replaying. ' + (cause instanceof Error ? cause.message : String(cause)) }) }
  }

}
