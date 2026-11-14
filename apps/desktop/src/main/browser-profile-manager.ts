import type { BrowserProfileTrashEntry, BrowserProfileNativeUse, BrowserProfileRecycleReceipt, BrowserProfileRestoreReceipt } from '@agentmux/core/control'
import { describeRetainedPartition, inspectRetainedPartition, retainedPartitionPath, BrowserProfileDataUnavailable } from './browser-profile-retained-data.js'
import { resolve } from 'node:path'
import { type BrowserProxyAsset, type BrowserProxyEdit, type BrowserProxyBinding, parseBrowserProfileQuery, parseBrowserProfileSelection, parseBrowserProfileBulkAction, type BrowserProfileQuery, type BrowserProfileView, type BrowserProfileViewSaveReceipt, type BrowserProfileBulkAction, type BrowserProfileSelectionItem, type BrowserProfileBulkItemResult } from '@agentmux/core/control'
import { mintCapabilityToken, mintObjectId } from '@agentmux/core/object-id'
import { app, BrowserWindow, session, webContents, type Session } from 'electron'
import type {
  BrowserProfileImportSourceSummary,
  BrowserProfileSummary,
  BrowserProfileFolder,
  BrowserProfileDeleteApproval
} from '../shared/contracts.js'
import type {
  BrowserProfileImportSource,
  BrowserProfileImportPlan
} from './browser-profile-import-source.js'
import {
  browserProfilePartition,
  BrowserProfileStore,
  profileSummary, type BrowserProfileTrashRecord,
  BrowserProfileConfigurationConflict,
  type BrowserProfileActivityCheckpoint,
  validateBrowserProfileLabel,
  type BrowserProfileEdit,
  type BrowserProfileSnapshot
} from './browser-profile-store.js'
import type { BrowserProfileResolver } from './browser-view-manager.js'
import { presentSkipCounts } from '../shared/browser-profile-import-skip.js'
import { normalizeBrowserProfileNetwork } from '../shared/browser-profile-network.js'
import { createBrowserProfileSessions, type BrowserProfileSessions } from './browser-profile-session.js'

const PROFILE_IMPORT_SOURCE_TOKEN_TTL_MS = 5 * 60_000
const IMPORT_DOCUMENT_URL = 'data:text/html,<!doctype html><title>AgentMux Browser Profile import</title>'

type ImportSourceToken = {
  source: BrowserProfileImportSource
  expiresAt: number
}

function cloneProfile(profile: BrowserProfileSummary): BrowserProfileSummary {
  return {
    ...profile,
    ...(profile.activity ? { activity: { ...profile.activity } } : {}),
    ...(profile.tags ? { tags: [...profile.tags] } : {}),
    ...(profile.proxyBinding ? { proxyBinding: { ...profile.proxyBinding } } : {}),
    source: profile.source ? { ...profile.source } : null,
    ...(profile.environment ? { environment: structuredClone(profile.environment) } : {})
  }
}

function assertCookieWriteResult(value: unknown, index: number): void {
  if (!value || typeof value !== 'object' || (value as { success?: unknown }).success !== true) {
    throw new Error(`Chromium rejected imported cookie ${index + 1}`)
  }
}

function throwPublicBrowserProfileError(message: string, cause: unknown): never {
  console.error(message, cause)
  throw new Error(message)
}

export class BrowserProfileManager implements BrowserProfileResolver {
  private folders: BrowserProfileFolder[] = []
  private views: BrowserProfileView[] = []
  private proxyAssets: BrowserProxyAsset[] = []
  private readonly profiles = new Map<string, BrowserProfileSummary>()
  private readonly sourceTokens = new Map<string, ImportSourceToken>()
  private readonly importWindows = new Set<BrowserWindow>()
  private readonly activeMutations = new Set<Promise<unknown>>()
  private readonly changeListeners = new Set<(snapshot: BrowserProfileSnapshot) => void>()
  /** Temporary admission fence for this exact Profile during a queued recycle or restore. */
  private readonly retiring = new Set<string>()
  private readonly archivedProfiles = new Map<string, BrowserProfileTrashRecord>()
  private legacyPendingDeletes: string[] = []
  private defaultId: string | null = null
  private revision = 0
  private sequence = 0
  private activitySources: Record<string, string> = {}
  readonly activityObserverId = mintObjectId()
  /** Original encrypted credential owner pins its current endpoint before this Profile changes routes. */
  bindProxyCredentialsBeforeNetworkChange?: (profileId: string) => Promise<void>
  private readonly configurationTails = new Map<string, Promise<unknown>>()
  private initialization: Promise<void> | null = null
  private initializationError: Error | null = null
  private disposed = false
  private disposePromise: Promise<void> | null = null

