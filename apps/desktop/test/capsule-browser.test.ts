import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NodeCapsuleOwner } from '../../../packages/capsule/src/node'
import type { CapsuleInspection, CapsuleMode } from '@agentmux/core/capsule'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { hydratePersistedTab, reducePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { browserColdDescriptor } from '../src/main/browser-cold-descriptor'

// Native ownership and event ordering are controlled here. Actual Electron navigation, pixels
// and OS restart are verified by the integrated Browser gate, not by these ports.
const native = await vi.hoisted(async () => {
  const ports = (await import('./helpers/browser-resource-directory-ports')).directoryNativePorts()
  class View extends ports.View {
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      super()
      Object.assign(this.webContents.mainFrame, { isDestroyed: () => this.webContents.dead })
      Object.assign(this.webContents, { prependListener(event: string, listener: (...args: any[]) => void) {
        const listeners = new Set([listener, ...(this.listeners.get(event) ?? [])]); this.listeners.set(event, listeners); return this
      } })
    }
  }
  return { ...ports, View }
})
vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.View, app: { getPath: () => tmpdir() } }))
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store'

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'capsule-browser-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'page'); await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'index.html'), '<!doctype html><title>Persistent Capsule</title><p>Real static content</p>')
  const owner = await NodeCapsuleOwner.open({ stateDirectory: join(root, 'state') }); cleanups.push(() => owner.close())
  let operation = 0
  const page = async (mode: CapsuleMode): Promise<CapsuleInspection> => owner.call('capsule.create', {
    operationId: `create-${++operation}`, sourcePath, storageMode: 'path', mode, routing: 'spa'
  })
  const views: InstanceType<typeof native.View>[] = []
  const window = { webContents: new native.Contents(), isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), contentView: {
      addChildView(view: InstanceType<typeof native.View>) { views.push(view) },
      removeChildView(view: InstanceType<typeof native.View>) { const index = views.indexOf(view); if (index !== -1) views.splice(index, 1) }
    } }
  const profiles = { defaultProfileId: vi.fn(() => 'default-profile'), resolvePartition: vi.fn(profile => `persist:${profile}`) }
  const manager = new BrowserViewManager(window as never, profiles, new BrowserRefLedgerStore(join(root, 'ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  cleanups.push(() => manager.dispose())
  const create = async (id: string, capsule: CapsuleInspection, url?: string) => {
    expect(capsule.endpoint.status).toBe('available')
    return manager.create(id, url ?? (capsule.endpoint as { url: string }).url, 'workspace', undefined, 'normal', 'responsive', { capsule })
  }
  return { owner, manager, page, create, views, profiles }
}

it('keeps Capsule storage independent from user Profiles and installs SDK only for injected containers', async () => {
  const { manager, page, create, views, profiles } = await fixture()
  const ready = vi.fn(); manager.capsuleDocumentReady = ready
  const isolated = await page('isolated'), injected = await page('injected')
  const first = await create('isolated-browser', isolated), second = await create('injected-browser', injected)
  expect(first).toMatchObject({ profileId: null, mode: 'normal', capsuleId: isolated.record.capsuleId, capsuleActive: true })
  expect(second).toMatchObject({ profileId: null, capsuleId: injected.record.capsuleId, capsuleActive: true })
  expect(views[0]!.options.webPreferences).toEqual({ partition: `persist:agentmux-capsule:${isolated.record.capsuleId}`,
    contextIsolation: true, sandbox: true, nodeIntegration: false })
  expect(views[1]!.options.webPreferences).toMatchObject({ partition: `persist:agentmux-capsule:${injected.record.capsuleId}`,
    preload: expect.stringMatching(/preload\/capsule\.cjs$/u), contextIsolation: true, sandbox: true, nodeIntegration: false })
  expect(views[0]!.options.webPreferences.partition).not.toBe(views[1]!.options.webPreferences.partition)
  expect(profiles.defaultProfileId).not.toHaveBeenCalled(); expect(profiles.resolvePartition).not.toHaveBeenCalled()
  expect(manager.recoveryPreviewScope(first.id)).toBeNull()
  expect(ready).toHaveBeenCalledExactlyOnceWith(second.id)
  expect(manager.capsuleDocument(views[0]!.webContents as never, views[0]!.webContents.mainFrame as never)).toBeNull()
  expect(manager.capsuleDocument(views[1]!.webContents as never, views[1]!.webContents.mainFrame as never)).toMatchObject({
    record: injected.record, browserId: 'injected-browser', navigationId: second.navigationId })
  expect(manager.capsuleDocumentContents(first.id)).toBeNull()
  expect(manager.capsuleDocumentContents(second.id)).toBe(views[1]!.webContents)
  expect(manager.capsuleDocumentIds()).toEqual([second.id])
  await expect(manager.switchProfile(second.id, 'user-profile')).rejects.toThrow('own persistent container')
  expect(await (await fetch((injected.endpoint as { url: string }).url + 'route', { headers: { Accept: 'text/html' } })).text()).toContain('Real static content')
})

it('admits only the exact live committed nonloading Capsule main document and rejects frames, popups and stale documents', async () => {
  const { manager, page, create, views } = await fixture()
  const capsule = await page('injected'), snapshot = await create('browser', capsule)
  const contents = views[0]!.webContents, frame = contents.mainFrame
  const admit = () => manager.capsuleDocument(contents as never, frame as never)
  const unrelated = vi.spyOn((manager as any).entries, 'values')
  expect(admit()).toMatchObject({ navigationId: snapshot.navigationId })
  expect(unrelated).not.toHaveBeenCalled(); unrelated.mockRestore()
  expect(manager.capsuleDocument(contents as never, { ...frame, parent: frame } as never)).toBeNull()
  const popup = new native.View({ webPreferences: {} }).webContents
  popup.url = contents.url; popup.mainFrame.url = contents.url
  expect(manager.capsuleDocument(popup as never, popup.mainFrame as never)).toBeNull()
  const loading = vi.spyOn(contents, 'isLoadingMainFrame').mockReturnValue(true)
  expect(admit()).toBeNull(); loading.mockRestore()
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: contents.url })
  expect(admit()).toBeNull()
  contents.emit('did-navigate', {}, contents.url)
  expect(admit()).not.toBeNull()
  frame.url = 'https://outside.invalid/frame'
  expect(admit()).toBeNull(); frame.url = contents.url
  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(admit()).toBeNull()
})

