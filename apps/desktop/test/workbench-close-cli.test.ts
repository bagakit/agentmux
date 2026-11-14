// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type * as Core from '@agentmux/core'
let core: typeof import('@agentmux/core')
import { act, createElement, createRef, Fragment } from 'react'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { webcrypto, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { build } from '../../../packages/core/node_modules/esbuild/lib/main.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { activateRuntime } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture.js'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { monacoKeybindingConstants } from './helpers/editor-pane-store.js'

vi.mock('electron', () => ({ app: { getPath: () => '/private-unused' } }))
const sourceEditor = vi.hoisted(() => ({ mount: null as ((editor: any, monaco: any) => void) | null }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ onMount, value, path }: { onMount: typeof sourceEditor.mount; value: string; path: string }) => { sourceEditor.mount = onMount; return process.env.AGENTMUX_WORKBENCH_CLOSE_VISUAL_DOM ? createElement('textarea', { 'data-isolated-monaco-paint': path, readOnly: true, value, style: { width: '100%', height: '180px' } }) : null } }))
const nativeBranch = process.env.AGENTMUX_WORKBENCH_CLOSE_NATIVE === '1'
const restartMode = process.env.AGENTMUX_WORKBENCH_CLOSE_RESTART
const business = nativeBranch && !restartMode
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private workbench close cleanup failed.')
})

it.runIf(!nativeBranch)('executes the shipping persistence branch in an isolated product-consumer process', async () => {
  const result = await new Promise<{ code: number | null; text: string }>((yes, no) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.workbench-close.config.mts'], {
      cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, AGENTMUX_WORKBENCH_CLOSE_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('Private workbench consumer process deadline.')) }, 180_000)
    child.stdout.on('data', b => { text += b }); child.stderr.on('data', b => { text += b })
    child.once('error', no); child.once('close', code => { clearTimeout(timer); yes({ code, text }) })
  })
  expect(result.code, result.text).toBe(0)
  if (process.env.AGENTMUX_WORKBENCH_CLOSE_CONSUMER_LOG) await writeFile(process.env.AGENTMUX_WORKBENCH_CLOSE_CONSUMER_LOG, result.text)
  expect(result.text).toMatch(/[1-9]\d* passed/)
}, 190_000)

async function fixture() {
  vi.resetModules(); window.localStorage.clear(); vi.stubGlobal('crypto', webcrypto)
  const root = process.env.AGENTMUX_WORKBENCH_CLOSE_ROOT ?? await mkdtemp('/tmp/wc-')
  if (!restartMode) cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = objectCliEnvironment(root)
  for (const [key, value] of Object.entries(env)) if (key.startsWith('AGENTMUX_')) vi.stubEnv(key, value!)
  // The outer restart driver loads neither a second Core nor a second Renderer
  // graph. Real product owners load only inside their Native consumer process.
  core = await import('@agentmux/core')
  const [{ AgentMuxSpatialStateStore }, { startAgentMuxHost }, { RuntimeController },
    { connectDesktopAgentMuxHost, callOriginalDesktopHost }, { desktopRpcMethods },
    { WorkbenchUserStateStore }, { DesktopControlIpcBridge }, { createDesktopWorkbenchCloseOwner }] = await Promise.all([
    import('@agentmux/core/spatial-state'), import('../../host/src/host.js'), import('../src/main/runtime-controller.js'),
    import('../src/main/desktop-host.js'), import('../src/main/desktop-rpc-exposure.js'), import('../src/main/workbench-user-state.js'),
    import('../src/main/control-ipc-bridge.js'), import('../src/main/workbench-close-owner.js')
  ])
  await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  const native = await activateRuntime({ executable: resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    socketPath: join(root, 'ctxmux.sock'), stateDir: join(root, 'state/ctxmux'), childDisposition: { mode: 'detached', stderr: 'pipe' } })
  expect(native.spawned).toBe(!restartMode); cleanup.push(() => native.dispose({ shutdown: !restartMode }))
  const agentStore = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const paths = { store: agentStore, socketPath: join(root, 'control.sock'), desktopSocketPath: join(root, 'desktop.sock'), mobileBuildDirectory: join(root, 'absent-mobile') }
  const host = await startAgentMuxHost(paths); cleanup.push(() => host.dispose()); await host.client.connect()
  const program = "process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',d=>process.stdout.write(d));process.stdout.write('READY')"
  const saved = restartMode === 'reader' ? JSON.parse(await readFile(join(root, 'original-process-facts.json'), 'utf8')) : null
  const run = saved?.run ?? await host.client.createTerminal({ command: process.execPath, args: ['-e', program], workspacePath: root, createOperationId: 'close-raw' })
  const other = saved?.other ?? await host.client.createTerminal({ command: process.execPath, args: ['-e', program], workspacePath: root, createOperationId: 'healthy-agent' })
  const capability = saved?.capability ?? core.issueAgentCapability(), agent: Core.AgentMuxStoredAgentSession = saved?.agent ?? { kind: 'agent', agentSessionId: 'healthy-agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: other.runId }, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token', capabilityHash: core.hashAgentCapability(capability), createdAt: 1, updatedAt: 1 }
  if (!saved) await agentStore.compareAndSwap(null, agent)
  if (restartMode === 'writer') await writeFile(join(root, 'original-process-facts.json'), JSON.stringify({ run, other, capability, agent, pid: process.pid }))
  const inner = host.client as unknown as { registry: { load(hostId: string): Promise<void> }; kernel: { stop: (...a: any[]) => Promise<any> } }
  await inner.registry.load('local')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private close' }], executors: {},
    workspaces: [{ id: 'W', name: 'Private close', hostId: 'local', path: root, kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const runtime = new RuntimeController(agentStore, connectDesktopAgentMuxHost)
  runtime.commit(await runtime.prepare(config)); cleanup.push(() => runtime.dispose())
  const { useAppStore: store, prepareRendererUpdate } = await import('../src/renderer/src/store.js')
  const { api } = await import('../src/renderer/src/lib/api.js')
  const { createWorkbenchTab, addWorkbenchRegion, documentKey } = await import('../src/renderer/src/lib/workbench-tabs.js')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state.js')
  const sessions = (await runtime.snapshot(config)).sessions
  expect(sessions.some(s => s.control.kind === 'terminal' && s.control.run.runId === run.runId)).toBe(true)
  const raw = sessions.find(s => s.control.kind === 'terminal' && s.control.run.runId === run.runId)!
  const original = sessions.find(s => s.control.kind === 'agent' && s.control.agentSessionId === agent.agentSessionId)!
  expect(original).toBeTruthy()
  const tab = addWorkbenchRegion(createWorkbenchTab('target-tab', { regionId: 'raw-region', kind: 'terminal', phase: 'attached', workspaceId: 'W', sessionId: raw.id }),
    'raw-region', 'right', { regionId: 'file-region', kind: 'file', workspaceId: 'W', path: 'draft.txt' })!
  const healthy = createWorkbenchTab('healthy-tab', { regionId: 'healthy-region', kind: 'agent', phase: 'attached', workspaceId: 'W', sessionId: original.id })
  const key = documentKey('W', 'draft.txt')
  if (!saved) store.setState({ config, tabs: { [tab.id]: tab, [healthy.id]: healthy }, layouts: { W: createWorkspaceLayout('G', [tab.id, healthy.id]) }, sessions,
    activeWorkspaceId: 'W', loading: false, documents: { [key]: { path: 'draft.txt', content: 'Original unsaved content', revision: 'original-file-revision' } },
    dirtyDocuments: { [key]: true }, documentGenerations: { [key]: 1 }, agentComposerDrafts: { 'healthy-region': 'Original unsent Agent draft' } })
  else store.setState({ config, sessions, loading: false })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  if (!saved) await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  const user = new WorkbenchUserStateStore(join(root, 'user.json'))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions, timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'stop').mockImplementation((control, operationId) => runtime.stopSession(control, operationId))
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => sessions.find(s => s.control.kind === control.kind && (control.kind === 'agent' ? s.control.kind === 'agent' && s.control.agentSessionId === control.agentSessionId : s.control.kind === 'terminal' && s.control.runId === control.runId))!)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  const arranged = store.getState(), dispose = await store.getState().initialize(); cleanup.push(async () => dispose())
  if (!saved) { store.setState(arranged, true); await prepareRendererUpdate('quit') }
  let bridge: InstanceType<typeof DesktopControlIpcBridge>
  bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation: () => {}, sendRequest(request) {
    if (!request.operation.startsWith('workbench.close.')) throw Error('Unexpected private Renderer request')
    void store.getState().executeWorkbenchClose(request as import('../src/shared/workbench-close-control.js').WorkbenchCloseRendererRequest).then(result => {
      bridge.accept({ requestId: request.requestId, ok: true, result })
    }, error => { bridge.accept({ requestId: request.requestId, ok: false, error: { code: 'CONTROL_UNAVAILABLE', message: error.message } }) })
  } }); cleanup.push(async () => bridge.dispose())
  const browserClose = vi.fn(async (_id: string) => {})
  const authority = { ownerId: core.spaceCloseDigest(user.path), endpoint: 'private-desktop', documentGeneration: 'private-renderer-generation' }
  let owner = createDesktopWorkbenchCloseOwner({ store: user, bridge, authority: () => authority, runtime, closeBrowser: browserClose })
  const server = new core.AgentMuxControlServer({ socketPath: paths.desktopSocketPath, exposedMethods: desktopRpcMethods(), forwardingPeer: { authoritySocketPath: paths.socketPath },
    coreClients: () => [{ hostId: 'local', client: host.client }], spaceClose: { call: (method, input, context) => owner.call(method, input, context) },
    execute: request => store.getState().executeControl(request),
    callOriginalCore: (_host, method, params, context) => callOriginalDesktopHost(host.client as any, method, params, context) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: paths.socketPath } }); cleanup.push(() => rpc.dispose())
  const managed = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: paths.socketPath }, credentials: { agentSessionId: agent.agentSessionId, capability } }); cleanup.push(() => managed.dispose())
  const cliEnv = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: `unix:${paths.socketPath}` })
  const cli = (action: string, input: unknown) => runCompiledObjectCli(['space', 'close', action, '--input', '-'], cliEnv, JSON.stringify(input), 20_000)
  const prepare = (operationId: string) => cli('prepare', { operationId, target: { kind: 'tab-occurrence', displayWorkspaceId: 'W', groupId: 'G', tabId: tab.id }, keepAgentSessions: false })
  const stops = vi.spyOn(inner.kernel, 'stop')
  return { root, host, native, run, agent, other, store, api, user, spatial, runtime, key, cli, prepare, rpc, managed, stops, browserClose, authority,
    reopenOwner: () => { owner = createDesktopWorkbenchCloseOwner({ store: user, bridge, authority: () => authority, runtime, closeBrowser: browserClose }) },
    prepared: (value: { code: number | null; stdout: string; stderr: string }) => { expect(value.code, value.stderr || value.stdout).toBe(0); return JSON.parse(value.stdout).result.operation as Core.SpaceCloseReceipt },
    apply: (record: Core.SpaceCloseReceipt) => cli('apply', { operationId: record.operationId, expectedPlanDigest: record.planDigest, decisions: core.spaceCloseDecisions(record.plan) }) }
}

