import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep, posix } from 'node:path'
import type { FileDocumentReadResult, FileWriteReceipt, FileNameListing } from '@agentmux/core/files'
import type { NoteFileWitness } from '@agentmux/core/note-history'
import { SCRATCH_WORKSPACE_ID, scratchTopicIdFromDirectoryName, scratchTopicDirectoryName } from './mote-topic-model.js'
import { resolveScratchTopicDirectory, scratchStorageTopicIds } from './mote-directories.js'
import type { WorkspaceDirectoryEntry, WorkspaceFileDeleteExactResult } from './content-types.js'
export type { WorkspaceDirectoryEntry, WorkspaceFileDeleteExactResult } from './content-types.js'
import type { FileWorkspace } from './file-resource.js'
import { WORKSPACE_FILE_MAX_BYTES, WORKSPACE_FILE_MAX_READ_BYTES, type WorkspaceFileReadBudget,
  type WorkspaceFileByteRead, type WorkspaceFileByteReadOptions } from './workspace-file-bytes.js'
import { runWorkspaceFileWorker, type WorkspaceFileWorkerRequest } from './workspace-file-worker.js'
import { LOCAL_FILE_LIST_SOURCE } from './workspace-file-list.js'
export { LOCAL_FILE_LIST_SOURCE } from './workspace-file-list.js'
export { runWorkspaceFileWorker, type WorkspaceFileWorkerRequest } from './workspace-file-worker.js'

type LocalExistingPath = { root: string; target: string }
type LocalMutablePath = { root: string; parent: string; name: string }
export type OrdinaryFileWriteInput = { path: string; content: string; expectedRevision: string | null; baseContent?: string; operationId?: string }
export type OrdinaryFileWriteResult = FileWriteReceipt & { fileWitness?: NoteFileWitness }
export type OrdinaryWorkspaceFilesOptions = {
  beforeLocalDeleteClaim?: () => Promise<void>
  afterLocalDeleteClaim?: () => Promise<void>
  localDeleteFault?: string
  helperPath?: string
  hostFor?: (id: string) => { kind: string }
  beforeWrite?: (input: OrdinaryFileWriteInput) => Promise<void>
  localWriteFault?: 'temporary-write' | 'replace' | 'receipt' | 'occupy' | (() => 'temporary-write' | 'replace' | 'receipt' | 'occupy' | undefined)
}
// Embedding launchers supply their own artifact location; standalone Host keeps its package layout.
const helperPath = process.env.AGENTMUX_WORKSPACE_MOVE_HELPER ?? resolve(import.meta.dirname, '../resources/bin/agentmux-workspace-move')
// Names only, through the same pinned-cwd READY contract; no Explorer observer/tree owner.
const FILE_NAME_WORKER_SOURCE = String.raw`
import { lstat, realpath, stat } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { sep } from 'node:path'
${LOCAL_FILE_LIST_SOURCE}
const request = JSON.parse(process.argv[1]), root = process.argv[2]
async function current() { const path = await realpath('.'); if (path !== root && !path.startsWith(root + sep)) throw Error('Path escapes the workspace root') }
try {
 await current(); process.stderr.write('AGENTMUX_WORKSPACE_READY\n')
 for await (const _chunk of process.stdin) {}
 await current(); process.stdout.write(JSON.stringify(await listFileNames(request.limit)))
} catch(error) { process.stderr.write('AGENTMUX_WORKSPACE_ERROR:' + JSON.stringify({message: error instanceof Error ? error.message : String(error), code: error?.code ?? null}) + '\n'); process.exitCode = 1 }
`

