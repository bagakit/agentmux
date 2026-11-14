import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Session } from 'electron'
import { AgentMuxError } from '@agentmux/core'
import { parseBrowserProfileExtensionInputSource } from '@agentmux/core/control'
import { prepareOnlineExtension } from './browser-profile-extension-online.js'
import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserProfileExtension, BrowserProfileExtensionReview, BrowserProfileExtensionReceipt, BrowserProfileExtensionApplication, BrowserProfileExtensionPending, BrowserProfileExtensionInputSource } from '@agentmux/core/control'
import type { BrowserProfileExtensionRecord } from './browser-profile-extension-record.js'
import { prepareExtensionPackage, hashExtensionDirectory, BrowserProfileExtensionPackageError, type PreparedExtensionPackage } from './browser-profile-extension-package.js'

type ProfileExtensions = { profileRevision: string; records: BrowserProfileExtensionRecord[]; receipts: BrowserProfileExtensionReceipt[]; pending: BrowserProfileExtensionPending[] }
export type BrowserProfileExtensionConfirmation = { kind: 'install' | 'update' | 'remove'; review: BrowserProfileExtensionReview; localSourcePath?: string; onlineSource?: string }
export type BrowserProfileExtensionPorts = {
  root(profileId: string): string
  read(profileId: string): Promise<ProfileExtensions>
  begin(profileId: string, expectedRevision: string, intent: BrowserProfileExtensionPending): Promise<void>
  commit(profileId: string, expectedRevision: string, records: BrowserProfileExtensionRecord[], receipt: BrowserProfileExtensionReceipt): Promise<ProfileExtensions>
  change<T>(profileId: string, action: () => Promise<T>): Promise<T>
  prepareSession(profileId: string): Promise<void> | undefined
  session(profileId: string): Session
  existingSession(profileId: string): Session | undefined
}
type Preparation = { review: BrowserProfileExtensionReview; package: PreparedExtensionPackage; source: BrowserProfileExtensionInputSource }
const unavailable = (message: string, code = 'BROWSER_PROFILE_EXTENSION_UNAVAILABLE', detail?: unknown): never => {
  throw new AgentMuxError(message, code, detail === undefined ? undefined : JSON.stringify(detail))
}
const permissionSet = (permissions: BrowserProfileExtensionReview['permissions']): string[] => [
  ...permissions.api.map(value => 'API: ' + value), ...permissions.hosts.map(value => 'Host: ' + value),
  ...permissions.contentScripts.map(value => 'Content: ' + value), ...permissions.optional.map(value => 'Optional: ' + value)]

/** One Profile metadata owner, one original native Session. Loading never grants Agent or site access. */
export class BrowserProfileExtensions {
  private readonly prepared = new Map<string, Preparation>()
  private readonly preparing = new Map<string, { fingerprint: string; promise: Promise<BrowserProfileExtensionReview> }>()
  private definitions: Record<string, BrowserProfileExtensionRecord[]> = {}
  private readonly applications = new Map<string, Map<string, BrowserProfileExtensionApplication>>()
  private readonly loading = new Map<string, Promise<void>>()
  private confirm: ((request: BrowserProfileExtensionConfirmation) => Promise<boolean>) | undefined
  constructor(private readonly ports: BrowserProfileExtensionPorts) {}