async function sourceCloseFixture(split = false, file = false) {
  const f = await fixture()
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture.js')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture.js')
  const { originalSourceWorkspaceId, originalSourceTabProjectionId, originalSourceRegionProjectionId, originalSourceInputOwnerKey } = await import('../src/renderer/src/lib/original-space-navigation.js')
  const { splitWorkbenchRegion } = await import('@agentmux/layout')
  const source = await createSpaceSessionsFixture(cleanup)
  const agent = await source.d.put(f.agent.agentSessionId, 1, 'original-source-run')
  const admitted = await source.admit('D-in-B', source.d.owner.runtimeId, agent.agentSessionId, 'source-close-creation')
  if (split || file) {
    const before = (await source.b.spatial.read())!, tab = before.graph.tabs.find(tab => tab.tabId === admitted.address.tabId)!
    const regionId = 'retained-source-launcher', graph = structuredClone(before.graph)
    if (file) graph.regions = graph.regions.map(region => region.regionId === admitted.address.regionId ? {
      regionId: region.regionId, tabId: region.tabId, kind: 'file', agentSessionId: null, runId: null, execution: null,
      file: { workspaceId: admitted.address.workspaceId!, path: 'retained-source.txt' } } : region)
    graph.tabs = graph.tabs.map(current => current.tabId === tab.tabId ? { ...current, regionIds: [...current.regionIds, regionId] } : current)
    graph.regions.push({ regionId, tabId: tab.tabId, kind: 'launcher', agentSessionId: null, runId: null, execution: null })
    graph.tabLayouts[tab.tabId] = splitWorkbenchRegion(graph.tabLayouts[tab.tabId]!, admitted.address.regionId, 'right', regionId)
    await source.b.spatial.commit({ expectedRevision: before.revision, graph })
  }
  const sourceNative = vi.spyOn(source.d.core, 'runtimeSubject').mockRejectedValue(Error('Original Native observation unavailable'))
  const bridge = spaceMountTransport(cleanup, [{ id: 'source-close-route', carrier: {
    forwardRpc: source.b.rpc.call.bind(source.b.rpc), subscribeRpc: source.b.rpc.subscribe.bind(source.b.rpc) } }])
  const call = vi.spyOn(f.api.spaceMounts, 'call').mockImplementation(bridge.api.call)
  vi.spyOn(f.api.workbenchClose, 'call').mockImplementation((method, input) => f.rpc.call(method, input))
  const target = { hostId: 'source-close-route', reference: source.reference, zoneId: admitted.address.zoneId!, workspaceId: admitted.address.workspaceId! }
  const snapshot = await bridge.api.call('snapshot', { hostId: target.hostId, reference: target.reference })
  f.store.getState().mountSpace(target, false)
  f.store.getState().observeSpaceMount(target, { snapshot, reading: false })
  const workspaceId = originalSourceWorkspaceId(target), tabId = originalSourceTabProjectionId(target, admitted.address.tabId)
  const regionId = originalSourceRegionProjectionId(target, admitted.address.regionId)
  const groupId = f.store.getState().layouts[workspaceId]!.groups.find(group => group.tabOrder.includes(tabId))!.id
  const ownerKey = originalSourceInputOwnerKey(source.d.owner.runtimeId, agent.agentSessionId)
  f.store.getState().setAgentComposerDraft(ownerKey, 'Original unsent Source input')
  const close = { kind: split ? 'region' as const : 'tab-occurrence' as const, displayWorkspaceId: workspaceId, groupId, tabId, ...(split ? { regionId } : {}) }
  return { ...f, source, bridge, target, call, sourceNative, tabId, regionId, ownerKey, close, admitted }
}

it.runIf(business).each([false, true])('the shared close owner retires an unobserved Source workface (split %s) without borrowing a same-SID local Run', async split => {
  const f = await sourceCloseFixture(split), original = await f.source.d.core.readAgentSession(f.agent.agentSessionId)
  const record = await f.store.getState().prepareWorkbenchClose({ target: f.close, keepAgentSessions: false })
  expect(record.plan.projection.source).toMatchObject({ hostId: f.target.hostId, edit: { reference: f.source.reference } })
  expect(record.plan.projection.resources).toEqual([])
  const { preparedCloseConfirmation, lastViewCloseCopy } = await import("../src/renderer/src/lib/last-view-close-confirmation.js")
  const confirmation = preparedCloseConfirmation(record, f.store.getState())!
  expect(confirmation.unconfirmed).toEqual(["Agent " + f.agent.agentSessionId])
  const copy = lastViewCloseCopy(confirmation, split ? "split" : "tab")
  expect(copy.description).toContain("original shared Space"); expect(copy.description).toContain("No Stop is sent")
  expect(copy.description).not.toContain("original-source-member")
  expect(core.spaceCloseDecisions(record.plan)).toMatchObject([{ action: 'close-view-only', regionId: f.regionId }])
  expect(await f.store.getState().applyWorkbenchClose(record)).toBe(true)
  expect(f.sourceNative).not.toHaveBeenCalled(); expect(f.stops).not.toHaveBeenCalled()
  expect(await f.source.d.core.readAgentSession(f.agent.agentSessionId)).toEqual(original)
  expect((await f.native.client.status(f.other.runId)).state.type).toBe('running')
  expect(f.store.getState().agentComposerDrafts[f.ownerKey]).toBe('Original unsent Source input')
  expect(f.store.getState().agentComposerDrafts['healthy-region']).toBe('Original unsent Agent draft')
  const saved = (await f.source.b.spatial.read())!
  expect(saved.graph.regions.some(region => region.regionId === f.admitted.address.regionId)).toBe(false)
  const snapshot = await f.bridge.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  f.store.getState().observeSpaceMount(f.target, { snapshot, reading: false })
  expect(f.store.getState().tabs[f.tabId]?.regions[f.regionId]).toBeUndefined()
  if (split) expect(Object.values(f.store.getState().tabs[f.tabId]!.regions)).toHaveLength(1)
  else expect(f.store.getState().tabs[f.tabId]).toBeUndefined()
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts[f.ownerKey]).toBe('Original unsent Source input')
})

it.runIf(business)('a lost Source spatial ACK keeps the same close unknown and never repeats the write or stops either same-SID Agent', async () => {
  const f = await sourceCloseFixture(), apply = f.bridge.api.call
  f.call.mockImplementation(async (method, input, signal) => {
    const result = await apply(method, input, signal)
    if (method === 'apply') throw Error('Original Source close ACK unavailable')
    return result
  })
  const record = await f.store.getState().prepareWorkbenchClose({ target: f.close, keepAgentSessions: false })
  expect(await f.store.getState().applyWorkbenchClose(record)).toBe(false)
  expect(f.store.getState().tabs[f.tabId]?.regions[f.regionId]).toBeDefined()
  expect(await f.store.getState().applyWorkbenchClose(record)).toBe(false)
  expect(f.call.mock.calls.filter(([method]) => method === 'apply')).toHaveLength(1)
  expect((await f.rpc.call('space.close.inspect', { operationId: record.operationId })).operation).toMatchObject({ outcome: 'unknown' })
  expect(f.store.getState().agentComposerDrafts[f.ownerKey]).toBe('Original unsent Source input')
  expect(f.sourceNative).not.toHaveBeenCalled(); expect(f.stops).not.toHaveBeenCalled()
  const snapshot = await f.bridge.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  f.store.getState().observeSpaceMount(f.target, { snapshot, reading: false })
  expect(f.store.getState().tabs[f.tabId]).toBeUndefined()
})