  /** Applies each Profile's route to its own session; the view manager awaits it before any page opens. */
  readonly sessions: BrowserProfileSessions

  constructor(private readonly store = new BrowserProfileStore(), sessions?: BrowserProfileSessions, private readonly sessionRoot: () => string = () => app.getPath('sessionData')) {
    this.sessions = sessions ?? createBrowserProfileSessions({
      session: profileId => session.fromPartition(this.resolvePartition(profileId)),
      retainedSession: profileId => {
        this.assertInitialized()
        if (!this.profiles.has(profileId) && !this.archivedProfiles.has(profileId)) throw new Error(`Unknown retained Browser Profile: ${profileId}`)
        return session.fromPartition(browserProfilePartition(profileId))
      },
      network: profileId => (this.profiles.get(profileId) ?? this.archivedProfiles.get(profileId)?.profile)?.network,
      environment: profileId => (this.profiles.get(profileId) ?? this.archivedProfiles.get(profileId)?.profile)?.environment,
      defaultLanguage: () => app.getLocale(),
      openContents: () => webContents.getAllWebContents()
    })
  }

  /** Await before creating, restoring or switching any page into this Profile; nothing to await without a route. */
  prepareSession(profileId: string): Promise<void> | undefined {
    this.resolvePartition(profileId)
    return this.sessions.prepare(profileId)
  }

  environmentSettings(profileId: string): import('@agentmux/core/control').BrowserProfileEnvironment | undefined { const value = this.profiles.get(profileId)?.environment; return value && structuredClone(value) }
  preparePageEnvironment(profileId: string, browserId: string, contents: import('electron').WebContents, port: import('./browser-profile-page-environment.js').BrowserProfilePageEnvironmentPorts): Promise<void> { return this.sessions.preparePageEnvironment?.(profileId, browserId, contents, port) ?? Promise.resolve() }
  environmentApplication(profileId: string) { return this.sessions.environmentApplication?.(profileId) }
  hasOnlyEnvironmentDebugger(profileId: string, contents: import('electron').WebContents): boolean { return this.sessions.hasOnlyEnvironmentDebugger?.(profileId,contents) === true }
  publishEnvironmentBindings(profileIds:readonly string[]):void { this.sessions.publishEnvironmentBindings?.(profileIds) }
  onEnvironmentApplicationChange(listener: (profileId: string) => void): () => void {
    return this.sessions.onEnvironmentApplicationChange?.(listener) ?? (() => {})
  }

  async initialize(): Promise<void> {
    this.assertActive()
    if (this.defaultId) return
    if (this.initialization) return await this.initialization
    const attempt = this.trackMutation((async () => {
      let snapshot = await this.store.list()
      if (!snapshot.profiles.some((profile) => profile.id === snapshot.defaultProfileId)) throw new Error('Browser Profile metadata has no default Profile')

      for (const pending of await this.store.listPendingImports()) {
        await this.clearPartition(pending.profileId)
        snapshot = await this.store.abortPendingImport(pending.profileId)
      }
      // Historical deletion tombstones contain no recoverable Profile record. Keep their original
      // data and IDs; the recycle-bin service window exposes the unconfirmed cleanup explicitly.
      // Loading is a read, not a change; only later commits are published.
      this.replace(snapshot)
      this.initializationError = null
    })()).catch(cause => {
      this.initializationError = new Error(`Browser Profiles could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}. Original profile data is kept. Repair the metadata or its access, then retry the Profile connection.`, { cause })
      throw this.initializationError
    }).finally(() => {
      if (this.initialization === attempt) this.initialization = null
    })
    this.initialization = attempt
    await attempt
  }

