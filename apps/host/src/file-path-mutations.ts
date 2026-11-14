import { createHash } from 'node:crypto'
import { constants, mkdir, open, lstat } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, durableWriteFile } from '@agentmux/core'
import { parseFileMkdirParams, parseFilePathMutationReceipt, parseFileEntryWitness, type FileMkdirParams, type FileMkdirResult,
  type FileMutationInspectParams, type FileMutationInspectResult, type FilePathMutationContext,
  type FilePathMutationReceipt, type FilePathObservation, type FileEntryWitness } from '@agentmux/core/files'
import type { WorkspaceRecord } from './content-types.js'
import type { OrdinaryWorkspaceFiles } from './ordinary-files.js'

type Actor = NonNullable<FilePathMutationContext['actor']>
type Original = { schema: 'agentmux.file-path-mutation.v1'; action: 'mkdir'; request: FileMkdirParams; actor: Actor;
  callerHostId?: string; digest: string; stage: string; producer?: { stage: FileEntryWitness; entry: FileEntryWitness; location: { root: string; path: string } }; result?: FilePathMutationReceipt }
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
function digest(request: FileMkdirParams, original: Actor, callerHostId?: string): string {
  return createHash('sha256').update(JSON.stringify(canonical({ action: 'mkdir', request, actor: original, ...(callerHostId ? { callerHostId } : {}) }))).digest('hex')
}
function unknown(cause: unknown, code = 'FILE_MKDIR_UNCONFIRMED'): FilePathMutationReceipt {
  return { action: 'mkdir', phase: 'prepared', filesystem: 'unknown', durability: 'unconfirmed', code,
    message: 'The original directory creation is unconfirmed. Its request is retained; inspect that operation without replaying it. ' + (cause instanceof Error ? cause.message : String(cause)) }
}
const targetKeys = ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const