it.runIf(business)('late Source File input retains its original View after the spatial ACK and can then close locally without a second Source write', async () => {
  const f = await sourceCloseFixture(true, true)
  const surface = f.store.getState().tabs[f.tabId]!.regions[f.regionId]!
  expect(surface.kind).toBe('file'); if (surface.kind !== 'file') throw Error('Expected original Source File')
  const { documentKey } = await import('../src/renderer/src/lib/workbench-tabs.js')
  const key = documentKey(surface.workspaceId, surface.path)
  f.store.setState(current => ({ documents: { ...current.documents, [key]: { path: surface.path, content: 'Original Source buffer', revision: 'original-source-file-revision' } }, dirtyDocuments: { ...current.dirtyDocuments, [key]: true } }))
  const record = await f.store.getState().prepareWorkbenchClose({ target: f.close, keepAgentSessions: true })
  expect(record.plan.projection.drafts).toMatchObject([{ document: { hostId: f.target.hostId, workspaceId: surface.workspaceId } }])
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  cleanup.push(async () => release?.())
  const actual = f.bridge.api.call
  f.call.mockImplementation(async (method, input, signal) => {
    if (method === 'apply') { enter(); await waiting }
    return await actual(method, input, signal)
  })
  const pending = f.store.getState().applyWorkbenchClose(record); await entered
  f.store.getState().updateDocument(f.tabId, 'Late Source buffer must survive', f.regionId)
  release()
  expect(await pending).toBe(false)
  expect(f.store.getState().tabs[f.tabId]?.regions[f.regionId]).toMatchObject({ kind: 'file', path: surface.path })
  expect(f.store.getState().documents[key]?.content).toBe('Late Source buffer must survive')
  const inspected = (await f.rpc.call('space.close.inspect', { operationId: record.operationId })).operation!
  expect(inspected, inspected.issue).toMatchObject({ outcome: 'partial', clientProjection: { retainedRegions: [f.regionId] } })
  const snapshot = await f.bridge.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  f.store.getState().observeSpaceMount(f.target, { snapshot, reading: false })
  expect(f.store.getState().tabs[f.tabId]?.regions[f.regionId]).toBeDefined()
  expect(JSON.parse((await f.user.read())!).state.documents[key].content).toBe('Late Source buffer must survive')
  const reviewed = await f.store.getState().prepareWorkbenchClose({ target: f.close, keepAgentSessions: true })
  expect(reviewed.plan.projection.source).toBeUndefined()
  expect(await f.store.getState().applyWorkbenchClose(reviewed)).toBe(true)
  expect(f.call.mock.calls.filter(([method]) => method === 'apply')).toHaveLength(1)
  expect(f.store.getState().tabs[f.tabId]?.regions[f.regionId]).toBeUndefined()
})

it.runIf(business)('a Source successor binding received after the spatial write survives the older exact close', async () => {
  const f = await sourceCloseFixture(true)
  const record = await f.store.getState().prepareWorkbenchClose({ target: f.close, keepAgentSessions: false }), actual = f.bridge.api.call
  f.call.mockImplementation(async (method, input, signal) => {
    const receipt = await actual(method, input, signal)
    if (method === 'apply') {
      const current = (await f.source.b.spatial.read())!, graph = structuredClone(current.graph), tabId = f.admitted.address.tabId
      graph.tabs = graph.tabs.map(tab => tab.tabId === tabId ? { ...tab, regionIds: [...tab.regionIds, f.admitted.address.regionId] } : tab)
      graph.regions.push({ regionId: f.admitted.address.regionId, tabId, kind: 'agent', agentSessionId: 'successor-source-agent', runId: null, execution: null })
      const { splitWorkbenchRegion } = await import('@agentmux/layout')
      graph.tabLayouts[tabId] = splitWorkbenchRegion(graph.tabLayouts[tabId]!, graph.tabLayouts[tabId]!.activeRegionId, 'right', f.admitted.address.regionId)
      await f.source.b.spatial.commit({ expectedRevision: current.revision, graph })
      const snapshot = await actual('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
      f.store.getState().observeSpaceMount(f.target, { snapshot, reading: false })
    }
    return receipt
  })
  expect(await f.store.getState().applyWorkbenchClose(record)).toBe(false)
  expect(f.store.getState().tabs[f.tabId]?.regions[f.regionId]?.source).toMatchObject({ agentSessionId: 'successor-source-agent' })
  expect(f.stops).not.toHaveBeenCalled(); expect(f.sourceNative).not.toHaveBeenCalled()
  expect((await f.source.b.spatial.read())!.graph.regions.find(region => region.regionId === f.admitted.address.regionId)?.agentSessionId).toBe('successor-source-agent')
})

it.runIf(business)('compiled CLI closes the exact frozen raw Run and reviewed dirty file through the original Main and Renderer owners', async () => {
  const f = await fixture(), before = await readFile(join(f.root, 'sessions.json'))
  const prepared = f.prepared(await f.prepare('reviewed-close'))
  expect(prepared).toMatchObject({ phase: 'prepared', diskDurability: 'confirmed', preparedBy: { kind: 'user' } })
  expect(prepared.plan.projection.drafts).toHaveLength(1); expect(f.stops).not.toHaveBeenCalled()
  expect(JSON.stringify(prepared)).not.toContain('Original unsaved content')
  const applied = f.prepared(await f.apply(prepared))
  expect(applied).toMatchObject({ phase: 'settled', outcome: 'applied', approvedBy: prepared.preparedBy,
    clientProjection: { removedRegions: ['raw-region', 'file-region'], retainedRegions: [], save: { diskDurability: 'confirmed' } }, spatialContribution: { save: { diskDurability: 'confirmed' } } })
  expect(f.stops).toHaveBeenCalledTimes(1)
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('exited')
  expect(f.store.getState().tabs['target-tab']).toBeUndefined()
  expect(f.store.getState().tabs['healthy-tab']).toBeDefined()
  expect(f.store.getState().agentComposerDrafts['healthy-region']).toBe('Original unsent Agent draft')
  await f.host.client.writeAgent({ agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, data: 'healthy-after-close', source: 'user' })
  expect((await f.native.client.status(f.other.runId)).state.type).toBe('running')
  expect(await readFile(join(f.root, 'sessions.json'))).toEqual(before)
  expect((await f.spatial.read())!.graph.tabs.some(t => t.tabId === 'target-tab')).toBe(false)
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts['healthy-region']).toBe('Original unsent Agent draft')
  expect(f.prepared(await f.apply(prepared))).toEqual(applied); expect(f.stops).toHaveBeenCalledTimes(1)
  expect((await f.rpc.call('space.close.inspect', { operationId: prepared.operationId })).operation).toEqual(applied)
})

it.runIf(business)('prepared and unknown IDs are discoverable after owner reopen without replay or Native activation, and managed apply is refused', async () => {
  const f = await fixture(), prepared = f.prepared(await f.prepare('prepared-original'))
  const request = { operationId: 'managed-original', target: prepared.request.target, keepAgentSessions: false }
  const managed = (await f.managed.call('space.close.prepare', request)).operation!
  expect(managed.preparedBy).toMatchObject({ kind: 'agent', id: f.agent.agentSessionId })
  await expect(f.managed.call('space.close.apply', { operationId: managed.operationId, expectedPlanDigest: managed.planDigest, decisions: core.spaceCloseDecisions(managed.plan) })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const originalStop = f.stops.getMockImplementation()
  f.stops.mockRejectedValueOnce(Error('Private Native Stop observation unavailable'))
  const unknown = await f.apply(prepared)
  expect(unknown.code, unknown.stdout).toBe(1)
  expect(JSON.parse(unknown.stdout).result.operation.outcome).toBe('partial')
  expect(f.store.getState().tabs['target-tab']?.regions['raw-region']).toBeDefined()
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
  f.reopenOwner()
  const originalCalls = vi.spyOn(f.runtime, 'callOriginalCore')
  const list = await f.rpc.call('space.close.ls', { limit: 1 })
  expect(list.coverage).toBe('live-page'); expect(list.items).toHaveLength(1)
  const next = list.nextCursor ? await f.rpc.call('space.close.ls', { limit: 10, cursor: list.nextCursor }) : list
  expect([...list.items, ...next.items].map(o => o.operationId)).toContain('prepared-original')
  const inspection = await f.rpc.call('space.close.inspect', { operationId: prepared.operationId })
  expect(inspection.operation).toMatchObject({ outcome: 'partial', diskDurability: 'unconfirmed' })
  expect(originalCalls.mock.calls.some(([, method]) => method === 'terminal.operation.inspect')).toBe(true)
  expect(originalCalls.mock.calls.filter(([, method]) => method === 'terminal.stop')).toHaveLength(0)
  expect((await f.apply(prepared)).code).toBe(1); expect(f.stops).toHaveBeenCalledTimes(1)
  expect((await f.managed.call('space.close.ls', {})).items.map(o => o.operationId)).toEqual(['managed-original'])
  expect(originalStop).toBeUndefined()
})

async function successorFixture() {
  const f = await fixture()
  const next = await f.host.client.createTerminal({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], workspacePath: f.root, createOperationId: 'successor' })
  const current = { ...f.agent, retiredRuns: [f.agent.run], run: { runId: next.runId }, updatedAt: 2 }
  await (f.host.client as any).store.compareAndSwap(f.agent, current)
  await (f.host.client as any).registry.load('local')
  return { f, current, next }
}
it.runIf(business)('exact Agent Stop keeps its discriminated Run fence, rejects unfenced or non-Stop misuse and never stops a successor', async () => {
  const { f, next } = await successorFixture()
  const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: `unix:${join(f.root, 'control.sock')}` })
  const race = await runCompiledObjectCli(['agent', 'stop', '--session', f.agent.agentSessionId, '--run', f.agent.run.runId, '--operation-id', 'frozen-old-run'], env)
  expect(race.code, race.stdout).toBe(1)
  expect(f.stops).not.toHaveBeenCalled()
  expect((await f.native.client.status(next.runId)).state.type).toBe('running')
  const { rpcControlRequest } = await import('../../../packages/core/src/rpc-business-codec.js')
  for (const method of ['agent.interrupt', 'agent.resume', 'agent.stop'] as const) {
    expect(() => rpcControlRequest(method, { target: { kind: 'agent-run', agentSessionId: f.agent.agentSessionId }, ...(method === 'agent.stop' ? {} : { expectedRun: f.agent.run }) })).toThrow()
  }
  expect(() => rpcControlRequest('agent.stop', { target: { kind: 'agent-session', agentSessionId: f.agent.agentSessionId }, expectedRun: f.agent.run })).toThrow()
})

