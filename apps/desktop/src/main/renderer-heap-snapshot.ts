import type { WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, DurableWriteError, durableWriteFile } from '@agentmux/core'
import { agentMuxControlTimeoutMs, sameRendererV8ProfileTarget, parseRendererHeapSnapshotInput,
  parseRendererHeapSnapshotInspectInput, parseRendererHeapSnapshotCapture, parseRendererHeapSnapshotResult,
  parseRendererHeapSnapshotInspection, type RendererHeapSnapshotInput, type RendererHeapSnapshotInspectInput,
  type RendererHeapSnapshotCapture, type RendererHeapSnapshotResult, type RendererHeapSnapshotInspection,
  type RendererHeapSnapshotHost, type RendererHeapSnapshotArtifact, type RendererV8ProfileTarget,
  type RendererV8ProfileIssue } from '@agentmux/core/control'

export type RendererHeapSnapshotDependencies = { contents: WebContents; currentTarget(): RendererV8ProfileTarget | null; host(): RendererHeapSnapshotHost }
const issue = (stage: string, error: unknown): RendererV8ProfileIssue => {
  const cause = error instanceof Error ? error as Error & { code?: string } : null
  const message = cause?.message ?? String(error)
  return { stage, code: typeof cause?.code === 'string' ? cause.code.slice(0, 128) : 'CONTROL_FAILED',
    message: message.slice(0, 2048), messageTruncated: message.length > 2048 }
}
const failure = (message: string, code = 'CONTROL_UNAVAILABLE') => new AgentMuxError(message, code)
const copy = <T>(value: T): T => structuredClone(value)

/** Native file material and small receipts only. No parsed heap, debugger session or Window registry. */
export class RendererHeapSnapshotOwner {
  private active: RendererHeapSnapshotCapture | null = null
  private last: RendererHeapSnapshotCapture | null = null
  private publication: { result: RendererHeapSnapshotResult; previous: RendererHeapSnapshotCapture | null; incompatible: boolean; recovered?: boolean } | null = null
  private disposed = false
  constructor(private readonly directory: string, private readonly write = durableWriteFile) {}