it('retains the original container through external navigation, release and cold restoration without navigating it back', async () => {
  const { manager, page, create, views, owner, profiles } = await fixture()
  const capsule = await page('injected'), opened = await create('browser', capsule)
  manager.recordCapsuleOpen(opened.id, capsule.record.capsuleId, 'original-open-operation')
  manager.recordCapsuleOpen(opened.id, capsule.record.capsuleId, 'original-open-operation')
  expect(() => manager.recordCapsuleOpen(opened.id, 'other-capsule', 'wrong-container')).toThrow('does not match')
  const origin = new URL((capsule.endpoint as { url: string }).url).origin
  const contents = views[0]!.webContents
  await manager.navigate(opened.id, 'https://outside.invalid/article?q=kept')
  const external = await manager.create(opened.id, origin, 'workspace')
  expect(external).toMatchObject({ capsuleId: capsule.record.capsuleId, capsuleOrigin: origin, capsuleActive: false,
    profileId: null, url: 'https://outside.invalid/article?q=kept', capsuleOpenOperationIds: ['original-open-operation'] })
  expect(manager.capsuleDocument(contents as never, contents.mainFrame as never)).toBeNull()
  expect(manager.capsuleDocumentContents(opened.id)).toBeNull()
  expect(manager.capsuleDocumentIds()).toEqual([])
  const tab = createWorkbenchTab('tab', { ...external, regionId: 'region', kind: 'browser', workspaceId: 'workspace', browserId: external.id })
  const persisted = JSON.parse(JSON.stringify(reducePersistedTab(tab)))
  expect(persisted.regions.region).toMatchObject({ capsuleId: capsule.record.capsuleId, capsuleOrigin: origin, url: external.url,
    capsuleOpenOperationIds: ['original-open-operation'] })
  expect(persisted.regions.region).not.toHaveProperty('capsuleActive')
  expect(persisted.regions.region).not.toHaveProperty('navigationId')
  const restored = hydratePersistedTab(persisted)
  expect(restored.regions.region).toMatchObject({ capsuleId: capsule.record.capsuleId, capsuleOrigin: origin, profileId: null, nativeOwnerDeferred: true })
  expect(restored.regions.region).not.toHaveProperty('capsuleActive')
  const graph = { regions: [{ kind: 'browser', browserId: external.id, regionId: 'region', tabId: tab.id }],
    tabs: [{ tabId: tab.id, regionIds: ['region'] }], resources: { 'region:region': persisted.regions.region } } as unknown as AgentMuxSpatialGraph
  const saved = browserColdDescriptor(graph, external.id)
  expect(saved).toMatchObject({ capsuleId: capsule.record.capsuleId, capsuleOrigin: origin, url: external.url,
    capsuleOpenOperationIds: ['original-open-operation'] })
  expect((await manager.release(external.id, external.navigationId)).status).toBe('released')
  const resumed = await manager.restore(external.id)
  expect(resumed).toMatchObject({ id: external.id, capsuleId: capsule.record.capsuleId, capsuleOrigin: origin, capsuleActive: false, url: external.url, profileId: null })
  expect(views[0]!.options.webPreferences.partition).toBe(`persist:agentmux-capsule:${capsule.record.capsuleId}`)
  expect(profiles.resolvePartition).not.toHaveBeenCalled()
  manager.close(external.id)
  expect(views).toHaveLength(0)
  await expect(manager.ensure(external.id, async () => saved)).rejects.toThrow('not been resolved')
  const cold = await manager.ensure(external.id, async () => ({ ...saved, capsule: await owner.call('capsule.inspect', { capsuleId: capsule.record.capsuleId }) }))
  expect(cold).toMatchObject({ id: external.id, url: external.url, capsuleActive: false, capsuleId: capsule.record.capsuleId,
    capsuleOpenOperationIds: ['original-open-operation'] })
  const reused = await manager.create(external.id, origin, 'workspace', undefined, undefined, 'responsive', {
    capsule, capsuleOpenOperationIds: ['original-open-operation', 'second-open-operation']
  })
  expect(reused.url).toBe(external.url)
  expect(reused.capsuleOpenOperationIds).toEqual(['original-open-operation', 'second-open-operation'])
})

it('rejects incomplete or conflicting cold Capsule descriptors without replacing the original Browser resource', async () => {
  const { manager, page, create } = await fixture()
  const capsule = await page('injected'), opened = await create('browser', capsule)
  const graph = { regions: [{ kind: 'browser', browserId: opened.id, regionId: 'region', tabId: 'tab' }],
    tabs: [{ tabId: 'tab', regionIds: ['region'] }], resources: { 'region:region': {
      browserId: opened.id, workspaceId: 'workspace', url: opened.url, capsuleId: capsule.record.capsuleId
    } } } as unknown as AgentMuxSpatialGraph
  expect(() => browserColdDescriptor(graph, opened.id)).toThrow('incomplete')
  await expect(manager.create('invalid', opened.url, 'workspace', 'user-profile', 'normal', 'responsive', { capsule })).rejects.toThrow('own persistent container')
  expect((await manager.create(opened.id, 'https://unrelated.invalid', 'workspace')).url).toBe(opened.url)
})
