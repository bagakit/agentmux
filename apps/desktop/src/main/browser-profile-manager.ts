import { mintCapabilityToken } from '@agentmux/core/object-id'
import { BrowserWindow, session, type Session } from 'electron'
import type {
  BrowserProfileImportSourceSummary,
  BrowserProfileSummary,
  BrowserProfileDeleteApproval
} from '../shared/contracts.js'
import type {
  BrowserProfileImportSource,
  BrowserProfileImportPlan
} from './browser-profile-import-source.js'
import {
  browserProfilePartition,
  BrowserProfileStore,
  validateBrowserProfileLabel,
  type BrowserProfileEdit,
  type BrowserProfileSnapshot
} from './browser-profile-store.js'
import type { BrowserProfileResolver } from './browser-view-manager.js'

const PROFILE_IMPORT_SOURCE_TOKEN_TTL_MS = 5 * 60_000
const IMPORT_DOCUMENT_URL = 'data:text/html,<!doctype html><title>AgentMux Browser Profile import</title>'

type ImportSourceToken = {
  source: BrowserProfileImportSource
  expiresAt: number
}

function cloneProfile(profile: BrowserProfileSummary): BrowserProfileSummary {
  return {
    ...profile,
    source: profile.source ? { ...profile.source } : null
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
  private readonly profiles = new Map<string, BrowserProfileSummary>()
  private readonly sourceTokens = new Map<string, ImportSourceToken>()
  private readonly importWindows = new Set<BrowserWindow>()
  private readonly activeMutations = new Set<Promise<unknown>>()
  private readonly changeListeners = new Set<(snapshot: BrowserProfileSnapshot) => void>()
  /** Profiles whose partition is being cleared; a snapshot committed meanwhile cannot bring them back. */
  private readonly deleting = new Set<string>()
  private defaultId: string | null = null
  private revision = 0
  private initialization: Promise<void> | null = null
  private initializationError: Error | null = null
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(private readonly store = new BrowserProfileStore()) {}

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
      // A deleted Profile is already out of the list, so a clear that fails again blocks nothing.
      for (const profileId of await this.store.listPendingDeletes()) {
        try { await this.clearPartition(profileId); await this.store.finishDelete(profileId) }
        catch (error) { console.warn('A deleted Browser Profile still has site data; clearing is retried at the next start.', error) }
      }

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
    if (!this.profiles.has(profileId)) throw new Error(`Unknown Browser Profile: ${profileId}`)
    return browserProfilePartition(profileId)
  }

  listProfiles(): BrowserProfileSummary[] {
    this.assertInitialized()
    return [...this.profiles.values()].map(cloneProfile)
  }

  /** Revision of the list this Main last committed or loaded; edits must name it. */
  listRevision(): number {
    this.assertInitialized()
    return this.revision
  }

  /** Called with the whole committed list after every store write, in revision order. */
  onChange(listener: (snapshot: BrowserProfileSnapshot) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  async updateProfile(profileId: string, edit: BrowserProfileEdit, expectedRevision: number): Promise<BrowserProfileSummary> {
    this.resolvePartition(profileId)
    return await this.trackMutation((async () => {
      const { snapshot, profile } = await this.store.updateProfile(profileId, edit, expectedRevision)
      this.adopt(snapshot)
      return cloneProfile(profile)
    })())
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

  async deleteProfile(profileId: string, approval: BrowserProfileDeleteApproval): Promise<void> {
    if (
      approval?.kind !== 'user-confirmed' ||
      approval.operation !== 'delete-profile' ||
      approval.scope !== 'profile' ||
      approval.profileId !== profileId
    ) {
      throw Object.assign(new Error('Browser Profile deletion requires explicit user approval'), {
        code: 'BROWSER_DESTRUCTIVE_APPROVAL_REQUIRED'
      })
    }
    this.resolvePartition(profileId)
    if (profileId === this.defaultId) throw new Error('The default Browser Profile cannot be deleted')
    const profile = this.profiles.get(profileId)!
    await this.trackMutation((async () => {
      this.profiles.delete(profileId)
      this.deleting.add(profileId)
      // The list is written first. Clearing first could leave a listed Profile with its sign-ins gone.
      let snapshot: BrowserProfileSnapshot
      try { snapshot = await this.store.deleteProfile(profileId) }
      catch (error) {
        this.deleting.delete(profileId)
        this.profiles.set(profileId, profile)
        throw error
      }
      this.deleting.delete(profileId)
      this.adopt(snapshot)
      await this.clearDeleted(profileId, profile.label)
    })())
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
        skippedCookies: plan.skippedCookies
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
    for (const profile of snapshot.profiles) if (!this.deleting.has(profile.id)) this.profiles.set(profile.id, cloneProfile(profile))
    this.defaultId = snapshot.defaultProfileId
    this.revision = snapshot.revision
  }

  /** The store committed this whole list; it replaces the cache, then subscribers hear it. */
  private adopt(snapshot: BrowserProfileSnapshot): void {
    if (this.disposed) return
    this.replace(snapshot)
    for (const listener of this.changeListeners) {
      // A subscriber cannot turn a committed write into a failure.
      try { listener({ revision: snapshot.revision, defaultProfileId: snapshot.defaultProfileId, profiles: this.listProfiles() }) }
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

  /** A deleted Profile's data is cleared after the list commits; failure keeps its record for the next start. */
  private async clearDeleted(profileId: string, label: string): Promise<void> {
    try {
      await this.clearPartition(profileId)
      await this.store.finishDelete(profileId)
    } catch (cause) {
      throw Object.assign(new Error(`${label} was deleted, but clearing its sign-ins and site data did not finish. AgentMux clears it again when it next starts.`, { cause }),
        { code: 'BROWSER_PROFILE_DATA_CLEAR_PENDING', profileId })
    }
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
