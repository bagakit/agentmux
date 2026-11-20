import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
function png() { return Buffer.alloc(0) }

const fakeElectron = vi.hoisted(() => {
  type Listener = (...args: any[]) => void

  class FakeWebContents {
    url = ''
    title = ''
    loading = false
    destroyed = false
    crashed = false
    isCrashed() { return this.crashed }
    mainFrame = { framesInSubtree: [{ osProcessId: 10, detached: false }] }
    zoomFactor = 1
    backgroundThrottling = true
    readonly getBackgroundThrottling = vi.fn(() => this.backgroundThrottling)
    readonly setBackgroundThrottling = vi.fn((value: boolean) => { this.backgroundThrottling = value })
    deviceEmulation: Record<string, unknown> | null = null
    readonly disableDeviceEmulation = vi.fn(() => { this.deviceEmulation = null })
    readonly enableDeviceEmulation = vi.fn((parameters: Record<string, unknown>) => {
      this.deviceEmulation = parameters
    })
    readonly executeJavaScript = vi.fn(async (_code: string) => true)
    readonly openDevTools = vi.fn()
    executeJavaScriptInIsolatedWorldImpl = async (_worldId: number, scripts: Array<{ code: string }>): Promise<unknown> =>
      scripts[0]?.code.includes('Select an element') ? null : true
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async (
      worldId: number,
      scripts: Array<{ code: string }>
    ) => await this.executeJavaScriptInIsolatedWorldImpl(worldId, scripts))
    capturePageImpl = async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => png()
    })
    readonly capturePage = vi.fn(async () => await this.capturePageImpl())
    readonly session = {
      fetch: vi.fn<typeof fetch>(),
      on: vi.fn(), removeListener: vi.fn(),
      checkHandler: null as null | ((...args: any[]) => boolean),
      requestHandler: null as null | ((...args: any[]) => void),
      setDevicePermissionHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn((handler: (...args: any[]) => boolean) => {
        this.session.checkHandler = handler
      }),
      setPermissionRequestHandler: vi.fn((handler: (...args: any[]) => void) => {
        this.session.requestHandler = handler
      })
    }
    readonly listeners = new Map<string, Listener[]>()
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn()
    }
    windowOpenHandler: null | ((details: { url: string }) => { action: string }) = null
    loadURLImpl = async (url: string): Promise<void> => { this.finishLoad(url) }

    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }

    prependListener(event: string, listener: Listener) {
      this.listeners.set(event, [listener, ...(this.listeners.get(event) ?? [])])
      return this
    }

    getLastWebPreferences() { return {} }

    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }

    removeListener(event: string, listener: Listener) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
      return this
    }

    emit(event: string, ...args: any[]) {
      for (const listener of this.listeners.get(event) ?? []) listener({}, ...args)
    }

    emitDetails(event: string, details: Record<string, unknown>) {
      for (const listener of this.listeners.get(event) ?? []) listener(details)
    }

    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      this.windowOpenHandler = handler
    }
    setZoomFactor(value: number) { this.zoomFactor = value }
    getZoomFactor() { return this.zoomFactor }

    finishLoad(url: string) {
      this.loading = true
      this.emitDetails('did-start-navigation', { url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.zoomFactor = 1
      this.url = url
      this.title = url === 'about:blank' ? '' : new URL(url).hostname
      this.emit('did-navigate', url)
      this.emit('dom-ready')
      this.emit('did-finish-load')
      this.loading = false
      this.emit('did-stop-loading')
    }

    async loadURL(url: string) { await this.loadURLImpl(url) }

    getURL() { return this.url }
    getTitle() { return this.title }
    isLoading() { return this.loading }
    isDestroyed() { return this.destroyed }
    isBeingCaptured() { return false }
    isCurrentlyAudible() { return false }
    reload() {
      this.loading = true
      this.emitDetails('did-start-navigation', { url: this.url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.zoomFactor = 1
      this.emit('dom-ready')
      this.emit('did-finish-load')
      this.loading = false
      this.emit('did-stop-loading')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    static nextLoadURLImpl: null | ((contents: FakeWebContents, url: string) => Promise<void>) = null
    readonly webContents: FakeWebContents
    readonly partition: string | undefined
    // 整份 webPreferences 都留着，不只挑 partition 出来。沙箱开关（contextIsolation/sandbox/
    // nodeIntegration）是这个内嵌浏览器唯一挡住"任意 URL 的页面拿到 Node 能力"的东西，而这个 fake
    // 此前只读 partition、把另外三个字段直接丢掉——于是把三个开关**各自**翻反，24 条测试照旧全绿。
    // 丢掉的字段等于没人守的字段，所以这里存整份，让下面那条断言够得着。
    readonly webPreferences: Record<string, unknown> | undefined
    visible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    // Keep every native geometry write so lifecycle synchronization cannot hide extra layout work.
    boundsHistory: Array<{ x: number; y: number; width: number; height: number }> = []

    constructor(options?: { webContents?: FakeWebContents; webPreferences?: Record<string, unknown> }) {
      this.webContents = options?.webContents ?? new FakeWebContents()
      FakeWebContentsView.instances.push(this)
      this.webPreferences = options?.webPreferences
      this.partition = options?.webPreferences?.partition as string | undefined
      if (this.partition?.startsWith('agentmux-browser-private:')) Object.assign(this.webContents, { session: fromPartition(this.partition) })
      const nextLoadURLImpl = FakeWebContentsView.nextLoadURLImpl
      FakeWebContentsView.nextLoadURLImpl = null
      if (nextLoadURLImpl) {
        this.webContents.loadURLImpl = async (url) => await nextLoadURLImpl(this.webContents, url)
      }
    }

    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = value; this.boundsHistory.push({ ...value }) }
    getBounds() { return this.bounds }
  }

  const privateSessions = new Map<string, FakeWebContents['session'] & { clearStorageData: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> }>()
  const fromPartition = vi.fn((partition: string) => {
    let value = privateSessions.get(partition)
    if (!value) {
      value = Object.assign(new FakeWebContents().session, { clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) })
      privateSessions.set(partition, value)
    }
    return value
  })
  return { FakeWebContentsView, fromPartition }
})


