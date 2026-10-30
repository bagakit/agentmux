import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { NodeCapsuleOwner } from '../../../packages/capsule/src/node'
import type { CapsuleInspection, CapsuleMode } from '@agentmux/core/capsule'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { hydratePersistedTab, reducePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { browserColdDescriptor, coldBrowserTargets } from '../src/main/browser-cold-descriptor'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { createCapsuleBrowserDocument } from '../src/main/capsule-presentation'

// Native ownership and event ordering are controlled here. Actual Electron navigation, pixels
// and OS restart are verified by the integrated Browser gate, not by these ports.
const native = await vi.hoisted(async () => {
  const ports = (await import('./helpers/browser-resource-directory-ports')).directoryNativePorts()
  class View extends ports.View {
    lastLoad = Promise.resolve()
    request: ((details: any, callback: (value: unknown) => void) => void) | null = null
    response: ((details: any) => void) | null = null
    responseOverride: ((details: any) => void) | null = null
    requestId = 0
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      super()
      Object.assign(this.webContents.mainFrame, { isDestroyed: () => this.webContents.dead })
      Object.assign(this.webContents, { prependListener(event: string, listener: (...args: any[]) => void) {
        const listeners = new Set([listener, ...(this.listeners.get(event) ?? [])]); this.listeners.set(event, listeners); return this
      } })
      Object.assign(this.webContents.session, { webRequest: {
        onBeforeRequest: (listener: typeof this.request) => { this.request = listener },
        onResponseStarted: (listener: typeof this.response) => { this.response = listener }
      } })
      this.webContents.loadURL = url => {
        const contents = this.webContents
        this.lastLoad = (async () => {
          contents.loads.push(url)
          contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url, frame: contents.mainFrame })
          const details = { id: ++this.requestId, url, resourceType: 'mainFrame', webContents: contents, frame: contents.mainFrame,
            statusCode: 200, responseHeaders: {} as Record<string, string[]> }
          this.request?.(details, () => {})
          if (url.startsWith('http://127.0.0.1:')) {
            const actual = await fetch(url, { headers: { Accept: 'text/html' } })
            details.statusCode = actual.status
            details.responseHeaders = Object.fromEntries([...actual.headers].map(([key, value]) => [key, [value]]))
            await actual.arrayBuffer()
          }
          if (this.responseOverride) this.responseOverride(details)
          else this.response?.(details)
          contents.url = url; contents.mainFrame.url = url
          contents.emit('did-navigate', {}, url)
          contents.emit('did-finish-load'); contents.emit('did-stop-loading')
        })()
        return this.lastLoad
      }
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
      addChildView(view: InstanceType<typeof native.View>) { const index = views.indexOf(view); if (index !== -1) views.splice(index, 1); views.push(view) },
      removeChildView(view: InstanceType<typeof native.View>) { const index = views.indexOf(view); if (index !== -1) views.splice(index, 1) }
    } }
  const profiles = { defaultProfileId: vi.fn(() => 'default-profile'), resolvePartition: vi.fn(profile => `persist:${profile}`) }
  const manager = new BrowserViewManager(window as never, profiles, new BrowserRefLedgerStore(join(root, 'ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  cleanups.push(() => manager.dispose())
  const create = async (id: string, capsule: CapsuleInspection, url?: string) => {
    expect(capsule.endpoint.status).toBe('available')
    const target = url ?? (capsule.endpoint as { url: string }).url
    await manager.create(id, target, 'workspace', undefined, 'normal', 'responsive', { capsule })
    await views.at(-1)!.lastLoad
    return manager.create(id, target, 'workspace')
  }
  return { root, owner, manager, page, create, views, profiles }
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

it('derives stable object addresses from the original container while keeping real routes and healthy pages after missing handshake observations', async () => {
  const { root, manager, page, create, views } = await fixture()
  const capsule = await page('injected'), opened = await create('browser', capsule)
  const objectLink = `amux://capsule/${capsule.record.capsuleId}`
  expect(opened.objectLink).toBe(objectLink)
  expect(opened.url).toBe((capsule.endpoint as { url: string }).url)
  const route = new URL('review/shape?q=kept#preview', opened.url).href
  await manager.navigate(opened.id, route); await views[0]!.lastLoad
  const snapshot = await manager.create(opened.id, opened.url, 'workspace')
  expect(snapshot).toMatchObject({ objectLink, url: route, capsuleActive: true })
  expect(manager.target(opened.id)).toMatchObject({ objectLink, url: route })
  views[0]!.responseOverride = details => views[0]!.response?.({ ...details, responseHeaders: {} })
  await manager.reload(opened.id); await views[0]!.lastLoad
  const unconfirmed = await manager.create(opened.id, opened.url, 'workspace')
  expect(unconfirmed).toMatchObject({ objectLink, url: route, capsuleActive: false })
  expect(manager.target(opened.id)).toMatchObject({ objectLink, url: route })
  expect(views[0]!.webContents.isDestroyed()).toBe(false)
  const ordinary = await manager.create('ordinary', route, 'workspace')
  await views[1]!.lastLoad
  expect(ordinary).not.toHaveProperty('objectLink')
  expect(manager.target('ordinary')).not.toHaveProperty('objectLink')

  const tab = createWorkbenchTab('tab', { ...snapshot, regionId: 'region', kind: 'browser', workspaceId: 'workspace', browserId: opened.id })
  const persisted = JSON.parse(JSON.stringify(reducePersistedTab(tab)))
  expect(persisted.regions.region).toMatchObject({ url: route, capsuleId: capsule.record.capsuleId, capsuleOrigin: new URL(opened.url).origin })
  expect(persisted.regions.region).not.toHaveProperty('objectLink')
  const graph = { regions: [{ kind: 'browser', browserId: opened.id, regionId: 'region', tabId: tab.id }],
    tabs: [{ tabId: tab.id, regionIds: ['region'] }], resources: { 'region:region': persisted.regions.region } } as unknown as AgentMuxSpatialGraph
  expect(coldBrowserTargets(graph, [])).toEqual([expect.objectContaining({ id: opened.id, objectLink, url: route, status: 'unavailable', capabilities: [] })])
  const savedPath = join(root, 'original-graph.json'), coldModule = join(root, 'cold-descriptor.mjs')
  await writeFile(savedPath, JSON.stringify(graph))
  await symlink(fileURLToPath(new URL('../../../packages/core/node_modules', import.meta.url)), join(root, 'node_modules'), 'dir')
  const coreSource = fileURLToPath(new URL('../../../packages/core/src/', import.meta.url))
  const { build } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('esbuild')
  await build({ entryPoints: [fileURLToPath(new URL('../src/main/browser-cold-descriptor.ts', import.meta.url))], outfile: coldModule,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
    plugins: [{ name: 'original-source-public-exports', setup(plugin: { onResolve(options: { filter: RegExp }, callback: () => { path: string }): void }) {
      plugin.onResolve({ filter: /^@agentmux\/core$/ }, () => ({ path: join(coreSource, 'control-browser-targets.ts') }))
      plugin.onResolve({ filter: /^@agentmux\/core\/sharing$/ }, () => ({ path: join(coreSource, 'sharing.ts') }))
    } }] })
  // A separate process reads the first real saved projection; it receives no re-created page or graph.
  const childResult = await new Promise<string>((yes, no) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {readFile} from 'node:fs/promises';import {coldBrowserTargets} from ${JSON.stringify(pathToFileURL(coldModule).href)};
const graph=JSON.parse(await readFile(${JSON.stringify(savedPath)},'utf8'));process.stdout.write(JSON.stringify({pid:process.pid,targets:coldBrowserTargets(graph,[])}));`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
    child.once('error', no); child.once('close', code => code === 0 ? yes(stdout) : no(new Error(stderr)))
  })
  const cold = JSON.parse(childResult)
  expect(cold.pid).not.toBe(process.pid)
  expect(cold.targets).toEqual([expect.objectContaining({ id: opened.id, objectLink, url: route, status: 'unavailable', capabilities: [] })])
  expect((await manager.release(opened.id, unconfirmed.navigationId)).status).toBe('released')
  expect(manager.resourceTargets(new Map()).find(target => target.id === opened.id)).toMatchObject({ objectLink, url: route })
  await manager.restore(opened.id)
  await views.at(-1)!.lastLoad
  const restored = await manager.create(opened.id, opened.url, 'workspace')
  expect(restored).toMatchObject({ id: opened.id, objectLink, url: route })
  await manager.navigate(opened.id, 'https://outside.invalid/article?q=kept')
  const outside = await manager.create(opened.id, opened.url, 'workspace')
  expect(outside.url).toBe('https://outside.invalid/article?q=kept')
  expect(outside).not.toHaveProperty('objectLink')
  expect(manager.target(opened.id)).not.toHaveProperty('objectLink')
})

it('retains the original stable object address through actual Browser target RPC and the source-compiled CLI', async () => {
  const { root, manager, page, create } = await fixture()
  const capsule = await page('isolated'), opened = await create('browser', capsule)
  const objectLink = `amux://capsule/${capsule.record.capsuleId}`
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [], execute: async request => {
    expect(request.operation).toBe('browser.targets')
    return { operation: 'browser.targets', targets: manager.targets(), coverage: 'complete' }
  } })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const original = await rpc.call('browser.targets', {})
  expect(original.targets).toEqual([expect.objectContaining({ id: opened.id, objectLink, url: opened.url })])
  const cli = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'browser', 'targets'], objectCliEnvironment(root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.targets).toEqual(original.targets)
  expect(original.targets[0]!.control).toEqual(manager.target(opened.id)!.control)
  for (const value of ['http://127.0.0.1:12345/', 'amux://capsule/ID?execute=1', 'amux://capsule/%49D', '', null, 12]) {
    expect(() => parseBrowserTargetsResult({ ...original, targets: [{ ...original.targets[0], objectLink: value }] })).toThrow()
  }
})

it('resolves a canonical Capsule address through its original acquisition owner before loading HTTP into the exact requested Browser', async () => {
  const { manager, owner, page, views } = await fixture()
  const capsule = await page('isolated'), capsuleId = capsule.record.capsuleId
  const endpoint = (capsule.endpoint as { url: string }).url, uri = `amux://capsule/${capsuleId}`
  const create = vi.spyOn(manager, 'create')
  const acquire = (id: string, url: string) => createCapsuleBrowserDocument({
    inspect: capsuleId => owner.call('capsule.inspect', { capsuleId }), browsers: manager
  }, { id, url, capsuleId, workspaceId: 'workspace', viewport: 'responsive', operationId: 'original-bookmark-open' })
  await expect(acquire('stable-browser', uri)).resolves.toMatchObject({ id: 'stable-browser' }); await views[0]!.lastLoad
  expect(create).toHaveBeenCalledExactlyOnceWith('stable-browser', endpoint, 'workspace', undefined, 'normal', 'responsive', {
    capsule: expect.objectContaining({ record: expect.objectContaining({ capsuleId }) }), capsuleOrigin: new URL(endpoint).origin,
    capsuleOpenOperationIds: ['original-bookmark-open']
  })
  expect(manager.target('stable-browser')).toMatchObject({ objectLink: uri, url: endpoint })
  const route = new URL('original/route?q=kept#selection', endpoint).href
  await acquire('route-browser', route); await views[1]!.lastLoad
  expect(manager.target('route-browser')).toMatchObject({ objectLink: uri, url: route })
  const count = create.mock.calls.length
  for (const url of ['amux://capsule/not-original', uri + '?open=1', uri + '#selection', endpoint.replace('127.0.0.1', 'localhost')]) {
    const outcome = await acquire('wrong-browser', url).then(value => ({ value, error: null }), error => ({ value: null, error }))
    expect(outcome.error).toBeInstanceOf(Error)
    expect(outcome.value).toBeNull()
  }
  expect(create).toHaveBeenCalledTimes(count)
  expect(manager.targets().map(target => target.id)).toEqual(['stable-browser', 'route-browser'])
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
  ;(contents as any).mainFrame = { ...frame }
  expect(manager.capsuleDocument(contents as never, frame as never)).toBeNull()
  ;(contents as any).mainFrame = frame
  const popup = new native.View({ webPreferences: {} }).webContents
  popup.url = contents.url; popup.mainFrame.url = contents.url
  expect(manager.capsuleDocument(popup as never, popup.mainFrame as never)).toBeNull()
  const loading = vi.spyOn(contents, 'isLoadingMainFrame').mockReturnValue(true)
  expect(admit()).toBeNull(); loading.mockRestore()
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: contents.url })
  expect(admit()).toBeNull()
  const details = { id: ++views[0]!.requestId, url: contents.url, resourceType: 'mainFrame', webContents: contents, frame,
    statusCode: 200, responseHeaders: { 'X-AgentMux-Capsule-Instance': [(capsule.endpoint as { instanceId: string }).instanceId] } }
  views[0]!.request?.(details, () => {}); views[0]!.response?.(details)
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

it('requires the exact main-document response and preserves same-document provenance without granting stale or foreign responses', async () => {
  const { manager, page, create, views } = await fixture()
  const capsule = await page('injected'), opened = await create('browser', capsule)
  const view = views[0]!, contents = view.webContents
  const original = manager.capsuleDocument(contents as never, contents.mainFrame as never)!
  expect(original.instanceId).toBe((capsule.endpoint as { instanceId: string }).instanceId)
  const path = opened.url + '#selection'
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: path })
  contents.url = path; contents.mainFrame.url = path; contents.emit('did-navigate-in-page', {}, path, true)
  expect(manager.capsuleDocument(contents as never, contents.mainFrame as never)).toMatchObject({ instanceId: original.instanceId })
  await manager.navigate(opened.id, opened.url); await view.lastLoad
  for (const change of [
    (details: any) => ({ ...details, id: details.id - 1 }),
    (details: any) => ({ ...details, statusCode: 404 }),
    (details: any) => ({ ...details, resourceType: 'subFrame' }),
    (details: any) => ({ ...details, frame: { ...details.frame, parent: details.frame } }),
    (details: any) => ({ ...details, webContents: new native.Contents() }),
    (details: any) => ({ ...details, responseHeaders: {} })
  ]) {
    view.responseOverride = details => view.response?.(change(details))
    await manager.reload(opened.id); await view.lastLoad
    expect(manager.capsuleDocument(contents as never, contents.mainFrame as never)).toBeNull()
    expect(contents.getURL()).toBe(opened.url)
    expect(contents.isDestroyed()).toBe(false)
  }
  view.responseOverride = details => view.response?.({ ...details, responseHeaders: { 'X-AgentMux-Capsule-Instance': ['23456789ABCD'] } })
  await manager.reload(opened.id); await view.lastLoad
  expect(manager.capsuleDocument(contents as never, contents.mainFrame as never)?.instanceId).toBe('23456789ABCD')
  view.responseOverride = null
  await manager.reload(opened.id); await view.lastLoad
  expect(manager.capsuleDocument(contents as never, contents.mainFrame as never)?.instanceId).toBe(original.instanceId)
})

