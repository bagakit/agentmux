import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserProfileImportedSource,
  BrowserProfileSummary
} from '../src/shared/contracts.js'

const sourceMocks = vi.hoisted(() => ({
  detect: vi.fn(),
  plan: vi.fn()
}))

const electronMocks = vi.hoisted(() => {
  type FakeSession = {
    clearStorageData: ReturnType<typeof vi.fn>
    flushStorageData: ReturnType<typeof vi.fn>
  }
  const sessions = new Map<string, FakeSession>()
  const windows: FakeBrowserWindow[] = []
  let nextSetCookieResult: unknown = { success: true }
  let nextLoad: (() => Promise<void>) | null = null

  class FakeBrowserWindow {
    readonly partition: string
    destroyed = false
    readonly sendCommand = vi.fn(async (method: string) => (
      method === 'Network.setCookie' ? nextSetCookieResult : {}
    ))
    readonly webContents = {
      debugger: {
        attached: false,
        attach: vi.fn(() => { this.webContents.debugger.attached = true }),
        detach: vi.fn(() => { this.webContents.debugger.attached = false }),
        isAttached: vi.fn(() => this.webContents.debugger.attached),
        sendCommand: this.sendCommand
      }
    }

    constructor(options: { webPreferences: { partition: string } }) {
      this.partition = options.webPreferences.partition
      windows.push(this)
    }

    async loadURL(): Promise<void> {
      await (nextLoad?.() ?? Promise.resolve())
    }

    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true }
  }

  return {
    FakeBrowserWindow,
    sessions,
    windows,
    sessionFor(partition: string): FakeSession {
      let target = sessions.get(partition)
      if (!target) {
        target = {
          clearStorageData: vi.fn(async () => {}),
          flushStorageData: vi.fn(async () => {})
        }
        sessions.set(partition, target)
      }
      return target
    },
    setCookieResult(value: unknown) { nextSetCookieResult = value },
    setNextLoad(value: (() => Promise<void>) | null) { nextLoad = value },
    reset() {
      sessions.clear()
      windows.length = 0
      nextSetCookieResult = { success: true }
      nextLoad = null
    }
  }
})

vi.mock('../src/main/browser-profile-import-source.js', () => ({
  detectBrowserProfileImportSources: sourceMocks.detect,
  planBrowserProfileImport: sourceMocks.plan
}))

vi.mock('electron', () => ({
  BrowserWindow: electronMocks.FakeBrowserWindow,
  session: { fromPartition: (partition: string) => electronMocks.sessionFor(partition) }
}))

import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111'
const CREATED_ID = '22222222-2222-4222-8222-222222222222'
const IMPORT_ID = '33333333-3333-4333-8333-333333333333'
const PENDING_ID = '44444444-4444-4444-8444-444444444444'
const partition = (id: string) => `persist:agentmux-browser-profile:${id}`

const defaultProfile: BrowserProfileSummary = {
  id: DEFAULT_ID,
  label: 'Default',
  createdAt: 1,
  isDefault: true,
  source: null
}

const detectedSource = {
  kind: 'chromium',
  browserId: 'chrome',
  browserLabel: 'Google Chrome',
  profileDirectory: 'Default',
  profileLabel: 'Personal',
  browserRoot: '/private/chrome',
  cookiesPath: '/private/chrome/Default/Cookies',
  fileIdentity: { device: '1', inode: '2' }
}

const importedSource: BrowserProfileImportedSource = {
  browserLabel: 'Google Chrome',
  profileLabel: 'Personal',
  importedAt: 10,
  importedCookies: 1,
  skippedCookies: 2
}

class FakeStore {
  profiles: BrowserProfileSummary[] = [structuredClone(defaultProfile)]
  pending: Array<{ profileId: string; label: string; startedAt: number }> = []
  nextCreatedId = CREATED_ID