vi.mock('electron', () => ({ WebContentsView: fakeElectron.FakeWebContentsView, BrowserWindow: class {},
  session: { fromPartition: fakeElectron.fromPartition }, app: { getPath: () => tmpdir(), getLocale: () => 'en-US' } }))
import { browserProfilePartition, BrowserProfileStore, type BrowserProfileActivityCheckpoint } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { parseBrowserProfileControlPayload, parseBrowserProfileControlResult } from '../../../packages/core/src/browser-profile-control.js'

const roots: string[] = [], owners: BrowserViewManager[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) { owner.dispose(); await owner.flushProfileActivity(true) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  fakeElectron.FakeWebContentsView.instances.length = 0; fakeElectron.FakeWebContentsView.nextLoadURLImpl = null
})
async function fixture(sessions: any = { prepare: () => undefined, apply: async () => {} }) {
  const root = await mkdtemp(join(tmpdir(), 'profile-activity-')); roots.push(root)
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path), manager = new BrowserProfileManager(store, sessions)
  await manager.initialize()
  const id = manager.defaultProfileId(), profile = (id: string) => manager.listProfiles().find(value => value.id === id)!
  return { root, path, store, manager, id, profile }
}
function checkpoint(observerId: string, previousObserverId: string | null = null, overrides: Partial<BrowserProfileActivityCheckpoint> = {}): BrowserProfileActivityCheckpoint {
  return { observerId, previousObserverId, sequence: 1, unionMs: 1000, observedAt: 10_000, lastUsedAt: 10_000, active: true, gaps: [], ...overrides }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function native(f: Awaited<ReturnType<typeof fixture>>) {
  const children: InstanceType<typeof fakeElectron.FakeWebContentsView>[] = [], events: any[] = []
  const window = { getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }), isDestroyed: () => false,
    contentView: { addChildView(view: typeof children[number]) { if (!children.includes(view)) children.push(view) }, removeChildView(view: typeof children[number]) { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1) } },
    webContents: { isDestroyed: () => false, send: (_channel: string, event: any) => events.push(event) } }
  const owner = new BrowserViewManager(window as never, f.manager, new BrowserRefLedgerStore(join(f.root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} })
  owners.push(owner)
  let monotonic = 0, wall = 100_000
  vi.spyOn((owner as any).profileActivity, 'activityTime').mockImplementation(() => ({ monotonic, wall }))
  return { owner, children, events, tick(ms: number) { monotonic += ms; wall += ms }, view(id: string) { return (owner as any).entries.get(id).view as typeof children[number] } }
}