it('does not let a foreign page loaded on a reused port regain SDK provenance after the original Host returns', async () => {
  const { root, manager, page, create, views, owner } = await fixture()
  const capsule = await page('injected'), opened = await create('browser', capsule), view = views[0]!
  const endpoint = capsule.endpoint as { url: string; port: number; instanceId: string }
  await owner.close()
  const other = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html',
    'X-AgentMux-Capsule-Instance': endpoint.instanceId }).end('<title>Foreign content</title>'))
  await new Promise<void>((yes, no) => { other.once('error', no); other.listen(endpoint.port, '127.0.0.1', yes) })
  const closeOther = async () => { other.closeAllConnections(); await new Promise<void>(yes => other.close(() => yes())) }
  cleanups.push(async () => { if (other.listening) await closeOther() })
  await manager.reload(opened.id); await view.lastLoad
  const foreign = manager.capsuleDocument(view.webContents as never, view.webContents.mainFrame as never)!
  expect(foreign.instanceId).toBe(endpoint.instanceId)
  await closeOther()
  const restoredOwner = await NodeCapsuleOwner.open({ stateDirectory: join(root, 'state') }); cleanups.push(() => restoredOwner.close())
  const restored = await restoredOwner.call('capsule.inspect', { capsuleId: capsule.record.capsuleId })
  expect(restored.endpoint.status).toBe('available')
  expect((restored.endpoint as { instanceId: string }).instanceId).not.toBe(foreign.instanceId)
  // Main compares this fresh original-owner instance with the loaded document before each SDK call.
  expect(manager.capsuleDocument(view.webContents as never, view.webContents.mainFrame as never)?.instanceId).toBe(foreign.instanceId)
  await manager.reloadCapsule(opened.id, restored); await view.lastLoad
  expect(manager.capsuleDocument(view.webContents as never, view.webContents.mainFrame as never)?.instanceId).toBe((restored.endpoint as { instanceId: string }).instanceId)
})