it.runIf(business).each([false, true])('compiled Agent Stop exact=%s preserves the original business operation receipt through both services', async exact => {
  const f = await fixture(), operationId = exact ? 'exact-native-stop' : 'current-native-stop'
  const result = await runCompiledObjectCli(['agent', 'stop', '--session', f.agent.agentSessionId, ...(exact ? ['--run', f.agent.run.runId] : []), '--operation-id', operationId],
    objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: `unix:${join(f.root, 'control.sock')}` }))
  expect(result.code, result.stderr || result.stdout).toBe(0)
  expect(JSON.parse(result.stdout).result.receipt).toMatchObject({ operationId, agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, admission: 'new' })
  expect(f.stops).toHaveBeenCalledTimes(1)
  expect((await f.native.client.status(f.other.runId)).state.type).toBe('exited')
  expect((await f.rpc.call('agent.stop.inspect', { agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, operationId })).operationIdMatched).toBe(true)
})

it.runIf(business && Boolean(process.env.AGENTMUX_WORKBENCH_LEGACY_BASE))('qualifies the exact mixed-version codec receiver against the current compiled CLI without a current-Run downgrade', async () => {
  const { f, current, next } = await successorFixture()
  // Compile the actual frozen pre-feature receiver codecs, with their original
  // module contents. The Unix/compiled-CLI boundary is real; this deliberately
  // does not claim to start an entire older installed App.
  const base = process.env.AGENTMUX_WORKBENCH_LEGACY_BASE!
  const frozen = (file: string) => execFileSync('git', ['show', `${base}:packages/core/src/${file}`], { encoding: 'utf8' })
  const receiverPath = join(f.root, 'original-receiver.mjs')
  await build({ stdin: { contents: frozen('rpc-business-codec.ts'), resolveDir: resolve('packages/core/src'), sourcefile: 'rpc-business-codec.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: receiverPath,
    banner: { js: "import { createRequire as privateRequire } from 'node:module';const require=privateRequire(import.meta.url);" }, plugins: [{ name: 'frozen-original-codec', setup(b) {
      b.onLoad({ filter: /\/control-codec\.ts$/ }, () => ({ contents: frozen('control-codec.ts'), loader: 'ts' }))
    } }] })
  const receiver = new ObjectCliProbe(async request => {
    // Native Node loads this frozen receiver; a test-runner module transform is
    // deliberately not used for mixed-version protocol acceptance.
    let parsed: any
    try {
      parsed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
        'import{readFileSync}from"node:fs";const m=await import(process.argv[1]);const q=JSON.parse(readFileSync(0,"utf8"));try{console.log(JSON.stringify(m.rpcControlRequest(q.method,q.params)))}catch(e){console.log(JSON.stringify({rejected:{code:e.code,message:e.message}}))}',
        receiverPath], { encoding: 'utf8', input: JSON.stringify(request) }))
    } catch (error) { throw Error('The frozen receiver process failed before protocol acceptance: ' + String(error)) }
    if (parsed.rejected) throw Object.assign(Error(parsed.rejected.message), { code: parsed.rejected.code })
    // A faulty downgrade is consequential: the exact private successor would
    // actually be stopped by the original current-intent consumer.
    await f.host.client.stopAgent(parsed.target.agentSessionId, current.run, { operationId: 'old-receiver-current-intent' })
    throw Object.assign(Error('Old receiver accepted an unsafe current intent.'), { code: 'PRIVATE_UNSAFE_DOWNGRADE' })
  }); await receiver.start(); cleanup.push(() => receiver.stop())
  const oldResult = await receiver.run(['agent', 'stop', '--session', f.agent.agentSessionId, '--run', f.agent.run.runId, '--operation-id', 'old-codec-fence'])
  expect(oldResult.code).toBe(1)
  expect(JSON.parse(oldResult.stderr).error.code).toBe('INVALID_CONTROL_REQUEST')
  expect(receiver.requests).toHaveLength(1)
  expect(receiver.requests[0]!.params).toMatchObject({ target: { kind: 'agent-run', agentSessionId: f.agent.agentSessionId }, expectedRun: f.agent.run })
  expect(f.stops).not.toHaveBeenCalled()
  expect((await f.native.client.status(next.runId)).state.type).toBe('running')
  if (process.env.AGENTMUX_WORKBENCH_LEGACY_PROOF) await writeFile(process.env.AGENTMUX_WORKBENCH_LEGACY_PROOF, JSON.stringify({
    schema: 'agentmux.workbench-close-legacy-codec.v1', base,
    originalBlobs: Object.fromEntries(['rpc-business-codec.ts', 'control-codec.ts'].map(file => [file, execFileSync('git', ['rev-parse', `${base}:packages/core/src/${file}`], { encoding: 'utf8' }).trim()])),
    bundleSha256: createHash('sha256').update(await readFile(receiverPath)).digest('hex'),
    currentSourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    currentCompiledCliSha256: createHash('sha256').update(await readFile(resolve('packages/core/dist/agentmux.js'))).digest('hex'),
    actualWire: receiver.requests[0], rejectedCode: JSON.parse(oldResult.stderr).error.code, stopCalls: f.stops.mock.calls.length,
    successorState: (await f.native.client.status(next.runId)).state.type,
    scope: 'Explicit opt-in frozen old codec/real Node receiver and current compiled CLI over private Unix transport; not an entire old App.'
  }, null, 2) + '\n')
})

it.runIf(business)('input typed during a real external Stop wait survives final dirty CAS and retains only that changed File Region', async () => {
  const f = await fixture(), prepared = f.prepared(await f.prepare('dirty-during-stop'))
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(yes => { entered = yes }), held = new Promise<void>(yes => { release = yes })
  const attach = (f.host.client as any).kernel.client
  const originalAttach = attach.attachRecoverableStop.bind(attach)
  vi.spyOn(attach, 'attachRecoverableStop').mockImplementationOnce(async (...args: any[]) => { entered(); await held; return originalAttach(...args) })
  const applying = f.apply(prepared)
  await started
  const state = f.store.getState()
  f.store.setState({ documents: { ...state.documents, [f.key]: { ...state.documents[f.key]!, content: 'New input with dirty still true' } }, documentGenerations: { ...state.documentGenerations, [f.key]: 2 } })
  release()
  const result = await applying
  expect(result.code, result.stderr).toBe(1)
  const receipt = JSON.parse(result.stdout).result.operation
  expect(receipt).toMatchObject({ outcome: 'partial', clientProjection: { removedRegions: ['raw-region'], retainedRegions: ['file-region'] } })
  expect(f.store.getState().documents[f.key]?.content).toBe('New input with dirty still true')
  expect(f.store.getState().dirtyDocuments[f.key]).toBe(true)
  expect(f.store.getState().tabs['target-tab']?.regions['file-region']).toBeDefined()
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('exited')
  expect(f.stops).toHaveBeenCalledTimes(1)
})