export function fileBytesAreBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12))
  if (head.toString('ascii', 0, 5) === '%PDF-' || head.toString('ascii', 0, 6) === 'GIF87a' ||
      head.toString('ascii', 0, 6) === 'GIF89a' || head.toString('ascii', 0, 3) === 'ID3' ||
      head.toString('ascii', 0, 4) === 'fLaC' ||
      (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) ||
      (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) ||
      (head[0] === 0x1f && head[1] === 0x8b) ||
      (head.toString('ascii', 0, 4) === 'RIFF' && ['WEBP', 'WAVE', 'AVI '].includes(head.toString('ascii', 8, 12)))) return true
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false } catch { return true }
}

export function localPathWithin(root: string, requested: string): string {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, requested)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('Path escapes the workspace root')
  }
  return target
}


export function assertRealPathWithin(root: string, target: string, separator: string): void {
  if (target !== root && !target.startsWith(`${root}${separator}`)) {
    throw new Error('Path escapes the workspace root')
  }
}

export function assertMutableRelativePath(requested: string): void {
  if (!requested.trim() || requested === '.' || requested === '/') {
    throw new Error('The workspace root cannot be changed')
  }
}


export async function localFileScope(owner: string | FileWorkspace, requested: string): Promise<{ root: string; requested: string }> {
  const root = typeof owner === 'string' ? owner : owner.path
  const lexical = localPathWithin(root, requested)
  if (typeof owner === 'string' || owner.id !== SCRATCH_WORKSPACE_ID || owner.hostId !== 'local') return { root, requested }
  const parts = relative(resolve(root), lexical).split(sep)
  const id = scratchTopicIdFromDirectoryName(parts[0]!)
  if (!id) return { root, requested }
  const directory = await resolveScratchTopicDirectory(root, id)
  if (!directory) throw Object.assign(new Error('This Topic directory is unavailable. Refresh its files before retrying.'), { code: 'ENOENT' })
  return { root: dirname(directory), requested: [basename(directory), ...parts.slice(1)].join(sep) }
}

export async function localExistingPathWithin(owner: string | FileWorkspace, requestedPath: string): Promise<LocalExistingPath> {
  const { root, requested } = await localFileScope(owner, requestedPath)
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexicalTarget)])
  assertRealPathWithin(realRoot, realTarget, sep)
  return { root: realRoot, target: realTarget }
}

// Explorer follows explicit links for reads only. Mutations retain real-root confinement.
// Resolve each lexical ancestor to detect directory cycles before adding another expandable level.
export async function localReadablePath(owner: string | FileWorkspace, requestedPath: string): Promise<LocalExistingPath> {
  const { root, requested } = await localFileScope(owner, requestedPath)
  const lexical = localPathWithin(root, requested)
  const realRoot = await realpath(root)
  const seen = new Set([realRoot])
  let cursor = resolve(root)
  let target = realRoot
  for (const part of lexical.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    target = await realpath(cursor)
    if (seen.has(target)) throw new Error('Directory link cycle: this folder is already an ancestor')
    seen.add(target)
  }
  // The worker pins the already resolved read location. No write operation uses this boundary.
  return { target, root: target === realRoot || target.startsWith(realRoot + sep) ? realRoot : (await stat(target)).isDirectory() ? target : dirname(target) }
}


export async function localMutablePathWithin(owner: string | FileWorkspace, requestedPath: string): Promise<LocalMutablePath> {
  const { root, requested } = await localFileScope(owner, requestedPath)
  assertMutableRelativePath(requested)
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(lexicalTarget))])
  assertRealPathWithin(realRoot, realParent, sep)
  return { root: realRoot, parent: realParent, name: basename(lexicalTarget) }
}

