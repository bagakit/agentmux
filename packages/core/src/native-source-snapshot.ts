import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rm, type FileHandle } from 'node:fs/promises'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import type { BigIntStats } from 'node:fs'
import type { AgentSessionHistorySource } from './types.js'
import { AgentMuxError } from './errors.js'
import { DurableWriteError, durableWriteFile } from './durable-write.js'
import { mintObjectId } from './object-id.js'
import { cloneNativeFile, nativeDataGeneration } from './native-file-clone.js'

type Stamp = { dev: string; ino: string; birth: string; size: string; mtime: string; ctime: string }
export type NativeSnapshotContext = { directory: string; secret: string; agentSessionId: string; source: AgentSessionHistorySource; sourcePath: string }
export type NativeSnapshotManifest = { version: 1; id: string; source: Pick<NativeSnapshotContext, 'agentSessionId' | 'source'>; locator: string;
  origin: Stamp; dataGeneration?: number; file: Stamp; createdAt: number; purpose: 'scope' | 'range'; start: number; end: number; released?: true; retained?: true }
export type NativeSnapshotReceipt = { reference: string; release: string }
export type NativeSnapshotLease = { manifest: NativeSnapshotManifest; path: string; file: FileHandle; close(): Promise<void> }
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number, options?: { shared?: boolean }): boolean }
const fail = (message: string, code = 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE') => new AgentMuxError(message, code)
const stamp = (value: BigIntStats): Stamp => ({ dev: String(value.dev), ino: String(value.ino), birth: String(value.birthtimeNs), size: String(value.size), mtime: String(value.mtimeNs), ctime: String(value.ctimeNs) })
const encode = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const validStamp = (value: unknown): value is Stamp => !!value && typeof value === 'object' && ['dev', 'ino', 'birth', 'size', 'mtime', 'ctime'].every(key => typeof (value as Record<string, unknown>)[key] === 'string' && /^\d+$/u.test(String((value as Record<string, unknown>)[key])))
const same = (left: unknown, right: unknown) => encode(left) === encode(right)

/** One Core-owned byte observation. It contains no Agent lifecycle or independent
 * semantic transcript. Read references and release capabilities are separate. */
export class NativeSourceSnapshots {
  readonly directory: string
  private readonly subject: NativeSnapshotManifest['source']
  constructor(private readonly context: NativeSnapshotContext) {
    if (!isAbsolute(context.directory) || !isAbsolute(context.sourcePath) || !context.secret || !context.agentSessionId)
      throw fail('The original private snapshot owner is unavailable.')
    this.subject = { agentSessionId: context.agentSessionId, source: { ...context.source } }
    const key = createHash('sha256').update(encode(this.subject)).digest('hex')
    this.directory = join(context.directory, key)
  }
  private signature(domain: string, value: unknown): string {
    return createHmac('sha256', this.context.secret).update('agentmux-native-snapshot.v1\0' + domain + '\0' + encode(this.subject) + '\0' + encode(value)).digest('base64url')
  }
  private token(id: string, domain: 'read' | 'release'): string { return id + '.' + this.signature(domain, id) }
  private identity(reference: string, domain: 'read' | 'release'): string {
    const parts = reference.split('.')
    if (parts.length !== 2 || !/^[a-zA-Z0-9_-]{8,100}$/u.test(parts[0]!) || !/^[a-zA-Z0-9_-]{43}$/u.test(parts[1]!)) throw fail('The exact original snapshot reference is invalid.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
    const actual = Buffer.from(parts[1]!), expected = Buffer.from(this.signature(domain, parts[0]))
    if (!timingSafeEqual(actual, expected)) throw fail('The snapshot belongs to another original source or owner.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    return parts[0]!
  }
  private path(id: string): string { return join(this.directory, id) }
  private async save(manifest: NativeSnapshotManifest): Promise<void> {
    await durableWriteFile(join(this.path(manifest.id), 'manifest.json'), JSON.stringify({ value: manifest, signature: this.signature('manifest', manifest) }), { mode: 0o600, requireDirectorySync: true })
  }
  private async manifest(id: string): Promise<NativeSnapshotManifest> {
    let value: { value: NativeSnapshotManifest; signature: string }
    try { value = JSON.parse(await readFile(join(this.path(id), 'manifest.json'), 'utf8')) as typeof value }
    catch { throw fail('The retained snapshot manifest is unavailable; its original reference is retained.') }
    const m = value.value
    if (!m || m.version !== 1 || m.id !== id || !same(m.source, this.subject) || value.signature !== this.signature('manifest', m) ||
      !validStamp(m.file) || !validStamp(m.origin) || !Number.isSafeInteger(m.createdAt) || !['scope', 'range'].includes(m.purpose) || !Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.end) || m.start < 0 || m.end < m.start || m.end > Number(m.file.size))
      throw fail('The original snapshot manifest could not be verified.')
    return m
  }
  async recoveryFailure(source: FileHandle, scope: string): Promise<AgentMuxError | undefined> {
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'recovery-failure.json'), 'utf8')) as { value: { revision: 1; origin: Stamp; dataGeneration: number; scope: string; code: string; message: string }; signature: string }
      const generation = nativeDataGeneration(source), current = stamp(await source.stat({ bigint: true }))
      if (generation !== undefined && saved.signature === this.signature('recovery-failure', saved.value) && saved.value.revision === 1 && saved.value.scope === scope && saved.value.code === 'AGENT_SESSION_HISTORY_SOURCE_REPAIR_REQUIRED' && saved.value.dataGeneration === generation && ['dev', 'ino', 'birth'].every(key => Reflect.get(saved.value.origin, key) === Reflect.get(current, key))) return fail(saved.value.message, saved.value.code)
    } catch { /* A cache observation cannot remove an available source capability. */ }
    return undefined
  }
  async rememberRecoveryFailure(origin: Stamp, dataGeneration: number | undefined, scope: string, error: unknown): Promise<void> {
    if (dataGeneration === undefined || !(error instanceof AgentMuxError) || error.code !== 'AGENT_SESSION_HISTORY_SOURCE_REPAIR_REQUIRED') return
    const value = { revision: 1, origin, dataGeneration, scope, code: error.code, message: error.message }
    await durableWriteFile(join(this.directory, 'recovery-failure.json'), JSON.stringify({ value, signature: this.signature('recovery-failure', value) }))
  }
  /** Capture and seal are one custody operation. The caller derives its accepted cut
   * from this immutable file, never from the live source after capture. */
  async capture(source: FileHandle, purpose: NativeSnapshotManifest['purpose'], signal: AbortSignal,
    bounds: (snapshot: FileHandle, size: number) => Promise<{ start: number; end: number }>): Promise<NativeSnapshotReceipt> {
    signal.throwIfAborted()
    await this.collectAbandoned()
    const id = mintObjectId(), directory = this.path(id)
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700)
    await mkdir(directory, { mode: 0o700 })
    const lock = await open(join(directory, 'lease'), 'wx+', 0o600)
    let committed = false
    try {
      if (!native.tryLock(lock.fd)) throw fail('The original snapshot creation lease is unavailable.')
      const observation = await cloneNativeFile(source, directory, 'source.jsonl', signal)
      const filePath = join(directory, 'source.jsonl')
      await chmod(filePath, 0o600)
      const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      try {
        const state = await file.stat({ bigint: true })
        if (!state.isFile() || state.size > BigInt(Number.MAX_SAFE_INTEGER) || observation.dataGeneration !== undefined && state.size !== observation.origin.size) throw fail('The native clone extent differs from its qualified source.')
        const range = await bounds(file, Number(state.size))
        if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > Number(state.size)) throw fail('The immutable native range is invalid.')
        signal.throwIfAborted()
        await file.sync()
        try { await this.save({ version: 1, id, source: this.subject, locator: this.context.sourcePath, origin: { ...stamp(observation.origin), size: String(state.size) }, ...(observation.dataGeneration === undefined ? {} : { dataGeneration: observation.dataGeneration }), file: stamp(state), createdAt: Date.now(), purpose, ...range }) } catch (error) {
          // A rename with an unconfirmed directory ACK may have committed. Retain
          // this original candidate for inspection rather than inventing absence.
          if (error instanceof DurableWriteError && error.phase === 'after-replace') committed = true
          throw error
        }
        // The manifest ACK flushes its own directory. Also acknowledge each new
        // custody directory entry before exposing a cross-restart reference.
        for (const path of [this.directory, this.context.directory, dirname(this.context.directory)]) {
          const parent = await open(path, 'r'); try { await parent.sync() } finally { await parent.close() }
        }
        committed = true
      } finally { await file.close() }
      return { reference: this.token(id, 'read'), release: this.token(id, 'release') }
    } finally {
      await lock.close()
      if (!committed) await rm(directory, { recursive: true, force: true })
    }
  }
  /** Called while the producer still holds its read lease, before exposing any cut. */
  async setRangeStart(lease: NativeSnapshotLease, start: number): Promise<void> {
    if (lease.manifest.retained || lease.manifest.purpose !== 'range' || start < 0 || start > lease.manifest.end) throw fail('The original unoffered range cannot change its accepted start.')
    await this.save({ ...lease.manifest, start }); lease.manifest.start = start
  }
  async retain(lease: NativeSnapshotLease): Promise<void> {
    if (!same(lease.manifest.source, this.subject)) throw fail('The snapshot producer belongs to another owner.')
    if (!lease.manifest.retained) {
      await this.save({ ...lease.manifest, retained: true })
      lease.manifest.retained = true
    }
  }
  async open(reference: string): Promise<NativeSnapshotLease> {
    const id = this.identity(reference, 'read'), lock = await open(join(this.path(id), 'lease'), 'r+')
    let file: FileHandle | undefined
    try {
      if (!native.tryLock(lock.fd, { shared: true })) throw fail('The original snapshot is being committed or released.', 'AGENT_SESSION_HISTORY_BUSY')
      const manifest = await this.manifest(id)
      if (manifest.released) throw fail('This exact snapshot was explicitly released. Its source and Agent remain available.')
      const path = join(this.path(id), 'source.jsonl')
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      const current = await file.stat({ bigint: true })
      if (!current.isFile() || !same(stamp(current), manifest.file)) throw fail('The immutable snapshot bytes changed; its original receipt is retained.')
      const retained = file
      return { manifest, path, file: retained, close: async () => { try { await retained.close() } finally { await lock.close() } } }
    } catch (error) { try { await file?.close() } finally { await lock.close() }; throw error }
  }
  /** Release never interrupts another reader. The tombstone is durable and makes
   * an unknown response inspectable without replaying a destructive action. */
  async release(reference: string): Promise<{ released: boolean }> {
    const id = this.identity(reference, 'release'), lock = await open(join(this.path(id), 'lease'), 'r+')
    try {
      if (!native.tryLock(lock.fd)) throw fail('The original snapshot still has an active reader.', 'AGENT_SESSION_HISTORY_BUSY')
      const manifest = await this.manifest(id)
      if (!manifest.released) await this.save({ ...manifest, released: true })
      await rm(join(this.path(id), 'source.jsonl'), { force: true }); await rm(join(this.path(id), 'identities.sqlite'), { force: true })
      return { released: true }
    } finally { await lock.close() }
  }
  async releaseReadReference(reference: string): Promise<{ released: boolean }> {
    return this.release(this.token(this.identity(reference, 'read'), 'release'))
  }
  async list(after: string | undefined, limit: number): Promise<{ snapshots: { reference: string; purpose: 'scope' | 'range'; start: number; end: number; createdAt: number; released: boolean }[]; next: string | null }> {
    const afterId = after ? this.identity(after, 'read') : undefined
    let entries: string[]
    try { entries = (await readdir(this.directory)).filter(id => /^[a-zA-Z0-9_-]{8,100}$/u.test(id)).sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { snapshots: [], next: null }; throw error }
    const selected = entries.filter(id => !afterId || id > afterId).slice(0, limit), snapshots = []
    for (const id of selected) {
      try { const m = await this.manifest(id); if (!m.retained) continue; snapshots.push({ reference: this.token(id, 'read'), purpose: m.purpose, start: m.start, end: m.end, createdAt: m.createdAt, released: m.released === true }) }
      catch { /* Unsealed producers are separately owned by their kernel lease. */ }
    }
    return { snapshots, next: entries.some(id => selected.length && id > selected.at(-1)!) ? this.token(selected.at(-1)!, 'read') : null }
  }
  /** Only unpublished candidates whose kernel lease is released may be collected. */
  async collectAbandoned(): Promise<number> {
    let entries: string[]
    try { entries = await readdir(this.directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
    let collected = 0
    for (const id of entries) {
      if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(id)) continue
      try { await readFile(join(this.path(id), 'manifest.json')); if ((await this.manifest(id)).retained) continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue }
      let lock: FileHandle | undefined
      try {
        lock = await open(join(this.path(id), 'lease'), 'r+')
        if (!native.tryLock(lock.fd)) continue
        // Recheck after taking the original producer's kernel lease.
        try { await readFile(join(this.path(id), 'manifest.json')); if ((await this.manifest(id)).retained) continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue }
        await rm(this.path(id), { recursive: true, force: true }); collected++
      } catch { /* Unknown ownership or filesystem failure preserves the candidate. */ }
      finally { await lock?.close() }
    }
    return collected
  }
}