it.runIf(business)('wrong decisions, a new outside View and a single-Region target never authorize another resource or whole Tab', async () => {
  const f = await fixture(), plan = f.prepared(await f.prepare('outside-view'))
  await expect(f.rpc.call('space.close.apply', { operationId: plan.operationId, expectedPlanDigest: plan.planDigest, decisions: [] })).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_DECISIONS_REQUIRED' })
  expect(f.stops).not.toHaveBeenCalled()
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs.js')
  const raw = f.store.getState().sessions.find(s => s.control.kind === 'terminal' && s.control.run.runId === f.run.runId)!
  const outside = createWorkbenchTab('new-outside-view', { kind: 'terminal', phase: 'attached', workspaceId: 'W', regionId: 'outside-raw', sessionId: raw.id })
  const state = f.store.getState(), layout = state.layouts.W!
  f.store.setState({ tabs: { ...state.tabs, [outside.id]: outside }, layouts: { ...state.layouts, W: { ...layout, groups: layout.groups.map(g => ({ ...g, tabOrder: [...g.tabOrder, outside.id] })) } } })
  expect((await f.apply(plan)).code).toBe(1)
  expect(f.stops).not.toHaveBeenCalled(); expect(f.store.getState().tabs['target-tab']).toBeDefined()
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
  const region = f.prepared(await f.cli('prepare', { operationId: 'only-file-region', keepAgentSessions: false,
    target: { kind: 'region', displayWorkspaceId: 'W', groupId: 'G', tabId: 'target-tab', regionId: 'file-region' } }))
  expect(f.prepared(await f.apply(region)).clientProjection).toMatchObject({ removedRegions: ['file-region'], retainedRegions: [] })
  expect(f.store.getState().tabs['target-tab']?.regions['raw-region']).toBeDefined()
  const sole = await f.cli('prepare', { operationId: 'cannot-expand-region', keepAgentSessions: false,
    target: { kind: 'region', displayWorkspaceId: 'W', groupId: 'G', tabId: 'target-tab', regionId: 'raw-region' } })
  expect(sole.code).toBe(1); expect(f.stops).not.toHaveBeenCalled()
  expect(f.store.getState().tabs['new-outside-view']).toBeDefined()
})

it.runIf(business)('obtained Native ACK survives a missing Main receipt member; a cold read lists that original ID as unconfirmed without replay', async () => {
  const f = await fixture(), plan = f.prepared(await f.prepare('ack-before-member-loss'))
  const path = f.user.path + '.close-operations/' + createHash('sha256').update(plan.operationId).digest('hex') + '.json'
  const native = (f.host.client as any).kernel.client, actual = native.attachRecoverableStop.bind(native)
  vi.spyOn(native, 'attachRecoverableStop').mockImplementationOnce(async (...args: any[]) => {
    const ack = await actual(...args)
    await rm(path)
    return ack
  })
  const result = await f.apply(plan)
  expect(result.code).toBe(1)
  const record = JSON.parse(result.stdout).result.operation
  expect(record).toMatchObject({ outcome: 'unknown', diskDurability: 'unconfirmed', resources: [{ outcome: 'acknowledged', receipt: { outcome: 'applied', acknowledgement: { kind: 'stop', runId: f.run.runId } } }] })
  expect((await f.rpc.call('space.close.inspect', { operationId: plan.operationId })).operation).toEqual(record)
  expect(f.store.getState().tabs['target-tab']).toBeDefined()
  f.reopenOwner()
  const list = await f.rpc.call('space.close.ls', {})
  expect(list).toMatchObject({ availability: 'partial', items: [{ operationId: plan.operationId, phase: 'unconfirmed', outcome: 'unknown' }] })
  await expect(f.rpc.call('space.close.inspect', { operationId: plan.operationId })).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_UNCONFIRMED' })
  expect((await f.apply(plan)).code).toBe(1); expect(f.stops).toHaveBeenCalledTimes(1)
})

it.runIf(business)('a late real Stop ACK updates only the original facts and never consumes later input or removes the retained Region again', async () => {
  const f = await fixture(), plan = f.prepared(await f.prepare('late-original-stop'))
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(yes => { entered = yes }), held = new Promise<void>(yes => { release = yes })
  const native = (f.host.client as any).kernel.client, actual = native.attachRecoverableStop.bind(native)
  vi.spyOn(native, 'attachRecoverableStop').mockImplementationOnce(async (...args: any[]) => { entered(); await held; return actual(...args) })
  const applying = f.apply(plan); await started
  await f.host.client.writeAgent({ agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, data: 'healthy-during-close-observation', source: 'user' })
  const result = await applying
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout).result.operation).toMatchObject({ outcome: 'partial', resources: [{ outcome: 'unknown' }], clientProjection: { retainedRegions: ['raw-region'] } })
  f.store.getState().setAgentComposerDraft('healthy-region', 'New draft after unknown close')
  release()
  await vi.waitFor(async () => expect((await f.rpc.call('space.close.inspect', { operationId: plan.operationId })).operation?.resources[0]).toMatchObject({ outcome: 'acknowledged', receipt: { acknowledgement: { kind: 'stop' } } }), { timeout: 5000 })
  expect(f.store.getState().tabs['target-tab']?.regions['raw-region']).toBeDefined()
  expect(f.store.getState().agentComposerDrafts['healthy-region']).toBe('New draft after unknown close')
  expect(f.stops).toHaveBeenCalledTimes(1)
  expect((await f.apply(plan)).code).toBe(1); expect(f.stops).toHaveBeenCalledTimes(1)
})

it.runIf(business)('original managed preparation and transport-approved Device execution retain distinct actors through the real trusted child channel', async () => {
  const f = await fixture(), input = { operationId: 'device-reviewed-close', target: { kind: 'tab-occurrence' as const, displayWorkspaceId: 'W', groupId: 'G', tabId: 'target-tab' }, keepAgentSessions: false }
  const prepared = (await f.managed.call('space.close.prepare', input)).operation!
  const authority = await f.host.deviceAuthority(), key = Buffer.alloc(32, 17).toString('base64'), device = await authority.authorizeKey(key)
  const actor = { kind: 'device' as const, id: `${authority.hostId}:${device.deviceId}` }, observation = authority.observe(device)
  cleanup.push(async () => observation.dispose())
  let receive: ((frame: any) => void) | undefined
  const frames = f.host.server.openAuthenticatedFrames({ authorization: { principal: actor, signal: observation.signal, assertCurrent: () => authority.assertCurrentKey(device, key) }, send: frame => { receive?.(frame) }, close: () => {} })
  cleanup.push(async () => frames.dispose())
  const result = await new Promise<any>((yes, no) => {
    receive = frame => { if (frame.id === 1) frame.error ? no(frame.error) : yes(frame.result) }
    void frames.receive({ jsonrpc: '2.0', id: 1, method: 'space.close.apply', params: { operationId: input.operationId, expectedPlanDigest: prepared.planDigest, decisions: core.spaceCloseDecisions(prepared.plan) } }).catch(no)
  })
  expect(result.operation).toMatchObject({ outcome: 'applied', preparedBy: { kind: 'agent', id: f.agent.agentSessionId }, approvedBy: actor,
    resources: [{ receipt: { actor, target: { run: { runId: f.run.runId } } } }] })
  expect(f.stops).toHaveBeenCalledTimes(1)
})

it.runIf(business)('Keep choice cannot broaden a human review after another Region or display occurrence appears between the two real preparations', async () => {
  const f = await fixture()
  const { samePreparedCloseReview } = await import('../src/renderer/src/lib/workbench-close-owner.js')
  const { addWorkbenchRegion } = await import('../src/renderer/src/lib/workbench-tabs.js')
  const stop = f.prepared(await f.prepare('review-before-new-region'))
  const before = f.store.getState(), tab = before.tabs['target-tab']!
  f.store.setState({ tabs: { ...before.tabs, [tab.id]: addWorkbenchRegion(tab, 'file-region', 'right', { kind: 'launcher', regionId: 'new-unreviewed-region', workspaceId: 'W' }) } })
  const keep = f.prepared(await f.cli('prepare', { operationId: 'keep-after-new-region', target: stop.plan.target, keepAgentSessions: true }))
  expect(samePreparedCloseReview(stop, keep)).toBe(false)
  expect(f.store.getState().tabs['target-tab']?.regions['new-unreviewed-region']).toBeDefined()
  // A second change to display membership also requires a current review even
  // when every existing surface/draft still compares equal.
  const current = f.store.getState(), layout = current.layouts.W!
  f.store.setState({ layouts: { ...current.layouts, W: { ...layout, groups: [...layout.groups, { ...layout.groups[0]!, id: 'new-display-group', tabOrder: [tab.id], activeTabId: tab.id }] } } })
  const another = f.prepared(await f.cli('prepare', { operationId: 'keep-after-new-occurrence', target: stop.plan.target, keepAgentSessions: true }))
  expect(samePreparedCloseReview(keep, another)).toBe(false)
  expect(f.stops).not.toHaveBeenCalled()
})

