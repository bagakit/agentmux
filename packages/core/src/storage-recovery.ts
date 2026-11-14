import { createHash } from 'node:crypto'
import { constants, watch, type FSWatcher } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, rm, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { mintObjectId } from './object-id.js'
import { createRequire } from 'node:module'
import { StorageRestoreOperations, type RestorePreflight, type RestoreObservation } from './storage-restore.js'

export type RecoveryGap = { sourceId: string; memberId?: string; code: string }
export type RecoverySourceMember = { id: string; file: string; target: string; kind: 'file' | 'session-database'; capturedAt: number; revision?: string }
export type RecoveryRestoreMember = RecoverySourceMember & { sha256: string; operationId: string; originalSHA256?: string }
/** Private composition port. Neither source paths nor bytes are accepted as an RPC snapshot. */
export type RecoverySource = {
  id: string
  /** Exact owner roots for composition; never a public registration or restore grant. */
  readonly ownedPaths?: readonly string[]
  capture(directory: string): Promise<{ revision: string; members: RecoverySourceMember[]; gaps: RecoveryGap[] }>
  prepareRestore?(members: RecoveryRestoreMember[], directory: string, context?: RecoveryRestoreContext): Promise<RecoveryPreparation>
  /** Restoring this owner's controls invalidates pre-cut business eligibility, never healthy Runs. */
  readonly requiresInputCut?: boolean
  restoreMissing?(member: RecoveryRestoreMember): Promise<'restored' | 'same' | 'conflict'>
  previewInput?(file: string, selector: RecoveryInputSelector): Promise<{ baselineHash: string; resultHash: string }>
  restoreInput?(file: string, selector: RecoveryInputSelector, baselineHash: string, resultHash: string): Promise<void>
  subscribe?(changed: () => void, unavailable?: (issue: RecoveryGap) => void): () => void
}
export type RecoveryRestoreContext = { original(memberId: string): Promise<RecoveryRestoreMember | null>; inputCutSourceSHA256: string }
export type RecoveryInputCuts = { admit(input: { operationId: string; sourceSHA256: string }): Promise<
  { state: 'admitted'; inputEpoch: string } | { state: 'unavailable'; selectors: Array<{ agentSessionId?: string; reason: string }> }> }
export type RecoveryInputSelector = { agentSessionId: string; runId: string; submissionId: string }
export type RecoveryPreparation = { state: 'prepared'; members: RecoveryRestoreMember[]; metadata?: Record<string, string | number | boolean> } |
  { state: 'unavailable'; selectors: Array<{ memberId?: string; agentSessionId?: string; reason: string }> }
export type RecoveryMember = Omit<RecoverySourceMember, 'file'> & { sha256: string; bytes: number }
export type RecoveryManifest = {
  schema: 'agentmux.recovery-generation.v1'; generationId: string; namespace: string; createdAt: number
  sources: { id: string; revision: string; capturedAt: number; members: RecoveryMember[] }[]
  gaps: RecoveryGap[]
}
export type RecoveryGeneration = { generationId: string; namespace: string; createdAt: number; memberCount: number; gaps: RecoveryGap[]; manifestHash: string;
  verification?: 'members' | 'manifest-only'; coverage?: Array<{ sourceId: string; memberId: string; kind: RecoverySourceMember['kind'] }> }
export type RecoveryStatus = { state: 'idle' | 'capturing' | 'unavailable'; lastGeneration: RecoveryGeneration | null; pending: boolean; issue: string | null }
export const recoveryDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const issueCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z_0-9-]{1,100}$/u.test(code) ? code : 'RECOVERY_SOURCE_UNAVAILABLE'
}
function invalid(message: string): never { throw new AgentMuxError(message, 'STORAGE_RECOVERY_INVALID') }
export async function hashRecoveryFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256'); let bytes = 0
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { for await (const chunk of file.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk) } }
  finally { await file.close() }
  return { sha256: hash.digest('hex'), bytes }
}
const stamp = (value: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
async function syncFile(path: string): Promise<void> {
  for (const target of [path, dirname(path)]) { const handle = await open(target, 'r'); try { await handle.sync() } finally { await handle.close() } }
}
export async function confirmRecoveryDirectory(directory: string): Promise<void> {
  // A previous mkdir may be visible after a lost directory ACK. Confirm the
  // entire publication ancestry again, without interpreting existence as ACK.
  for (let path = directory; ; path = dirname(path)) {
    const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() }
    if (path === dirname(path)) break
  }
}
const confirmDirectoryAncestry = confirmRecoveryDirectory
/** Snapshot one exact atomic-file owner member; an in-place or path replacement is an explicit gap. */
export async function snapshotRecoveryFile(source: string, destination: string): Promise<string> {
  const before = await lstat(source, { bigint: true })
  if (!before.isFile()) invalid('The original recovery member is not a regular file.')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  try { await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE) }
  catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    await requireRecoverySpace(dirname(destination), before.size)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  }
  await chmod(destination, 0o600)
  const after = await lstat(source, { bigint: true })
  if (stamp(before) !== stamp(after)) { await unlink(destination); throw new AgentMuxError('This original source changed during capture. Retry its exact owner.', 'RECOVERY_SOURCE_CHANGED') }
  await syncFile(destination)
  return stamp(before)
}

