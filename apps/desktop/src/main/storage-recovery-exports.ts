import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError, type RecoveryGap, type RecoverySource, type RecoverySourceMember, type RecoveryRestoreMember, type RecoveryPreparation, type StorageRecoveryExportsPort } from '@agentmux/core'

type Source = RecoverySource & { inspect(): Promise<string> }
type Capture = { captureId: string; revision: string; members: RecoverySourceMember[]; gaps: RecoveryGap[] }
type Prepared = { captureId: string; result: RecoveryPreparation }
type Export<T> = { directory: string | undefined; promise: Promise<T>; timer: ReturnType<typeof setTimeout> | undefined; fingerprint?: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const validId = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value)

/** Ephemeral exact-owner exports; restoration always returns to the original data owner. */
export class DesktopStorageRecoveryExports implements StorageRecoveryExportsPort {
  private readonly exports = new Map<string, Export<Capture>>()
  private readonly preparations = new Map<string, Export<Prepared>>()
  private disposed = false
  constructor(private readonly directory: string, private readonly sources: () => readonly Source[]) {}

  async inspect(): Promise<{ revision: string }> {
    const values = await Promise.all(this.sources().map(async source => [source.id, await source.inspect()]))
    return { revision: digest(JSON.stringify(values)) }
  }

  capture(captureId: string): Promise<Capture> {
    if (!validId(captureId) || this.disposed) return Promise.reject(new AgentMuxError('The original local Desktop source export is unavailable.', 'STORAGE_RECOVERY_UNAVAILABLE'))
    const previous = this.exports.get(captureId)
    if (previous) return previous.promise
    if (this.preparations.has(captureId) || this.exports.size + this.preparations.size >= 4) return Promise.reject(new AgentMuxError('Original Desktop source exports still await release. Keep their capture IDs and retry.', 'STORAGE_RECOVERY_EXPORT_BUSY'))
    const entry: Export<Capture> = { directory: undefined, timer: undefined, promise: undefined! }
    entry.promise = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      if (!(await lstat(this.directory)).isDirectory()) throw new AgentMuxError('The private Desktop source export directory is unconfirmed.', 'STORAGE_RECOVERY_EXPORT_UNSAFE')
      await chmod(this.directory, 0o700)
      entry.directory = await mkdtemp(join(this.directory, 'capture-'))
      return { captureId, ...await this.captureSources(entry.directory) }
    })()
    this.exports.set(captureId, entry)
    // A lost consumer/release cannot accumulate private copies indefinitely.
    // Expiration only invalidates this read export, never original user bytes.
    void entry.promise.then(() => {
      if (this.disposed || this.exports.get(captureId) !== entry) return
      entry.timer = setTimeout(() => { void this.release(captureId).catch(() => {}) }, 5 * 60_000)
      entry.timer.unref?.()
    }, () => { void this.release(captureId).catch(() => {}) })
    return entry.promise
  }

  private async captureSources(directory: string) {
    const before = await this.inspect()
      const members: RecoverySourceMember[] = [], gaps: RecoveryGap[] = []
      await Promise.all(this.sources().map(async source => {
        const output = join(directory, digest(source.id))
        await mkdir(output, { mode: 0o700 })
        try {
          const cut = await source.capture(output)
          members.push(...cut.members.map(member => ({ ...member, id: source.id + '/' + member.id })))
          gaps.push(...cut.gaps)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code
          gaps.push({ sourceId: source.id, code: typeof code === 'string' && /^[A-Z_0-9-]{1,100}$/u.test(code) ? code : 'RECOVERY_SOURCE_UNAVAILABLE' })
        }
      }))
      if ((await this.inspect()).revision !== before.revision) gaps.push({ sourceId: 'desktop.workbench', code: 'RECOVERY_SOURCE_CHANGED' })
      // The pre-cut revision ensures a concurrent later edit is still detected
      // by inspect; it must never be marked as covered by this older export.
      return { revision: before.revision, members: members.sort((a, b) => a.id.localeCompare(b.id)), gaps }
  }

  /** The same three original data owners, usable before UI/default initialization. */
  recoverySource(): RecoverySource {
    return { id: 'desktop.workbench', ownedPaths: this.sources().flatMap(source => source.ownedPaths ?? []),
      capture: async directory => {
        const cut = await this.captureSources(directory)
        return { ...cut, gaps: cut.gaps.map(gap => gap.sourceId === 'desktop.workbench' ? gap : {
          sourceId: 'desktop.workbench', memberId: gap.sourceId + '/' + (gap.memberId ?? ''), code: gap.code }) }
      },
      prepareRestore: (members, directory) => this.prepareSources(members, directory), restoreMissing: member => this.restore(member) }
  }

  private async prepareSources(members: RecoveryRestoreMember[], directory: string): Promise<RecoveryPreparation> {
    const result: RecoveryRestoreMember[] = [], selectors: Extract<RecoveryPreparation, { state: 'unavailable' }>['selectors'] = []
    const sources = this.sources(), claimed = new Set<string>()
    for (const source of sources) {
      const selected = members.filter(member => member.id.startsWith(source.id + '/'))
      if (!selected.length) continue
      for (const member of selected) claimed.add(member.id)
      if (!source.prepareRestore) { selectors.push(...selected.map(member => ({ memberId: member.id, reason: 'DESKTOP_RECOVERY_OWNER_UNAVAILABLE' }))); continue }
      const output = join(directory, digest(source.id)); await mkdir(output, { recursive: true, mode: 0o700 })
      const prepared = await source.prepareRestore(selected.map(member => ({ ...member, id: member.id.slice(source.id.length + 1) })), output)
      if (prepared.state === 'unavailable') selectors.push(...prepared.selectors.map(selector => ({ ...selector, ...(selector.memberId === undefined ? {} : { memberId: source.id + '/' + selector.memberId }) })))
      else result.push(...prepared.members.map(member => ({ ...member, id: source.id + '/' + member.id })))
    }
    selectors.push(...members.filter(member => !claimed.has(member.id)).map(member => ({ memberId: member.id, reason: 'DESKTOP_RECOVERY_MEMBER_MISMATCH' })))
    return selectors.length ? { state: 'unavailable', selectors } : { state: 'prepared', members: result }
  }

  prepare(captureId: string, original: RecoveryRestoreMember[]): Promise<Prepared> {
    if (!validId(captureId) || this.disposed) return Promise.reject(new AgentMuxError('The original local Desktop preparation is unavailable.', 'STORAGE_RECOVERY_UNAVAILABLE'))
    const members = structuredClone(original), fingerprint = digest(JSON.stringify(members)), previous = this.preparations.get(captureId)
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.reject(new AgentMuxError('Keep the original source preparation members and capture ID.', 'STORAGE_RECOVERY_CONFLICT'))
    if (this.exports.has(captureId) || this.exports.size + this.preparations.size >= 4) return Promise.reject(new AgentMuxError('Original Desktop exports still await release.', 'STORAGE_RECOVERY_EXPORT_BUSY'))
    const entry: Export<Prepared> = { directory: undefined, promise: undefined!, timer: undefined, fingerprint }
    entry.promise = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      if (!(await lstat(this.directory)).isDirectory()) throw new AgentMuxError('The original private preparation directory is unconfirmed.', 'STORAGE_RECOVERY_EXPORT_UNSAFE')
      await chmod(this.directory, 0o700)
      entry.directory = await mkdtemp(join(this.directory, 'prepare-'))
      return { captureId, result: await this.prepareSources(members, entry.directory) }
    })()
    this.preparations.set(captureId, entry)
    void entry.promise.then(() => {
      if (this.disposed || this.preparations.get(captureId) !== entry) return
      entry.timer = setTimeout(() => { void this.release(captureId).catch(() => {}) }, 5 * 60_000); entry.timer.unref?.()
    }, () => { void this.release(captureId).catch(() => {}) })
    return entry.promise
  }

  async restore(original: RecoveryRestoreMember): Promise<'restored' | 'same' | 'conflict'> {
    const member = structuredClone(original), source = this.sources().find(source => member.id.startsWith(source.id + '/'))
    if (this.disposed || !source?.restoreMissing) throw new AgentMuxError('The exact original Desktop data owner is unavailable.', 'STORAGE_RECOVERY_UNAVAILABLE')
    return await source.restoreMissing({ ...member, id: member.id.slice(source.id.length + 1) })
  }

  async release(captureId: string): Promise<{ released: boolean }> {
    const entry = this.exports.get(captureId) ?? this.preparations.get(captureId)
    if (!entry) return { released: false }
    clearTimeout(entry.timer)
    await entry.promise.catch(() => {})
    clearTimeout(entry.timer)
    if (entry.directory) await rm(entry.directory, { recursive: true, force: true })
    if (this.exports.get(captureId) === entry) this.exports.delete(captureId)
    if (this.preparations.get(captureId) === entry) this.preparations.delete(captureId)
    return { released: true }
  }

  dispose(): void {
    this.disposed = true
    // Read-only export cleanup cannot become a controlled-Quit write barrier.
    for (const captureId of this.exports.keys()) void this.release(captureId).catch(() => {})
    for (const captureId of this.preparations.keys()) void this.release(captureId).catch(() => {})
  }
}
