import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

// Two real client processes consume production Store, Main, Core spatial storage and a real PTY.
// The transport delays a successful launch reply; it never fabricates a Session or Run.
// This proves reconnect and identity preservation, not Electron paint or native conversation resume.
const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const require = createRequire(join(base, 'packages/core/package.json'))
const { build } = await import(require.resolve('esbuild'))
const desktopRequire = createRequire(join(base, 'apps/desktop/package.json'))
const happyDomPath = desktopRequire.resolve('happy-dom')
const requestedOutput = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
const out = requestedOutput ? resolve(base, requestedOutput) : join(base, '.tmp/agent-launch-spatial-proof')
await mkdir(out, { recursive: true })
const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-launch-spatial-"))
await mkdir(join(root, 'home'), { mode: 0o700 })
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTMUX_')))
Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
const critical = [fileURLToPath(import.meta.url), join(base, 'apps/desktop/scripts/probe-process.mjs'),
  ...['main/runtime-controller.ts', 'shared/contracts.ts', 'renderer/src/store.ts', 'renderer/src/lib/session-state.ts',
    'renderer/src/lib/api.ts', 'renderer/src/lib/desktop-spatial-state.ts', 'renderer/src/lib/focus-tab-projection.ts'].map(p => join(base, 'apps/desktop/src', p)),
  join(base, 'packages/core/dist/spatial-state.js'), join(base, 'packages/core/dist/client.js'), join(base, 'packages/core/dist/ctxmux-run-adapter.js'),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json')]
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex')
const capture = async () => Object.fromEntries(await Promise.all(critical.map(async p => [p, await hash(p)])))
const before = await capture(), children = [], records = [], cleanupErrors = [], cleanupObservations = []
let failure
const worker = join(root, 'worker.mjs')
const source = `
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Window } from ${JSON.stringify(happyDomPath)}
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux, AgentProviderRegistry, defineAgentProvider } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from ${JSON.stringify(join(base, 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'))}
import { createWorkbenchTab, addWorkbenchRegion } from ${JSON.stringify(join(base, 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts'))}
import { launcherCreationSpatialIntent } from ${JSON.stringify(join(base, 'apps/desktop/src/main/goal-discussion-handoff.ts'))}
import { RuntimeController } from ${JSON.stringify(join(base, 'apps/desktop/src/main/runtime-controller.ts'))}
import { localRuntimeConnector } from ${JSON.stringify(join(base, 'apps/desktop/test/helpers/local-runtime-connector.ts'))}
const [mode, root] = process.argv.slice(2)
const window = new Window({ url: 'http://private.test' })
const storagePath = join(root, 'workbench.json')
Object.defineProperty(window, 'localStorage', { value: {
 getItem: key => existsSync(storagePath) ? (JSON.parse(readFileSync(storagePath, 'utf8'))[key] ?? null) : null,
 setItem: (key, value) => { const values = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) : {}; values[key] = value; writeFileSync(storagePath, JSON.stringify(values)) },
 removeItem: key => { const values = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) : {}; delete values[key]; writeFileSync(storagePath, JSON.stringify(values)) }
} })
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CSS: window.CSS })
const { api } = await import(${JSON.stringify(join(base, 'apps/desktop/src/renderer/src/lib/api.ts'))})
const { useAppStore } = await import(${JSON.stringify(join(base, 'apps/desktop/src/renderer/src/store.ts'))})
const template = new AgentProviderRegistry().get('codex')
const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'spatial-proof-native', label: 'Private generic PTY',
 executable: '/usr/bin/python3', expectedProcess: '/usr/bin/python3', hookStrategy: { kind: 'none' },
 readySignal: { kind: 'foreground-process', expectedProcess: '/usr/bin/python3' },
 resumeStrategy: { kind: 'none' },
 capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: false, replyCorrelation: 'none' } },
 hook: { rules: [], eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
 buildArgs: (_prompt, args) => args })
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
const core = await connectLocalAgentMux({ store, providers: [provider] })
const runtime = new RuntimeController(store, localRuntimeConnector)
const host = { id: 'local', kind: 'local', label: 'Private' }
runtime.commit({ hosts: [{ id: host.id, config: host, client: core, executionHost: { kind: 'local', dispose: async () => {} } }],
 removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
const config = { version: 9, hosts: [host],
 executors: { fixture: { label: 'Private generic PTY', providerId: provider.id, command: '/usr/bin/python3',
 args: ['-u', join(root, 'pty.py')], env: {}, injectAgentMuxGuide: false } },
 workspaces: [{ id: 'private', name: 'Private', hostId: 'local', path: root, kind: 'folder' }],
 appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const listeners = new Set()
const sender = Object.assign(new EventEmitter(), { id: mode === 'first' ? 1 : 2, isDestroyed: () => false,
 send: (_channel, event) => { for (const listener of listeners) listener(event) } })
const detach = runtime.attach(sender)
api.spatial.read = () => spatial.readForLayout()
api.spatial.commit = input => spatial.commit(input)
api.spatial.onChange = listener => spatial.subscribe(listener)
api.spatial.retainLabels = values => spatial.retainDisplayLabels(values)
api.config.get = async () => config
let lastRuntimeSnapshot
api.sessions.snapshot = async () => {
 lastRuntimeSnapshot = await runtime.snapshot(config)
 return { ...lastRuntimeSnapshot, localHome: join(root, 'home') }
}
api.providers.list = options => runtime.providerCatalog(options)
api.sessions.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
let created, releaseReply, launchCalls = 0
const heldReply = new Promise(resolve => { releaseReply = resolve })
api.sessions.launchAgent = async input => {
 ++launchCalls
 const result = await runtime.launchAgent(input, config, launcherCreationSpatialIntent(input, config.workspaces))
 created = result
 await heldReply
 return result
}
api.sessions.refresh = control => runtime.refresh(control, config)
api.sessions.timeline = control => runtime.sessionTimeline(control)
api.sessions.recover = (control, path, operation) => runtime.recoverSession(control, config, path, operation)
api.ui.requestStorageFlush = async () => {}
const wait = async (predicate, label) => { const end = Date.now() + 10000; do {
 const value = await predicate(); if (value) return value; await new Promise(done => setTimeout(done, 25))
 } while (Date.now() < end); throw new Error('Private deadline: ' + label) }
const tabId = 'original-tab', regionId = 'original-agent', siblingId = 'original-neighbor'
const publicWorkbench = state => structuredClone({ tabs: state.tabs, layouts: state.layouts })
let disposeUi, creationProof = null
try {
 if (mode === 'first') {
  const tab = addWorkbenchRegion(createWorkbenchTab(tabId, { regionId, kind: 'launcher', workspaceId: 'private' }),
   regionId, 'right', { regionId: siblingId, kind: 'launcher', workspaceId: 'private' })
  tab.layout.activeRegionId = regionId
  const initial = { config, sessions: [], tabs: { [tabId]: tab }, layouts: { private: createWorkspaceLayout('original-group', [tabId]) }, spaceZoneBindings: {} }
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(initial, []) })
 }
 disposeUi = await useAppStore.getState().initialize()
 await useAppStore.getState().retryWorkbenchSave()
 let id
 if (mode === 'first') {
  await useAppStore.getState().selectWorkspace('private')
  const pending = useAppStore.getState().launchAgent('fixture', '', 'original-group', { tabId, regionId })
  // Observe the actual Core creation while its successful response is withheld from the Renderer.
  await wait(() => created, 'actual Core creation before Renderer reply')
  id = created.created.agentSessionId
  const before = structuredClone(useAppStore.getState().tabs[tabId].regions[regionId])
  assert.equal(before.kind, 'agent'); assert.equal(before.phase, 'launching'); assert.equal(before.sessionId, id)
  assert.equal((await core.statusAgent(id)).run.state, 'running')
  const revision = (await spatial.readForLayout()).revision
  // A normal split resize forces a real save ACK while the original launch is unresolved.
  useAppStore.getState().updateRegionSplitRatio('private', tabId, '', 0.61)
  await useAppStore.getState().retryWorkbenchSave()
  const saved = await spatial.readForLayout()
  assert.ok(saved.revision > revision, 'The overlapping ACK must actually have been committed')
  assert.equal(saved.graph.regions.find(region => region.regionId === regionId).kind, 'launcher')
  const afterAck = structuredClone(useAppStore.getState().tabs[tabId].regions[regionId])
  assert.deepEqual(afterAck, before, 'The saved Launcher cannot replace the pending Agent')
  releaseReply(); await pending
  const attached = useAppStore.getState().tabs[tabId].regions[regionId]
  assert.equal(attached.kind, 'agent'); assert.equal(attached.phase, 'attached'); assert.equal(attached.sessionId, id)
  assert.equal(launchCalls, 1, 'The original request creates one Agent only')
  assert.equal(useAppStore.getState().focusExecutionSession(id), true, 'Focus must navigate the original terminal occurrence')
  await useAppStore.getState().retryWorkbenchSave()
  creationProof = { before, afterAck, attached: structuredClone(attached), ackRevision: saved.revision, originalRevision: revision,
   operationId: created.creation.createOperationId, launchCalls, focusOpened: true }
 } else {
  const previous = JSON.parse(readFileSync(join(root, 'first.json'), 'utf8'))
  id = previous.id
  assert.deepEqual(publicWorkbench(useAppStore.getState()), previous.workbench)
  assert.equal(launchCalls, 0, 'Reconnection must not launch another Agent')
  assert.equal(useAppStore.getState().focusExecutionSession(id), true)
 }
 // Startup publishes durable positions before its background Runtime observation.
 const session = await wait(() => useAppStore.getState().sessions.find(value => value.id === id), 'original Session observation')
 assert.ok(session); assert.equal(session.kind, 'agent'); assert.equal(session.processState, 'running')
 const initial = await core.statusAgent(id)
 await wait(async () => (await core.statusAgent(id)).run.latestOutputBytes > 0, 'nonempty PTY')
 await runtime.write(session.control, mode === 'first' ? 'a' : 'b', 'user')
 const current = await wait(async () => { const value = await core.statusAgent(id);
  return value.run.acceptedInputBytes > initial.run.acceptedInputBytes && value.run.latestOutputBytes > initial.run.latestOutputBytes ? value : null }, 'actual input and output')
 await useAppStore.getState().retryWorkbenchSave()
 const state = useAppStore.getState(), saved = await spatial.readForLayout()
 assert.equal(saved.graph.regions.find(region => region.regionId === regionId).agentSessionId, id)
 assert.equal(saved.graph.regions.find(region => region.regionId === regionId).runId, current.session.run.runId)
 assert.equal(state.tabs[tabId].regions[siblingId].kind, 'launcher')
 assert.equal(state.tabs[tabId].layout.root.ratio, 0.61)
 const result = { mode, clientPid: process.pid, id, run: current.session.run, childPid: current.run.pid,
  daemon: core.runtimeIdentity().instanceId, accepted: current.run.acceptedInputBytes, output: current.run.latestOutputBytes,
  workbench: publicWorkbench(state), retainedCreated: current.session.agentSessionId, creationProof,
  launchCalls, focusOpened: true, durableRegion: saved.graph.regions.find(region => region.regionId === regionId) }
 if (mode === 'first') writeFileSync(join(root, 'first.json'), JSON.stringify(result))
 process.stdout.write(JSON.stringify(result) + '\\n')
} catch (error) {
 process.stderr.write(JSON.stringify({ mode, lastRuntimeSnapshot, uiError: useAppStore.getState().error }) + '\\n')
 throw error
} finally { await disposeUi?.(); detach(); await runtime.dispose(); await window.happyDOM.close() }
`
try {
  await writeFile(join(root, 'pty.py'), "import os,tty\ntty.setraw(0)\nos.write(1,b'PRIVATE-READY')\nwhile True:\n b=os.read(0,1)\n if b==b'q':break\n os.write(1,b'PRIVATE-ACK:'+b)\n")
  const entry = join(root, 'entry.mjs'); await writeFile(entry, source)
  await build({ absWorkingDir: base, entryPoints: { worker: entry }, outdir: root, outExtension: { '.js': '.mjs' },
    bundle: true, splitting: true, packages: 'external', external: [happyDomPath],
    platform: 'node', format: 'esm', loader: { '.png': 'dataurl' }, plugins: [{ name: 'local-workspace-source', setup(bundler) {
      bundler.onResolve({ filter: /^@agentmux\/core(?:\/.*)?$/ }, args => {
        const manifest = JSON.parse(require('node:fs').readFileSync(join(base, 'packages/core/package.json'), 'utf8'))
        const subpath = args.path === '@agentmux/core' ? '.' : '.' + args.path.slice('@agentmux/core'.length)
        const entry = manifest.exports[subpath]?.import
        assert.ok(entry, 'The original Core public export must be explicit: ' + args.path)
        return { path: join(base, 'packages/core', entry), external: true }
      })
      bundler.onResolve({ filter: /^@agentmux\/layout$/ }, args => ({ path: join(base, 'packages/layout', JSON.parse(require('node:fs').readFileSync(join(base, 'packages/layout/package.json'), 'utf8')).exports['.'].import) }))
      // This Node host does not provide Electron's optional OS resource sampling.
      // Runtime lifecycle, public Core and persistence remain their actual implementations.
      bundler.onResolve({ filter: /^electron$/ }, () => ({ path: 'private-resource-observation', namespace: 'private-node-host' }))
      bundler.onLoad({ filter: /.*/, namespace: 'private-node-host' }, () => ({ contents: 'export const app = { getAppMetrics: () => [] }; export const nativeImage = { createFromBuffer: () => { throw new Error("Private Node host does not provide OS image decoding") } }', loader: 'js' }))
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, logLevel: 'silent' })
  // Resolve external dependencies from the project without copying/installing them.
  await import('node:fs/promises').then(({ symlink }) => symlink(join(base, 'apps/desktop/node_modules'), join(root, 'node_modules')))
  const run = async mode => {
    const child = spawn(process.execPath, [worker, mode, root], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value; assert.ok(stdout.length < 1024 * 1024) })
    child.stderr.on('data', value => { stderr += value; if (stderr.length > 65536) stderr = stderr.slice(-65536) })
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25000)
    try {
      const result = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
      assert.equal(result.code, 0, stderr); assert.equal(result.signal, null)
      const record = { ...JSON.parse(stdout.trim().split('\n').at(-1)), exit: result }; records.push(record); return record
    } finally { clearTimeout(deadline) }
  }
  const first = await run('first'), second = await run('second')
  assert.notEqual(first.clientPid, second.clientPid)
  assert.equal(first.id, second.id); assert.deepEqual(first.run, second.run)
  assert.equal(first.childPid, second.childPid); assert.equal(first.daemon, second.daemon)
  assert.deepEqual(first.workbench, second.workbench)
  assert.equal(first.launchCalls, 1); assert.equal(second.launchCalls, 0); assert.equal(second.focusOpened, true)
  assert.equal(second.accepted, first.accepted + 1); assert.ok(second.output > first.output)
} catch (error) { failure = error.stack ?? String(error) }
finally {
  // Cleanup remains independent of assertion/process errors, restricted to the unique private root.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  for (const pid of await listProbeProcesses(-1, root)) {
    try {
      await signalOwnedProbeProcess(pid, root, 'SIGTERM')
    } catch (error) {
      if ((await listProbeProcesses(-1, root)).includes(pid)) cleanupErrors.push(String(error))
      else cleanupObservations.push({ pid, observation: String(error), resolved: 'A fresh process listing no longer contains this private process.' })
    }
  }
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && (await listProbeProcesses(-1, root)).length) await new Promise(done => setTimeout(done, 25))
  let remaining = await listProbeProcesses(-1, root)
  for (const pid of remaining) {
    try { await signalOwnedProbeProcess(pid, root, 'SIGKILL') } catch (error) {
      if ((await listProbeProcesses(-1, root)).includes(pid)) cleanupErrors.push(String(error))
      else cleanupObservations.push({ pid, observation: String(error), resolved: 'A fresh process listing no longer contains this private process.' })
    }
  }
  await new Promise(done => setTimeout(done, 50)); remaining = await listProbeProcesses(-1, root)
  const after = await capture(); if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= 'Selected inputs changed during proof'
  if (!remaining.length && !cleanupErrors.length) await rm(root, { recursive: true, force: true })
  const receipt = { passed: !failure && !remaining.length && !cleanupErrors.length, records,
    inputsBefore: before, inputsAfter: after, failure: failure ?? null,
    cleanup: { remaining, errors: cleanupErrors, observations: cleanupObservations, rootRemoved: !remaining.length && !cleanupErrors.length },
    scope: 'Production Store launch/focus/spatial save, RuntimeController, public Core/FileStore/native PTY and durable spatial owner; two real Node client processes reconnect the same healthy Run. No Electron paint, OS input, native conversation resume or user Run claim.' }
  await writeFile(join(out, 'restart-last.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, processes: records.length, cleanup: receipt.cleanup }))
  if (!receipt.passed) process.exitCode = 1
}
