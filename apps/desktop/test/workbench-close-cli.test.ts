// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { webcrypto, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { build } from '../../../packages/core/node_modules/esbuild/lib/main.js'
import * as core from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { activateRuntime } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { connectDesktopAgentMuxHost, callOriginalDesktopHost } from '../src/main/desktop-host.js'
import { desktopRpcMethods } from '../src/main/desktop-rpc-exposure.js'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state.js'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import { createDesktopWorkbenchCloseOwner } from '../src/main/workbench-close-owner.js'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture.js'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => '/private-unused' } }))
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
  expect(result.text).toMatch(/[1-9]\d* passed/)
}, 190_000)

async function fixture() {
  vi.resetModules(); window.localStorage.clear(); vi.stubGlobal('crypto', webcrypto)
  const root = process.env.AGENTMUX_WORKBENCH_CLOSE_ROOT ?? await mkdtemp('/tmp/wc-')
  if (!restartMode) cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = objectCliEnvironment(root)
  for (const [key, value] of Object.entries(env)) if (key.startsWith('AGENTMUX_')) vi.stubEnv(key, value!)
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
  const capability = saved?.capability ?? core.issueAgentCapability(), agent: core.AgentMuxStoredAgentSession = saved?.agent ?? { kind: 'agent', agentSessionId: 'healthy-agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
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
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => sessions.find(s => s.control.kind === control.kind && (control.kind === 'agent' ? s.control.kind === 'agent' && s.control.agentSessionId === control.agentSessionId : s.control.kind === 'terminal' && s.control.runId === control.runId))!)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  const arranged = store.getState(), dispose = await store.getState().initialize(); cleanup.push(async () => dispose())
  if (!saved) { store.setState(arranged, true); await prepareRendererUpdate('quit') }
  let bridge: DesktopControlIpcBridge
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
    prepared: (value: { code: number | null; stdout: string; stderr: string }) => { expect(value.code, value.stderr || value.stdout).toBe(0); return JSON.parse(value.stdout).result.operation as core.SpaceCloseReceipt },
    apply: (record: core.SpaceCloseReceipt) => cli('apply', { operationId: record.operationId, expectedPlanDigest: record.planDigest, decisions: core.spaceCloseDecisions(record.plan) }) }
}

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
  const list = await f.rpc.call('space.close.ls', { limit: 1 })
  expect(list.coverage).toBe('live-page'); expect(list.items).toHaveLength(1)
  const next = list.nextCursor ? await f.rpc.call('space.close.ls', { limit: 10, cursor: list.nextCursor }) : list
  expect([...list.items, ...next.items].map(o => o.operationId)).toContain('prepared-original')
  const inspection = await f.rpc.call('space.close.inspect', { operationId: prepared.operationId })
  expect(inspection.operation).toMatchObject({ outcome: 'partial', diskDurability: 'unconfirmed' })
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

it.runIf(Boolean(restartMode))('private restart worker restores the original workface and discovers retained close operations without replay', async () => {
  const f = await fixture()
  if (restartMode === 'writer') {
    f.prepared(await f.prepare('restart-prepared'))
    const unknown = f.prepared(await f.prepare('restart-unknown'))
    f.stops.mockRejectedValueOnce(Error('Private original Stop unavailable'))
    expect((await f.apply(unknown)).code).toBe(1)
    const { prepareRendererUpdate } = await import('../src/renderer/src/store.js')
    f.store.getState().setAgentComposerDraft('healthy-region', 'Original draft across two OS processes')
    await prepareRendererUpdate('quit')
    await writeFile(join(f.root, 'writer-proof.json'), JSON.stringify({ pid: process.pid, rawRun: f.run.runId, agentRun: f.other.runId,
      tab: f.store.getState().tabs['target-tab'], layouts: f.store.getState().layouts, stoppedCalls: f.stops.mock.calls.length }))
  } else {
    const original = JSON.parse(await readFile(join(f.root, 'writer-proof.json'), 'utf8'))
    expect(process.pid).not.toBe(original.pid)
    expect(f.store.getState().tabs['target-tab']).toEqual(original.tab)
    expect(f.store.getState().layouts).toEqual(original.layouts)
    expect(f.store.getState().agentComposerDrafts['healthy-region']).toBe('Original draft across two OS processes')
    expect(f.store.getState().sessions.find(s => s.control.kind === 'agent' && s.control.agentSessionId === f.agent.agentSessionId)?.control.run.runId).toBe(original.agentRun)
    const found = await f.rpc.call('space.close.ls', {})
    expect(found.items.map(x => x.operationId).sort()).toEqual(['restart-prepared', 'restart-unknown'])
    expect((await f.rpc.call('space.close.inspect', { operationId: 'restart-prepared' })).operation).toMatchObject({ phase: 'prepared', diskDurability: 'unconfirmed' })
    const unknown = (await f.rpc.call('space.close.inspect', { operationId: 'restart-unknown' })).operation!
    expect(unknown).toMatchObject({ outcome: 'partial', diskDurability: 'unconfirmed' })
    expect((await f.apply(unknown)).code).toBe(1)
    expect(f.stops).not.toHaveBeenCalled()
    expect((await f.native.client.status(original.rawRun)).state.type).toBe('running')
    await f.host.client.writeAgent({ agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, data: 'healthy-after-OS-restart', source: 'user' })
    expect((await f.native.client.status(original.agentRun)).state.type).toBe('running')
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