  defaultProfileId(): string {
    this.assertInitialized()
    return this.defaultId!
  }

  resolvePartition(profileId: string): string {
    this.assertInitialized()
    if (this.retiring.has(profileId)) throw Object.assign(new Error('This exact Profile is being recycled or restored. Its original data is kept; retry after that operation.'), { code: 'BROWSER_PROFILE_RETIREMENT_PENDING' })
    if (!this.profiles.has(profileId)) throw new Error(`Unknown Browser Profile: ${profileId}`)
    return browserProfilePartition(profileId)
  }

  /** The listed Profile that owns this session, or null for a private page, a Capsule or anything else. */
  profileOfSession(target: Session): string | null {
    if (!this.defaultId) return null
    const id = this.sessions.profileOfSession?.(target)
    return id && (this.profiles.has(id) || this.archivedProfiles.has(id)) ? id : null
  }

  /** The proxy server a Profile's route sends its pages through, if its route is a proxy. */
  proxyOf(profileId: string): { host: string; port: number } | null {
    const network = (this.profiles.get(profileId) ?? this.archivedProfiles.get(profileId)?.profile)?.network
    return network?.mode === 'proxy' ? { host: network.server.host, port: network.server.port } : null
  }

  listProfiles(): BrowserProfileSummary[] {
    this.assertInitialized()
    return [...this.profiles.values()].map(profile => this.presentProfile(profile))
  }

  private archiveSummary(entry: BrowserProfileTrashRecord): BrowserProfileTrashEntry {
    return { id: entry.id, revision: entry.revision, archivedAt: entry.archivedAt,
      profile: this.presentProfile(profileSummary(entry.profile, this.defaultId!), false), dataOwner: 'original-partition' }
  }

  listTrash(): BrowserProfileTrashEntry[] { this.assertInitialized(); return [...this.archivedProfiles.values()].map(entry => this.archiveSummary(entry)) }
  /** Retained references, including future fields on the original full Profile record. No Session is acquired. */
  listTrashedProfiles(): BrowserProfileSummary[] { this.assertInitialized(); return [...this.archivedProfiles.values()].map(entry => this.presentProfile(profileSummary(entry.profile, this.defaultId!), false)) }
  listLegacyPendingDeletes(): string[] { this.assertInitialized(); return [...this.legacyPendingDeletes] }
  nativeUse(profileId: string): BrowserProfileNativeUse {
    return this.sessions.nativeUse?.(profileId) ?? { status: 'unknown', pages: null, workers: null, requests: null, downloads: null, reason: 'Native Profile ownership is unavailable; the original Profile remains available.' }
  }

  listViews(): BrowserProfileView[] { this.assertInitialized(); return structuredClone(this.views) }

  async saveView(label: string, query: BrowserProfileQuery, expectedRevision: number, viewId?: string): Promise<BrowserProfileViewSaveReceipt> {
    this.assertInitialized()
    return this.trackMutation((async () => {
      const { snapshot, view } = await this.store.saveView(label, parseBrowserProfileQuery(query), expectedRevision, viewId)
      this.adopt(snapshot)
      return { view, revision: snapshot.revision }
    })())
  }

  async deleteView(viewId: string, expectedRevision: number): Promise<void> {
    this.assertInitialized()
    return this.trackMutation((async () => { this.adopt(await this.store.deleteView(viewId, expectedRevision)) })())
  }

