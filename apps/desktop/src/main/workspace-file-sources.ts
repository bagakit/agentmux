import { randomBytes } from 'node:crypto'
import type { WorkspaceRecord } from '../shared/contracts'
import { WORKSPACE_FILE_SOURCE_CHUNK_BYTES, type WorkspaceFileSourceFailure, type WorkspaceFileSourceOpenResult, type WorkspaceFileSourceReadResult } from '../shared/workspace-file-source'
import type { WorkspaceFiles, WorkspaceMediaHandle, WorkspaceMediaHandleState } from './workspace-files'

type Source = {
  caller: number
  workspace: WorkspaceRecord
  file: WorkspaceMediaHandle
  released: boolean
  reads: Map<string, AbortController>
  pending: Set<Promise<void>>
}
const failure = (status: WorkspaceFileSourceFailure['status'], code: string, message: string): WorkspaceFileSourceFailure => ({ status, code, message })
const released = () => failure('released', 'WORKSPACE_FILE_SOURCE_RELEASED', 'This file source was released. Reload the original File to read it again.')
const cancelled = () => failure('cancelled', 'ABORT_ERR', 'This file read was cancelled.')
function physicalFailure(state: WorkspaceMediaHandleState): WorkspaceFileSourceFailure | null {
  if (state === 'deleted') return failure('deleted', 'ENOENT', 'This file no longer exists in the Workspace.')
  if (state === 'changed') return failure('changed', 'WORKSPACE_FILE_CHANGED_WHILE_READING', 'The file was replaced or rewritten. Reload to read the current file.')
  if (state === 'outside-workspace') return failure('outside-workspace', 'WORKSPACE_PATH_ESCAPE', 'This path now points outside the Workspace. Its bytes were not read.')
  return null
}
function readFailure(error: unknown): WorkspaceFileSourceFailure {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'WORKSPACE_FILE_SOURCE_UNAVAILABLE'
  if (code === 'ENOENT' || code === 'ENOTDIR') return failure('deleted', code, 'This file no longer exists in the Workspace.')
  if (code === 'EISDIR') return failure('directory', code, 'This path is a directory, not a file.')
  if (code === 'WORKSPACE_PATH_ESCAPE') return failure('outside-workspace', code, 'This path points outside the Workspace. Its bytes were not read.')
  if (code === 'WORKSPACE_FILE_CHANGED_WHILE_READING') return failure('changed', code, 'The file changed while it was opened. Reload to read the current file.')
  if (code === 'REMOTE_WORKSPACE_PREVIEW_UNAVAILABLE') return failure('unavailable', code, 'Random-access reading is unavailable for this remote Workspace. The original File remains available.')
  return failure('unavailable', code, error instanceof Error ? error.message : 'The original file could not be read. Reload to try again.')
}

/** One pinned, read-only source per visible consumer. No whole-file buffer or whole-file size quota. */
export class WorkspaceFileSources {
  private readonly sources = new Map<string, Source>()
  private readonly generations = new Map<number, number>()
  private readonly closing = new Set<Promise<void>>()
  private disposed = false
  constructor(private readonly files: Pick<WorkspaceFiles, 'openMediaHandle'>, private readonly workspaceFor: (id: string) => WorkspaceRecord | undefined) {}

  async open(caller: number, workspace: WorkspaceRecord, path: string): Promise<WorkspaceFileSourceOpenResult> {
    if (this.disposed) return released()
    const generation = this.generations.get(caller) ?? 0
    let file: WorkspaceMediaHandle
    try { file = await this.files.openMediaHandle(workspace, path) } catch (error) { return readFailure(error) }
    if (this.disposed || generation !== (this.generations.get(caller) ?? 0)) { await file.handle.close(); return released() }
    const source: Source = { caller, workspace: { ...workspace }, file, released: false, reads: new Map(), pending: new Set() }
    if (!this.sameWorkspace(source)) { await file.handle.close(); return failure('changed', 'WORKSPACE_RESOURCE_CHANGED', 'The Workspace resource changed. Reload the original File to read the current resource.') }
    const id = randomBytes(32).toString('base64url')
    this.sources.set(id, source)
    return { status: 'ready', id, size: file.byteLength }
  }

