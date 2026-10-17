// @vitest-environment happy-dom
import { readFileSync, appendFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import ts from 'typescript'
import type { AgentMuxBrowserTargetsResult } from '@agentmux/core'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'

const native = await vi.hoisted(async () => (await import('./helpers/browser-resource-directory-ports')).directoryNativePorts())
const wire = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.View,
  app: { getPath: () => process.env.AGENTMUX_DIRECTORY_PRIVATE_ROOT },
  contextBridge: { exposeInMainWorld(_key: string, api: AgentMuxPreloadApi) { wire.api = api } },
  ipcRenderer: { invoke: wire.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webFrame: {} }))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt'
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store'
import { ExternalBrowserBridge } from '../src/main/browser-external-bridge'
import { coldBrowserTargets } from '../src/main/browser-cold-descriptor'
import { browserResourceLocations } from '../src/main/browser-resource-directory'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets'

const fact = (name: string, value: unknown) => { if (process.env.AGENTMUX_DIRECTORY_FACTS) appendFileSync(process.env.AGENTMUX_DIRECTORY_FACTS, JSON.stringify({ name, value }) + '\n') }
const previewListTargets = api.browser.listTargets
const roots: string[] = [], managers: BrowserViewManager[] = [], bridges: ExternalBrowserBridge[] = []
afterEach(async () => { for (const manager of managers.splice(0)) manager.dispose()
  for (const bridge of bridges.splice(0)) await bridge.dispose()
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); vi.restoreAllMocks() })
async function fixture(graph = savedGraph()) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-directory-owner-')); roots.push(directory)
  const views: InstanceType<typeof native.View>[] = []
  const window = { webContents: new native.Contents(), isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), contentView: { children: views,
      addChildView(view: InstanceType<typeof native.View>, index = views.length) {
        const before = views.indexOf(view); if (before !== -1) views.splice(before, 1); views.splice(index, 0, view)
      }, removeChildView(view: InstanceType<typeof native.View>) { const index = views.indexOf(view); if (index !== -1) views.splice(index, 1) } } }
  const partition = vi.fn((id: string) => 'persist:' + id)
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: partition },
    new BrowserRefLedgerStore(directory), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  managers.push(manager)
  const bridge = new ExternalBrowserBridge(join(directory, 'external.json')); bridges.push(bridge); await bridge.ready()
  const spatialState = { read: vi.fn<() => Promise<{ graph: AgentMuxSpatialGraph } | null>>(async () => ({ graph })) }
  const browserProfiles = { initialize: vi.fn() }, app = { getAppMetrics: vi.fn(() => views.map(view => ({ pid: view.webContents.id, creationTime: 100 }))) }
  const ports = { browsers: manager, spatialState, browserProfiles, app, externalBridge: bridge, coldBrowserTargets, browserResourceLocations,
    config: {}, workspace: vi.fn((_config, id) => { if (id !== 'workspace') throw new Error('Wrong original workspace') }),
    requireTrustedSender: vi.fn((_channel, event) => { if (event !== trusted) throw new Error('Wrong source') }) }
  const list = handler('browser:listTargets', ports)
  return { directory, manager, views, partition, bridge, spatialState, browserProfiles, app, list }
}
const trusted = { source: 'controlled original Renderer port' }
function sourceText(path: string) {
  const overrides = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
  const value = overrides[path] ?? readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')
  if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED,
    JSON.stringify({ path, sha256: createHash('sha256').update(value).digest('hex'), consumer: 'actual registered Main callback AST', bytes: Buffer.byteLength(value) }) + '\n')
  return value as string
}
/** Only the original registered function bytes execute; native/App/graph ports are controlled Node inputs. */
function handler(channel: string, ports: Record<string, unknown>) {
  const source = sourceText('apps/desktop/src/main/ipc.ts'), file = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  const callbacks: ts.Expression[] = []
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'handleWithEvent' && node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) callbacks.push(node.arguments[1]!)
    ts.forEachChild(node, walk)
  }
  walk(file); expect(callbacks).toHaveLength(1)
  const compiled = ts.transpileModule(`const callback = ${callbacks[0]!.getText(file)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(ports), compiled + ';return callback')(...Object.values(ports)) as (event: unknown, workspaceId?: string) => Promise<AgentMuxBrowserTargetsResult>
}
function savedGraph(count = 258): AgentMuxSpatialGraph {
  const ids = [...Array.from({ length: count }, (_, i) => 'cold-' + i), ...Array.from({ length: 257 }, () => 'live')]
  return { spaces: [], zones: [], bindings: [], locations: [], layouts: {}, tabLayouts: {},
    tabs: ids.map((_id, i) => ({ tabId: 'tab-' + i, workspaceId: 'workspace', regionIds: ['region-' + i] })),
    regions: ids.map((id, i) => ({ tabId: 'tab-' + i, regionId: 'region-' + i, kind: 'browser', browserId: id })),
    resources: Object.fromEntries(ids.map((id, i) => ['region:region-' + i, { browserId: id, workspaceId: 'workspace', url: 'https://fixture.invalid/' + id,
      title: 'Original ' + id, profileId: 'saved-profile', viewport: 'mobile' }])) } as unknown as AgentMuxSpatialGraph
}

it('reads every original target and location beyond 256 through the registered Main owner and strict codec without acquisition', async () => {
  const f = await fixture(); await f.manager.create('live', 'https://fixture.invalid/live', 'workspace', 'original')
  const beforeRelease = await f.manager.create('released', 'https://fixture.invalid/released', 'workspace', 'original')
  await Promise.resolve(); await Promise.resolve()
  const released = await f.manager.release('released', beforeRelease.navigationId)
  expect(released.status).toBe('released')
  const originalView = f.views[0]!, create = vi.spyOn(f.manager, 'create'), ensure = vi.spyOn(f.manager, 'ensure'), close = originalView.webContents.close
  const calls = f.partition.mock.calls.length
  const raw = await f.list(trusted, 'workspace'), parsed = parseBrowserTargetsResult(raw)
  expect(parsed.coverage).toBe('complete'); expect(parsed.targets).toHaveLength(260)
  expect(parsed.targets.some(row => row.id === 'cold-257')).toBe(true)
  const live = parsed.targets.find(row => row.id === 'live')!
  expect(live.resource?.locations).toHaveLength(257)
  expect(live.resource?.processes).toEqual([{ pid: originalView.webContents.id, creationTime: 100 }])
  expect(parsed.targets.find(row => row.id === 'released')?.resource).toMatchObject({ state: 'released', processes: [] })
  expect(parsed.targets.filter(row => row.resource?.state === 'cold')).toHaveLength(258)
  expect(f.views).toHaveLength(1); expect(create).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  expect(f.browserProfiles.initialize).not.toHaveBeenCalled(); expect(f.partition).toHaveBeenCalledTimes(calls)
  expect(f.app.getAppMetrics).toHaveBeenCalledOnce()
  fact('actual-main-directory', { coverage: parsed.coverage, ids: parsed.targets.map(row => row.id), live, released, nativeViews: f.views.length, initializeCalls: f.browserProfiles.initialize.mock.calls.length, acquisitionCalls: create.mock.calls.length + ensure.mock.calls.length })
  await expect(f.list({})).rejects.toThrow('Wrong source')
})

it('separates membership coverage from graph or process observation failure while retaining live original owners', async () => {
  const f = await fixture(); await f.manager.create('live', 'https://fixture.invalid/live', 'workspace', 'original')
  const original = f.views[0]!, navigation = f.manager.targets().find(target => target.id === 'live')!.navigationId
  f.app.getAppMetrics.mockImplementationOnce(() => { throw new Error('metrics not observed') })
  const metricsUnknown = parseBrowserTargetsResult(await f.list(trusted))
  expect(metricsUnknown.coverage).toBe('complete'); expect(metricsUnknown.targets.find(row => row.id === 'live')?.resource?.processes).toBeNull()
  f.app.getAppMetrics.mockReturnValueOnce([{ pid: original.webContents.id, creationTime: Number.NaN }])
  expect(parseBrowserTargetsResult(await f.list(trusted)).targets.find(row => row.id === 'live')?.resource?.processes).toBeNull()
  f.spatialState.read.mockRejectedValueOnce(new Error('graph unavailable'))
  const partial = parseBrowserTargetsResult(await f.list(trusted))
  expect(partial.coverage).toBe('partial'); expect(partial.targets.map(row => row.id)).toEqual(['live']); expect(partial.warning).toContain('unconfirmed')
  expect(original.webContents.dead).toBe(false); expect(f.manager.targets().find(target => target.id === 'live')!.navigationId).toBe(navigation)
  expect(original.webContents.loads).toEqual(['https://fixture.invalid/live'])
  f.spatialState.read.mockResolvedValueOnce(null)
  expect(parseBrowserTargetsResult(await f.list(trusted)).coverage).toBe('partial')
  original.webContents.dead = true
  const unavailable = parseBrowserTargetsResult(await f.list(trusted)).targets.find(row => row.id === 'live')!
  expect(unavailable.status).toBe('unavailable'); expect(unavailable.resource?.state).toBe('unknown'); expect(unavailable.resource?.processes).toBeNull()
  original.webContents.dead = false
  fact('unknown-observation-keeps-original', { partial, metricsUnknown: metricsUnknown.targets.find(row => row.id === 'live'), unavailable })
})

it('uses original external load membership rather than ready or mutable persistence warning', async () => {
  const f = await fixture(savedGraph(1)), path = join(f.directory, 'unreadable-external.json')
  await writeFile(path, '{invalid JSON')
  const failed = new ExternalBrowserBridge(path); bridges.push(failed); await failed.ready()
  expect(failed.list()).toEqual([]); expect(failed.warning).toBeDefined()
  const list = handler('browser:listTargets', { browsers: f.manager, spatialState: f.spatialState, app: f.app, config: {},
    externalBridge: failed, coldBrowserTargets, browserResourceLocations, requireTrustedSender: vi.fn(), workspace: vi.fn() })
  const result = parseBrowserTargetsResult(await list(trusted))
  expect(result.coverage).toBe('partial'); expect(failed.membershipCoverage).toBe('partial'); expect(result.targets).toHaveLength(2); expect(result.warning).toContain('Shared Browser membership')
  // Exercise the original save owner only, without adding grants or opening the loopback transport.
  await Reflect.get(failed, 'persist').call(failed)
  expect(failed.warning).toBeUndefined(); expect(failed.membershipCoverage).toBe('partial')
  expect(f.bridge.membershipCoverage).toBe('complete') // Original ENOENT confirms empty saved membership.
  const valid = new ExternalBrowserBridge(path); bridges.push(valid); await valid.ready()
  expect(valid.membershipCoverage).toBe('complete'); expect(valid.list()).toEqual([])
  fact('external-membership-load-owner', { result, afterSuccessfulPersist: failed.membershipCoverage, missingFile: f.bridge.membershipCoverage, validDocument: valid.membershipCoverage })
})

it('rejects absent or invented required coverage without changing the original row validation', async () => {
  const f = await fixture(savedGraph(1)), original = await f.list(trusted)
  const { coverage: _coverage, ...missing } = original
  expect(() => parseBrowserTargetsResult(missing)).toThrow('coverage')
  expect(() => parseBrowserTargetsResult({ ...original, coverage: 'unknown' })).toThrow('coverage')
  expect(() => parseBrowserTargetsResult({ ...original, targets: [...original.targets, original.targets[0]] })).toThrow('identity')
  expect(parseBrowserTargetsResult(await previewListTargets()).coverage).toBe('partial')
})

it('consumes real CLI leaf through private Unix RPC Store API preload and the original Main directory owner', async () => {
  const cli = process.env.AGENTMUX_DIRECTORY_CLI
  expect(cli, 'The original Core CLI must be emitted before running the public consumer').toBeTypeOf('string')
  const f = await fixture(); await f.manager.create('live', 'https://fixture.invalid/live', 'workspace', 'original')
  const socketRoot = await mkdtemp('/tmp/amux-dir-'); roots.push(socketRoot)
  wire.invoke.mockImplementation(async (channel: string, workspaceId?: string) => {
    expect(channel).toBe('browser:listTargets'); return await f.list(trusted, workspaceId)
  })
  vi.spyOn(api.browser, 'listTargets').mockImplementation(id => wire.api!.browser.listTargets(id))
  const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
  const server = new AgentMuxControlServer({ socketPath: join(socketRoot, 'control.sock'), coreClients: () => [],
    execute: request => useAppStore.getState().executeControl(request) })
  const run = async () => new Promise<{ exit: number | null; pid: number | undefined; stdout: string; stderr: string }>((resolve, reject) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY'].filter(key => process.env[key]).map(key => [key, process.env[key]!]))
    env.AGENTMUX_RPC_ENDPOINT = 'unix:' + server.path
    const child = spawn(process.execPath, [cli!, 'browser', 'targets', '--workspace', 'workspace'], { cwd: socketRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    fact('original-cli-process', { pid: child.pid, cli, args: ['browser', 'targets', '--workspace', 'workspace'], endpoint: server.path })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => { child.kill(); reject(new Error('The exact private CLI child exceeded its bounded read')) }, 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', exit => { clearTimeout(timer); resolve({ exit, pid: child.pid, stdout, stderr }) })
  })
  try {
    await server.start()
    const complete = await run(); fact('original-cli-complete', complete); expect(complete.exit, complete.stderr).toBe(0)
    const receipt = objectCliReceipt(JSON.parse(complete.stdout)); expect(receipt.ok).toBe(true); expect(receipt.operation).toBe('browser.targets')
    const material = parseBrowserTargetsResult(receipt.result)
    expect(material.coverage).toBe('complete'); expect(material.targets).toHaveLength(259)
    expect(material.targets.find(row => row.id === 'live')?.resource?.locations).toHaveLength(257)
    expect(material.targets.find(row => row.id === 'live')?.resource?.processes).toEqual([{ pid: f.views[0]!.webContents.id, creationTime: 100 }])
    f.spatialState.read.mockRejectedValueOnce(new Error('graph unavailable'))
    const partial = await run(); fact('original-cli-partial', partial); expect(partial.exit, partial.stderr).toBe(0)
    const observed = objectCliReceipt(JSON.parse(partial.stdout)); expect(observed.ok).toBe(true)
    expect(observed.result.coverage).toBe('partial'); expect(observed.result.targets.map((row: { id: string }) => row.id)).toEqual(['live'])
    expect(execute).toHaveBeenCalledTimes(2); expect(wire.invoke).toHaveBeenCalledTimes(2)
    expect(f.views).toHaveLength(1); expect(f.views[0]!.webContents.close).not.toHaveBeenCalled()
    fact('actual-public-consumers', { execute: execute.mock.calls.map(([request]) => request), preload: wire.invoke.mock.calls, nativeViews: f.views.length, closeCalls: f.views[0]!.webContents.close.mock.calls.length })
  } finally { await server.stop() }
})