export async function requireRecoverySpace(directory: string, bytes: bigint): Promise<void> {
  const volume = await statfs(directory, { bigint: true })
  // Maintenance yields its own capture before consuming ordinary write headroom.
  // It never gates the original Store, input or healthy Runtime.
  if (volume.bavail * volume.bsize - bytes < 64n * 1024n * 1024n) throw new AgentMuxError('Recovery capture has insufficient write headroom. Original work remains available.', 'RECOVERY_SPACE_UNAVAILABLE')
}

export async function snapshotRecoverySqlite(source: string, destination: string): Promise<void> {
  const { DatabaseSync, backup } = await import('node:sqlite')
  const db = new DatabaseSync(source, { readOnly: true })
  try { await requireRecoverySpace(dirname(destination), (await lstat(source, { bigint: true })).size); await backup(db, destination); await chmod(destination, 0o600); await syncFile(destination) }
  finally { db.close() }
}
async function isSqliteFile(path: string): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const bytes = Buffer.alloc(16); const read = await file.read(bytes, 0, bytes.length, 0)
    return read.bytesRead === 16 && bytes.equals(Buffer.from('SQLite format 3\0')) }
  finally { await file.close() }
}

/** An original namespace owner may contribute its own files without interpreting their business fields. */
export function recoveryDirectorySource(id: string, directory: string, options: { exclude?: (path: string) => boolean; watchPaths?: readonly string[]; recursive?: boolean; restoreInertFiles?: boolean } = {}): RecoverySource {
  return { id, ownedPaths: [directory],
    async capture(output) {
      const members: RecoverySourceMember[] = [], gaps: RecoveryGap[] = []
      const visit = async (path: string): Promise<void> => {
        if (options.exclude?.(path)) return
        let attributes
        try { attributes = await lstat(path) } catch (error) { gaps.push({ sourceId: id, code: issueCode(error) }); return }
        if (attributes.isDirectory()) {
          const before = (await readdir(path)).sort()
          for (const name of before) await visit(join(path, name))
          if (JSON.stringify(before) !== JSON.stringify((await readdir(path)).sort())) gaps.push({ sourceId: id, code: 'RECOVERY_DIRECTORY_CHANGED' })
        } else if (attributes.isFile()) {
          const memberId = relative(directory, path), file = join(output, recoveryDigest(memberId))
          try {
            const sidecar = path.match(/^(.*)-(?:wal|shm|journal)$/u)
            if (sidecar && await isSqliteFile(sidecar[1]!).catch(() => false)) return
            const sqlite = await isSqliteFile(path)
            const revision = sqlite ? (await snapshotRecoverySqlite(path, file), undefined) : await snapshotRecoveryFile(path, file)
            members.push({ id: memberId, file, target: path, kind: 'file', capturedAt: Date.now(), ...(revision ? { revision } : {}) })
          }
          catch (error) { gaps.push({ sourceId: id, memberId, code: issueCode(error) }) }
        } else gaps.push({ sourceId: id, memberId: relative(directory, path), code: 'RECOVERY_NON_FILE_UNSUPPORTED' })
      }
      try { await visit(directory) } catch (error) { gaps.push({ sourceId: id, code: issueCode(error) }) }
      return { revision: recoveryDigest(JSON.stringify(members.map(value => [value.id, value.capturedAt]))), members, gaps }
    },
    ...(options.restoreInertFiles ? { async restoreMissing(member: RecoveryRestoreMember) {
      if (!isAbsolute(member.target) || relative(directory, member.target).startsWith('..') || options.exclude?.(member.target)) invalid('The recovery target is outside its original owner.')
      // A validated retained manifest is the original enrollment. No arbitrary RPC path enters here.
      return await restoreMissingRecoveryFile(member.file, member.target, member.sha256)
    } } : {}),
    subscribe(changed, unavailable) {
      const watchers = new Map<string, FSWatcher>(); let active = true
      const observe = async (selected: string): Promise<void> => {
        let attributes; try { attributes = await lstat(selected) } catch (error) { if (!absent(error)) { if (active) { unavailable?.({ sourceId: id, code: issueCode(error) }); changed() }; return } }
        const parent = dirname(selected), watched = attributes?.isDirectory() ? selected : parent, recursive = options.recursive ?? attributes?.isDirectory() ?? false
        const key = watched + ':' + recursive
        if (!active || watchers.has(key)) return
        try {
          const watcher = watch(watched, { recursive }, (_event, name) => {
            if (!active || !name) return
            const path = join(watched, String(name))
            if (!options.exclude?.(path)) { changed(); for (const selected of options.watchPaths ?? [directory]) void observe(selected) }
          }); watchers.set(key, watcher); watcher.on('error', error => { if (active) { unavailable?.({ sourceId: id, code: issueCode(error) }); changed() } })
        } catch (error) { if (active) { unavailable?.({ sourceId: id, code: issueCode(error) }); changed() } }
      }
      for (const path of options.watchPaths ?? [directory]) void observe(path)
      return () => { active = false; for (const watcher of watchers.values()) watcher.close(); watchers.clear() }
    }
  }
}