  async read(caller: number, id: string, readId: string, offset: number, length: number): Promise<WorkspaceFileSourceReadResult> {
    // This bounds one IPC allocation, not the original file. The client splits larger logical reads.
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > WORKSPACE_FILE_SOURCE_CHUNK_BYTES) {
      return failure('unavailable', 'INVALID_FILE_SOURCE_READ', 'A file read must name a nonnegative span of at most 1 MiB.')
    }
    const result = await this.operation(caller, id, readId, async (source, signal) => {
      const wanted = Math.min(length, Math.max(0, source.file.byteLength - offset)), bytes = new Uint8Array(wanted)
      let read = 0
      while (read < wanted) {
        const result = await source.file.handle.read(bytes, read, wanted - read, offset + read)
        if (signal.aborted) throw Object.assign(new Error('The file read was cancelled.'), { code: 'ABORT_ERR' })
        if (result.bytesRead === 0) throw Object.assign(new Error('The file ended before its original bytes were read.'), { code: 'WORKSPACE_FILE_CHANGED_WHILE_READING' })
        read += result.bytesRead
      }
      return bytes
    })
    return result.status === 'read' ? { status: 'read', bytes: result.value } : result
  }

  /** Host-only decoder port. Its child must end on signal; the original source owns fd and identity. */
  withDescriptor<T>(caller: number, id: string, operationId: string, consume: (fd: number, signal: AbortSignal) => Promise<T>): Promise<{ status: 'read'; value: T } | WorkspaceFileSourceFailure> {
    return this.operation(caller, id, operationId, (source, signal) => consume(source.file.handle.fd, signal))
  }

  private async operation<T>(caller: number, id: string, readId: string, consume: (source: Source, signal: AbortSignal) => Promise<T>): Promise<{ status: 'read'; value: T } | WorkspaceFileSourceFailure> {
    const source = this.sources.get(id)
    if (!source) return released()
    if (source.caller !== caller) return failure('unavailable', 'WORKSPACE_FILE_SOURCE_NOT_OWNED', 'This file source belongs to another Renderer.')
    if (!readId || source.reads.has(readId)) return failure('unavailable', 'INVALID_FILE_SOURCE_READ', 'A file operation must name one unique request.')
    if (!this.sameWorkspace(source)) return failure('changed', 'WORKSPACE_RESOURCE_CHANGED', 'The Workspace resource changed. Reload the original File to read the current resource.')
    const controller = new AbortController()
    source.reads.set(readId, controller)
    let settle!: () => void
    const done = new Promise<void>(resolve => { settle = resolve })
    source.pending.add(done)
    const stopped = () => source.released ? released() : controller.signal.aborted ? cancelled() : null
    try {
      let stoppedResult = stopped()
      if (stoppedResult) return stoppedResult
      let changed = physicalFailure(await source.file.current())
      if (changed) return changed
      stoppedResult = stopped()
      if (stoppedResult) return stoppedResult
      const value = await consume(source, controller.signal)
      changed = physicalFailure(await source.file.current())
      if (changed) return changed
      stoppedResult = stopped()
      return stoppedResult ?? { status: 'read', value }
    } catch (error) { return stopped() ?? readFailure(error) }
    finally { source.reads.delete(readId); source.pending.delete(done); settle() }
  }

  cancel(caller: number, id: string, readId: string): void {
    const source = this.sources.get(id)
    if (source?.caller === caller) source.reads.get(readId)?.abort()
  }
  async release(caller: number, id: string): Promise<void> {
    const source = this.sources.get(id)
    if (!source) return
    if (source.caller !== caller) throw new Error('This file source belongs to another Renderer.')
    this.sources.delete(id); source.released = true
    for (const controller of source.reads.values()) controller.abort()
    // Host decoders can borrow the descriptor. End their exact operations before closing/reusing its fd.
    const close = (async () => { await Promise.all(source.pending); await source.file.handle.close() })()
    this.closing.add(close)
    try { await close } finally { this.closing.delete(close) }
  }
  async releaseCaller(caller: number): Promise<void> {
    this.generations.set(caller, (this.generations.get(caller) ?? 0) + 1)
    await Promise.all([...this.sources].filter(([, source]) => source.caller === caller).map(([id]) => this.release(caller, id)))
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.sources].map(([id, source]) => this.release(source.caller, id)))
    await Promise.all(this.closing)
  }
  private sameWorkspace(source: Source): boolean {
    const current = this.workspaceFor(source.workspace.id)
    return current?.hostId === source.workspace.hostId && current.path === source.workspace.path
  }
}
