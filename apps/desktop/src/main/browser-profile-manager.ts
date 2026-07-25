import { randomUUID } from 'node:crypto'
import { BrowserWindow, session, type Session } from 'electron'
import type {
  BrowserProfileImportSourceSummary,
  BrowserProfileSummary
} from '../shared/contracts.js'
import {
  detectBrowserProfileImportSources,
  planBrowserProfileImport,
  type BrowserProfileImportSource,
  type BrowserProfileImportPlan
} from './browser-profile-import-source.js'
import {
  browserProfilePartition,
  BrowserProfileStore,
  validateBrowserProfileLabel
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
  private defaultId: string | null = null
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(private readonly store = new BrowserProfileStore()) {}

  async initialize(): Promise<void> {
    this.assertActive()
    await this.trackMutation((async () => {
      const profiles = await this.store.listProfiles()
      const defaultProfile = profiles.find((profile) => profile.isDefault)
      if (!defaultProfile) throw new Error('Browser Profile metadata has no default Profile')

      for (const pending of await this.store.listPendingImports()) {
        await this.clearPartition(pending.profileId)
        await this.store.abortPendingImport(pending.profileId)
      }

      this.profiles.clear()
      for (const profile of profiles) this.profiles.set(profile.id, cloneProfile(profile))
      this.defaultId = defaultProfile.id
    })())
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

  async createProfile(label: string): Promise<BrowserProfileSummary> {
    this.assertInitialized()
    const validatedLabel = validateBrowserProfileLabel(label)
    return await this.trackMutation((async () => {
      const profile = await this.store.createProfile(validatedLabel)
      this.profiles.set(profile.id, cloneProfile(profile))
      return cloneProfile(profile)
    })())
  }

  async deleteProfile(profileId: string): Promise<void> {
    this.resolvePartition(profileId)
    if (profileId === this.defaultId) throw new Error('The default Browser Profile cannot be deleted')
    const profile = this.profiles.get(profileId)!
    await this.trackMutation((async () => {
      this.profiles.delete(profileId)
      try {
        await this.clearPartition(profileId)
        await this.store.deleteProfile(profileId)
      } catch (error) {
        this.profiles.set(profileId, profile)
        throw error
      }
    })())
  }

  detectImportSources(): BrowserProfileImportSourceSummary[] {
    this.assertInitialized()
    this.sourceTokens.clear()
    const expiresAt = Date.now() + PROFILE_IMPORT_SOURCE_TOKEN_TTL_MS
    let detected: BrowserProfileImportSource[]
    try {
      detected = detectBrowserProfileImportSources()
    } catch (error) {
      throwPublicBrowserProfileError('Browser Profile sources could not be detected', error)
    }
    return detected.map((source) => {
      const token = randomUUID()
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
    const plan = planBrowserProfileImport(source)
    this.assertActive()
    const pending = await this.store.beginPendingImport(label)
    try {
      await this.writePlan(pending.profileId, plan)
      this.assertActive()
      const profile = await this.store.commitImportedProfile(pending.profileId, {
        browserLabel: plan.browserLabel,
        profileLabel: plan.profileLabel,
        importedAt: Date.now(),
        importedCookies: plan.importedCookies,
        skippedCookies: plan.skippedCookies
      })
      this.profiles.set(profile.id, cloneProfile(profile))
      return cloneProfile(profile)
    } catch (error) {
      try {
        await this.clearPartition(pending.profileId)
        await this.store.abortPendingImport(pending.profileId)
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
    if (!this.defaultId) throw new Error('Browser Profile manager is not initialized')
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Browser Profile manager is disposed')
  }
}