/** No replacement: an existing different object remains a conflict, including after a lost publication ACK. */
export async function restoreMissingRecoveryFile(source: string, target: string, sha256: string): Promise<'restored' | 'same' | 'conflict'> {
  try {
    if ((await hashRecoveryFile(target)).sha256 !== sha256) return 'conflict'
    await syncFile(target); await confirmDirectoryAncestry(dirname(target))
    return 'same'
  }
  catch (error) { if (!absent(error)) throw error }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const candidate = target + '.' + mintObjectId() + '.recovery-candidate'
  try {
    await snapshotRecoveryFile(source, candidate)
    if ((await hashRecoveryFile(candidate)).sha256 !== sha256) invalid('The retained recovery member changed.')
    try { await link(candidate, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await syncFile(target)
    await confirmDirectoryAncestry(dirname(target))
    return (await hashRecoveryFile(target)).sha256 === sha256 ? 'restored' : 'conflict'
  } finally { await rm(candidate, { force: true }) }
}

export class AgentMuxStorageRecovery {
  private readonly restoreOperations = new StorageRestoreOperations(this, id => this.sources.get(id))
  private readonly sources = new Map<string, RecoverySource>()
  private readonly subscriptions = new Map<string, { stop(): void; token: object }>()
  private readonly failedSubscriptions = new Map<string, string>()
  private pending = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private capturing: Promise<RecoveryGeneration> | undefined
  private latest: RecoveryGeneration | null = null
  private failure: string | null = null
  private maintenanceIssue: string | null = null
  private retainedVerificationIssue = false
  private disposed = false
  private readonly dirtySources = new Set<string>()
  private activeAllSources = false
  private readonly objectChecks = new Map<string, { stamp: string; bytes: number }>()
  private readonly memberChecks = new Map<string, { revision: string; target: string; sha256: string; bytes: number }>()
  constructor(readonly directory: string, readonly namespace: string, sources: readonly RecoverySource[], private readonly retainedGenerations = 5,
    readonly inputCuts?: RecoveryInputCuts) {
    if (!isAbsolute(directory) || !namespace || retainedGenerations < 2) invalid('Recovery needs its exact original namespace and multiple generations.')
    for (const source of sources) { if (!source.id || this.sources.has(source.id)) invalid('Recovery source identities must be unique.'); this.sources.set(source.id, source) }
  }
  start(): void {
    void this.list().then(values => { this.latest ??= values[0] ?? null }).catch(error => { this.failure = issueCode(error) })
    for (const source of this.sources.values()) this.attachSource(source)
    this.changed()
  }
  private attachSource(source: RecoverySource): void {
    if (!source.subscribe || this.disposed) return
    const old = this.subscriptions.get(source.id)
    try { old?.stop() } catch (error) { this.failedSubscriptions.set(source.id, issueCode(error)); return }
    const token = {}, subscription = { token, stop: () => {} }
    this.subscriptions.set(source.id, subscription); this.failedSubscriptions.delete(source.id)
    try { subscription.stop = source.subscribe(() => { if (this.subscriptions.get(source.id)?.token === token) this.changed(source.id) }, issue => {
      if (this.subscriptions.get(source.id)?.token !== token) return
      this.failedSubscriptions.set(source.id, issue.code); this.changed(source.id)
    }) }
    catch (error) { this.failedSubscriptions.set(source.id, issueCode(error)) }
  }
  changed(sourceId?: string): void { for (const id of sourceId ? [sourceId] : this.sources.keys()) this.dirtySources.add(id)
    this.pending = true; if (this.disposed || this.timer || this.capturing) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.capture({ changedOnly: true }).catch(() => {}) }, 30_000); this.timer.unref() }
  status(): RecoveryStatus { const issue = this.failedSubscriptions.values().next().value ?? this.failure
    return { state: this.capturing ? 'capturing' : issue ? 'unavailable' : 'idle', lastGeneration: this.latest, pending: this.pending, issue } }
  async dispose(): Promise<void> { this.disposed = true; if (this.timer) clearTimeout(this.timer)
    for (const subscription of this.subscriptions.values()) try { subscription.stop() } catch (error) { this.failure = issueCode(error) }
    this.subscriptions.clear(); await this.capturing?.catch(() => {}) }
  async capture(options?: { changedOnly: true }): Promise<RecoveryGeneration> {
    if (this.capturing) { const all = this.activeAllSources, result = await this.capturing; return !options && !all ? await this.capture() : result }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    for (const id of [...this.failedSubscriptions.keys()]) this.attachSource(this.sources.get(id)!)
    this.pending = false
    const selected = options && this.latest ? new Set(this.dirtySources) : undefined
    this.dirtySources.clear(); this.activeAllSources = selected === undefined
    const operation = this.withOwnerLock(() => this.captureGeneration(selected))
    this.capturing = operation
    try { const result = await operation; this.latest = result; this.failure = result.gaps.length ? 'RECOVERY_COVERAGE_INCOMPLETE' : this.maintenanceIssue; return result }
    catch (error) { this.failure = issueCode(error); for (const id of selected ?? this.sources.keys()) this.dirtySources.add(id); this.pending = true; throw error }
    finally { this.capturing = undefined; if (this.pending && !this.disposed && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.capture({ changedOnly: true }).catch(() => {}) }, 30_000); this.timer.unref()
    } }
  }
  private async withOwnerLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const handle = await open(this.directory + '.owner.lock', 'a+', 0o600)
    try {
      if (!native.tryLock(handle.fd)) throw new AgentMuxError('The original recovery owner is completing maintenance. Inspect or retry the same operation.', 'STORAGE_RECOVERY_BUSY')
      return await action()
    } finally { await handle.close() }
  }
  private manifestPath(id: string): string { if (!/^[A-Za-z0-9_-]{1,100}$/u.test(id)) invalid('An exact recovery generation is required.'); return join(this.directory, 'generations', id + '.json') }
  blobPath(hash: string): string { if (!/^[a-f0-9]{64}$/u.test(hash)) invalid('Invalid recovery digest.'); return join(this.directory, 'objects', hash) }
  private async verifyObject(member: Pick<RecoveryMember, 'sha256' | 'bytes'>, force = false): Promise<void> {
    const path = this.blobPath(member.sha256), before = await lstat(path, { bigint: true }), checked = this.objectChecks.get(member.sha256)
    if (!before.isFile() || (before.mode & 0o077n) !== 0n) invalid('A recovery object is not a protected regular file.')
    if (!force && checked?.stamp === stamp(before) && checked.bytes === member.bytes) return
    const actual = await hashRecoveryFile(path), after = await lstat(path, { bigint: true })
    if (stamp(before) !== stamp(after) || actual.sha256 !== member.sha256 || actual.bytes !== member.bytes) invalid('A retained recovery member is corrupt or incomplete.')
    this.objectChecks.set(member.sha256, { stamp: stamp(after), bytes: actual.bytes })
  }
  private async captureGeneration(selected?: ReadonlySet<string>): Promise<RecoveryGeneration> {
    const generationId = mintObjectId(), output = join(this.directory, 'pending', generationId)
    await mkdir(output, { recursive: true, mode: 0o700 })
    const manifest: RecoveryManifest = { schema: 'agentmux.recovery-generation.v1', generationId, namespace: this.namespace, createdAt: Date.now(), sources: [], gaps: [] }
    for (const [sourceId, code] of this.failedSubscriptions) manifest.gaps.push({ sourceId, code })
    const targets = new Set<string>()
    try {
      let previous: RecoveryManifest | undefined
      if (selected && this.latest) {
        try { previous = (await this.readManifest(this.latest.generationId)).manifest }
        catch (error) { this.maintenanceIssue = issueCode(error) /* The current live owners can still produce a new cut. */ }
      }
      for (const source of this.sources.values()) {
        const retainedSource = previous?.sources.find(value => value.id === source.id)
        if (selected && !selected.has(source.id) && retainedSource) {
          manifest.sources.push(retainedSource); manifest.gaps.push(...previous!.gaps.filter(gap => gap.sourceId === source.id))
          for (const member of retainedSource.members) targets.add(member.target)
          continue
        }
        const sourceOutput = join(output, recoveryDigest(source.id)); await mkdir(sourceOutput, { mode: 0o700 })
        try {
          const capture = await source.capture(sourceOutput), members: RecoveryMember[] = []
          manifest.gaps.push(...capture.gaps)
          for (const member of capture.members) {
            if (!isAbsolute(member.target) || relative(sourceOutput, member.file).startsWith('..') || !isAbsolute(member.file)) invalid('A source export escaped its private snapshot.')
            if (targets.has(member.target)) { manifest.gaps.push({ sourceId: source.id, memberId: member.id, code: 'RECOVERY_OWNER_OVERLAP' }); continue }
            targets.add(member.target)
            const key = JSON.stringify([source.id, member.id]), cached = this.memberChecks.get(key)
            const reused = !!member.revision && cached?.revision === member.revision && cached.target === member.target
            const hashed = reused ? { sha256: cached.sha256, bytes: cached.bytes } : await hashRecoveryFile(member.file), blob = this.blobPath(hashed.sha256)
            await mkdir(dirname(blob), { recursive: true, mode: 0o700 })
            if (!reused) try { await link(member.file, blob) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
            await this.verifyObject(hashed)
            await syncFile(blob)
            if (member.revision) this.memberChecks.set(key, { revision: member.revision, target: member.target, ...hashed })
            const { file: _file, ...retained } = member; members.push({ ...retained, ...hashed })
          }
          manifest.sources.push({ id: source.id, revision: capture.revision, capturedAt: Date.now(), members })
        } catch (error) { manifest.gaps.push({ sourceId: source.id, code: issueCode(error) }) }
      }
      // Every member is durable before this immutable generation becomes discoverable.
      await mkdir(dirname(this.manifestPath(generationId)), { recursive: true, mode: 0o700 })
      await confirmDirectoryAncestry(this.directory)
      await durableWriteFile(this.manifestPath(generationId), JSON.stringify(manifest) + '\n', { mode: 0o600, requireDirectorySync: true })
      const verified = await this.describe(generationId)
      this.maintenanceIssue = null
      await this.prune().catch(error => { this.maintenanceIssue = issueCode(error) })
      return verified
    } finally { await rm(output, { recursive: true, force: true }) }
  }
  async readManifest(generationId: string, force = false, selected?: ReadonlySet<string>): Promise<{ manifest: RecoveryManifest; hash: string }> {
    const path = this.manifestPath(generationId), before = await lstat(path, { bigint: true })
    if (!before.isFile() || (before.mode & 0o077n) !== 0n) invalid('The original recovery manifest is not protected.')
    const bytes = await readFile(path, 'utf8'), manifest = JSON.parse(bytes) as RecoveryManifest
    if (stamp(before) !== stamp(await lstat(path, { bigint: true }))) invalid('The original recovery manifest changed during inspection.')
    if (manifest.schema !== 'agentmux.recovery-generation.v1' || manifest.namespace !== this.namespace || manifest.generationId !== generationId || !Array.isArray(manifest.sources) || !Array.isArray(manifest.gaps)) invalid('The recovery generation belongs to another namespace or is unreadable.')
    const keys = new Set<string>()
    for (const source of manifest.sources) for (const member of source.members) {
      const key = JSON.stringify([source.id, member.id]); if (keys.has(key)) invalid('An original recovery source is ambiguous.'); keys.add(key)
      if (!isAbsolute(member.target) || !['file', 'session-database'].includes(member.kind)) invalid('Invalid recovery member.')
      if (selected === undefined || selected.has(key)) await this.verifyObject(member, force)
    }
    return { manifest, hash: recoveryDigest(bytes) }
  }
  async inspect(generationId: string): Promise<RecoveryGeneration> {
    return await this.describe(generationId, true)
  }
  async restorePreflight(request: RestorePreflight): Promise<RestoreObservation> { return await this.withOwnerLock(() => this.restoreOperations.preflight(request)) }
  async restoreApply(operationId: string): Promise<RestoreObservation> { return await this.withOwnerLock(() => this.restoreOperations.apply(operationId)) }
  async restoreInspect(operationId: string): Promise<RestoreObservation> { return await this.withOwnerLock(() => this.restoreOperations.inspect(operationId)) }
  /** Explicit local-user enrollment of an offline original; never caller-authored record JSON. */
  async importSessionBackup(request: { sourcePath: string; sha256: string }): Promise<RecoveryGeneration> {
    return await this.withOwnerLock(async () => {
      const actor = this.sources.get('core.sessions'), target = actor?.ownedPaths?.[0]
      if (!target || !isAbsolute(request.sourcePath) || request.sourcePath === target || !/^[a-f0-9]{64}$/u.test(request.sha256)) invalid('Select an exact offline original Session backup and digest.')
      const attrs = await lstat(request.sourcePath)
      if (!attrs.isFile() || (attrs.mode & 0o077) !== 0) invalid('The imported original must be a protected regular file.')
      for (const suffix of ['-wal', '-journal']) {
        try { if ((await lstat(request.sourcePath + suffix)).size > 0) invalid('The original has a live SQLite companion. Capture through its original owner instead.') } catch (error) { if (!absent(error)) throw error }
      }
      const generationId = mintObjectId(), output = join(this.directory, 'pending', generationId)
      await mkdir(output, { recursive: true, mode: 0o700 })
      try {
        const file = join(output, 'original.sqlite'); await snapshotRecoveryFile(request.sourcePath, file)
        const hashed = await hashRecoveryFile(file)
        if (hashed.sha256 !== request.sha256) invalid('The original source digest changed before admission.')
        const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(file, { readOnly: true })
        let incarnation: string
        try {
          if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') invalid('The original SQLite source is incomplete.')
          incarnation = String(db.prepare('SELECT incarnation FROM identity').get()?.incarnation ?? '')
          if (!incarnation) invalid('The original SQLite source has no retained incarnation.')
        } finally { db.close() }
        const blob = this.blobPath(hashed.sha256); await mkdir(dirname(blob), { recursive: true, mode: 0o700 })
        try { await link(file, blob) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        await this.verifyObject(hashed, true); await syncFile(blob)
        const manifest: RecoveryManifest = { schema: 'agentmux.recovery-generation.v1', generationId, namespace: this.namespace, createdAt: Date.now(),
          sources: [{ id: 'core.sessions', revision: incarnation, capturedAt: Date.now(), members: [{ id: 'database', target, kind: 'session-database', capturedAt: Date.now(), ...hashed }] }],
          gaps: [{ sourceId: 'core.sessions', code: 'RECOVERY_IMPORTED_ORIGINAL_PARTIAL_COVERAGE' }] }
        await mkdir(dirname(this.manifestPath(generationId)), { recursive: true, mode: 0o700 }); await confirmDirectoryAncestry(this.directory)
        await durableWriteFile(this.manifestPath(generationId), JSON.stringify(manifest) + '\n', { mode: 0o600, requireDirectorySync: true })
        return await this.describe(generationId, true)
      } finally { await rm(output, { recursive: true, force: true }) }
    })
  }
  private async describe(generationId: string, force = false, verification: 'members' | 'manifest-only' = 'members'): Promise<RecoveryGeneration> {
    const { manifest, hash } = await this.readManifest(generationId, force, verification === 'manifest-only' ? new Set() : undefined)
    return { generationId, namespace: manifest.namespace, createdAt: manifest.createdAt, memberCount: manifest.sources.reduce((sum, source) => sum + source.members.length, 0), gaps: manifest.gaps, manifestHash: hash,
      verification, ...(force || verification === 'manifest-only' ? { coverage: manifest.sources.flatMap(source => source.members.map(member => ({ sourceId: source.id, memberId: member.id, kind: member.kind }))) } : {}) }
  }
  async list(): Promise<RecoveryGeneration[]> {
    let names: string[]; try { names = await readdir(join(this.directory, 'generations')) } catch (error) { if (absent(error)) return []; throw error }
    const results: RecoveryGeneration[] = []; this.retainedVerificationIssue = false
    for (const name of names.filter(name => name.endsWith('.json'))) {
      try { results.push(await this.describe(basename(name, '.json'), false, 'manifest-only')) }
      catch { this.retainedVerificationIssue = true; this.maintenanceIssue = 'RECOVERY_RETAINED_GENERATION_UNAVAILABLE'; this.failure = this.maintenanceIssue }
    }
    return results.sort((a, b) => b.createdAt - a.createdAt || b.generationId.localeCompare(a.generationId))
  }
  private async prune(): Promise<void> {
    const generations = await this.list()
    if (this.retainedVerificationIssue) throw new AgentMuxError('A retained generation is unconfirmed. Verified generations remain readable; original evidence was retained.', 'RECOVERY_RETAINED_GENERATION_UNAVAILABLE')
    // Coverage gaps cannot evict the last fully covered generation.
    const retained = new Set(generations.slice(0, this.retainedGenerations).map(value => value.generationId))
    // An admitted recovery operation pins its immutable evidence across captures
    // and owner restarts, including an operation with an unknown apply reply.
    let operations: string[] = []
    try { operations = await readdir(join(this.directory, 'restore-operations')) } catch (error) { if (!absent(error)) throw error }
    for (const id of operations) if (/^[A-Za-z0-9_-]{1,100}$/u.test(id)) {
      const path = join(this.directory, 'restore-operations', id, 'operation.json')
      try {
        const attributes = await lstat(path)
        if (!attributes.isFile() || (attributes.mode & 0o077) !== 0) invalid('A retained restore operation is not protected.')
        const op = JSON.parse(await readFile(path, 'utf8')) as { schema?: string; namespace?: string; generationId?: string }
        if (op.schema !== 'agentmux.restore-operation.v1' || op.namespace !== this.namespace || !op.generationId) invalid('A retained restore operation belongs to another owner.')
        retained.add(op.generationId)
      } catch (error) { if (!absent(error)) throw error }
    }
    const complete = generations.find(value => value.gaps.length === 0); if (complete) retained.add(complete.generationId)
    const latestManifest = generations[0] ? (await this.readManifest(generations[0].generationId)).manifest : undefined
    const incompleteSources = new Set(latestManifest?.gaps.map(gap => gap.sourceId)), coveredMembers = new Set<string>()
    const covered = new Set<string>()
    for (const generation of generations) {
      const { manifest } = await this.readManifest(generation.generationId)
      for (const source of manifest.sources) {
        if (incompleteSources.has(source.id)) for (const member of source.members) {
          const key = JSON.stringify([source.id, member.id])
          if (!coveredMembers.has(key)) { retained.add(generation.generationId); coveredMembers.add(key) }
        }
        if (!source.members.length || covered.has(source.id) || manifest.gaps.some(gap => gap.sourceId === source.id)) continue
        // An unavailable sibling source does not make this exact original cut
        // disposable. Keep the newest verified complete cut for each owner.
        retained.add(generation.generationId); covered.add(source.id)
      }
    }
    for (const generation of generations) if (!retained.has(generation.generationId)) await unlink(this.manifestPath(generation.generationId))
    const referenced = new Set<string>()
    for (const id of retained) for (const source of (await this.readManifest(id)).manifest.sources) for (const member of source.members) referenced.add(member.sha256)
    for (const name of await readdir(join(this.directory, 'objects'))) if (/^[a-f0-9]{64}$/u.test(name) && !referenced.has(name)) await unlink(this.blobPath(name))
  }
}