it.runIf(business)('real Renderer capture and portable RPC accept 513 existing lightweight Regions within the actual carrier byte budget', async () => {
  const f = await fixture(), { createWorkbenchTab, addWorkbenchRegion } = await import('../src/renderer/src/lib/workbench-tabs.js')
  let tab = createWorkbenchTab('many-regions', { kind: 'launcher', regionId: 'light-0', workspaceId: 'W' })
  for (let i = 1; i <= 512; i++) tab = addWorkbenchRegion(tab, 'light-0', 'right', { kind: 'launcher', regionId: 'light-' + i, workspaceId: 'W' })
  const current = f.store.getState(), layout = current.layouts.W!
  f.store.setState({ tabs: { ...current.tabs, [tab.id]: tab }, layouts: { ...current.layouts, W: { ...layout, groups: layout.groups.map(g => ({ ...g, tabOrder: [...g.tabOrder, tab.id] })) } } })
  const record = f.prepared(await f.cli('prepare', { operationId: 'original-large-lightweight-view', target: { kind: 'tab-occurrence', displayWorkspaceId: 'W', groupId: 'G', tabId: tab.id }, keepAgentSessions: false }))
  expect(record.plan.projection.surfaces).toHaveLength(513)
  expect(record.plan.children).toEqual([])
  expect(f.stops).not.toHaveBeenCalled()
  expect(Object.keys(f.store.getState().tabs[tab.id]!.regions)).toHaveLength(513)
})

it.runIf(business)('a late old Monaco dispose cannot clear a new editor composition or authorize discard of its original File Region', async () => {
  const f = await fixture(), { FileSourceEditor } = await import('../src/renderer/src/components/FileSourceEditor.js')
  const { hasNoteComposition } = await import('../src/renderer/src/lib/note-live-merge.js')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const node = document.createElement('div'); document.body.append(node)
  const { createClientUiRoot } = await import('./helpers/client-ui-render.js')
  const root = createClientUiRoot(node)
  cleanup.push(async () => { await act(async () => root.unmount()); node.remove() })
  await act(async () => root.render(createElement(FileSourceEditor, { tabId: 'target-tab', surface: { kind: 'file', regionId: 'file-region', workspaceId: 'W', path: 'draft.txt' }, viewState: createRef() })))
  const editor = () => {
    let begin!: () => void, end!: () => void, dispose!: () => void
    const object = { layout() {}, focus() {}, getContainerDomNode: () => node, addCommand() {}, addAction() {}, createContextKey: () => ({ set() {} }),
      onDidChangeCursorSelection() {}, onDidCompositionStart(cb: () => void) { begin = cb }, onDidCompositionEnd(cb: () => void) { end = cb },
      onDidDispose(cb: () => void) { dispose = cb }, getModel: () => null }
    return { object, begin: () => begin(), end: () => end(), dispose: () => dispose() }
  }
  const old = editor(), next = editor()
  await act(async () => sourceEditor.mount!(old.object, monacoKeybindingConstants()))
  old.begin()
  await act(async () => sourceEditor.mount!(next.object, monacoKeybindingConstants()))
  next.begin(); old.dispose()
  expect(hasNoteComposition(f.key)).toBe(true)
  const request = { keepAgentSessions: false, target: { kind: 'region', displayWorkspaceId: 'W', groupId: 'G', tabId: 'target-tab', regionId: 'file-region' } }
  const blocked = f.prepared(await f.cli('prepare', { ...request, operationId: 'new-editor-still-composing' }))
  expect(blocked.plan.projection.surfaces[0]!.blocker).toBe('draft-busy')
  expect((await f.apply(blocked)).code).toBe(1)
  expect(f.store.getState().tabs['target-tab']?.regions['file-region']).toBeDefined()
  expect(f.store.getState().documents[f.key]?.content).toBe('Original unsaved content')
  next.end(); old.begin()
  expect(hasNoteComposition(f.key)).toBe(false)
  next.begin(); next.dispose()
  expect(hasNoteComposition(f.key)).toBe(false)
  const ended = f.prepared(await f.cli('prepare', { ...request, operationId: 'new-editor-ended' }))
  expect(f.prepared(await f.apply(ended)).outcome).toBe('applied')
  expect(f.store.getState().tabs['target-tab']?.regions['file-region']).toBeUndefined()
  expect(f.stops).not.toHaveBeenCalled()
})

it.runIf(business).each(['Keep Session & Close', 'Stop & Close'])('actual GUI %s consumes the same original Main plan and resource owners as CLI', async choice => {
  const f = await fixture(), { useWorkbenchTabsClose } = await import('../src/renderer/src/hooks/useWorkbenchTabsClose.js')
  const { installNativePopover } = await import('./fixtures/mote-workface.js')
  const restorePopover = installNativePopover(); cleanup.push(async () => restorePopover())
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const calls = vi.spyOn(f.api.workbenchClose, 'call').mockImplementation((method, input) => f.rpc.call(method, input))
  const visual = choice === 'Stop & Close' ? process.env.AGENTMUX_WORKBENCH_CLOSE_VISUAL_DOM : undefined
  const { AgentOperationFeedback } = await import('../src/renderer/src/components/AgentOperationFeedback.js')
  let releaseVisual: (() => void) | undefined
  if (visual) {
    const native = (f.host.client as any).kernel.client, stop = native.attachRecoverableStop.bind(native)
    const held = new Promise<void>(resolve => { releaseVisual = resolve })
    vi.spyOn(native, 'attachRecoverableStop').mockImplementationOnce(async (...args: any[]) => { await held; return stop(...args) })
    cleanup.push(async () => releaseVisual?.())
  }
  const { createClientUiRoot } = await import('./helpers/client-ui-render.js')
  const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node)
  cleanup.push(async () => { await act(async () => root.unmount()); node.remove() })
  function Consumer() {
    const close = useWorkbenchTabsClose()
    return createElement(Fragment, null, createElement('button', { onClick: () => void close.request({ workspaceId: 'W', group: { id: 'G', tabOrder: ['target-tab', 'healthy-tab'] }, tabIds: ['healthy-tab'], subject: 'Original Agent' }) }, 'Close original Agent View'), createElement(AgentOperationFeedback, { subject: { hostId: 'local', agentSessionId: f.agent.agentSessionId } }), close.dialog)
  }
  await act(async () => root.render(createElement(Consumer)))
  await act(async () => node.querySelector<HTMLButtonElement>('button')!.click())
  await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(b => b.textContent === choice), JSON.stringify({ error: f.store.getState().error, calls: calls.mock.calls, html: document.body.innerHTML })).toBe(true), { timeout: 5000 })
  if (visual) await writeFile(visual + '-confirmation.html', document.body.innerHTML)
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === choice)!
  await act(async () => button.click())
  if (visual) {
    await vi.waitFor(() => expect(document.querySelector('.agent-operation-feedback')).not.toBeNull())
    await act(async () => document.querySelector<HTMLElement>('.agent-operation-feedback__label')!.click())
    await writeFile(visual + '-pending.html', document.body.innerHTML)
    await writeFile(visual + '-original-operation.json', JSON.stringify({ agentOperations: f.store.getState().agentOperations, healthyDraft: f.store.getState().agentComposerDrafts['healthy-region'], stopCalls: f.stops.mock.calls.length }, null, 2))
    releaseVisual?.()
  }
  await vi.waitFor(async () => {
    const applied = calls.mock.calls.find(([method]) => method === 'space.close.apply')?.[1] as Core.SpaceCloseParams['space.close.apply'] | undefined
    const result = applied ? await f.rpc.call('space.close.inspect', { operationId: applied.operationId }) : null
    expect(f.store.getState().tabs['healthy-tab'], JSON.stringify({ error: f.store.getState().error, result })).toBeUndefined()
  }, { timeout: 5000 })
  expect(calls.mock.calls.filter(([method]) => method === 'space.close.apply')).toHaveLength(1)
  await calls.mock.results[calls.mock.calls.findIndex(([method]) => method === 'space.close.apply')]!.value
  expect(f.store.getState().tabs['target-tab']?.regions['file-region']).toBeDefined()
  expect(f.store.getState().documents[f.key]?.content).toBe('Original unsaved content')
  if (choice === 'Keep Session & Close') {
    expect(f.stops).not.toHaveBeenCalled()
    await f.host.client.writeAgent({ agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, data: 'healthy-kept-original-Agent', source: 'user' })
    expect((await f.native.client.status(f.other.runId)).state.type).toBe('running')
  } else {
    expect(f.stops).toHaveBeenCalledTimes(1)
    expect((await f.native.client.status(f.other.runId)).state.type).toBe('exited')
    const apply = calls.mock.calls.find(([method]) => method === 'space.close.apply')![1] as Core.SpaceCloseParams['space.close.apply']
    expect((await f.rpc.call('space.close.inspect', { operationId: apply.operationId })).operation).toMatchObject({ outcome: 'applied', resources: [{ receipt: { agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run } }] })
  }
})