export function revisionFor(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function resultError(error: unknown): { status: 'error'; code: string; message: string } {
  return {
    status: 'error',
    code: typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'WORKSPACE_FILE_ERROR',
    message: error instanceof Error ? error.message : String(error)
  }
}

export class WorkspaceFileWriteScope {
  readonly requests = new Map<string, Promise<void>>()
  readonly paths = new Map<string, Promise<void>>()
  async serialize<T>(
    tails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.catch(() => {}).then(async () => await current)
    tails.set(key, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }

}
/** The original confined local ordinary IO. Its embedding qualifies the exact owning Host. */
export class OrdinaryWorkspaceFiles {
  constructor(private readonly options: OrdinaryWorkspaceFilesOptions = {}, readonly scope = new WorkspaceFileWriteScope()) {}
  private run(cwd: string, root: string, request: WorkspaceFileWorkerRequest, input?: string | Uint8Array, signal?: AbortSignal) {
    return runWorkspaceFileWorker(cwd, root, request, { helperPath: this.options.helperPath ?? helperPath, workerSource: FILE_NAME_WORKER_SOURCE }, input, signal)
  }
  async read(workspace: FileWorkspace, requestedPath: string, budget?: WorkspaceFileReadBudget): Promise<FileDocumentReadResult> {
    budget?.signal?.throwIfAborted()
    if (budget && (!Number.isSafeInteger(budget.maxFileBytes) || budget.maxFileBytes < 1 || budget.maxFileBytes > WORKSPACE_FILE_MAX_BYTES)) {
      throw new Error('A bounded original file read requires a byte cap inside the existing transfer budget.')
    }
    try {
      const resolved = await localReadablePath(workspace, requestedPath)
      // A directory is not a read failure: the caller reveals it in the file tree. Only Main can
      // tell — path detection in the Renderer is pure-string. `resolved.target` is already the
      // root-confined realpath, so this stat classifies exactly the object the worker would open.
      if ((await stat(resolved.target)).isDirectory()) return { status: 'directory' }
      const snapshot = budget ? await this.readByteRange(workspace, requestedPath, {
        offset: 0, maxBytes: budget.maxFileBytes, maxFileBytes: budget.maxFileBytes, ...(budget.signal ? { signal: budget.signal } : {})
      }) : null
      if (snapshot) budget?.onReadCost?.(snapshot.readCost)
      const bytes = snapshot ? Buffer.from(snapshot.bytes) : await this.run(dirname(resolved.target), resolved.root, {
        action: 'read',
        name: basename(resolved.target)
      })
      if (fileBytesAreBinary(bytes)) {
        return { status: 'binary', path: requestedPath, revision: snapshot?.revision ?? revisionFor(bytes), byteLength: bytes.byteLength }
      }
      return {
        status: 'read',
        document: {
          path: requestedPath,
          content: budget ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString('utf8'),
          revision: snapshot?.revision ?? revisionFor(bytes)
        }
      }
    } catch (error) {
      if (budget) {
        const readCost = (error as { readCost?: WorkspaceFileByteRead['readCost'] }).readCost
        if (readCost) budget.onReadCost?.(readCost)
        budget.signal?.throwIfAborted()
      }
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return { status: 'deleted' }
      }
      return resultError(error)
    }
  }

  async deleteExact(workspace: FileWorkspace, input: {
    path: string; expectedRevision: string; witness: NoteFileWitness; operationId: string
  }): Promise<WorkspaceFileDeleteExactResult> {
    if (!/^sha256:[a-f0-9]{64}$/.test(input.expectedRevision) || !input.operationId ||
        /[\0\r\n]/u.test(input.operationId) || !input.witness ||
        !['device', 'inode', 'size', 'ctimeNs', 'mtimeNs'].every(key => {
          const value = input.witness[key as keyof NoteFileWitness]
          return typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n
        })) return { status: 'error', code: 'WORKSPACE_FILE_INVALID_REQUEST', message: 'Exact deletion requires the original revision, creation generation and operation.' }
    const requestKey = `${workspace.hostId}\0${workspace.path}\0${input.path}`
    return await this.scope.serialize(this.scope.requests, requestKey, async () => {
      try {
        if (this.options.hostFor && this.options.hostFor(workspace.hostId).kind !== 'local') return {
          status: 'error', code: 'REMOTE_WORKSPACE_FILE_DELETE_EXACT_UNSUPPORTED', message: 'Exact regular-file collection is unavailable on this remote Host.'
        }
        const resolved = await localMutablePathWithin(workspace, input.path)
        const key = `${resolved.root}\0${resolved.parent}\0${resolved.name}`
        return await this.scope.serialize(this.scope.paths, key, async () => {
          const token = createHash('sha256').update(JSON.stringify([requestKey, input.operationId])).digest('hex')
          const claim = `.agentmux-reclaim-${token}.note.md`
          const before = this.options.beforeLocalDeleteClaim, after = this.options.afterLocalDeleteClaim
          try {
            const result = JSON.parse((await runWorkspaceFileWorker(resolved.parent, resolved.root, {
              action: 'delete-exact', name: resolved.name, expectedRevision: input.expectedRevision, witness: input.witness, claim,
              fault: [before ? 'before-claim' : '', after ? 'after-claim' : '', this.options.localDeleteFault ?? ''].join(',')
            }, { helperPath: this.options.helperPath ?? helperPath, workerSource: FILE_NAME_WORKER_SOURCE }, undefined, undefined, before || after ? { ...(before ? { before } : {}), ...(after ? { after } : {}) } : undefined)).toString('utf8')) as WorkspaceFileDeleteExactResult
            return result
          } catch (error) {
            const detail = resultError(error), extra = error as { writeOutcomeUnknown?: boolean; retainedPath?: string }
            return { ...detail, ...(extra.writeOutcomeUnknown ? { status: 'unknown' as const } : {}),
              ...(extra.retainedPath ? { retainedPath: extra.retainedPath } : extra.writeOutcomeUnknown ? {
                // A recovery candidate, never evidence that the claim exists or that deletion applied.
                retainedPath: posix.join(posix.dirname(input.path), claim)
              } : {}) }
          }
        })
      } catch (error) { return resultError(error) }
    })
  }

  async readDirectory(workspace: FileWorkspace, requestedPath: string): Promise<WorkspaceDirectoryEntry[]> {
    const directory = await localReadablePath(workspace, requestedPath || '.')
    const entries = JSON.parse((await this.run(directory.target, directory.root, { action: 'list' })).toString('utf8')) as WorkspaceDirectoryEntry[]
    let mapped = entries.map(entry => ({ ...entry, path: posix.join(requestedPath || '.', entry.name) }))
    if (workspace.id === SCRATCH_WORKSPACE_ID && workspace.hostId === 'local' && (!requestedPath || requestedPath === '.')) {
      const ids = await scratchStorageTopicIds(workspace.path)
      const topics = await Promise.all(ids.map(async id => {
        await resolveScratchTopicDirectory(workspace.path, id)
        const name = scratchTopicDirectoryName(id)
        return { name, path: name, isDirectory: true, isSymlink: false }
      }))
      mapped = [...mapped.filter(entry => !scratchTopicIdFromDirectoryName(entry.name)), ...topics]
    }
    return mapped.sort((a, b) => a.isDirectory !== b.isDirectory ? a.isDirectory ? -1 : 1 : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  }

  async listFiles(workspace: FileWorkspace, requestedPath = '.', limit = 20000, options?: { signal?: AbortSignal }): Promise<FileNameListing> {
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw new Error('File discovery limit must be between 1 and 20000')
    const directory = await localReadablePath(workspace, requestedPath)
    return JSON.parse((await this.run(directory.target, directory.root, { action: 'list-files', limit }, undefined, options?.signal)).toString('utf8')) as FileNameListing
  }

  async write(
    workspace: FileWorkspace,
    input: OrdinaryFileWriteInput
  ): Promise<OrdinaryFileWriteResult> {
    return await this.writeContent(workspace, { ...input, ...(input.expectedRevision === null ? { exclusive: true } : {}) }, () => this.options.beforeWrite?.(input))
  }

  /** Publish a new binary file through the same atomic, root-confined owner as editor saves. */
  async writeBytes(workspace: FileWorkspace, input: { path: string; bytes: Uint8Array }): Promise<OrdinaryFileWriteResult> {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > WORKSPACE_FILE_MAX_BYTES) {
      return { status: 'error', code: 'WORKSPACE_FILE_BYTE_LIMIT', message: 'Workspace file exceeds the byte transfer budget.' }
    }
    return await this.writeContent(workspace, { path: input.path, content: Buffer.from(input.bytes), expectedRevision: null, exclusive: true })
  }

  async readBytes(workspace: FileWorkspace, requestedPath: string, options: WorkspaceFileByteReadOptions = {}): Promise<WorkspaceFileByteRead> {
    const offset = options.offset ?? 0, maxBytes = options.maxBytes ?? WORKSPACE_FILE_MAX_READ_BYTES
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WORKSPACE_FILE_MAX_READ_BYTES) {
      throw new Error(`Byte reads require an integer offset and maxBytes from 1 to ${WORKSPACE_FILE_MAX_READ_BYTES}.`)
    }
    return await this.readByteRange(workspace, requestedPath, { ...options, offset, maxBytes })
  }

  async readByteRange(workspace: FileWorkspace, requestedPath: string, options: WorkspaceFileByteReadOptions & { offset: number; maxBytes: number; maxFileBytes?: number; signal?: AbortSignal }): Promise<WorkspaceFileByteRead> {
    const { offset, maxBytes } = options
    const resolved = await localExistingPathWithin(workspace, requestedPath)
    const document = JSON.parse((await this.run(dirname(resolved.target), resolved.root, {
      action: 'read-bytes', name: basename(resolved.target), offset, maxBytes, maxFileBytes: options.maxFileBytes ?? WORKSPACE_FILE_MAX_BYTES,
      ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {})
    }, undefined, options.signal)).toString('utf8')) as Omit<WorkspaceFileByteRead, 'bytes'> & { data: string }
    const { data, ...result } = document
    return { ...result, bytes: Buffer.from(data, 'base64') }
  }

  async writeContent(
    workspace: FileWorkspace,
    input: { path: string; content: string | Uint8Array; expectedRevision: string | null; exclusive?: true },
    beforeWrite?: () => void | Promise<void>
  ): Promise<OrdinaryFileWriteResult> {
    const requestKey = `${workspace.hostId}\0${workspace.path}\0${input.path}`
    return await this.scope.serialize(this.scope.requests, requestKey, async () => {
      try {
        if (this.options.hostFor && this.options.hostFor(workspace.hostId).kind !== 'local') return {
          status: 'error', code: 'REMOTE_WORKSPACE_FILE_WRITE_UNSUPPORTED', message: 'Revision-aware atomic save is not available for remote workspaces.'
        }
        const resolved = await localMutablePathWithin(workspace, input.path)
        const key = `${resolved.root}\0${resolved.parent}\0${resolved.name}`
        return await this.scope.serialize(this.scope.paths, key, async () => {
          try {
            await beforeWrite?.()
            const fault = typeof this.options.localWriteFault === 'function'
              ? this.options.localWriteFault()
              : this.options.localWriteFault
            return JSON.parse((await this.run(resolved.parent, resolved.root, {
              action: 'write',
              name: resolved.name,
              expectedRevision: input.expectedRevision,
              ...(input.exclusive ? { exclusive: true as const } : {}),
              ...(typeof input.content === 'string' ? { textOnly: true as const } : {}),
              ...(fault ? { fault } : {})
            }, input.content)).toString('utf8')) as OrdinaryFileWriteResult
          } catch (error) {
            const detail = resultError(error)
            return typeof error === 'object' && error !== null && 'writeOutcomeUnknown' in error && error.writeOutcomeUnknown === true
              ? { ...detail, status: 'unknown' } : detail
          }
        })
      } catch (error) {
        return resultError(error)
      }
    })
  }

}