  async bulkUpdate(itemsInput: BrowserProfileSelectionItem[], actionInput: BrowserProfileBulkAction): Promise<BrowserProfileBulkItemResult[]> {
    this.assertInitialized()
    // Validate the entire request before a first write. Never recompute a selection from a query.
    const items = parseBrowserProfileSelection(itemsInput), action = parseBrowserProfileBulkAction(actionInput)
    if (action.kind === 'move' && action.folderId !== null && !this.folders.some(folder => folder.id === action.folderId)) throw new Error('The selected destination folder is unavailable. No Profile was changed.')
    const results: BrowserProfileBulkItemResult[] = []
    for (const item of items) {
      try {
        const profile = await this.configuration(item.profileId, async () => {
          const { profile: current } = await this.store.inspectProfile(item.profileId)
          if (current.revision !== item.expectedRevision) throw new BrowserProfileConfigurationConflict(current.revision)
          const edit: BrowserProfileEdit = action.kind === 'pin' ? { pinned: action.pinned } : action.kind === 'move' ? { folderId: action.folderId }
            : { tags: action.kind === 'add-tag' ? [...(current.tags ?? []), action.tag] : (current.tags ?? []).filter(tag => tag !== action.tag) }
          const saved = await this.store.updateProfile(item.profileId, edit, item.expectedRevision)
          this.adopt(saved.snapshot)
          return this.presentProfile(saved.profile)
        })
        results.push({ ...item, outcome: 'updated', profile })
      } catch (cause) {
        results.push({ ...item, outcome: 'failed', code: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'BROWSER_PROFILE_BULK_UPDATE_FAILED',
          message: cause instanceof Error ? cause.message : 'This Profile change could not be confirmed. Read the original Profile before retrying.' })
      }
    }
    return results
  }

  listFolders(): BrowserProfileFolder[] { this.assertInitialized(); return this.folders.map(folder => ({ ...folder })) }

  /** Configuration collection revision; folder writes name this stamp, Profile edits use their own token. */
  listRevision(): number {
    this.assertInitialized()
    return this.revision
  }

  listSequence(): number { this.assertInitialized(); return this.sequence }
  activitySource(profileId: string): string | null { return this.activitySources[profileId] ?? null }
  async recordActivity(profileId: string, checkpoint: BrowserProfileActivityCheckpoint): Promise<void> {
    this.assertInitialized()
    await this.trackMutation((async () => { this.adopt(await this.store.recordActivity(profileId, checkpoint)) })())
  }