it.runIf(business).each(['missing', 'exited', 'successor'])('a real original Agent Stop ACK consumes only its unchanged View after the snapshot becomes %s', async observation => {
  const f = await fixture(), actual = f.host.client.stopAgent.bind(f.host.client)
  vi.spyOn(f.host.client, 'stopAgent').mockImplementationOnce(async (...args) => {
    const receipt = await actual(...args)
    const state = f.store.getState()
    f.store.setState({ sessions: observation === 'missing' ? state.sessions.filter(s => s.id !== f.agent.agentSessionId)
      : state.sessions.map(s => s.id !== f.agent.agentSessionId || s.control.kind !== 'agent' ? s : observation === 'exited' ? { ...s, processState: 'exited' as const }
        : { ...s, control: { ...s.control, run: { runId: f.run.runId } } }) })
    return receipt
  })
  const prepared = f.prepared(await f.cli('prepare', { operationId: 'retired-ack-' + observation,
    target: { kind: 'tab-occurrence', displayWorkspaceId: 'W', groupId: 'G', tabId: 'healthy-tab' }, keepAgentSessions: false }))
  const result = await f.apply(prepared)
  if (observation === 'successor') {
    expect(result.code).toBe(1)
    expect(f.store.getState().tabs['healthy-tab']?.regions['healthy-region']).toBeDefined()
  } else {
    expect(f.prepared(result)).toMatchObject({ outcome: 'applied', resources: [{ outcome: 'acknowledged', receipt: { agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run } }] })
    expect(f.store.getState().tabs['healthy-tab']).toBeUndefined()
  }
  expect(f.stops).toHaveBeenCalledTimes(1)
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
  expect(f.store.getState().documents[f.key]?.content).toBe('Original unsaved content')
})

it.runIf(business)('loss of a namespace already confirmed by this Main is unknown rather than a missing operation or a complete empty list', async () => {
  const f = await fixture(), prepared = f.prepared(await f.prepare('known-before-namespace-loss'))
  await rm(f.user.path + '.close-operations', { recursive: true })
  await expect(f.rpc.call('space.close.inspect', { operationId: prepared.operationId })).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_UNCONFIRMED' })
  await expect(f.rpc.call('space.close.ls', {})).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_UNCONFIRMED' })
  expect((await f.apply(prepared)).code).toBe(1)
  expect(f.stops).not.toHaveBeenCalled()
  expect(f.store.getState().tabs['target-tab']).toBeDefined()
})

it.runIf(business)('Browser binding uses the original control owner and unknown binding requires an exact view-only decision without stopping an Agent', async () => {
  const f = await fixture(), { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs.js')
  const originalView = f.prepared(await f.cli('prepare', { operationId: 'keep-original-agent-before-page', target: { kind: 'tab-occurrence', displayWorkspaceId: 'W', groupId: 'G', tabId: 'healthy-tab' }, keepAgentSessions: true }))
  f.prepared(await f.apply(originalView))
  const browser = { kind: 'browser' as const, id: 'private-page', browserId: 'private-page', regionId: 'browser-region', navigationId: 'original-navigation', workspaceId: 'W', profileId: null,
    url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, error: null,
    agent: { hostId: 'stale-fallback-host', agentSessionId: 'stale-fallback-agent' },
    control: { owner: 'human' as const, activeOperationId: null, revision: 1, inputIsolation: 'inactive' as const, agent: { hostId: 'local', agentSessionId: f.agent.agentSessionId } } }
  const tab = createWorkbenchTab('browser-tab', browser), state = f.store.getState()
  const { ['healthy-tab']: _oldAgentView, ...tabs } = state.tabs
  f.store.setState({ tabs: { ...tabs, [tab.id]: tab }, layouts: { ...state.layouts, W: createWorkspaceLayout('G', ['target-tab', tab.id]) } })
  const target = { kind: 'tab-occurrence', displayWorkspaceId: 'W', groupId: 'G', tabId: tab.id }
  const original = f.prepared(await f.cli('prepare', { operationId: 'control-binding-original', target, keepAgentSessions: false }))
  expect(original.plan.projection.surfaces[0]).toMatchObject({ binding: browser.control.agent, bindingAvailability: 'known' })
  expect(original.plan.projection.resources.some(r => r.kind === 'session' && r.control.kind === 'agent' && r.control.agentSessionId === f.agent.agentSessionId), JSON.stringify({ projection: original.plan.projection, tabs: f.store.getState().tabs })).toBe(true)
  f.store.setState(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions, 'browser-region': { ...browser, control: { ...browser.control, agent: undefined } } } } } }))
  expect((await f.apply(original)).code).toBe(1)
  expect(f.stops).not.toHaveBeenCalled(); expect(f.browserClose).not.toHaveBeenCalled()
  const unknown = f.prepared(await f.cli('prepare', { operationId: 'explicit-unconfirmed-browser-view', target, keepAgentSessions: false }))
  const decisions = core.spaceCloseDecisions(unknown.plan)
  expect(decisions).toContainEqual({ action: 'close-view-only', regionId: 'browser-region', expectedWitness: unknown.plan.projection.surfaces[0]!.witness })
  expect(decisions.some(d => d.action === 'stop')).toBe(false)
  await expect(f.rpc.call('space.close.apply', { operationId: unknown.operationId, expectedPlanDigest: unknown.planDigest, decisions: decisions.filter(d => d.action !== 'close-view-only') })).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_DECISIONS_REQUIRED' })
  expect(f.prepared(await f.apply(unknown)).outcome).toBe('applied')
  expect(f.browserClose).toHaveBeenCalledExactlyOnceWith(browser.browserId)
  expect(f.stops).not.toHaveBeenCalled()
  expect((await f.native.client.status(f.other.runId)).state.type).toBe('running')
})

it.runIf(business)('the service window displays an opaque operation ID as data rather than interpolating it into executable shell text', async () => {
  const f = await fixture(), id = "close with 'quotes' and $(literal)", prepared = f.prepared(await f.prepare(id))
  vi.spyOn(f.api.workbenchClose, 'call').mockImplementation((method, input) => f.rpc.call(method, input))
  f.stops.mockRejectedValueOnce(Error('Private original Stop unavailable'))
  expect(await f.store.getState().applyWorkbenchClose(prepared)).toBe(false)
  const message = String(f.store.getState().error)
  expect(message).toContain('Private original Stop unavailable')
  expect(message).toContain('--operation-id <ID>')
  expect(message).toContain(JSON.stringify(id))
  expect(message).not.toContain('--operation-id ' + id)
  expect(f.store.getState().tabs['target-tab']?.regions['raw-region']).toBeDefined()
})

it.runIf(business)('an incomplete projection reply over the real Main bridge cannot certify a complete close or erase the obtained Native ACK', async () => {
  const f = await fixture(), plan = f.prepared(await f.prepare('missing-projection-rows'))
  const current = f.store.getState(), actual = current.executeWorkbenchClose
  const save = { layoutApplied: false, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'confirmed' as const, reason: null }
  const incomplete = { clientProjection: { applied: false, removedRegions: [], retainedRegions: [], save }, spatialContribution: { save } }
  vi.spyOn(current, 'executeWorkbenchClose').mockImplementation(async request => request.operation === 'workbench.close.commit'
    ? { operation: request.operation, requestId: request.requestId, result: incomplete } : actual(request))
  const result = await f.apply(plan)
  expect(result.code).toBe(1)
  const record = JSON.parse(result.stdout).result.operation
  expect(record).toMatchObject({ outcome: 'unknown', clientProjection: { applied: false, retainedRegions: ['raw-region', 'file-region'], save: null },
    resources: [{ outcome: 'acknowledged', receipt: { acknowledgement: { kind: 'stop', runId: f.run.runId } } }] })
  expect(f.store.getState().tabs['target-tab']?.regions['file-region']).toBeDefined()
  expect(f.store.getState().documents[f.key]?.content).toBe('Original unsaved content')
  expect(f.stops).toHaveBeenCalledTimes(1)
  expect(() => core.parseSpaceCloseReceipt({ ...record, ...incomplete, outcome: 'applied' })).toThrow()
  expect((await f.rpc.call('space.close.inspect', { operationId: plan.operationId })).operation?.resources[0]?.outcome).toBe('acknowledged')
})

it.runIf(business).each(['member', 'namespace'])('a cold owner keeps observed %s existence separate from prior writer durability after source loss', async lost => {
  const f = await fixture(), prepared = f.prepared(await f.prepare('cold-observed-source-loss'))
  f.reopenOwner()
  expect((await f.rpc.call('space.close.inspect', { operationId: prepared.operationId })).operation).toMatchObject({ phase: 'prepared', diskDurability: 'unconfirmed' })
  const directory = f.user.path + '.close-operations'
  if (lost === 'namespace') await rm(directory, { recursive: true })
  else {
    const path = join(directory, createHash('sha256').update(prepared.operationId).digest('hex') + '.json')
    await rm(path); await rm(path + '.prepare')
  }
  await expect(f.rpc.call('space.close.inspect', { operationId: prepared.operationId })).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_UNCONFIRMED' })
  if (lost === 'namespace') await expect(f.rpc.call('space.close.ls', {})).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_UNCONFIRMED' })
  else expect(await f.rpc.call('space.close.ls', {})).toMatchObject({ availability: 'partial', issues: [{ code: 'member-unconfirmed' }] })
  expect((await f.apply(prepared)).code).toBe(1)
  expect(f.stops).not.toHaveBeenCalled()
  expect(f.store.getState().tabs['target-tab']).toBeDefined()
})