it('refreshes Capsule mode in the same Browser and partition, preserves external routes, and retains a beforeunload veto', async () => {
  const { manager, owner, page, create, views } = await fixture()
  const capsule = await page('isolated'), opened = await create('browser', capsule)
  const first = views[0]!, partition = first.options.webPreferences.partition
  manager.setBounds(opened.id, { x: 0, y: 0, width: 800, height: 600 })
  expect((await manager.release(opened.id, opened.navigationId)).status).toBe('retained')
  const injected = await owner.call('capsule.update', { capsuleId: capsule.record.capsuleId, expectedRevision: capsule.record.revision,
    operationId: 'inject-mode', changes: { mode: 'injected' } })
  const updated = await manager.reloadCapsule(opened.id, injected)
  const second = views[0]!; await second.lastLoad
  expect(updated).toMatchObject({ id: opened.id, capsuleId: capsule.record.capsuleId, profileId: null })
  expect(first.webContents.dead).toBe(true); expect(second).not.toBe(first)
  expect(second.options.webPreferences).toMatchObject({ partition, preload: expect.stringMatching(/capsule\.cjs$/u) })
  expect(manager.capsuleDocument(second.webContents as never, second.webContents.mainFrame as never)).not.toBeNull()
  await manager.navigate(opened.id, 'https://outside.invalid/retained-route'); await second.lastLoad
  const isolated = await owner.call('capsule.update', { capsuleId: capsule.record.capsuleId, expectedRevision: injected.record.revision,
    operationId: 'isolate-mode', changes: { mode: 'isolated' } })
  const external = await manager.reloadCapsule(opened.id, isolated)
  const third = views[0]!; await third.lastLoad
  expect(external).toMatchObject({ id: opened.id, url: 'https://outside.invalid/retained-route' })
  expect(third.options.webPreferences).toMatchObject({ partition })
  expect(third.options.webPreferences).not.toHaveProperty('preload')
  expect(manager.capsuleDocument(third.webContents as never, third.webContents.mainFrame as never)).toBeNull()
  const reinjected = await owner.call('capsule.update', { capsuleId: capsule.record.capsuleId, expectedRevision: isolated.record.revision,
    operationId: 'reinject-mode', changes: { mode: 'injected' } })
  third.webContents.close.mockImplementation(() => { third.webContents.emit('will-prevent-unload', {}) })
  const retained = await manager.reloadCapsule(opened.id, reinjected)
  expect(retained).toMatchObject({ id: opened.id, url: 'https://outside.invalid/retained-route' })
  expect(retained.activity?.warning).toContain('retained')
  expect(third.webContents.dead).toBe(false); expect(views[0]).toBe(third)
})