  /** Wired only by the original trusted Workbench Main owner, never from a request field. */
  setConfirmationHandler(confirm: (request: BrowserProfileExtensionConfirmation) => Promise<boolean>): void { this.confirm = confirm }
  adopt(definitions: Record<string, BrowserProfileExtensionRecord[]>): void { this.definitions = definitions }
  private path(profileId: string, record: Pick<BrowserProfileExtensionRecord, 'id' | 'sha256'>): string { return join(this.ports.root(profileId), record.id, record.sha256) }
  private remember(profileId: string, extensionId: string, application: BrowserProfileExtensionApplication): BrowserProfileExtensionApplication {
    let values = this.applications.get(profileId); if (!values) this.applications.set(profileId, values = new Map())
    values.set(extensionId, application); return application
  }
  private observe(profileId: string, record: BrowserProfileExtensionRecord): BrowserProfileExtensionApplication {
    try {
      const native = this.ports.existingSession(profileId)?.extensions.getExtension(record.nativeId)
      if (native && native.path === this.path(profileId, record) && native.version === record.version) return this.remember(profileId, record.id, { state: 'loaded' })
    } catch { /* Missing native observation cannot remove the Profile's healthy Browser capabilities. */ }
    const previous = this.applications.get(profileId)?.get(record.id)
    return previous && previous.state !== 'loaded' ? previous : { state: 'unknown', reason: 'This approved extension is not confirmed loaded in this process. Load it explicitly to retry.' }
  }
  private present(profileId: string, record: BrowserProfileExtensionRecord): BrowserProfileExtension {
    const { key: _key, reviewId: _review, acquisition: _acquisition, ...value } = record
    return { ...structuredClone(value), application: this.observe(profileId, record) }
  }
  async list(profileId: string, operationId?: string) {
    const current = await this.ports.read(profileId)
    return { profileId, profileRevision: current.profileRevision, extensions: current.records.map(record => this.present(profileId, record)), pending: structuredClone(current.pending.filter(intent => operationId === undefined || intent.operationId === operationId)),
      ...(operationId === undefined ? {} : { receipt: current.receipts.find(receipt => receipt.operationId === operationId) ?? null }) }
  }
  /** Boot/loading facts are independent from the Browser's own network and page readiness. */
  prepare(profileId: string): Promise<void> | undefined {
    const records = this.definitions[profileId] ?? []
    if (!records.length) return undefined
    const pending = this.loading.get(profileId); if (pending) return pending
    const needed = records.filter(record => this.observe(profileId, record).state !== 'loaded' && !this.applications.get(profileId)?.has(record.id))
    if (!needed.length) return undefined
    const done = (async () => { for (const record of needed) await this.loadRecord(profileId, record) })()
    this.loading.set(profileId, done)
    void done.finally(() => { if (this.loading.get(profileId) === done) this.loading.delete(profileId) }).catch(() => {})
    return done
  }
  async load(profileId: string, extensionId: string) {
    return this.ports.change(profileId, async () => {
      const current = await this.ports.read(profileId), record = current.records.find(record => record.id === extensionId)
      if (!record) return unavailable('This approved extension is unavailable in the original Profile.')
      return { profileId, extensionId, application: await this.loadRecord(profileId, record) }
    })
  }
  private async loadRecord(profileId: string, record: BrowserProfileExtensionRecord): Promise<BrowserProfileExtensionApplication> {
    try {
      const path = this.path(profileId, record)
      if (await hashExtensionDirectory(path) !== record.sha256) {
        this.ports.existingSession(profileId)?.extensions.removeExtension(record.nativeId)
        return this.remember(profileId, record.id, { state: 'failed', reason: 'The approved package bytes changed. Existing Profile data remains; prepare and review the intended package again.' })
      }
      if (this.observe(profileId, record).state === 'loaded') return { state: 'loaded' }
      await this.ports.prepareSession(profileId)
      const target = this.ports.session(profileId)
      const loaded = await target.extensions.loadExtension(path, { allowFileAccess: false })
      if (loaded.id !== record.nativeId || loaded.version !== record.version || loaded.path !== path) return this.remember(profileId, record.id, { state: 'unknown', reason: 'The host did not confirm this exact approved extension identity and version. The original Profile remains available.' })
      return this.remember(profileId, record.id, { state: 'loaded' })
    } catch { return this.remember(profileId, record.id, { state: 'failed', reason: 'The host could not load this approved package. Its original files and Profile data remain; use Load to retry.' }) }
  }
  async review(profileId: string, expectedRevision: string, operationId: string, source: BrowserProfileExtensionInputSource, extensionId?: string): Promise<BrowserProfileExtensionReview> {
    source = parseBrowserProfileExtensionInputSource(source)
    const fingerprint = JSON.stringify({ profileId, expectedRevision, source, extensionId }), existing = this.preparing.get(operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return unavailable('This original review identity belongs to a different request.')
      return existing.promise
    }
    const preparation = { fingerprint, promise: this.prepareReview(profileId, expectedRevision, operationId, source, extensionId) }
    this.preparing.set(operationId, preparation)
    try { return await preparation.promise }
    finally { if (this.preparing.get(operationId) === preparation) this.preparing.delete(operationId) }
  }
  private async prepareReview(profileId: string, expectedRevision: string, operationId: string, source: BrowserProfileExtensionInputSource, extensionId?: string): Promise<BrowserProfileExtensionReview> {
    type Admission = { kind: 'ready'; review: BrowserProfileExtensionReview } | { kind: 'acquire'; id: string; previous?: BrowserProfileExtensionRecord }
    const admitted = await this.ports.change<Admission>(profileId, async () => {
      const current = await this.ports.read(profileId)
      if (current.profileRevision !== expectedRevision) return unavailable('The Profile settings changed. Read the original Profile before preparing this extension again.', 'BROWSER_PROFILE_CONFIGURATION_CONFLICT')
      const previous = extensionId ? current.records.find(record => record.id === extensionId) : undefined
      if (extensionId && !previous) return unavailable('The extension to update is unavailable in this Profile.')
      if (current.pending.some(intent => intent.operationId === operationId)) return unavailable('This original extension operation has a durable pending intent. Inspect it before preparing another action; it was not replayed.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
      const existing = this.prepared.get(operationId)
      if (existing) {
        if (JSON.stringify(existing.source) !== JSON.stringify(source) || existing.review.profileId !== profileId || existing.review.expectedRevision !== expectedRevision || existing.review.extensionId !== (extensionId ?? existing.review.extensionId)) return unavailable('This original review identity belongs to a different request.')
        return { kind: 'ready', review: structuredClone(existing.review) }
      }
      if (current.receipts.some(receipt => receipt.operationId === operationId)) return unavailable('This original extension operation already has a durable receipt. Inspect that operation before preparing a new one.')
      return { kind: 'acquire', id: previous?.id ?? mintObjectId(), ...(previous ? { previous: structuredClone(previous) } : {}) }
    })
    if (admitted.kind === 'ready') return admitted.review
    const stagingRoot = join(this.ports.root(profileId), '.staging'), staging = join(stagingRoot, mintObjectId())
    let published = false, failure: unknown
    try {
      let pkg: PreparedExtensionPackage
      // Network and package IO never occupy this Profile's configuration queue.
      try { await mkdir(stagingRoot, { recursive: true }); pkg = source.kind === 'local' ? await prepareExtensionPackage(source.path, staging, admitted.previous?.key) : await prepareOnlineExtension(source, staging, admitted.previous?.key) }
      catch (cause) { return unavailable(cause instanceof BrowserProfileExtensionPackageError ? cause.message : 'The extension source could not be read or unpacked. Original packages, Profile data and Browser work remain.', 'BROWSER_PROFILE_EXTENSION_SOURCE_UNAVAILABLE') }
      return await this.ports.change(profileId, async () => {
        const current = await this.ports.read(profileId), previous = current.records.find(record => record.id === admitted.id)
        if (current.profileRevision !== expectedRevision || previous?.key !== admitted.previous?.key || previous?.id !== admitted.previous?.id) return unavailable('The original Profile or extension changed while acquiring the package. Nothing was loaded; read the current target before another preparation.', 'BROWSER_PROFILE_CONFIGURATION_CONFLICT')
        if (current.pending.some(intent => intent.operationId === operationId)) return unavailable('This original extension operation now has an unconfirmed native intent. It was not replayed.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
        if (current.receipts.some(receipt => receipt.operationId === operationId)) return unavailable('This original operation already has a durable receipt. Inspect the same operation.')
        if (current.records.some(record => record.id !== admitted.id && record.key === pkg.key)) return unavailable('This native extension identity is already installed in the Profile. Update that exact installed item instead.')
        const oldPermissions = new Set(previous ? permissionSet(previous.permissions) : [])
        const review: BrowserProfileExtensionReview = { reviewId: operationId, profileId, expectedRevision, extensionId: admitted.id, name: pkg.name, version: pkg.version,
          sha256: pkg.sha256, source: pkg.source, permissions: pkg.permissions, addedPermissions: permissionSet(pkg.permissions).filter(permission => !oldPermissions.has(permission)),
          ...(previous ? { previousVersion: previous.version } : {}) }
        this.prepared.set(operationId, { review, package: pkg, source: structuredClone(source) }); published = true
        return structuredClone(review)
      })
    } catch (error) { failure = error; throw error }
    finally {
      if (!published) try { await rm(staging, { recursive: true, force: true }) }
      catch { return unavailable('Extension preparation did not complete and private staging cleanup is unconfirmed. No native action was sent; original Profile data remains. Restore storage before preparing again.', failure instanceof AgentMuxError ? failure.code : 'BROWSER_PROFILE_EXTENSION_SOURCE_UNAVAILABLE') }
    }
  }
  async apply(profileId: string, expectedRevision: string, reviewId: string) {
    return this.ports.change(profileId, async () => {
      let current = await this.ports.read(profileId)
      const already = current.receipts.find(receipt => receipt.operationId === reviewId)
      if (already?.kind === 'remove') return unavailable('This original operation identifies an extension removal, not an installation review.')
      if (already) return { profileId, profileRevision: current.profileRevision, outcome: 'applied' as const, receipt: already,
        ...(current.records.find(record => record.id === already.extensionId) ? { application: this.observe(profileId, current.records.find(record => record.id === already.extensionId)!) } : {}) }
      if (current.pending.some(intent => intent.operationId === reviewId)) return unavailable('This original extension change has an unconfirmed native effect. Inspect its original operation and current load facts; it was not replayed.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED', { profileId, operationId: reviewId })
      const prepared = this.prepared.get(reviewId)
      if (!prepared || prepared.review.profileId !== profileId || prepared.review.expectedRevision !== expectedRevision) return unavailable('The exact prepared extension review is unavailable. No package was loaded; prepare the intended source again.')
      if (current.profileRevision !== expectedRevision) return unavailable('The Profile settings changed. Its original extension remains; prepare against the current Profile revision.', 'BROWSER_PROFILE_CONFIGURATION_CONFLICT')
      if (!this.confirm) return unavailable('Human extension review is unavailable in this host. The original Profile and extension remain available.', 'HOST_CAPABILITY_UNAVAILABLE')
      const previous = current.records.find(record => record.id === prepared.review.extensionId), kind = previous ? 'update' as const : 'install' as const
      if (!await this.confirm({ kind, review: structuredClone(prepared.review), ...(prepared.source.kind === 'local' ? { localSourcePath: prepared.source.path } : { onlineSource: prepared.source.url }) })) return { profileId, profileRevision: current.profileRevision, outcome: 'cancelled' as const, receipt: null }
      current = await this.ports.read(profileId)
      if (current.profileRevision !== expectedRevision) return unavailable('The Profile changed during human review. No extension action was sent; prepare the current target again.', 'BROWSER_PROFILE_CONFIGURATION_CONFLICT')
      const pkg = prepared.package
      let reviewedHash: string | undefined
      try { reviewedHash = await hashExtensionDirectory(pkg.directory) } catch { /* Keep the original package and request unknown. */ }
      if (reviewedHash !== pkg.sha256) return unavailable('The reviewed package bytes changed. Nothing was loaded; prepare and review the source again.')
      const targetPath = this.path(profileId, { id: prepared.review.extensionId, sha256: pkg.sha256 })
      try {
        await mkdir(dirname(targetPath), { recursive: true })
        if (pkg.directory !== targetPath) {
          try { await rename(pkg.directory, targetPath) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; if (await hashExtensionDirectory(targetPath) !== pkg.sha256) throw error }
          pkg.directory = targetPath
        }
      } catch { return unavailable('The reviewed package could not be retained in its original Profile. No extension code was dispatched; original packages and Profile data remain.', 'BROWSER_PROFILE_EXTENSION_SOURCE_UNAVAILABLE') }
      const receipt: BrowserProfileExtensionReceipt = { operationId: reviewId, profileId, extensionId: prepared.review.extensionId, kind, sha256: pkg.sha256 }
      let nativeAttempted = false
      try {
        await this.ports.prepareSession(profileId)
        const target = this.ports.session(profileId)
        try { await this.ports.begin(profileId, expectedRevision, { ...receipt, expectedRevision, version: pkg.version, ...(previous ? { previousSha256: previous.sha256, nativeId: previous.nativeId } : {}) }) }
        catch { return unavailable('The original extension dispatch intent could not be confirmed saved. No native action was dispatched; inspect this operation before retrying.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED', receipt) }
        nativeAttempted = true
        const loaded = await target.extensions.loadExtension(targetPath, { allowFileAccess: false })
        if (loaded.path !== targetPath || loaded.version !== pkg.version || previous && loaded.id !== previous.nativeId || current.records.some(record => record.id !== receipt.extensionId && record.nativeId === loaded.id)) return unavailable('The native extension identity did not match the reviewed installation.')
        const record: BrowserProfileExtensionRecord = { id: receipt.extensionId, nativeId: loaded.id, reviewId, key: pkg.key, sha256: pkg.sha256,
          name: pkg.name, version: pkg.version, source: pkg.source, permissions: pkg.permissions, ...(prepared.source.kind === 'local' ? {} : { acquisition: prepared.source }) }
        const saved = await this.ports.commit(profileId, expectedRevision, [...current.records.filter(item => item.id !== record.id), record], receipt)
        this.remember(profileId, record.id, { state: 'loaded' }); this.prepared.delete(reviewId)
        return { profileId, profileRevision: saved.profileRevision, outcome: 'applied' as const, receipt, application: { state: 'loaded' as const } }
      } catch (cause) {
        if (!nativeAttempted) throw cause
        await this.restoreAfterFailure(profileId, receipt.extensionId, previous)
        return unavailable('The extension change is unconfirmed. The original Profile, files and request identity remain; inspect this operation and native load state before another action.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED', receipt)
      }
    })
  }
  private async restoreAfterFailure(profileId: string, extensionId: string, previous?: BrowserProfileExtensionRecord): Promise<void> {
    try {
      const actual = await this.ports.read(profileId), record = actual.records.find(record => record.id === extensionId)
      if (record) { if (this.observe(profileId, record).state !== 'loaded') await this.loadRecord(profileId, record); return }
      const native = this.ports.existingSession(profileId)
      // A new installation with no durable metadata must not remain active after a failed commit.
      if (native) for (const loaded of native.extensions.getAllExtensions()) {
        if (loaded.path.startsWith(join(this.ports.root(profileId), extensionId) + '/')) native.extensions.removeExtension(loaded.id)
      }
      if (previous) this.remember(profileId, extensionId, { state: 'unknown', reason: 'Original extension metadata was not confirmed. Existing files and Profile work remain; inspect the original operation.' })
    } catch { this.remember(profileId, extensionId, { state: 'unknown', reason: 'The extension change and restoration are unconfirmed. Original files and Profile work remain; restore storage and inspect this operation.' }) }
  }
  async remove(profileId: string, expectedRevision: string, extensionId: string, operationId: string) {
    return this.ports.change(profileId, async () => {
      let current = await this.ports.read(profileId), existing = current.receipts.find(receipt => receipt.operationId === operationId)
      if (existing) {
        if (existing.kind !== 'remove' || existing.extensionId !== extensionId) return unavailable('This original extension operation belongs to a different request.')
        return { profileId, profileRevision: current.profileRevision, outcome: 'applied' as const, receipt: existing }
      }
      if (current.pending.some(intent => intent.operationId === operationId)) return unavailable('This original removal has an unconfirmed native effect. Inspect that same operation before another action; it was not replayed.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED', { profileId, operationId })
      const record = current.records.find(record => record.id === extensionId)
      if (!record || current.profileRevision !== expectedRevision) return unavailable('The exact installed extension or Profile revision changed. Original data is kept; read the current Profile.')
      if (!this.confirm) return unavailable('Human extension review is unavailable in this host.', 'HOST_CAPABILITY_UNAVAILABLE')
      const review: BrowserProfileExtensionReview = { reviewId: operationId, profileId, expectedRevision, extensionId, name: record.name, version: record.version,
        sha256: record.sha256, source: record.source, permissions: record.permissions, addedPermissions: [] }
      if (!await this.confirm({ kind: 'remove', review })) return { profileId, profileRevision: current.profileRevision, outcome: 'cancelled' as const, receipt: null }
      current = await this.ports.read(profileId)
      if (current.profileRevision !== expectedRevision) return unavailable('The Profile changed during removal review. No extension was removed.')
      const receipt: BrowserProfileExtensionReceipt = { operationId, profileId, extensionId, kind: 'remove', sha256: record.sha256 }
      try {
        try { await this.ports.begin(profileId, expectedRevision, { ...receipt, expectedRevision, version: record.version, previousSha256: record.sha256, nativeId: record.nativeId }) }
        catch { return unavailable('The original removal intent could not be confirmed saved. No native removal was dispatched; inspect this operation before retrying.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED', receipt) }
        const target = this.ports.existingSession(profileId)
        target?.extensions.removeExtension(record.nativeId)
        if (target?.extensions.getExtension(record.nativeId)) return unavailable('The host did not confirm that this extension was unloaded.')
        const saved = await this.ports.commit(profileId, expectedRevision, current.records.filter(record => record.id !== extensionId), receipt)
        this.applications.get(profileId)?.delete(extensionId)
        return { profileId, profileRevision: saved.profileRevision, outcome: 'applied' as const, receipt }
      } catch {
        await this.restoreAfterFailure(profileId, extensionId, record)
        return unavailable('Extension removal is unconfirmed. Its original package and Profile data remain; inspect the original operation before retrying.', 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED', receipt)
      }
    })
  }
}