  async listProfiles() { return structuredClone(this.profiles) }
  async listPendingImports() { return structuredClone(this.pending) }
  async createProfile(label: string) {
    const profile = { id: this.nextCreatedId, label, createdAt: 2, isDefault: false, source: null }
    this.profiles.push(profile)
    return structuredClone(profile)
  }
  async deleteProfile(profileId: string) {
    this.profiles = this.profiles.filter((profile) => profile.id !== profileId)
  }
  async beginPendingImport(label: string) {
    const pending = { profileId: IMPORT_ID, label, startedAt: 3 }
    this.pending.push(pending)
    return structuredClone(pending)
  }
  async commitImportedProfile(profileId: string, source: BrowserProfileImportedSource) {
    const pending = this.pending.find((item) => item.profileId === profileId)!
    const profile: BrowserProfileSummary = {
      id: profileId,
      label: pending.label,
      createdAt: pending.startedAt,
      isDefault: false,
      source: structuredClone(source)
    }
    this.pending = this.pending.filter((item) => item.profileId !== profileId)
    this.profiles.push(profile)
    return structuredClone(profile)
  }
  async abortPendingImport(profileId: string) {
    const before = this.pending.length
    this.pending = this.pending.filter((item) => item.profileId !== profileId)
    if (before === this.pending.length) throw new Error('Unknown pending Browser Profile')
  }
}