  dispose(): void { this.disposed = true }
  isCapturing(): boolean { return this.active !== null }
  assertDebuggerAvailable(): void {
    if (this.active) throw failure('The original native heap snapshot is still in flight. Inspect that capture; no debugger capture was started.', 'CONTROL_OWNER_BUSY')
  }
  private path(id: string): string { return join(this.directory, `${id}.heapsnapshot`) }
  private async readEnvelope(name: 'latest.json' | 'pending.json'): Promise<unknown | null> {
    let file
    try {
      file = await open(join(this.directory, name), 'r')
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 128 * 1024) throw failure('Heap snapshot metadata is not a bounded regular file.', 'CONTROL_PROTOCOL_ERROR')
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length !== stat.size) throw failure('Heap snapshot metadata changed while being read.', 'CONTROL_PROTOCOL_ERROR')
      return JSON.parse(bytes.subarray(0, length).toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    } finally { await file?.close() }
  }
  private async metadata(): Promise<RendererHeapSnapshotCapture | null> {
    const raw = await this.readEnvelope('latest.json')
    return raw === null ? null : parseRendererHeapSnapshotCapture(raw)
  }
  private async removePending(): Promise<void> {
    try { await unlink(join(this.directory, 'pending.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  private async writePending(capture: RendererHeapSnapshotCapture, previous: RendererHeapSnapshotCapture | null, incompatible: boolean): Promise<void> {
    parseRendererHeapSnapshotCapture(capture)
    await this.write(join(this.directory, 'pending.json'), JSON.stringify({ capture, previous, incompatible }), { mode: 0o600, requireDirectorySync: true })
  }
  private async recoverPending(): Promise<void> {
    if (this.active || this.publication) return
    const raw = await this.readEnvelope('pending.json')
    if (raw === null) return
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 3 ||
      !['capture', 'previous', 'incompatible'].every(key => Object.hasOwn(raw, key)))
      throw failure('Original pending heap envelope is incompatible; existing bytes are preserved.', 'CONTROL_PROTOCOL_ERROR')
    const envelope = raw as { capture: unknown; previous: unknown; incompatible: unknown }
    if (typeof envelope.incompatible !== 'boolean') throw failure('Original pending heap envelope is incompatible.', 'CONTROL_PROTOCOL_ERROR')
    const capture = copy(parseRendererHeapSnapshotCapture(envelope.capture))
    const previous = envelope.previous === null ? null : parseRendererHeapSnapshotCapture(envelope.previous)
    // Only acknowledged facts from the original durable envelope survive. A file
    // that merely exists cannot manufacture the missing native completion ACK.
    if (!capture.artifact) {
      try {
        const actual = await this.fingerprint(this.path(capture.captureId))
        capture.artifact = { kind: 'renderer-heap-snapshot', captureId: capture.captureId, host: copy(capture.host),
          format: 'v8-heapsnapshot', path: this.path(capture.captureId), ...actual }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') capture.issues.push(issue('recover-file', error))
      }
    }
    this.last = capture
    this.publication = { result: { capture: copy(capture), persistence: { status: 'unknown', phase: null,
      issue: issue('recover', failure('The original owner ended without a publication acknowledgement. Inspect/export this capture; native completion is not inferred from file bytes.')) } },
      previous, incompatible: envelope.incompatible, recovered: true }
  }
  private async releaseExportedPending(captureId: string): Promise<void> {
    if (this.publication?.result.capture.captureId !== captureId) return
    let latest: RendererHeapSnapshotCapture | null = null
    try { latest = await this.metadata() } catch { /* Preserve incompatible latest bytes. */ }
    if (latest?.captureId !== captureId) {
      try { await unlink(this.path(captureId)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await this.removePending()
    this.publication = null
    if (this.last?.captureId === captureId && latest?.captureId !== captureId) this.last = null
  }
  private async fingerprint(path: string, signal?: AbortSignal, sync = false): Promise<{ byteLength: number; sha256: string }> {
    if (!(await lstat(path)).isFile()) throw failure('Original heap material is not a regular file.', 'CONTROL_PROTOCOL_ERROR')
    const file = await open(path, sync ? 'r+' : 'r')
    try {
      const before = await file.stat({ bigint: true }), hash = createHash('sha256'), bytes = Buffer.alloc(65536)
      let length = 0
      while (true) {
        signal?.throwIfAborted()
        const read = await file.read(bytes, 0, bytes.length, null)
        if (!read.bytesRead) break
        hash.update(bytes.subarray(0, read.bytesRead)); length += read.bytesRead
      }
      const after = await file.stat({ bigint: true })
      if (!length || !Number.isSafeInteger(length) || BigInt(length) !== before.size ||
        ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) {
        throw failure('Original heap material changed or is incomplete.', 'CONTROL_PROTOCOL_ERROR')
      }
      if (sync) await file.sync()
      return { byteLength: length, sha256: hash.digest('hex') }
    } finally { await file.close() }
  }
  private pending(): RendererHeapSnapshotCapture {
    const capture = copy(this.active!)
    capture.status = 'unknown'; capture.timing.finishedAt = Date.now()
    const message = capture.native.settled ? 'The native step settled; original file verification/publication is still in flight.'
      : capture.native.requested ? 'The original native heap capture has not settled.' : 'The original private file is being prepared; native collection has not been requested.'
    capture.issues = [issue('observe', failure(message + ' No second capture was started.', 'HEAP_SNAPSHOT_PENDING'))]
    return capture
  }
  private async retire(previous: RendererHeapSnapshotCapture | null, currentId: string): Promise<void> {
    if (!previous?.artifact || previous.captureId === currentId || previous.artifact.path !== this.path(previous.captureId)) return
    try { await unlink(previous.artifact.path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  private async publish(capture: RendererHeapSnapshotCapture, previous: RendererHeapSnapshotCapture | null, incompatible?: unknown): Promise<RendererHeapSnapshotResult> {
    let replaced = false, publishingLatest = false
    let persistence: RendererHeapSnapshotResult['persistence']
    try {
      await this.writePending(capture, previous, !!incompatible)
      if (incompatible) throw incompatible
      publishingLatest = true
      await this.write(join(this.directory, 'latest.json'), JSON.stringify(capture), { mode: 0o600, requireDirectorySync: true })
      replaced = true
      await this.retire(previous, capture.captureId)
      await this.removePending()
      persistence = { status: 'confirmed', phase: null, issue: null }
      this.publication = null
    } catch (error) {
      const after = replaced || publishingLatest && error instanceof DurableWriteError && error.phase === 'after-replace'
      persistence = { status: after ? 'unknown' : 'failed', phase: after ? 'after-replace' : 'before-replace', issue: issue('save', error) }
    }
    const result = parseRendererHeapSnapshotResult({ capture: copy(capture), persistence })
    if (persistence.status !== 'confirmed') this.publication = { result: copy(result), previous, incompatible: !!incompatible }
    return result
  }
  async inspect(raw: RendererHeapSnapshotInspectInput, signal?: AbortSignal): Promise<RendererHeapSnapshotInspection> {
    const input = parseRendererHeapSnapshotInspectInput(raw)
    signal?.throwIfAborted()
    try {
      await this.recoverPending()
      const capture = this.active && (!input.captureId || input.captureId === this.active.captureId) ? this.pending()
        : this.last && (!input.captureId || input.captureId === this.last.captureId) ? copy(this.last) : await this.metadata()
      if (!capture) return { status: 'absent', capture: null, issue: null }
      if (input.captureId && input.captureId !== capture.captureId)
        return { status: 'mismatch', capture: null, issue: issue('inspect', failure('Original captureId is not retained. No capture was started.', 'HEAP_SNAPSHOT_NOT_RETAINED')) }
      if (capture.artifact) {
        if (capture.artifact.path !== this.path(capture.captureId)) throw failure('Heap material does not belong to this original owner.', 'CONTROL_PROTOCOL_ERROR')
        const actual = await this.fingerprint(capture.artifact.path, signal)
        if (actual.byteLength !== capture.artifact.byteLength || actual.sha256 !== capture.artifact.sha256)
          throw failure('Original heap artifact integrity is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
      }
      const publication = this.publication
      if (publication?.result.capture.captureId === capture.captureId && !publication.incompatible &&
        (publication.result.persistence.phase === 'after-replace' || publication.recovered)) {
        const actual = await this.metadata()
        if (isDeepStrictEqual(actual, publication.result.capture)) {
          await this.retire(publication.previous, capture.captureId)
          await this.removePending()
          this.publication = null
        }
      }
      return parseRendererHeapSnapshotInspection({ status: 'available', capture, issue: null }, input)
    } catch (error) {
      return { status: 'unavailable', capture: null, issue: issue('inspect', error) }
    }
  }
  async capture(raw: RendererHeapSnapshotInput, deps: RendererHeapSnapshotDependencies, signal?: AbortSignal): Promise<RendererHeapSnapshotResult> {
    const input = copy(parseRendererHeapSnapshotInput(raw))
    signal?.throwIfAborted()
    if (this.disposed) throw failure('The original heap snapshot owner ended.')
    await this.recoverPending()
    this.assertDebuggerAvailable()
    if (this.publication) {
      const publication = this.publication, original = publication.result.capture
      if (original.captureId !== input.captureId)
        throw failure('The original heap file has an unconfirmed publication. Inspect its captureId or explicitly retry saving that same receipt; no new capture was started.', 'CONTROL_OWNER_BUSY')
      if (!sameRendererV8ProfileTarget(original.target, input.target))
        throw failure('This captureId belongs to another original Renderer target.', 'CONTROL_REQUEST_CONFLICT')
      if (publication.result.persistence.phase !== 'before-replace' || publication.incompatible || original.status !== 'completed')
        return copy(publication.result)
      // Explicit same-ID recovery retries only a known before-replace metadata failure.
      // It never calls native V8 again or rewrites the original capture timestamps.
      this.active = original
      try {
        const actual = await this.fingerprint(this.path(input.captureId), signal)
        if (!original.artifact || actual.sha256 !== original.artifact.sha256 || actual.byteLength !== original.artifact.byteLength)
          throw failure('Original heap file integrity is unconfirmed. Publication was not retried.', 'CONTROL_PROTOCOL_ERROR')
        return await this.publish(original, publication.previous)
      } finally { this.active = null }
    }
    if (this.last?.captureId === input.captureId)
      throw failure('This captureId already has an original result. Inspect it instead of collecting again.', 'CONTROL_REQUEST_CONFLICT')
    const verify = () => {
      const current = deps.currentTarget()
      if (deps.contents.isDestroyed() || !current || !sameRendererV8ProfileTarget(current, input.target))
        throw failure('The exact Renderer heap target is no longer current. Existing work remains available.', 'CONTROL_OWNER_LOST')
    }
    verify()
    const contents = deps.contents
    if (contents.isDevToolsOpened() || contents.debugger.isAttached())
      throw failure('The original Renderer debugger is already owned. Only this heap request was refused.')
    const capture: RendererHeapSnapshotCapture = { ...input, schema: 'agentmux.renderer-heap-snapshot.v1', scope: 'renderer-v8-isolate',
      host: copy(deps.host()), status: 'unknown', timing: { requestedAt: Date.now(), nativeRequestedAt: null, nativeSettledAt: null, finishedAt: Date.now() },
      native: { requested: false, settled: false, succeeded: null }, sourceVerified: { before: true, after: false }, artifact: null, issues: [] }
    this.active = capture
    let sourceChanged = false
    const changed = () => { sourceChanged = true }
    const navigation = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (event.isMainFrame && !event.isSameDocument) sourceChanged = true
    }
    contents.on('destroyed', changed); contents.on('render-process-gone', changed); contents.on('did-start-navigation', navigation)
    const job = (async (): Promise<RendererHeapSnapshotResult> => {
      let stage = 'prepare', created = false, admitted = false
      let previous: RendererHeapSnapshotCapture | null = null
      let previousError: unknown
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        // An incompatible old envelope must not suppress a legitimate native query
        // or be silently replaced. Capture may proceed, while publication preserves it.
        try { previous = await this.metadata() } catch (error) { previousError = error }
        if (previous?.captureId === input.captureId)
          throw failure('This captureId is already retained. Inspect the original result; no native capture was started.', 'CONTROL_REQUEST_CONFLICT')
        admitted = true
        const intent = copy(capture)
        intent.native = { requested: null, settled: null, succeeded: null }
        intent.issues = [issue('recover', failure('Native request/completion observations were not durably recorded. File bytes alone do not prove collection completed.', 'HEAP_NATIVE_UNCONFIRMED'))]
        stage = 'pending'
        await this.writePending(intent, previous, !!previousError)
        stage = 'prepare'
        const file = await open(this.path(input.captureId), 'wx', 0o600)
        created = true; await file.close()
        signal?.throwIfAborted()
        if (this.disposed) throw failure('The original heap snapshot owner ended before native collection.')
        verify()
        if (contents.isDevToolsOpened() || contents.debugger.isAttached()) throw failure('The original debugger owner changed before native heap capture.')
        stage = 'native'
        capture.native.requested = true; capture.timing.nativeRequestedAt = Date.now()
        // This native API has no cancellation acknowledgement or heap-size ceiling. It
        // writes chunks directly to a private file; no heap string crosses Main or IPC.
        try { await contents.takeHeapSnapshot(this.path(input.captureId)); capture.native.succeeded = true }
        catch (error) { capture.native.succeeded = false; throw error }
        finally { capture.native.settled = true; capture.timing.nativeSettledAt = Date.now() }
        stage = 'file'
        const actual = await this.fingerprint(this.path(input.captureId), undefined, true)
        capture.artifact = { kind: 'renderer-heap-snapshot', captureId: input.captureId, host: copy(capture.host),
          format: 'v8-heapsnapshot', path: this.path(input.captureId), ...actual }
        stage = 'source'
        verify()
        if (sourceChanged) throw failure('Renderer identity changed during the original native heap capture.', 'CONTROL_OWNER_LOST')
        capture.sourceVerified.after = true; capture.status = 'completed'
        capture.timing.finishedAt = Date.now()
        parseRendererHeapSnapshotCapture(capture, input)
        stage = 'save'
        return await this.publish(capture, previous, previousError)
      } catch (error) {
        if (!admitted) throw error
        capture.status = sourceChanged || stage === 'source' ? 'unknown' : 'failed'
        capture.issues.push(issue(stage, error)); capture.timing.finishedAt = Date.now()
        // Only an unpublishable private staging file is removed. An actual complete
        // artifact, including one with unconfirmed target identity, remains available.
        if (created && !capture.artifact) {
          try { await unlink(this.path(input.captureId)) }
          catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
              capture.issues.push(issue('cleanup', cleanupError))
              const result = parseRendererHeapSnapshotResult({ capture: copy(capture), persistence: { status: 'failed', phase: 'before-replace',
                issue: issue('save', failure('Private staging cleanup is unconfirmed. The original captureId remains retained; no further heap file will be created.')) } })
              this.publication = { result: copy(result), previous, incompatible: true }
              try { await this.writePending(capture, previous, true) }
              catch (writeError) { capture.issues.push(issue('pending', writeError)) }
              return result
            }
          }
        }
        if (capture.artifact) return await this.publish(capture, previous, previousError)
        const result = parseRendererHeapSnapshotResult({ capture: copy(capture), persistence: { status: 'failed', phase: 'before-replace', issue: issue('save', failure('The original attempt was not published; previous retained material is preserved.')) } }, input)
        if (stage !== 'pending') {
          try { await this.writePending(capture, previous, !!previousError) }
          catch (writeError) { result.persistence.issue = issue('pending', writeError) }
        }
        this.publication = { result: copy(result), previous, incompatible: true }
        return result
      } finally {
        contents.removeListener('destroyed', changed); contents.removeListener('render-process-gone', changed); contents.removeListener('did-start-navigation', navigation)
        if (admitted) this.last = copy(capture)
        if (this.active === capture) this.active = null
      }
    })()
    // Cancelling this reader does not cancel V8. Keep the original native slot until
    // its promise really settles; late completion never mutates the returned receipt.
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    const interrupted = new Promise<RendererHeapSnapshotResult>(resolve => {
      abort = () => {
        const observed = this.active === capture ? this.pending() : copy(capture)
        observed.status = 'unknown'; observed.timing.finishedAt = Date.now()
        observed.issues = [issue('observe', signal?.reason ?? failure('Native heap completion exceeded this observation budget; collection was not cancelled.', 'CONTROL_TIMEOUT'))]
        const mayHavePublished = observed.native.settled && observed.artifact !== null
        resolve({ capture: observed, persistence: { status: mayHavePublished ? 'unknown' : 'failed', phase: mayHavePublished ? null : 'before-replace',
          issue: issue('save', failure('This reader did not observe publication. Inspect the original captureId; do not recapture.')) } })
      }
      timer = setTimeout(abort, agentMuxControlTimeoutMs('metrics.heap.capture'))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    try { return parseRendererHeapSnapshotResult(await Promise.race([job, interrupted]), input) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  async artifact(input: RendererHeapSnapshotInspectInput): Promise<RendererHeapSnapshotArtifact> {
    const result = await this.inspect(input)
    if (result.status !== 'available' || !result.capture?.artifact) throw failure('The exact original heap file is unavailable. No capture was started.')
    return result.capture.artifact
  }
  async save(input: RendererHeapSnapshotInspectInput, chooseFile: (name: string) => Promise<string | null>): Promise<{ status: 'saved'; path: string } | { status: 'cancelled' }> {
    this.assertDebuggerAvailable()
    const inspected = await this.inspect(input)
    if (inspected.status !== 'available' || !inspected.capture) throw failure('The original heap attempt is unavailable; no file action was performed.')
    const capture = inspected.capture, artifact = capture.artifact
    const path = await chooseFile(artifact ? `renderer-${capture.captureId}.heapsnapshot` : `renderer-${capture.captureId}.heap-capture.json`)
    if (path === null) return { status: 'cancelled' }
    let latest: RendererHeapSnapshotCapture | null = null
    try { latest = await this.metadata() } catch { /* Preserve unreadable latest bytes. */ }
    const protectedPaths = [join(this.directory, 'pending.json'), join(this.directory, 'latest.json'), this.path(capture.captureId),
      ...(latest ? [this.path(latest.captureId)] : []), ...(this.publication?.previous ? [this.path(this.publication.previous.captureId)] : [])]
    if (protectedPaths.some(original => resolve(original) === resolve(path)))
      throw failure('Choose a different export destination. Original heap metadata and retained material must remain intact.', 'INVALID_CONTROL_REQUEST')
    if (!artifact) {
      await this.write(path, JSON.stringify(capture), { mode: 0o600, requireDirectorySync: true })
      await this.releaseExportedPending(capture.captureId)
      return { status: 'saved', path }
    }
    const temporary = join(dirname(path), `.amux-heap-${randomUUID()}.tmp`)
    try {
      await copyFile(artifact.path, temporary)
      const actual = await this.fingerprint(temporary, undefined, true)
      if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) throw failure('Saved bytes do not match the original heap artifact.', 'CONTROL_PROTOCOL_ERROR')
      await rename(temporary, path)
      await this.releaseExportedPending(capture.captureId)
      return { status: 'saved', path }
    } finally {
      try { await unlink(temporary) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
}