  private configuration<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    const result = (this.configurationTails.get(profileId) ?? Promise.resolve()).catch(() => {}).then(action)
    this.configurationTails.set(profileId, result)
    void result.finally(() => { if (this.configurationTails.get(profileId) === result) this.configurationTails.delete(profileId) }).catch(() => {})
    return this.trackMutation(result)
  }

  /** Called with the whole committed list after every store write, in snapshot sequence order. */
  onChange(listener: (snapshot: BrowserProfileSnapshot) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  async updateProfile(profileId: string, edit: BrowserProfileEdit, expectedRevision: string): Promise<BrowserProfileSummary> {
    this.resolvePartition(profileId)
    return this.configuration(profileId, () => this.applyProfileEdit(profileId, edit, expectedRevision))
  }

  private async applyProfileEdit(profileId: string, edit: BrowserProfileEdit, expectedRevision: string, binding?: BrowserProxyBinding): Promise<BrowserProfileSummary> {
    const network = edit.network === undefined ? undefined : edit.network === null ? null : normalizeBrowserProfileNetwork(edit.network)
    const observed = await this.store.inspectProfile(profileId), current = observed.profile
    if (observed.snapshot.sequence > this.sequence) this.adopt(observed.snapshot)
    if (expectedRevision !== current.revision) throw new BrowserProfileConfigurationConflict(current.revision)
    if (network !== undefined) {
      if (JSON.stringify(current.network ?? { mode: 'system' }) !== JSON.stringify(network ?? { mode: 'system' })) await this.bindProxyCredentialsBeforeNetworkChange?.(profileId)
      let saved: Awaited<ReturnType<BrowserProfileStore['updateProfile']>>
      let writeAttempted = false
      try {
        await this.sessions.apply(profileId, network === null || network.mode === 'system' ? undefined : network)
        writeAttempted = true
        saved = await this.store.updateProfile(profileId, { ...edit, ...(network === null ? { network: null } : { network }) }, expectedRevision, binding)
      } catch (error) {
        let restore = current.network
        if (writeAttempted) {
          const snapshot = await this.observeUnconfirmedWrite(error)
          const actual = snapshot.profiles.find(profile => profile.id === profileId)
          if (!actual) throw Object.assign(new Error('The original Profile metadata is unavailable after an unconfirmed write. Its native page and request are retained; no substitute route was applied.', { cause: error }), { code: 'BROWSER_PROFILE_WRITE_UNCONFIRMED' })
          restore = actual.network
        }
        try { await this.sessions.apply(profileId, restore) }
        catch (rollbackError) { throw Object.assign(new AggregateError([error, rollbackError], 'The Profile metadata mutation and its network restoration did not both receive confirmation. Browser controls remain available; inspect the original Profile and route before retrying.'), { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_PROFILE_NETWORK_UNAVAILABLE' }) }
        throw error
      }
      this.adopt(saved.snapshot)
      this.sessions.applyEnvironment?.(profileId)
      return this.presentProfile(saved.profile)
    }
    const { snapshot, profile } = await this.store.updateProfile(profileId, edit, expectedRevision)
    this.adopt(snapshot)
    if (edit.environment !== undefined) this.sessions.applyEnvironment?.(profileId)
    return this.presentProfile(profile)
  }

  listProxies(): BrowserProxyAsset[] { this.assertInitialized(); return structuredClone(this.proxyAssets) }

  async saveProxy(edit: BrowserProxyEdit, proxyId?: string, expectedRevision?: string): Promise<{ proxy: BrowserProxyAsset; revision: number }> {
    this.assertInitialized()
    return this.trackMutation((async () => {
      let saved: Awaited<ReturnType<BrowserProfileStore['saveProxy']>>
      try { saved = await this.store.saveProxy(edit, proxyId, expectedRevision) }
      catch (error) { await this.observeUnconfirmedWrite(error); throw error }
      this.adopt(saved.snapshot)
      return { proxy: saved.proxy, revision: saved.snapshot.revision }
    })())
  }

  async deleteProxy(proxyId: string, expectedRevision: string): Promise<{ proxyId: string; revision: number; deleted: true }> {
    this.assertInitialized()
    return this.trackMutation((async () => {
      let snapshot: BrowserProfileSnapshot
      try { snapshot = await this.store.deleteProxy(proxyId, expectedRevision) }
      catch (error) { await this.observeUnconfirmedWrite(error); throw error }
      this.adopt(snapshot)
      return { proxyId, revision: snapshot.revision, deleted: true as const }
    })())
  }

  /** Read actual original bytes after an uncertain write; never replay it or sign durability from a read. */
  private async observeUnconfirmedWrite(cause: unknown): Promise<BrowserProfileSnapshot> {
    try {
      const snapshot = await this.store.list()
      this.adopt(snapshot)
      return snapshot
    } catch (readError) {
      throw Object.assign(new AggregateError([cause, readError], 'The original Profile metadata write and readback are unconfirmed. Original bytes, native pages and input are retained. Repair the original metadata access before retrying; no write was replayed.'), { code: 'BROWSER_PROFILE_WRITE_UNCONFIRMED' })
    }
  }

  async assignProxy(proxyId: string, expectedRevision: string, input: BrowserProfileSelectionItem[]): Promise<BrowserProfileBulkItemResult[]> {
    this.assertInitialized()
    const items = parseBrowserProfileSelection(input), results: BrowserProfileBulkItemResult[] = []
    for (const item of items) {
      try {
        const profile = await this.configuration(item.profileId, async () => {
          this.resolvePartition(item.profileId)
          const proxy = await this.store.inspectProxy(proxyId, expectedRevision)
          return this.applyProfileEdit(item.profileId, { network: { mode: 'proxy', server: proxy.server, ...(proxy.bypass ? { bypass: proxy.bypass } : {}) } }, item.expectedRevision, { proxyId, revision: expectedRevision })
        })
        results.push({ ...item, outcome: 'updated', profile })
      } catch (cause) {
        results.push({ ...item, outcome: 'failed', code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'BROWSER_PROXY_ASSIGNMENT_FAILED', message: cause instanceof Error ? cause.message : 'The exact Profile assignment is unconfirmed. Inspect its current configuration before retrying.' })
      }
    }
    return results
  }

  private presentProfile(profile: BrowserProfileSummary, includeApplication = true): BrowserProfileSummary {
    const application = includeApplication ? this.sessions.environmentApplication?.(profile.id) : undefined, networkApplication = includeApplication ? this.sessions.networkApplication?.(profile.id, profile.network) : undefined
    return { ...cloneProfile(profile), ...(networkApplication ? { networkApplication } : {}), ...(profile.activity && this.activitySources[profile.id] !== this.activityObserverId && profile.activity.state === 'running'
      ? { activity: { ...profile.activity, state: 'unknown' as const } } : {}), ...(application ? { environmentApplication: application } : {}) }
  }

  /** Only Browsers created later without an explicit Profile use the new default. */
  async setDefaultProfile(profileId: string): Promise<void> {
    this.resolvePartition(profileId)
    await this.trackMutation((async () => {
      this.adopt(await this.store.setDefaultProfile(profileId))
    })())
  }

  async createProfile(label: string): Promise<BrowserProfileSummary> {
    this.assertInitialized()
    const validatedLabel = validateBrowserProfileLabel(label)
    return await this.trackMutation((async () => {
      const { snapshot, profile } = await this.store.createProfile(validatedLabel)
      this.adopt(snapshot)
      return cloneProfile(profile)
    })())
  }

  /** Copy only saved settings. A new native session is prepared when a Browser actually opens it. */
  async copyProfile(profileId: string, label: string, expectedRevision: string): Promise<BrowserProfileSummary> {
    this.resolvePartition(profileId)
    return this.configuration(profileId, async () => {
      const { snapshot, profile } = await this.store.copyProfile(profileId, label, expectedRevision)
      this.adopt(snapshot)
      return cloneProfile(profile)
    })
  }

  async createFolder(label: string, expectedRevision: number): Promise<BrowserProfileFolder> {
    this.assertInitialized()
    return this.trackMutation((async () => { const { snapshot, folder } = await this.store.createFolder(label, expectedRevision); this.adopt(snapshot); return folder })())
  }
  async renameFolder(folderId: string, label: string, expectedRevision: number): Promise<BrowserProfileFolder> {
    this.assertInitialized()
    return this.trackMutation((async () => { const { snapshot, folder } = await this.store.renameFolder(folderId, label, expectedRevision); this.adopt(snapshot); return folder })())
  }
  async deleteFolder(folderId: string, expectedRevision: number): Promise<{ folderId: string; unassignedProfileIds: string[] }> {
    this.assertInitialized()
    return this.trackMutation((async () => { const { snapshot, ...receipt } = await this.store.deleteFolder(folderId, expectedRevision); this.adopt(snapshot); return receipt })())
  }

  async deleteProfile(profileId: string, approval: BrowserProfileDeleteApproval, expectedRevision: string,
    assertUnused: () => Promise<void>): Promise<BrowserProfileRecycleReceipt> {
    if (approval?.kind !== 'user-confirmed' || approval.operation !== 'delete-profile' || approval.scope !== 'profile' || approval.profileId !== profileId) {
      throw Object.assign(new Error('Profile recycling requires approval for this exact Profile'), { code: 'BROWSER_DESTRUCTIVE_APPROVAL_REQUIRED' })
    }
    return this.configuration(profileId, async () => {
      const current = await this.store.inspectProfile(profileId)
      if (current.profile.revision !== expectedRevision) throw new BrowserProfileConfigurationConflict(current.profile.revision)
      if (current.profile.isDefault) throw new Error('The default Browser Profile cannot be recycled')
      // Establish the exact original native data/observation owner before checking all consumers.
      const target = this.sessions.nativeSession?.(profileId)
      if (!target) throw new BrowserProfileDataUnavailable()
      await assertUnused()
      this.retiring.add(profileId)
      try {
        const data = describeRetainedPartition(this.sessionRoot(), profileId, target.storagePath)
        await inspectRetainedPartition(this.sessionRoot(), data)
        // Source IO yields; recheck accurate native/cold ownership while new native admissions are fenced.
        await assertUnused()
        const { snapshot, archive } = await this.store.archiveProfile(profileId, expectedRevision, data)
        this.adopt(snapshot)
        return { revision: snapshot.revision, archive: this.archiveSummary(archive) }
      } finally { this.retiring.delete(profileId) }
    })
  }

  async restoreProfile(archiveId: string, expectedRevision: string, folderId?: string | null): Promise<BrowserProfileRestoreReceipt> {
    this.assertInitialized()
    const first = await this.store.inspectArchive(archiveId)
    return this.configuration(first.archive.profile.id, async () => {
      const { archive } = await this.store.inspectArchive(archiveId), profileId = archive.profile.id
      if (archive.revision !== expectedRevision) throw new BrowserProfileConfigurationConflict(archive.revision)
      this.retiring.add(profileId)
      try {
        // Check the held original directory before a native factory could create an empty replacement.
        await inspectRetainedPartition(this.sessionRoot(), archive.data)
        const target = this.sessions.retainedSession?.(profileId)
        if (!target || !target.storagePath || resolve(target.storagePath) !== retainedPartitionPath(this.sessionRoot(), archive.data)) throw new BrowserProfileDataUnavailable()
        const saved = await this.store.restoreProfile(archiveId, expectedRevision, folderId)
        this.adopt(saved.snapshot)
        return { revision: saved.snapshot.revision, archiveId, profile: this.presentProfile(saved.profile) }
      } finally { this.retiring.delete(profileId) }
    })
  }

  async detectImportSources(): Promise<BrowserProfileImportSourceSummary[]> {
    this.assertInitialized()
    this.sourceTokens.clear()
    const expiresAt = Date.now() + PROFILE_IMPORT_SOURCE_TOKEN_TTL_MS
    let detected: BrowserProfileImportSource[]
    try {
      const { detectBrowserProfileImportSources } = await import('./browser-profile-import-source.js')
      this.assertInitialized()
      detected = detectBrowserProfileImportSources()
    } catch (error) {
      throwPublicBrowserProfileError('Browser Profile sources could not be detected', error)
    }
    return detected.map((source) => {
      const token = mintCapabilityToken()
      this.sourceTokens.set(token, { source, expiresAt })
      return {
        token,
        browserLabel: source.browserLabel,
        profileLabel: source.profileLabel
      }
    })
  }

  async importProfile(sourceToken: string, label: string): Promise<BrowserProfileSummary> {
    this.assertInitialized()
    const source = this.consumeSourceToken(sourceToken)
    const validatedLabel = validateBrowserProfileLabel(label)
    const operation = this.importProfileFromSource(source, validatedLabel)
    try {
      return await this.trackMutation(operation)
    } catch (error) {
      throwPublicBrowserProfileError('Browser Profile import failed', error)
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.sourceTokens.clear()
    this.disposePromise = (async () => {
      for (const window of this.importWindows) {
        if (!window.isDestroyed()) window.destroy()
      }
      await Promise.allSettled(this.activeMutations)
      this.importWindows.clear()
      this.profiles.clear()
      this.folders = []
      this.views = []
      this.defaultId = null
    })()
    return this.disposePromise
  }

  private async importProfileFromSource(
    source: BrowserProfileImportSource,
    label: string
  ): Promise<BrowserProfileSummary> {
    const { planBrowserProfileImport } = await import('./browser-profile-import-source.js')
    this.assertActive()
    const plan = planBrowserProfileImport(source)
    this.assertActive()
    const begun = await this.store.beginPendingImport(label)
    this.adopt(begun.snapshot)
    const pending = begun.pending
    try {
      await this.writePlan(pending.profileId, plan)
      this.assertActive()
      const { snapshot, profile } = await this.store.commitImportedProfile(pending.profileId, {
        browserLabel: plan.browserLabel,
        profileLabel: plan.profileLabel,
        importedAt: Date.now(),
        importedCookies: plan.importedCookies,
        skippedCookies: plan.skippedCookies,
        skippedByReason: presentSkipCounts(plan.skippedByReason)
      })
      this.adopt(snapshot)
      return cloneProfile(profile)
    } catch (error) {
      try {
        await this.clearPartition(pending.profileId)
        this.adopt(await this.store.abortPendingImport(pending.profileId))
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Browser Profile import failed and its pending partition could not be cleaned'
        )
      }
      throw error
    }
  }

  private async writePlan(profileId: string, plan: BrowserProfileImportPlan): Promise<void> {
    const partition = browserProfilePartition(profileId)
    const targetSession = session.fromPartition(partition)
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    this.importWindows.add(window)
    let debuggerAttached = false
    let primaryFailed = false
    let primaryError: unknown
    try {
      await window.loadURL(IMPORT_DOCUMENT_URL)
      this.assertActive()
      window.webContents.debugger.attach()
      debuggerAttached = true
      await window.webContents.debugger.sendCommand('Network.enable')
      for (const [index, cookie] of plan.cookies.entries()) {
        this.assertActive()
        assertCookieWriteResult(
          await window.webContents.debugger.sendCommand('Network.setCookie', cookie),
          index
        )
      }
      await targetSession.flushStorageData()
    } catch (error) {
      primaryFailed = true
      primaryError = error
      throw error
    } finally {
      try {
        if (debuggerAttached && window.webContents.debugger.isAttached()) {
          window.webContents.debugger.detach()
        }
      } catch (cleanupError) {
        if (primaryFailed) {
          throw new AggregateError(
            [primaryError, cleanupError],
            'Browser Profile import failed and its debugger could not be detached'
          )
        }
        throw cleanupError
      } finally {
        this.importWindows.delete(window)
        if (!window.isDestroyed()) window.destroy()
      }
    }
  }

  private async trackMutation<T>(operation: Promise<T>): Promise<T> {
    this.activeMutations.add(operation)
    try {
      return await operation
    } finally {
      this.activeMutations.delete(operation)
    }
  }

  private replace(snapshot: BrowserProfileSnapshot): void {
    this.profiles.clear()
    this.archivedProfiles.clear()
    for (const entry of snapshot.trash) this.archivedProfiles.set(entry.profile.id, structuredClone(entry))
    this.legacyPendingDeletes = [...snapshot.legacyPendingDeletes]
    this.views = structuredClone(snapshot.views)
    this.proxyAssets = structuredClone(snapshot.proxyAssets ?? [])
    this.folders = snapshot.folders.map(folder => ({ ...folder }))
    for (const profile of snapshot.profiles) this.profiles.set(profile.id, cloneProfile(profile))
    this.defaultId = snapshot.defaultProfileId
    this.revision = snapshot.revision
    this.sequence = snapshot.sequence
    this.activitySources = { ...snapshot.activitySources }
  }

  /** The store committed this whole list; it replaces the cache, then subscribers hear it. */
  private adopt(snapshot: BrowserProfileSnapshot): void {
    if (this.disposed || snapshot.sequence < this.sequence) return
    this.replace(snapshot)
    for (const listener of this.changeListeners) {
      // A subscriber cannot turn a committed write into a failure.
      try { listener({ proxyAssets: this.listProxies(), activitySources: { ...this.activitySources }, sequence: snapshot.sequence, revision: snapshot.revision, defaultProfileId: snapshot.defaultProfileId, profiles: this.listProfiles(), folders: this.listFolders(), views: this.listViews(), trash: structuredClone(snapshot.trash), legacyPendingDeletes: [...snapshot.legacyPendingDeletes] }) }
      catch (error) { console.error('A Browser Profile change subscriber failed; the change itself is committed.', error) }
    }
  }

  private consumeSourceToken(token: string): BrowserProfileImportSource {
    const entry = this.sourceTokens.get(token)
    this.sourceTokens.delete(token)
    if (!entry) throw new Error('Unknown or already consumed Browser Profile import source')
    if (entry.expiresAt < Date.now()) throw new Error('Browser Profile import source expired')
    return entry.source
  }

  private async clearPartition(profileId: string): Promise<void> {
    const targetSession: Session = session.fromPartition(browserProfilePartition(profileId))
    await targetSession.clearStorageData()
    await targetSession.flushStorageData()
  }

  private assertInitialized(): void {
    this.assertActive()
    if (!this.defaultId) throw this.initializationError ?? new Error('Browser Profiles are not confirmed yet. Other work is available; retry the Profile connection.')
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Browser Profile manager is disposed')
  }
}