describe('Profile native activity and exact configuration versions', () => {
  it('reads a legacy current configuration baseline without inventing edit counts or rewriting original bytes', async () => {
    const f = await fixture(), original = await readFile(f.path, 'utf8'), first = f.profile(f.id)
    expect(first.revision).toMatch(/^baseline:/); expect(first.activity).toBeUndefined(); expect(first).not.toHaveProperty('editCount')
    const reopened = await new BrowserProfileStore(f.path).list()
    expect(reopened.profiles[0]!.revision).toBe(first.revision)
    expect(await readFile(f.path, 'utf8')).toBe(original)
  })

  it('allows A/B edits and Folder CAS across activity checkpoints while ordering every actual snapshot', async () => {
    const f = await fixture(), other = await f.manager.createProfile('B', crypto.randomUUID(), profileCreationTestActor), a = f.profile(f.id), b = f.profile(other.id)
    const folderRevision = f.manager.listRevision(), sequence = f.manager.listSequence()
    await f.manager.recordActivity(f.id, checkpoint(f.manager.activityObserverId))
    expect(f.manager.listRevision()).toBe(folderRevision); expect(f.manager.listSequence()).toBeGreaterThan(sequence)
    expect(f.profile(f.id).revision).toBe(a.revision)
    await f.manager.createFolder('Unaffected by observation', folderRevision, crypto.randomUUID(), profileCreationTestActor)
    await Promise.all([f.manager.updateProfile(f.id, { notes: 'A changed' }, a.revision), f.manager.updateProfile(other.id, { notes: 'B changed' }, b.revision)])
    expect(f.profile(f.id)).toMatchObject({ notes: 'A changed', activity: { observedRunMs: 1000 } }); expect(f.profile(other.id).notes).toBe('B changed')
  })

  it('refuses a stale exact Profile including ABA without treating unrelated configuration as a conflict', async () => {
    const f = await fixture(), initial = f.profile(f.id)
    await f.manager.updateProfile(f.id, { notes: 'B' }, initial.revision)
    const second = f.profile(f.id).revision
    await f.manager.updateProfile(f.id, { notes: '' }, second)
    expect(f.profile(f.id).revision).not.toBe(initial.revision)
    const bytes = await readFile(f.path, 'utf8')
    await expect(f.manager.updateProfile(f.id, { notes: 'stale overwrite' }, initial.revision)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(await readFile(f.path, 'utf8')).toBe(bytes)
  })

  it('merges absolute high-water checkpoints idempotently and preserves unknown restart suffixes and copy boundaries', async () => {
    const f = await fixture(), cp = checkpoint(f.manager.activityObserverId)
    await f.manager.recordActivity(f.id, cp)
    const sequence = f.manager.listSequence(), token = f.profile(f.id).revision
    await f.manager.recordActivity(f.id, cp)
    expect(f.manager.listSequence()).toBe(sequence)
    await f.manager.recordActivity(f.id, { ...cp, sequence: 2, unionMs: 3000, observedAt: 12_000, lastUsedAt: 12_000 })
    await f.manager.recordActivity(f.id, cp)
    expect(f.profile(f.id).activity?.observedRunMs).toBe(3000); expect(f.profile(f.id).revision).toBe(token)
    const restarted = new BrowserProfileManager(new BrowserProfileStore(f.path), { prepare: () => undefined, apply: async () => {} } as never)
    await restarted.initialize()
    expect(restarted.listProfiles()[0]!.activity).toMatchObject({ observedRunMs: 3000, state: 'unknown', lastUsedAt: 12_000 })
    await restarted.recordActivity(f.id, checkpoint(restarted.activityObserverId, cp.observerId, { unionMs: 250, observedAt: 100_000, lastUsedAt: 100_000 }))
    expect(restarted.listProfiles()[0]!.activity).toMatchObject({ observedRunMs: 3250, interruptions: 1 })
    const source = restarted.listProfiles()[0]!, copied = await restarted.copyProfile(f.id, 'Independent', source.revision, crypto.randomUUID(), profileCreationTestActor)
    expect(copied.activity).toBeUndefined(); expect(copied.revision).not.toBe(source.revision)
    const stored = JSON.parse(await readFile(f.path, 'utf8')).profiles.find((value: any) => value.id === f.id)
    expect(stored.activity.gaps).toContainEqual({ id: cp.observerId + ':unclosed', after: 12_000, until: 100_000, reason: 'observation-interrupted' })
    await expect(restarted.recordActivity(f.id, { ...cp, sequence: 3, unionMs: 9000 })).rejects.toThrow('observation changed')
  })

  it('preserves unreadable original bytes and merges retry with current configuration instead of inventing empty history', async () => {
    const f = await fixture(), token = f.profile(f.id).revision, saved = await readFile(f.path, 'utf8'), cp = checkpoint(f.manager.activityObserverId)
    await writeFile(f.path, '{unknown')
    await expect(f.manager.recordActivity(f.id, cp)).rejects.toThrow()
    expect(await readFile(f.path, 'utf8')).toBe('{unknown'); expect(f.manager.resolvePartition(f.id)).toContain(f.id)
    await writeFile(f.path, saved)
    await f.manager.updateProfile(f.id, { notes: 'Keep configuration' }, token)
    await f.manager.recordActivity(f.id, cp)
    expect(f.profile(f.id)).toMatchObject({ notes: 'Keep configuration', activity: { observedRunMs: 1000 } })
    await rm(f.path)
    await expect(f.manager.recordActivity(f.id, { ...cp, sequence: 2 })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes same-Profile network apply before native side effects while independent edits and checkpoints progress', async () => {
    const gate = deferred<void>(), entered = deferred<void>(), applied: unknown[] = []
    const apply = vi.fn(async (_id: string, route: unknown) => { applied.push(route); if (applied.length === 1) { entered.resolve(); await gate.promise } })
    const f = await fixture({ prepare: () => undefined, apply }), other = await f.manager.createProfile('Independent', crypto.randomUUID(), profileCreationTestActor), token = f.profile(f.id).revision
    const first = f.manager.updateProfile(f.id, { network: { mode: 'direct' } }, token)
    await entered.promise
    const stale = f.manager.updateProfile(f.id, { network: { mode: 'proxy', server: 'proxy.invalid:8080' } }, token)
    const refused = expect(stale).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    await f.manager.updateProfile(other.id, { notes: 'Independent saved' }, other.revision)
    await f.manager.recordActivity(f.id, checkpoint(f.manager.activityObserverId))
    expect(apply).toHaveBeenCalledTimes(1)
    gate.resolve(); await first; await refused
    expect(applied).toEqual([{ mode: 'direct' }]); expect(f.profile(f.id).network).toEqual({ mode: 'direct' })
  })

  it('changes only affected Profile tokens on folder removal and never revives a recycled Profile from late activity', async () => {
    const f = await fixture(), b = await f.manager.createProfile('B', crypto.randomUUID(), profileCreationTestActor), folder = await f.manager.createFolder('Shared', f.manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    await f.manager.updateProfile(b.id, { folderId: folder.id }, b.revision)
    const a = f.profile(f.id).revision, tokenB = f.profile(b.id).revision
    await f.manager.deleteFolder(folder.id, f.manager.listRevision())
    expect(f.profile(f.id).revision).toBe(a); expect(f.profile(b.id).revision).not.toBe(tokenB)
    const { archive } = await f.store.archiveProfile(b.id, f.profile(b.id).revision, {
      partition: browserProfilePartition(b.id), relativePath: `Partitions/${b.id}`
    })
    await f.manager.recordActivity(b.id, checkpoint(f.manager.activityObserverId))
    expect((await f.store.inspectArchive(archive.id)).archive.profile).toMatchObject({ id: b.id, activity: { observedRunMs: 1000 } })
    expect((await f.store.list()).profiles.map(value => value.id)).toEqual([f.id])
  })

  it('counts two native incarnations by union and retains the original closing marker across a replacement with the same Browser ID', async () => {
    const f = await fixture(), n = native(f)
    await n.owner.create('one', 'https://one.invalid/', 'workspace', f.id); const original = n.view('one')
    n.tick(1000); await n.owner.create('two', 'https://two.invalid/', 'workspace', f.id)
    n.tick(1000); n.owner.checkpointProfileActivity(); await n.owner.flushProfileActivity()
    expect(f.profile(f.id).activity?.observedRunMs).toBe(2000)
    const destroy = original.webContents.close.bind(original.webContents)
    original.webContents.close = () => {} // native beforeunload/late destroy remains the original physical owner
    n.owner.close('one')
    n.tick(1000); await n.owner.create('one', 'https://replacement.invalid/', 'workspace', f.id); const replacement = n.view('one')
    n.tick(1000); destroy(); await n.owner.flushProfileActivity()
    expect(replacement.webContents.isDestroyed()).toBe(false); expect(n.owner.target('one')?.url).toBe('https://replacement.invalid/')
    expect(f.profile(f.id).activity?.observedRunMs).toBe(4000)
    n.tick(1000); await n.owner.flushProfileActivity()
    expect(f.profile(f.id).activity).toMatchObject({ observedRunMs: 5000, state: 'running' })
  })

  it('does not count a failed Profile candidate and retains old A until exact native destruction after a committed switch', async () => {
    const f = await fixture(), b = await f.manager.createProfile('B', crypto.randomUUID(), profileCreationTestActor), n = native(f)
    await n.owner.create('switch', 'https://original.invalid/', 'workspace', f.id)
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => { throw new Error('candidate load failed') }
    await expect(n.owner.switchProfile('switch', b.id)).rejects.toThrow('candidate load failed')
    expect(f.profile(b.id).activity).toBeUndefined()
    const old = n.view('switch'), destroy = old.webContents.close.bind(old.webContents); old.webContents.close = () => {}
    n.tick(1000); await n.owner.switchProfile('switch', b.id); await n.owner.flushProfileActivity()
    expect(f.profile(b.id).activity?.lastUsedAt).toBe(101_000)
    n.tick(1000); destroy(); await n.owner.flushProfileActivity()
    expect(f.profile(f.id).activity?.observedRunMs).toBe(2000); expect(f.profile(b.id).activity?.observedRunMs).toBe(1000)
  })

  it('keeps crash and save-failure suffixes unknown, recovers only at native dom-ready and never disables the healthy page', async () => {
    const f = await fixture(), n = native(f)
    await n.owner.create('page', 'https://original.invalid/', 'workspace', f.id); const view = n.view('page')
    n.tick(1000); await n.owner.flushProfileActivity(); expect(f.profile(f.id).activity?.observedRunMs).toBe(1000)
    n.tick(5000); view.webContents.crashed = true; view.webContents.emit('render-process-gone', { reason: 'crashed' }); await n.owner.flushProfileActivity()
    expect(f.profile(f.id).activity).toMatchObject({ state: 'unknown', observedRunMs: 1000 })
    n.tick(5000); view.webContents.crashed = false; view.webContents.emit('dom-ready'); n.tick(1000); await n.owner.flushProfileActivity()
    expect(f.profile(f.id).activity).toMatchObject({ state: 'running', observedRunMs: 2000, interruptions: 1 })
    const original = await readFile(f.path, 'utf8'); await writeFile(f.path, '{unknown'); n.tick(1000); await n.owner.flushProfileActivity()
    expect(n.owner.target('page')?.warning).toContain('could not be saved'); expect(view.webContents.isDestroyed()).toBe(false)
    await writeFile(f.path, original); await n.owner.flushProfileActivity()
    expect(n.owner.target('page')?.warning ?? '').not.toContain('could not be saved'); expect(f.profile(f.id).activity?.observedRunMs).toBe(3000)
  })

  it('retries an actually committed checkpoint with an unknown acknowledgement without counting its interval twice', async () => {
    const f = await fixture(), n = native(f)
    await n.owner.create('original', 'https://original.invalid/', 'workspace', f.id); await n.owner.flushProfileActivity()
    const write = f.store.recordActivity.bind(f.store)
    vi.spyOn(f.store, 'recordActivity').mockImplementationOnce(async (id, value) => {
      await write(id, value)
      throw new Error('Original save acknowledgement is unavailable after the durable commit')
    })
    n.tick(1000); await n.owner.flushProfileActivity()
    expect((await f.store.inspectProfile(f.id)).profile.activity?.observedRunMs).toBe(1000)
    expect(n.owner.target('original')?.warning).toContain('could not be saved')
    n.tick(500); await n.owner.flushProfileActivity()
    expect(f.profile(f.id).activity?.observedRunMs).toBe(1500)
    expect(n.owner.target('original')?.warning ?? '').not.toContain('could not be saved')
    expect(n.view('original').webContents.isDestroyed()).toBe(false)
  })

  it('stops sampling after the final checkpoint is confirmed and rearms for the next original view', async () => {
    const f = await fixture(), n = native(f)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await n.owner.create('original', 'https://original.invalid/', 'workspace', f.id)
      await n.owner.flushProfileActivity()
      const original = n.view('original'), save = f.store.recordActivity.bind(f.store)
      const writes = vi.spyOn(f.store, 'recordActivity').mockImplementationOnce(async (id, checkpoint) => {
        await save(id, checkpoint)
        throw new Error('Final checkpoint acknowledgement is unavailable')
      })
      n.tick(1000)
      n.owner.close('original')
      expect(original.webContents.isDestroyed()).toBe(true)
      // Let the write and its lost acknowledgement settle before the sampling timer retries it.
      await n.owner.flushProfileActivity()
      expect(vi.getTimerCount()).toBe(1)
      expect(writes).toHaveBeenCalledTimes(1)
      const final = writes.mock.calls[0]![1]
      expect(final).toMatchObject({ active: false, unionMs: 1000, observedAt: 101_000 })

      n.tick(5000)
      vi.advanceTimersByTime(5000)
      await n.owner.flushProfileActivity()
      expect(writes).toHaveBeenNthCalledWith(2, f.id, final)
      expect(f.profile(f.id).activity?.observedRunMs).toBe(1000)
      expect(vi.getTimerCount(), 'sampling stops after final acknowledgement').toBe(0)

      vi.advanceTimersByTime(10_000)
      expect(writes).toHaveBeenCalledTimes(2)
      await n.owner.create('next', 'https://next.invalid/', 'workspace', f.id)
      expect(vi.getTimerCount()).toBe(1)
      n.tick(500)
      await n.owner.flushProfileActivity()
      expect(f.profile(f.id).activity).toMatchObject({ observedRunMs: 1500, state: 'running' })
      n.owner.dispose()
      expect(vi.getTimerCount(), 'native close during teardown does not restart sampling').toBe(0)
    } finally {
      n.owner.dispose()
      await n.owner.flushProfileActivity(true)
      vi.useRealTimers()
    }
  })

  it('runs strict configuration-token edits and activity reads through the actual compiled CLI and original Main owners', async () => {
    const f = await fixture(), core = await privateRpcCorePort(join(f.root, 'sessions.json'), join(f.root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => { if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected operation'); return executeBrowserProfileControl(request,
        { profiles: f.manager, usage: { usage: async () => ({ complete: true, browsers: [] }) } as never, network: {} as never }, context?.actor) } })
    await server.start()
    try {
      const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' })
      const run = async (args: string[]) => { const reply = await runCompiledObjectCli(['browser', 'profile', ...args], env); expect(reply.code, reply.stderr).toBe(0); return JSON.parse(reply.stdout).result }
      const initial = await run(['inspect', '--profile', f.id]), token = initial.profile.revision
      await f.manager.recordActivity(f.id, checkpoint(f.manager.activityObserverId))
      const read = await run(['ls']); expect(read.sequence).toBeGreaterThan(initial.sequence); expect(read.revision).toBe(initial.revision)
      const saved = await run(['update', '--profile', f.id, '--expected-revision', token, '--notes', 'Public exact token'])
      expect(saved.profile.activity).toMatchObject({ observedRunMs: 1000, history: 'partial' })
      const copied = await run(['copy', '--operation-id', 'activity-copy-original', '--profile', f.id, '--expected-revision', saved.profile.revision, '--label', 'New identity'])
      const copiedProfile = f.manager.listProfiles().find(value => value.id === copied.creation.receipt.createdId)!
      expect(copiedProfile.activity).toBeUndefined(); expect(copiedProfile.revision).not.toBe(saved.profile.revision)
      expect(() => parseBrowserProfileControlPayload({ operation: 'browser.profile.update', profileId: f.id, expectedRevision: 0, edit: { notes: 'wrong scope' } }, ['operation'])).toThrow()
      expect(() => parseBrowserProfileControlPayload({ operation: 'browser.profile.update', profileId: f.id, expectedRevision: saved.profile.revision, edit: { activity: { observedRunMs: 5000 } } }, ['operation'])).toThrow()
      expect(() => parseBrowserProfileControlResult('browser.profile.ls', { revision: read.revision, profiles: read.profiles, folders: [], views: [] })).toThrow()
    } finally { await server.stop(); await core.dispose() }
  }, 40_000)
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