/** Files-path intent/effect only. Note history, names and resource mappings keep their original owners. */
export class FilePathMutations {
  private readonly inFlight = new Map<string, { digest: string; promise: Promise<FileMkdirResult> }>()
  constructor(private readonly ports: {
    directory: string
    files: Pick<OrdinaryWorkspaceFiles, 'statPath' | 'mkdirPath' | 'inspectPathMutation'>
    noteLease<T>(work: () => Promise<T>): Promise<T>
  }) {}
  stat(workspace: WorkspaceRecord, path: string): Promise<FilePathObservation> { return this.ports.files.statPath(workspace, path) }
  private operationDirectory(operationId: string) { return join(this.ports.directory, createHash('sha256').update(operationId).digest('hex')) }
  private path(operationId: string) { return join(this.operationDirectory(operationId), 'request.json') }
  private async load(operationId: string): Promise<Original | null> {
    let handle
    try { handle = await open(this.path(operationId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await lstat(this.operationDirectory(operationId)) }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null; throw missing }
      throw new Error('The original Files admission exists but its request member is missing. It must not be recreated or replayed.')
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > MAX_RECORD_BYTES) throw new Error('The original Files record is not a bounded regular file.')
      const value = JSON.parse(await handle.readFile('utf8')) as Original
      if (!value || value.schema !== 'agentmux.file-path-mutation.v1' || value.action !== 'mkdir' || Object.keys(value).some(key => !['schema', 'action', 'request', 'actor', 'callerHostId', 'digest', 'stage', 'producer', 'result'].includes(key))) throw new Error('The original Files record is unreadable. Its bytes are kept.')
      const input = parseFileMkdirParams(value.request), original = actor({ actor: value.actor, ...(value.callerHostId ? { callerHostId: value.callerHostId } : {}) })
      if (input.operationId !== operationId || value.digest !== digest(input, original, value.callerHostId) || value.stage !== '.agentmux-mkdir-' + value.digest) throw new Error('The original Files record belongs to another intent.')
      if (value.producer) this.producer(value.producer, input)
      if (value.result) parseFilePathMutationReceipt(value.result)
      return value
    } finally { await handle.close() }
  }
  private producer(value: unknown, input: FileMkdirParams): NonNullable<Original['producer']> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'stage' && key !== 'entry' && key !== 'location')) throw new Error('The original native producer witness is invalid.')
    const record = value as Record<string, unknown>, stage = parseFileEntryWitness(record.stage), entry = parseFileEntryWitness(record.entry)
    if (stage.device !== input.expected.parent.device || entry.device !== stage.device || stage.inode === entry.inode || stage.birthtimeNs === null || entry.birthtimeNs === null) throw new Error('The original native producer does not identify two exact new directories on this parent filesystem.')
    const location = record.location as { root: string; path: string }
    if (!location || typeof location !== 'object' || Array.isArray(location) || Object.keys(location).some(key => key !== 'root' && key !== 'path') || typeof location.root !== 'string' || !isAbsolute(location.root) || location.root.length > 16384 || typeof location.path !== 'string' || !location.path || location.path.length > 16384 || isAbsolute(location.path) || /\0/u.test(location.root + location.path) || location.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The original native producer location is invalid.')
    return { stage, entry, location }
  }
  private async prepare(value: Original): Promise<boolean> {
    await mkdir(this.ports.directory, { recursive: true, mode: 0o700 })
    // The containing config directory also confirms the new domain directory.
    const parent = await open(dirname(this.ports.directory), 'r')
    try { await parent.sync() } finally { await parent.close() }
    try { await mkdir(this.operationDirectory(value.request.operationId), { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    const admissions = await open(this.ports.directory, 'r')
    try { await admissions.sync() } finally { await admissions.close() }
    const handle = await open(this.path(value.request.operationId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    const directory = await open(this.operationDirectory(value.request.operationId), 'r')
    try { await directory.sync() } finally { await directory.close() }
    return true
  }
  private sameTarget(original: FileMkdirParams, input: FileMutationInspectParams): void {
    if (original.zoneId !== input.zoneId || original.path !== input.path || input.spaceId !== undefined && original.spaceId !== input.spaceId || targetKeys.some(key => original.expectedResource[key] !== input.expectedResource[key]))
      throw new AgentMuxError('This Files operation belongs to another original target.', 'FILE_MUTATION_CONFLICT')
  }
  private authorizeRead(value: Original, context: FilePathMutationContext | undefined): void {
    const reader = actor(context)
    if (reader.kind === 'agent' && (!isDeepStrictEqual(reader, value.actor) || context?.callerHostId !== value.callerHostId))
      throw new AgentMuxError('A managed Agent may inspect only its own original Files mutation.', 'CONTROL_PERMISSION_DENIED')
  }
  private async observe(value: Original, workspace?: WorkspaceRecord): Promise<FilePathMutationReceipt> {
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
    try { original = await this.load(input.operationId) }
    catch (cause) { return { operationId: input.operationId, resource: workspace ? input.expectedResource : null,
      result: { action: 'mkdir', phase: 'unavailable', filesystem: 'unknown', durability: 'unconfirmed', code: 'FILE_MUTATION_RECORD_UNAVAILABLE', message: cause instanceof Error ? cause.message : String(cause) } } }
    if (!original) return { operationId: input.operationId, resource: workspace ? input.expectedResource : null,
      result: { action: 'mkdir', phase: 'absent', filesystem: 'unknown', durability: 'unconfirmed', code: 'FILE_MUTATION_NOT_OBSERVED', message: 'No original operation record was observed. No filesystem action was replayed.' } }
    this.authorizeRead(original, context); this.sameTarget(original.request, input)
    return { operationId: input.operationId, resource: workspace ? original.request.expectedResource : null,
      result: { ...await this.observe(original, workspace), original: structuredClone(original.request) } }
  }
  mkdir(workspace: WorkspaceRecord, raw: FileMkdirParams, context: FilePathMutationContext | undefined): Promise<FileMkdirResult> {
    const input = structuredClone(parseFileMkdirParams(raw)), originalActor = actor(context)
    if (workspace.id !== input.expectedResource.workspaceId || workspace.hostId !== input.expectedResource.hostId || workspace.path !== input.expectedResource.workspacePath)
      throw new AgentMuxError('The original Files Workspace mapping changed before directory creation.', 'FILE_RESOURCE_MISMATCH')
    const fingerprint = digest(input, originalActor, context?.callerHostId), prior = this.inFlight.get(input.operationId)
    if (prior) {
      if (prior.digest !== fingerprint) return Promise.reject(new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT'))
      return prior.promise
    }
    const promise = this.execute(workspace, input, originalActor, context?.callerHostId, fingerprint)
    this.inFlight.set(input.operationId, { digest: fingerprint, promise })
    void promise.finally(() => { if (this.inFlight.get(input.operationId)?.promise === promise) this.inFlight.delete(input.operationId) }).catch(() => {})
    return promise
  }
  private async execute(workspace: WorkspaceRecord, input: FileMkdirParams, originalActor: Actor, callerHostId: string | undefined, fingerprint: string): Promise<FileMkdirResult> {
    const result = (receipt: FilePathMutationReceipt): FileMkdirResult => ({ operationId: input.operationId, resource: input.expectedResource, result: receipt })
    let prior
    try { prior = await this.load(input.operationId) } catch (cause) { return result(unknown(cause, 'FILE_MUTATION_RECORD_UNAVAILABLE')) }
    if (prior) {
      if (prior.digest !== fingerprint) throw new AgentMuxError('This original Files operation has different input or actor.', 'FILE_MUTATION_CONFLICT')
      return result(await this.observe(prior, workspace))
    }
    const prepared: Original = { schema: 'agentmux.file-path-mutation.v1', action: 'mkdir', request: input, actor: originalActor,
      ...(callerHostId ? { callerHostId } : {}), digest: fingerprint, stage: '.agentmux-mkdir-' + fingerprint }
    try {
      if (!await this.prepare(prepared)) {
        const retained = await this.load(input.operationId)
        if (!retained || retained.digest !== fingerprint) throw new AgentMuxError('The original Files operation belongs to different input or actor.', 'FILE_MUTATION_CONFLICT')
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
          if (!latest || latest.digest !== fingerprint || latest.result || latest.producer) throw new Error('The original Files record changed before native publication.')
          await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, producer }), { mode: 0o600, requireDirectorySync: true })
          prepared.producer = producer
        }
      })) } catch (cause) { return result(unknown(cause)) }
      try {
        await durableWriteFile(this.path(input.operationId), JSON.stringify({ ...prepared, result: receipt }), { mode: 0o600, requireDirectorySync: true })
        return result(receipt)
      } catch (cause) {
        return result({ ...receipt, durability: 'unconfirmed', code: 'FILE_MUTATION_RESULT_UNCONFIRMED',
          message: 'The filesystem result is separate from its unconfirmed record save. Keep this operation and inspect it without replaying. ' + (cause instanceof Error ? cause.message : String(cause)) })
      }
    })
  }
}