it('does not repeat an unknown native close or discard an active operation while refreshing Capsule policy', async () => {
  const { manager, owner, page, create, views } = await fixture()
  const capsule = await page('isolated'), opened = await create('browser', capsule), view = views[0]!
  const injected = await owner.call('capsule.update', { capsuleId: capsule.record.capsuleId, expectedRevision: capsule.record.revision,
    operationId: 'inject-original', changes: { mode: 'injected' } })
  const entry = (manager as any).entries.get(opened.id)
  entry.runInFlight = true
  const busy = await manager.reloadCapsule(opened.id, injected)
  expect(busy.activity?.warning).toContain('operation'); expect(view.webContents.close).not.toHaveBeenCalled()
  entry.runInFlight = false
  view.webContents.close.mockImplementation(() => { throw new Error('Native close receipt unavailable') })
  const unknown = await manager.reloadCapsule(opened.id, injected)
  expect(unknown.activity?.warning).toContain('unknown'); expect(view.webContents.close).toHaveBeenCalledOnce()
  await manager.reloadCapsule(opened.id, injected)
  expect(view.webContents.close).toHaveBeenCalledOnce(); expect(views).toEqual([view])
  expect(view.webContents.dead).toBe(false); expect(view.webContents.getURL()).toBe(opened.url)
  view.webContents.close.mockImplementation(() => { view.webContents.dead = true; view.webContents.emit('destroyed') })
})