function managerFixture(store = new FakeStore()): { store: FakeStore; manager: BrowserProfileManager } {
  return { store, manager: new BrowserProfileManager(store as never) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10)
  electronMocks.reset()
  sourceMocks.detect.mockReset().mockReturnValue([structuredClone(detectedSource)])
  sourceMocks.plan.mockReset().mockReturnValue({
    browserLabel: 'Google Chrome',
    profileLabel: 'Personal',
    cookies: [{
      url: 'https://example.com/',
      name: 'session',
      value: 'secret',
      path: '/',
      secure: true,
      httpOnly: true,
      partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: true }
    }],
    totalCookies: 3,
    importedCookies: 1,
    skippedCookies: 2,
    plannedBytes: 100,
    skippedByReason: {}
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserProfileManager', () => {
  it('initializes the strict resolver and recovers pending unpublished partitions before use', async () => {
    const { store, manager } = managerFixture()
    store.pending.push({ profileId: PENDING_ID, label: 'Interrupted', startedAt: 2 })

    await manager.initialize()

    expect(manager.defaultProfileId()).toBe(DEFAULT_ID)
    expect(manager.resolvePartition(DEFAULT_ID)).toBe(partition(DEFAULT_ID))
    expect(manager.listProfiles()).toEqual([defaultProfile])
    expect(store.pending).toEqual([])
    expect(electronMocks.sessionFor(partition(PENDING_ID)).clearStorageData).toHaveBeenCalledOnce()
    expect(() => manager.resolvePartition(PENDING_ID)).toThrow(`Unknown Browser Profile: ${PENDING_ID}`)
  })

  it('creates and deletes Profiles while keeping partition coordinates private', async () => {
    const { store, manager } = managerFixture()
    await manager.initialize()

    const created = await manager.createProfile('Work')
    expect(created).toMatchObject({ id: CREATED_ID, label: 'Work' })
    expect(JSON.stringify(manager.listProfiles())).not.toContain('partition')

    await manager.deleteProfile(CREATED_ID)
    expect(store.profiles).toEqual([defaultProfile])
    expect(electronMocks.sessionFor(partition(CREATED_ID)).clearStorageData).toHaveBeenCalledOnce()
    await expect(manager.deleteProfile(DEFAULT_ID)).rejects.toThrow('default Browser Profile cannot be deleted')
  })

  it('makes a Profile unavailable before its destructive partition clear can yield', async () => {
    const { manager } = managerFixture()
    await manager.initialize()
    await manager.createProfile('Work')
    let releaseClear!: () => void
    electronMocks.sessionFor(partition(CREATED_ID)).clearStorageData.mockImplementationOnce(
      async () => await new Promise<void>((resolve) => { releaseClear = resolve })
    )

    const deleting = manager.deleteProfile(CREATED_ID)

    expect(() => manager.resolvePartition(CREATED_ID)).toThrow(`Unknown Browser Profile: ${CREATED_ID}`)
    releaseClear()
    await deleting
  })

  it('publishes opaque one-generation source tokens and atomically imports a CHIPS cookie', async () => {
    const { store, manager } = managerFixture()
    await manager.initialize()
    const [source] = manager.detectImportSources()

    expect(source).toEqual({
      token: expect.any(String),
      browserLabel: 'Google Chrome',
      profileLabel: 'Personal'
    })
    expect(JSON.stringify(source)).not.toContain('/private')
    const imported = await manager.importProfile(source!.token, 'Imported personal')

    expect(imported).toMatchObject({
      id: IMPORT_ID,
      label: 'Imported personal',
      source: { ...importedSource, importedAt: 10 }
    })
    expect(store.pending).toEqual([])
    expect(electronMocks.windows).toHaveLength(1)
    expect(electronMocks.windows[0]!.partition).toBe(partition(IMPORT_ID))
    expect(electronMocks.windows[0]!.sendCommand).toHaveBeenCalledWith('Network.setCookie', expect.objectContaining({
      partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: true }
    }))
    expect(electronMocks.sessionFor(partition(IMPORT_ID)).flushStorageData).toHaveBeenCalledOnce()
    await expect(manager.importProfile(source!.token, 'Replay')).rejects.toThrow('already consumed')
  })

  it('expires tokens and invalidates the prior detection generation', async () => {
    const { manager } = managerFixture()
    await manager.initialize()
    const [oldGeneration] = manager.detectImportSources()
    const [newGeneration] = manager.detectImportSources()

    await expect(manager.importProfile(oldGeneration!.token, 'Old')).rejects.toThrow('already consumed')
    vi.advanceTimersByTime(5 * 60_000 + 1)
    await expect(manager.importProfile(newGeneration!.token, 'Expired')).rejects.toThrow('expired')
    expect(sourceMocks.plan).not.toHaveBeenCalled()
  })

  it('rolls back every write when CDP rejects one cookie and consumes the token', async () => {
    const { store, manager } = managerFixture()
    await manager.initialize()
    const [source] = manager.detectImportSources()
    electronMocks.setCookieResult({ success: false })

    await expect(manager.importProfile(source!.token, 'Rejected')).rejects.toThrow('rejected imported cookie 1')

    expect(store.pending).toEqual([])
    expect(store.profiles).toEqual([defaultProfile])
    expect(electronMocks.sessionFor(partition(IMPORT_ID)).clearStorageData).toHaveBeenCalledOnce()
    await expect(manager.importProfile(source!.token, 'Replay')).rejects.toThrow('already consumed')
  })

  it('keeps the pending journal when rollback cleanup fails', async () => {
    const { store, manager } = managerFixture()
    await manager.initialize()
    const [source] = manager.detectImportSources()
    electronMocks.setCookieResult({ success: false })
    electronMocks.sessionFor(partition(IMPORT_ID)).clearStorageData.mockRejectedValueOnce(
      new Error('partition cleanup failed')
    )

    await expect(manager.importProfile(source!.token, 'Recover later')).rejects.toThrow(
      'pending partition could not be cleaned'
    )
    expect(store.pending).toEqual([{ profileId: IMPORT_ID, label: 'Recover later', startedAt: 3 }])
  })

  it('destroys an active hidden import window and waits for rollback during disposal', async () => {
    const { store, manager } = managerFixture()
    await manager.initialize()
    const [source] = manager.detectImportSources()
    let releaseLoad!: () => void
    electronMocks.setNextLoad(async () => await new Promise<void>((resolve) => { releaseLoad = resolve }))
    const importing = manager.importProfile(source!.token, 'Interrupted')
    await vi.waitFor(() => expect(electronMocks.windows).toHaveLength(1))

    const disposing = manager.dispose()
    expect(electronMocks.windows[0]!.destroyed).toBe(true)
    releaseLoad()
    await disposing

    await expect(importing).rejects.toThrow('disposed')
    expect(store.pending).toEqual([])
    expect(electronMocks.sessionFor(partition(IMPORT_ID)).clearStorageData).toHaveBeenCalledOnce()
  })
})