it.runIf(business)('one close snapshot indexes outside document consumers once rather than rescanning the whole topology per File View', async () => {
  const f = await fixture(), { createWorkbenchTab, addWorkbenchRegion, documentKey } = await import('../src/renderer/src/lib/workbench-tabs.js')
  const { captureWorkbenchClose } = await import('../src/renderer/src/lib/workbench-close-owner.js')
  let tab = createWorkbenchTab('shared-file-views', { kind: 'file', regionId: 'shared-file-0', workspaceId: 'W', path: 'many.txt' })
  for (let i = 1; i <= 512; i++) tab = addWorkbenchRegion(tab, 'shared-file-0', 'right', { kind: 'file', regionId: 'shared-file-' + i, workspaceId: 'W', path: 'many.txt' })
  let enumerations = 0
  const tabs = new Proxy({ [tab.id]: tab }, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target) } }), key = documentKey('W', 'many.txt')
  const projection = captureWorkbenchClose({ ...f.store.getState(), tabs, layouts: { W: createWorkspaceLayout('G', [tab.id]) },
    documents: { [key]: { path: 'many.txt', content: 'Original shared dirty document', revision: 'original-many-file' } }, dirtyDocuments: { [key]: true } },
    { operationId: 'related-document-cost', target: { kind: 'tab-occurrence', displayWorkspaceId: 'W', groupId: 'G', tabId: tab.id }, keepAgentSessions: false })
  expect(core.parseSpaceCloseProjection(projection).surfaces).toHaveLength(513)
  expect(projection.drafts).toHaveLength(1); expect(projection.drafts[0]!.regionIds).toHaveLength(513)
  expect(enumerations).toBeGreaterThan(0); expect(enumerations).toBeLessThan(10)
  expect(f.stops).not.toHaveBeenCalled()
})

it.runIf(Boolean(restartMode))('private restart worker restores the original workface and discovers retained close operations without replay', async () => {
  const f = await fixture()
  if (restartMode === 'writer') {
    f.prepared(await f.prepare('restart-prepared'))
    const { setNoteComposition } = await import('../src/renderer/src/lib/note-live-merge.js')
    setNoteComposition(f.key, 'private-restart-file-input', true)
    const unknown = f.prepared(await f.prepare('restart-unknown'))
    f.stops.mockRejectedValueOnce(Error('Private original Stop unavailable'))
    expect((await f.apply(unknown)).code).toBe(1)
    setNoteComposition(f.key, 'private-restart-file-input', false)
    expect(f.store.getState().tabs['target-tab']?.regions['file-region']).toBeDefined()
    const { prepareRendererUpdate } = await import('../src/renderer/src/store.js')
    f.store.getState().setAgentComposerDraft('healthy-region', 'Original draft across two OS processes')
    await prepareRendererUpdate('quit')
    await writeFile(join(f.root, 'writer-proof.json'), JSON.stringify({ pid: process.pid, rawRun: f.run.runId, agentRun: f.other.runId,
      tab: f.store.getState().tabs['target-tab'], layouts: f.store.getState().layouts, stoppedCalls: f.stops.mock.calls.length }))
  } else {
    const original = JSON.parse(await readFile(join(f.root, 'writer-proof.json'), 'utf8'))
    expect(process.pid).not.toBe(original.pid)
    const { directoryIdentity, workspaceZoneId } = await import('../src/shared/space-addresses.js')
    const spaceId = directoryIdentity('local', f.root)
    // Core restores the original directory/Zone binding; a freshly arranged
    // fixture may not yet have that derived association on its local Tab.
    expect(f.store.getState().tabs['target-tab']).toEqual({ ...original.tab, space: { spaceId, zoneId: workspaceZoneId(spaceId, 'W') } })
    expect(f.store.getState().layouts).toEqual(original.layouts)
    expect(f.store.getState().agentComposerDrafts['healthy-region']).toBe('Original draft across two OS processes')
    expect(f.store.getState().sessions.find(s => s.control.kind === 'agent' && s.control.agentSessionId === f.agent.agentSessionId)?.control.run.runId).toBe(original.agentRun)
    const found = await f.rpc.call('space.close.ls', {})
    expect(found.items.map(x => x.operationId).sort()).toEqual(['restart-prepared', 'restart-unknown'])
    expect(found.items.every(x => x.diskDurability === 'unconfirmed')).toBe(true)
    expect((await f.rpc.call('space.close.inspect', { operationId: 'restart-prepared' })).operation).toMatchObject({ phase: 'prepared', diskDurability: 'unconfirmed' })
    const path = join(f.user.path + '.close-operations', createHash('sha256').update('restart-unknown').digest('hex') + '.json')
    const beforeInspection = await readFile(path)
    const unknown = (await f.rpc.call('space.close.inspect', { operationId: 'restart-unknown' })).operation!
    expect(unknown.outcome).toBe('partial')
    // The cold Main read above cannot borrow a previous writer ACK. An explicit
    // original-child query may then persist new facts with its own current ACK
    // (for example the reopened Core's unconfirmed journal observation).
    const newlyWritten = !(await readFile(path)).equals(beforeInspection)
    expect(unknown.diskDurability).toBe(newlyWritten ? 'confirmed' : 'unconfirmed')
    if (newlyWritten) expect(unknown.resources[0]?.receipt).toMatchObject({ outcome: 'unknown', acknowledgement: null, diskDurability: 'unconfirmed' })
    expect((await f.apply(unknown)).code).toBe(1)
    expect(f.stops).not.toHaveBeenCalled()
    expect((await f.native.client.status(original.rawRun)).state.type).toBe('running')
    await f.host.client.writeAgent({ agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, data: 'healthy-after-OS-restart', source: 'user' })
    expect((await f.native.client.status(original.agentRun)).state.type).toBe('running')
    const visual = process.env.AGENTMUX_WORKBENCH_CLOSE_VISUAL_DOM
    if (visual) {
      const { FileSourceEditor } = await import('../src/renderer/src/components/FileSourceEditor.js')
      const { AgentComposer } = await import('@agentmux/client-ui/components/AgentComposer')
      const { createClientUiRoot } = await import('./helpers/client-ui-render.js')
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node)
      cleanup.push(async () => { await act(async () => root.unmount()); node.remove() })
      const state = f.store.getState(), surface = state.tabs['target-tab']!.regions['file-region']!
      expect(surface.kind).toBe('file')
      await act(async () => root.render(createElement(Fragment, null,
        createElement('h3', null, 'Restored original File Region · target-tab / file-region'),
        createElement(FileSourceEditor, { tabId: 'target-tab', surface: surface as any, viewState: createRef() }),
        createElement('h3', null, 'Restored original unsent Agent draft · healthy-region'),
        createElement(AgentComposer, { value: state.agentComposerDrafts['healthy-region']!, disabled: false, placeholder: 'Message original Agent', onChange: () => {}, onSubmit: () => {} }))))
      expect(node.querySelector<HTMLTextAreaElement>('[data-isolated-monaco-paint]')?.value).toBe('Original unsaved content')
      expect(node.textContent).toContain('Original draft across two OS processes')
      await writeFile(visual + '-restored.html', document.body.innerHTML)
      await writeFile(visual + '-restored-original.json', JSON.stringify({ writerPid: original.pid, readerPid: process.pid, tabId: 'target-tab', regionId: surface.regionId,
        originalAgentSessionId: f.agent.agentSessionId, originalAgentRun: original.agentRun, originalRawRun: original.rawRun, stopCalls: f.stops.mock.calls.length,
        scope: 'Original restored FileSourceEditor consumes original Store document; Monaco paint alone is a declared readonly textarea leaf. Actual shared AgentComposer consumes the restored unsent draft. Native Electron later paints this immutable DOM with original product CSS.' }, null, 2))
    }
    await writeFile(join(f.root, 'reader-proof.json'), JSON.stringify({ pid: process.pid, restored: true, originalIds: found.items.map(x => x.operationId), stopCalls: f.stops.mock.calls.length }))
  }
})

it.runIf(!nativeBranch)('reopens Main, Host and Renderer in two real OS processes while retaining the private healthy Native Runtime', async () => {
  const root = await mkdtemp('/tmp/wcr-')
  await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  // The outer fixture owns activation and shutdown; workers only borrow it.
  const native = await activateRuntime({ executable: resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    socketPath: join(root, 'ctxmux.sock'), stateDir: join(root, 'state/ctxmux'), childDisposition: { mode: 'detached', stderr: 'pipe' } })
  expect(native.spawned).toBe(true)
  try {
    for (const mode of ['writer', 'reader']) {
      const result = await new Promise<{ code: number | null; text: string }>((yes, no) => {
        const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.workbench-close.config.mts'], {
          cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, AGENTMUX_WORKBENCH_CLOSE_NATIVE: '1', AGENTMUX_WORKBENCH_CLOSE_RESTART: mode, AGENTMUX_WORKBENCH_CLOSE_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] })
        let text = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('Private restart worker deadline.')) }, 90_000)
        child.stdout.on('data', b => { text += b }); child.stderr.on('data', b => { text += b })
        child.once('error', no); child.once('close', code => { clearTimeout(timer); yes({ code, text }) })
      })
      expect(result.code, mode + '\n' + result.text).toBe(0)
      expect(result.text).toMatch(/1 passed/)
    }
    expect(JSON.parse(await readFile(join(root, 'reader-proof.json'), 'utf8'))).toMatchObject({ restored: true, stopCalls: 0, originalIds: expect.arrayContaining(['restart-prepared', 'restart-unknown']) })
  } finally {
    await native.dispose({ shutdown: true }); await rm(root, { recursive: true, force: true })
  }
}, 190_000)
