import { fixtureClock as _hygiene_fixtureClock, fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { connectCdp, preparePrivateNotesIsolation } from './fixtures/settings-cli/desktop.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Consume existing ordinary product bundles. This producer never builds, packages or installs.
// The public Provider starts the repository CLI fixture; no DTO Run or guessed native identity.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json')), ts = require('typescript')
const exec = promisify(execFile)
const rulerJoin = process.argv.includes('--ruler-join'), collectionLayoutJoin = process.argv.includes('--collection-layout-join')
assert.ok(!(rulerJoin && collectionLayoutJoin), 'Choose one bounded restart join mode')
const core = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const { connectAgentMuxRpc } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/public-rpc-client.js')).href)
const { macosHostServiceAddress, macosHostServiceRegistration, inspectMacosHostProcess } = await import(pathToFileURL(join(repositoryRoot, 'apps/host/dist/macos-service.js')).href)
const { directoryIdentity } = await import(pathToFileURL(join(repositoryRoot, 'apps/host/dist/mote-model.js')).href)
const output = resolve(repositoryRoot, process.env.AGENTMUX_FOCUS_NAME_WIDTH_RESTART_OUTPUT ?? (".tmp/focus-timeline-name-width-restart-" + (globalThis.crypto.randomUUID()) + ""))
await mkdir(output, { recursive: true })
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-name-width-")), userData = join(privateRoot, 'user-data')
const privateHome = join(privateRoot, 'home'), runtimeDirectory = join(privateRoot, 'runtime')
const privateService = macosHostServiceAddress(join(runtimeDirectory, 'control.sock'))
const workspacePath = join(privateRoot, 'workspace'), topicsPath = join(privateRoot, 'topics'), codexHome = join(privateRoot, 'codex-home')
const fixtureEnvironment = { CODEX_HOME: codexHome, AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(codexHome, 'sessions') }
const environment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_SPATIAL_STATE_STORE: join(runtimeDirectory, 'state/spatial.json'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: codexHome }
const inheritedCallerNames = Object.keys(process.env).filter(name => /^AGENTMUX_(?:ENV|CLI|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID|USAGE_TRANSCRIPT_FORMAT)$/.test(name))
const previous = new Map([...Object.keys(environment), ...inheritedCallerNames].map(name => [name, process.env[name]]))
const digest = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const children = new Set(), connections = new Set(), diagnosticSockets = new Set(), deadline = Date.now() + 140_000
const workspaceId = 'width-workspace', groupId = 'width-group', tabId = 'width-tab', agentRegionId = 'width-agent', fileRegionId = 'width-file'
const draft = 'Keep the original width restart draft'
const joinPreferences = { mode: 'uniform', timeZone: 'America/New_York', intervalMinutes: 90, phaseMinutes: 1425 }
const receipt = { schema: 'agentmux.focus-timeline-name-width-restart.v1', passed: false, processes: [], controls: [], cleanup: {},
  privateRuntime: true, userRuntimeTouched: false,
  mode: collectionLayoutJoin ? 'collection-layout-join' : rulerJoin ? 'ruler-join' : 'name-width',
  boundary: 'Existing ordinary production Main/preload/Renderer, public Core Provider and real private PTY. Controlled first-hydrate Focus timestamps are visit inputs, not execution duration. Repository CLI fixture, not vendor Writer or user installation. First process receives one initial seed; second receives none. No HOME environment reassignment, package, build or user Runtime.' }
let client, session, originalRun, hostProcess, hostBirth, hostRpc, failure, interruption, stage = 'prepare'
const abort = signal => {
  interruption ??= new Error(`Private width restart interrupted: ${signal}`)
  for (const connection of connections) connection.close()
  for (const socket of diagnosticSockets) socket.close()
  void stopProbeProcesses(process.pid + 1_000_000_000, privateRoot).catch(error => { receipt.cleanup.interruptionError = error.message })
}
const watchdog = setTimeout(() => abort('bounded deadline'), 140_000)
const onSigterm = () => abort('SIGTERM'), onSigint = () => abort('SIGINT')
process.on('SIGTERM', onSigterm); process.on('SIGINT', onSigint)
async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { if (interruption) throw interruption; const value = await read(); if (value) return value; await delay(50) }
  throw new Error(`Name width restart timed out: ${label}`)
}
async function files(directory, prefix) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), `${prefix}/${entry.name}`))
    else if (entry.isFile()) result.push(`${prefix}/${entry.name}`)
  }
  return result
}
async function binding() {
  const names = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/desktop/package.json', 'apps/host/package.json',
    'apps/desktop/scripts/verify-focus-timeline-name-width-restart.mjs', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/fixtures/settings-cli/desktop.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs', 'packages/core/bin/amux',
    ...await files(join(desktopRoot, 'resources/toolkit'), 'apps/desktop/resources/toolkit'),
    ...await files(join(desktopRoot, 'src'), 'apps/desktop/src'), ...await files(join(desktopRoot, 'out'), 'apps/desktop/out'),
    ...await files(join(repositoryRoot, 'packages/core/src'), 'packages/core/src'), ...await files(join(repositoryRoot, 'packages/core/dist'), 'packages/core/dist'),
    ...await files(join(repositoryRoot, 'apps/host/src'), 'apps/host/src'), ...await files(join(repositoryRoot, 'apps/host/dist'), 'apps/host/dist'),
    ...await files(join(repositoryRoot, 'packages/core/vendor'), 'packages/core/vendor')]
  assert.ok(names.length > 700, 'Complete actual execution input must be nonempty')
  for (const entry of ['apps/desktop/out/main/index.js', 'apps/desktop/out/main/agentmux-host.js', 'apps/host/src/index.ts', 'apps/host/dist/index.js', 'apps/host/dist/macos-service.js', 'packages/core/dist/index.js']) {
    assert.ok(names.includes(entry) && (await readFile(join(repositoryRoot, entry))).length > 0, 'Actual executable owner must be nonempty: ' + entry)
  }
  return Object.fromEntries(await Promise.all(names.sort().map(async name => {
    const bytes = await readFile(join(repositoryRoot, name))
    // Type-only Host modules can emit an empty JS file. Keep its exact digest;
    // the actual executing owners and complete input collection are checked above.
    if (!name.startsWith('apps/host/dist/')) assert.ok(bytes.length > 0, name)
    return [name, digest(bytes)]
  })))
}
async function run() {
  const value = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(value?.state, 'running'); assert.equal(value.pid, originalRun.pid)
  assert.equal(client.agentSession(session.agentSessionId).run.runId, session.run.runId)
  return value
}
async function hostArtifact(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  await writeFile(join(output, file), bytes, { flag: 'wx', mode: 0o600 })
  return { file, sha256: digest(bytes) }
}
async function startPrivateSemanticHost() {
  stage = 'creator-releases-observation'
  await client.dispose(); client = null
  stage = 'private-semantic-host-start'
  const storePath = join(userData, 'agent-sessions.json'), entrypoint = 'apps/host/dist/index.js'
  assert.equal(await macosHostServiceRegistration(privateService), null, 'A fresh private namespace cannot adopt a platform owner')
  hostProcess = spawn(process.execPath, [join(repositoryRoot, entrypoint), '--store', storePath], { cwd: repositoryRoot, detached: true,
    env: { ...process.env, ...environment, AGENTMUX_AGENT_SESSION_STORE: storePath,
      AGENTMUX_HOST_CONFIGURATION_PATH: join(userData, 'agentmux.config.json'), AGENTMUX_MOTE_CONFIGURATION_PATH: join(userData, 'agentmux.config.json'),
      AGENTMUX_CONNECTOR_DIRECTORY: join(userData, 'connectors'), AGENTMUX_MOBILE_BUILD_DIRECTORY: join(desktopRoot, 'out/mobile') },
    stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(hostProcess)
  let stdout = '', spawnError
  hostProcess.once('error', error => { spawnError = error })
  hostProcess.stdout.on('data', bytes => { stdout += bytes; appendFileSync(join(output, 'private-host.stdout.log'), bytes) })
  hostProcess.stderr.on('data', bytes => appendFileSync(join(output, 'private-host.stderr.log'), bytes))
  hostBirth = await inspectMacosHostProcess(hostProcess.pid); assert.ok(hostBirth)
  const ready = await waitFor('original private Host public ready receipt', () => {
    if (spawnError) throw spawnError
    if (hostProcess.exitCode !== null || hostProcess.signalCode !== null) throw new Error('Private semantic Host exited before readiness; inspect original private-host stderr')
    for (const line of stdout.split('\n')) { try { const value = JSON.parse(line); if (value.protocol === 'jsonrpc-2.0') return value } catch {} }
  })
  assert.equal(ready.pid, hostProcess.pid)
  hostRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
  const identity = await hostRpc.call('runtime.owner.identity', {}), owner = identity.owner
  assert.equal(owner.processId, hostProcess.pid)
  const bootstrap = await hostRpc.call('runtime.bootstrap', { consumerId: randomUUID(), fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  assert.equal(bootstrap.storePath, storePath); assert.equal(bootstrap.hostProcessId, hostProcess.pid)
  const original = bootstrap.sessions.find(value => value.agentSessionId === session.agentSessionId)
  assert.ok(original); assert.deepEqual(original.run, session.run)
  client = await core.connectHostedAgentMux({ rpc: hostRpc, expectedStorePath: storePath, expectedRuntimeId: owner.runtimeId })
  assert.deepEqual(client.runtimeIdentity(), receipt.runtimeBefore)
  const preserved = await run(); assert.equal(preserved.pid, originalRun.pid)
  receipt.semanticHost = { entrypoint, pid: hostProcess.pid, birth: hostBirth, storePath,
    ownerIdentity: await hostArtifact('host-owner.identity.json', identity),
    bootstrap: await hostArtifact('host-bootstrap.json', bootstrap), ready: await hostArtifact('host-ready.json', ready),
    originalSession: { agentSessionId: session.agentSessionId, run: { ...session.run } }, originalRun: { runId: preserved.runId, pid: preserved.pid } }
}
async function seedOriginalSpatialWorkface(seed) {
  stage = 'original-core-spatial-seed'
  const adapter = join(privateRoot, 'spatial-adapter.mjs')
  const built = await createRequire(require.resolve('vite/package.json'))('esbuild').build({
    entryPoints: [join(desktopRoot, 'src/renderer/src/lib/desktop-spatial-state.ts')], outfile: adapter,
    bundle: true, platform: 'node', format: 'esm', metafile: true,
    banner: { js: "import{createRequire as privateRequire}from'node:module';const require=privateRequire(import.meta.url);" },
    alias: { '@agentmux/layout': join(repositoryRoot, 'packages/layout/src/index.ts') }, logLevel: 'silent' })
  const inputs = Object.keys(built.metafile.inputs)
  assert.ok(inputs.length > 0 && inputs.every(path => !/runtime-controller|public-rpc-service|electron/.test(path)))
  const { desktopSpatialGraph } = await import(pathToFileURL(adapter).href)
  const config = JSON.parse(await readFile(join(userData, 'agentmux.config.json'), 'utf8'))
  const baseline = { id: session.agentSessionId, kind: 'agent', hostId: 'local', workspacePath: originalRun.workspacePath,
    providerId: session.providerId, executorId: session.executorId,
    control: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: { ...session.run } } }
  const graph = desktopSpatialGraph({ config, sessions: [baseline], ...seed.state.restoredWorkbench, spaceZoneBindings: {}, spatialRequests: {} }, [])
  const store = new core.AgentMuxSpatialStateStore()
  assert.equal(await store.read(), null, 'Initial seed can only originate this fresh private workface')
  await store.commit({ expectedRevision: 0, graph })
  const recorded = await store.read(); assert.ok(recorded?.graph)
  const region = recorded.graph.regions.find(region => region.regionId === agentRegionId)
  assert.equal(region?.agentSessionId, session.agentSessionId); assert.equal(region?.runId, session.run.runId)
  assert.equal(region?.execution?.hostId, 'local')
  receipt.initialSpatialSeed = { adapterSha256: digest(await readFile(adapter)), inputs, state: await hostArtifact('initial-core-spatial-state.json', recorded) }
}
async function inspectRegion(probe) {
  /** @type {import('../../../packages/core/dist/public-rpc-client.js').AgentMuxRpcClient} */
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
  try {
    const reply = await rpc.call('space.inspect', { target: { regionId: agentRegionId }, presentation: true })
    if (reply.catalog) receipt.restoredSpatialCatalog = reply.catalog
    const request = { schemaVersion: core.AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'inspect.region', target: { kind: 'region', regionId: agentRegionId } }
    const observed = await probe.main.call('Runtime.callFunctionOn', { objectId: probe.controlBridgeId,
      functionDeclaration: 'async function(request){return await this.execute(request)}', arguments: [{ value: request }], awaitPromise: true, returnByValue: true })
    assert.equal(observed.exceptionDetails, undefined)
    const result = observed.result.value
    receipt.regionObservations ??= []; receipt.regionObservations.push({ source: probe.controlBridgeOwner, request, result })
    assert.equal(result.operation, 'inspect.region'); assert.ok(result.region); return result.region
  } finally { await rpc.dispose() }
}
async function collectDiagnostics(url, label) {
  const file = join(output, label + '-cdp.ndjson'), socket = new WebSocket(url)
  diagnosticSockets.add(socket)
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data)
    if (value.method || value.error) appendFileSync(file, JSON.stringify(value) + '\n')
  })
  socket.addEventListener('error', () => appendFileSync(file, JSON.stringify({ observation: 'diagnostic-socket-error' }) + '\n'))
  await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('Diagnostic CDP handshake timed out')), 12_000)
    socket.addEventListener('open', () => { clearTimeout(timer); yes() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); no(new Error('Diagnostic CDP handshake failed')) }, { once: true })
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
  socket.send(JSON.stringify({ id: 2, method: 'Log.enable' }))
  return socket
}
async function captureLaunchFailure(cdp, label) {
  const file = label + '-launch-state.json'
  const state = await cdp.evaluate(`(() => {
    const shape=n=>n?{tag:n.tagName,className:n.className,hidden:n.hidden,inert:n.inert,ariaHidden:n.getAttribute('aria-hidden'),rects:n.getClientRects().length,display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility,attributes:Object.fromEntries([...n.attributes].map(a=>[a.name,a.value]))}:null;
    return {readyState:document.readyState,href:location.href,xterms:[...document.querySelectorAll('.xterm')].map(n=>({element:shape(n),region:shape(n.closest('[data-workbench-region-id]'))})),regions:[...document.querySelectorAll('[data-workbench-region-id]')].map(shape),focus:[...document.querySelectorAll('.global-focus-surface')].map(shape),focusViews:[...document.querySelectorAll('[data-desktop-focus-view]')].map(shape),workbench:localStorage.getItem('agentmux-workbench-v1'),bodyText:document.body.innerText.slice(0,50000),html:document.documentElement.outerHTML.slice(0,300000)}
  })()`)
  try { state.runtimeSnapshot = await cdp.evaluate('window.agentmux.sessions.snapshot()') } catch (error) { state.runtimeSnapshotFailure = error.message }
  await writeFile(join(output, file), JSON.stringify(state, null, 2) + '\n')
  const screenshot = label + '-launch-failure.png', image = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
  await writeFile(join(output, screenshot), Buffer.from(image.data, 'base64'))
  receipt.launchDiagnostics ??= []; receipt.launchDiagnostics.push({ label, file, screenshot, sha256: digest(await readFile(join(output, screenshot))) })
}
async function launch(label, seed) {
  receipt.privateNotes = await preparePrivateNotesIsolation({ root: privateRoot, privateHome, environment })
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) assert.equal(process.env[name], undefined, `Private launch inherited ${name}`)
  const readyFile = join(privateRoot, `ready-${label}.json`), reportFile = join(privateRoot, `${label}-seed-report.json`)
  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
  assert.equal(resolve(desktopRoot, manifest.main), join(desktopRoot, 'out/main/index.js'), 'Use the existing official package Main')
  const child = spawn(require('electron'), ['--inspect-brk=0', desktopRoot, '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...environment, AGENTMUX_DESKTOP_READY_FILE: readyFile,
      ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed), AGENTMUX_DESKTOP_RECOVERY_REPORT: reportFile } : {}) }
  })
  assert.ok(child.pid > 1); children.add(child)
  let diagnostics = '', mainUrl, rendererUrl, spawnError
  child.once('error', error => { spawnError = error })
  child.stderr.on('data', bytes => { appendFileSync(join(output, label + '-desktop.stderr.log'), bytes); diagnostics = (diagnostics + bytes).slice(-16384); mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]; rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1] })
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  const main = await connectCdp(await waitFor(`${label} Main debugger`, () => { alive(); return mainUrl }), connections)
  const mainDiagnostics = await collectDiagnostics(mainUrl, label + '-main')
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  const mainPath = join(desktopRoot, 'out/main/index.js'), mainBytes = await readFile(mainPath)
  const mainLines = mainBytes.toString().split('\n')
  const anchors = mainLines.flatMap((line, i) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [i] : [])
  assert.equal(anchors.length, 1, 'Home isolation must precede the one actual compiled home-dependent constant')
  const breakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor(`${label} initial pause`, () => main.pauses.shift())
  if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) { await main.call('Debugger.resume'); paused = await waitFor(`${label} home boundary`, () => main.pauses.shift()) }
  assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId))
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: `(() => { app.setPath('home', ${JSON.stringify(privateHome)}); return { home:app.getPath('home'), appPath:app.getAppPath() } })()`, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined); assert.equal(isolated.result.value.home, privateHome); assert.equal(isolated.result.value.appPath, desktopRoot)
  const bridgeAnchors = mainLines.flatMap((line, i) => line.includes('const controlBridge = new DesktopControlIpcBridge(') ? [i] : [])
  assert.equal(bridgeAnchors.length, 1, 'Capture the single actual Main IPC owner; never add a replacement bridge')
  const bridgeBreakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: bridgeAnchors[0] })
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await main.call('Debugger.resume')
  paused = await waitFor(`${label} original Main IPC bridge constructor`, () => main.pauses.shift())
  assert.ok(paused.hitBreakpoints?.includes(bridgeBreakpoint.breakpointId))
  await main.call('Debugger.removeBreakpoint', { breakpointId: bridgeBreakpoint.breakpointId })
  await main.call('Debugger.stepOver')
  paused = await waitFor(`${label} initialized original Main IPC bridge`, () => main.pauses.shift())
  const originalBridge = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: 'controlBridge', objectGroup: 'private-main-inspection', returnByValue: false })
  assert.equal(originalBridge.exceptionDetails, undefined); assert.ok(originalBridge.result.objectId)
  const controlBridgeId = originalBridge.result.objectId, controlBridgeOwner = { pid: child.pid,
    source: 'apps/desktop/out/main/index.js', sha256: digest(mainBytes), symbol: 'DesktopControlIpcBridge', contract: 'Main-to-original-Renderer inspect.region' }
  await main.call('Debugger.resume')
  const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
  const target = await waitFor(`${label} Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`, { signal: AbortSignal.timeout(5000) })).json()).find(value => value.type === 'page' && value.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl, connections); await cdp.call('Runtime.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  const rendererDiagnostics = await collectDiagnostics(target.webSocketDebuggerUrl, label + '-renderer')
  await waitFor(`${label} ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; return null } })
  if (seed) await copyFile(reportFile, join(output, label + '-seed-report.json'))
  try {
  await waitFor(`${label} original workface and ${collectionLayoutJoin ? 'Collection presentation' : 'visible name handle'}`, () => cdp.evaluate(
    collectionLayoutJoin
      ? `Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .xterm')&&document.querySelector('.global-focus-surface[data-focus-topic-presentation]')?.getClientRects().length)`
      : `Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .xterm')&&document.querySelector('[aria-label="Resize timeline names"]')?.getClientRects().length)`))
  } catch (error) {
    try { await captureLaunchFailure(cdp, label) } catch (diagnosticError) { receipt.launchDiagnosticFailure = diagnosticError.message }
    throw error
  }
  assert.equal(await cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()'), privateHome)
  return { child, main, cdp, controlBridgeId, controlBridgeOwner, diagnostics: [mainDiagnostics, rendererDiagnostics], seedReport: seed ? JSON.parse(await readFile(reportFile, 'utf8')) : null }
}
async function surface(probe) {
  if (collectionLayoutJoin) {
    const value = await probe.cdp.evaluate(`(() => { const saved=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;return{selection:saved.workbenchSpaceSelection,focus:saved.agentFocus,draft:saved.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],topicPresentation:document.querySelector('.global-focus-surface')?.dataset.focusTopicPresentation,regions:[...document.querySelectorAll('[data-workbench-region-id]')].filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible').map(n=>n.dataset.workbenchRegionId).sort()}})()`)
    const spatial = await new core.AgentMuxSpatialStateStore().read()
    assert.ok(spatial?.graph?.tabs.some(tab => tab.tabId === tabId), 'Original Tab must exist in the actual Core durable workface')
    assert.ok(spatial.graph.layouts[workspaceId] && spatial.graph.tabLayouts[tabId], 'Original Group and split layout must be nonempty')
    return { ...value, workbench: spatial.graph }
  }
  return probe.cdp.evaluate(`(() => { const saved=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state, scene=document.querySelector('.recent-focus'), name=scene.querySelector('.recent-focus__ruler > .recent-focus__gutter').getBoundingClientRect(), handle=scene.querySelector('[aria-label="Resize timeline names"]');return{workbench:saved.restoredWorkbench,focus:saved.agentFocus,draft:saved.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],width:saved.focusTimelineNameWidth,renderedWidth:name.width,handle:handle.getAttribute('aria-valuenow'),tracks:[...scene.querySelectorAll('[data-focus-timeline-id]')].map(n=>n.dataset.focusTimelineId),projects:[...scene.querySelectorAll('[data-timeline-project]')].map(n=>n.dataset.timelineProject),height:saved.focusTimelineHeight,ruler:saved.focusTimelineRuler,hours:Number(scene.querySelector('[aria-label=\"Focus window size\"]')?.value),mode:scene.dataset.rulerMode,zone:scene.dataset.timeZone,regions:[...document.querySelectorAll('[data-workbench-region-id]')].filter(n=>n.getClientRects().length).map(n=>n.dataset.workbenchRegionId).sort()}})()`)
}
function originalWorkfaceScope(graph) {
  const choice = receipt.originalSelection
  const tab = graph.tabs.find(tab => tab.tabId === choice.tabId), space = graph.spaces.find(space => space.spaceId === choice.spaceId), zone = graph.zones.find(zone => zone.zoneId === choice.zoneId)
  assert.ok(tab && space && zone)
  assert.equal(tab.workspaceId, choice.workspaceId); assert.equal(tab.zoneId, choice.zoneId)
  const tabResource = graph.resources[`tab:${choice.tabId}`]
  if (tabResource.space) { assert.equal(tabResource.space.spaceId, choice.spaceId); assert.equal(tabResource.space.zoneId, choice.zoneId) }
  assert.equal(tabResource.titleRegionId, choice.regionId)
  const regions = graph.regions.filter(region => region.tabId === choice.tabId).sort((a, b) => a.regionId.localeCompare(b.regionId))
  assert.deepEqual(regions.map(region => region.regionId).sort(), [...tab.regionIds].sort())
  return { space, zone, bindings: graph.bindings.filter(binding => binding.zoneId === choice.zoneId).sort((a, b) => a.spaceId.localeCompare(b.spaceId)),
    tab, regions, layout: graph.layouts[choice.workspaceId], tabLayout: graph.tabLayouts[choice.tabId], titleRegionId: tabResource.titleRegionId,
    regionResources: Object.fromEntries(regions.map(region => [region.regionId, graph.resources[`region:${region.regionId}`]])) }
}
async function collectionCommand(args, operation) {
  const cli = join(repositoryRoot, 'packages/core/bin/amux'), endpoint = `unix:${join(runtimeDirectory, 'control.sock')}`
  const captured = { args: ['--endpoint', endpoint, ...args], operation, startedAt: Date.now() }
  receipt.collectionCli ??= []; receipt.collectionCli.push(captured)
  let result
  try {
    const execution = exec(process.execPath, [cli, ...captured.args], { cwd: repositoryRoot, timeout: 10_000,
      env: { ...process.env, ...environment, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } })
    children.add(execution.child)
    try { result = { code: 0, ...await execution } } finally { children.delete(execution.child) }
  } catch (error) { result = { code: error.code ?? null, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
  Object.assign(captured, result, { elapsedMs: Date.now() - captured.startedAt })
  // Preserve an unknown write exactly. Never retry it or open a second service.
  assert.equal(result.code, 0, JSON.stringify(captured))
  const payload = JSON.parse(result.stdout)
  captured.receipt = payload
  assert.equal(payload.ok, true); assert.equal(payload.operation, operation)
  return payload.result
}
async function durableCollectionPreference(expected, checkpoint) {
  const path = join(userData, 'agentmux.config.json'), bytes = await readFile(path), config = JSON.parse(bytes)
  assert.equal(config.focus?.topicPresentation, expected)
  const file = `collection-config-${checkpoint}.json`
  await writeFile(join(output, file), bytes, { flag: 'wx', mode: 0o600 })
  return { file, sha256: digest(bytes), value: config.focus.topicPresentation }
}
async function setCollectionPresentation(probe) {
  stage = 'collection-cli-discovery'
  const found = await collectionCommand(['settings', 'inspect', 'focus.topicPresentation'], 'settings.inspect')
  assert.deepEqual(found.entries, [{ key: 'focus.topicPresentation', kind: 'string', value: 'cards', default: 'cards', enum: ['cards', 'sections'] }])
  stage = 'collection-cli-single-write'
  const operationId = randomUUID()
  receipt.collectionOperation = { operationId, key: 'focus.topicPresentation', value: 'sections' }
  const saved = await collectionCommand(['settings', 'set', 'focus.topicPresentation', 'sections', '--operation-id', operationId], 'settings.set')
  assert.equal(saved.entry.key, 'focus.topicPresentation'); assert.equal(saved.entry.value, 'sections')
  stage = 'collection-renderer-consumption'
  const edited = await waitFor('actual Focus consumes public CLI Topic presentation', async () => {
    const value = await surface(probe); return value.topicPresentation === 'sections' ? value : null
  })
  stage = 'collection-config-durability'
  receipt.collectionConfigAfterSave = await durableCollectionPreference('sections', 'after-save')
  return edited
}
async function joinClick(probe, selector) {
  await waitFor('actual join control can be hit: ' + selector, () => probe.cdp.evaluate(`(() => {const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button,input')===n})()`))
  const point = await probe.cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed','mouseReleased']) await probe.cdp.call('Input.dispatchMouseEvent', {type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1})
}
async function joinChange(probe, selector, value) {
  await probe.cdp.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing actual join control');if(n instanceof HTMLSelectElement&&!Array.from(n.options).some(o=>o.value===${JSON.stringify(value)}))throw new Error('Nonexistent actual option');const proto=n instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}
async function setJoinPreferences(probe) {
  await probe.cdp.evaluate(`document.querySelector('[aria-label="Focus timeline settings"]').scrollIntoView({block:'nearest',inline:'nearest'})`)
  await joinClick(probe, '[aria-label="Focus timeline settings"]')
  await waitFor('actual ruler dialog',()=>probe.cdp.evaluate(`Boolean(document.querySelector('.focus-ruler-settings'))`))
  await probe.cdp.evaluate(`Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&(a.effect?.getComputedTiming().iterations??1)!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))`)
  await joinClick(probe, '[name="focus-ruler-mode"][value="uniform"]')
  await joinChange(probe, '[aria-label="Focus timeline time zone"]', joinPreferences.timeZone)
  await joinChange(probe, '[aria-label="Time ruler interval in minutes"]', String(joinPreferences.intervalMinutes))
  await joinChange(probe, '[aria-label="Time ruler clock offset"]', _hygiene_fixtureClock(23, 45))
  await joinClick(probe, '.focus-ruler-settings footer button:last-child')
  const value=await waitFor('actual selected preferences persisted',async()=>{const value=await surface(probe);return JSON.stringify(value.ruler)===JSON.stringify(joinPreferences)?value:null})
  assert.equal(value.mode,'uniform');assert.equal(value.zone,joinPreferences.timeZone);return value
}
async function joinShot(probe,name) {
  await probe.cdp.evaluate(`Promise.all([document.fonts.ready,...document.getAnimations().filter(a=>a.playState==='running'&&(a.effect?.getComputedTiming().iterations??1)!==Infinity).map(a=>a.finished.catch(()=>{}))]).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))`)
  const image=await probe.cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true})
  const imagePath=join(output,name+'.png');await writeFile(imagePath,Buffer.from(image.data,'base64'))
  receipt.images??=[];receipt.images.push({path:name+'.png',sha256:digest(await readFile(imagePath)),state:await surface(probe),pid:probe.child.pid})
}
async function actualTerminal(probe) {
  const { cdp } = probe; await cdp.call('Debugger.enable')
  const candidates = []
  for (const asset of (await readdir(join(desktopRoot, 'out/renderer/assets'))).filter(name => name.endsWith('.js'))) {
    const path = join(desktopRoot, 'out/renderer/assets', asset), source = await readFile(path, 'utf8'), ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set(node.properties.map(p => p.name?.getText(ast).replace(/^['"]|['"]$/g, '')))
        if (['sampledAt', 'viewGrid', 'mouseTrackingMode', 'buffer', 'liveReady'].every(name => names.has(name))) {
          let owner = node.parent; while (owner && !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner) && !ts.isFunctionDeclaration(owner)) owner = owner.parent
          assert.ok(owner); const objects = []
          function find(current) { if (ts.isPropertyAccessExpression(current) && current.name.text === 'active' && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'buffer' && ts.isIdentifier(current.expression.expression)) objects.push(current.expression.expression.text); ts.forEachChild(current, find) }
          find(owner); assert.equal(new Set(objects).size, 1)
          candidates.push({ url: pathToFileURL(path).href, ...ast.getLineAndCharacterOfPosition(node.getStart(ast)), identifier: objects[0] })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  assert.equal(candidates.length, 1, 'Read the single actual production terminal getter, not an empty source scan')
  const target = candidates[0], breakpoint = await cdp.call('Debugger.setBreakpointByUrl', { url: target.url, lineNumber: target.line, columnNumber: target.character })
  let paused; const request = inspectRegion(probe)
  try {
    paused = await waitFor('actual xterm getter pause', () => cdp.pauses.shift(), 10000); assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId))
    const value = await cdp.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: target.identifier, returnByValue: false, objectGroup: 'name-width-observation' })
    assert.equal(value.exceptionDetails, undefined); assert.ok(value.result.objectId); return value.result.objectId
  } finally { await cdp.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); if (paused) await cdp.call('Debugger.resume'); await request }
}
async function adjust(probe, width) {
  const point = await probe.cdp.evaluate(`(()=>{const e=document.querySelector('[aria-label="Resize timeline names"]'),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const targetX = point.x + width - Number((await surface(probe)).handle)
  await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: point.y, button: 'left', buttons: 1 })
  await probe.cdp.evaluate('new Promise(requestAnimationFrame)')
  const interim = await surface(probe); assert.equal(interim.renderedWidth, width); assert.equal(interim.width, 112, 'Draft geometry is not a persisted commit')
  await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  return waitFor('width commits on release', async () => { const value = await surface(probe); return value.width === width ? value : null })
}
async function normalQuit(probe) {
  for (const socket of probe.diagnostics ?? []) { socket.close(); diagnosticSockets.delete(socket) }
  let replyError
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron').app.quit()`) } catch (error) { replyError = error.message }
  probe.cdp.close(); probe.main.close()
  await waitFor('ordinary Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null); children.delete(probe.child)
  return { pid: probe.child.pid, exitCode: probe.child.exitCode, signal: probe.child.signalCode, inspectorReplyError: replyError ?? null }
}
try {
  stage = 'canonical-freshness'
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(repositoryRoot)});`], { cwd: repositoryRoot, encoding: 'utf8' })
  await writeFile(join(output, 'freshness.log'), (freshness.stdout ?? '') + (freshness.stderr ?? ''))
  assert.equal(freshness.status, 0, 'Use fresh ordinary private Core/Demand output; never bypass the canonical guard')
  stage = 'source-and-compiled-input-binding'
  receipt.inputsBefore = await binding()
  for (const name of inheritedCallerNames) delete process.env[name]
  Object.assign(process.env, environment)
  for (const path of [privateHome, userData, workspacePath, topicsPath, codexHome]) await mkdir(path, { recursive: true, mode: 0o700 })
  receipt.privateNotes = await preparePrivateNotesIsolation({ root: privateRoot, privateHome, environment })
  stage = 'private-original-run'
  const executable = join(privateRoot, 'private-codex.sh'), quote = text => `'${text.replace(/'/g, `'\\''`)}'`
  const fixtureSource = join(repositoryRoot, 'packages/core/test/fixtures/fake-codex-cli.mjs'), ownedFixture = join(privateRoot, 'fake-codex-cli.mjs')
  await copyFile(fixtureSource, ownedFixture); assert.equal(digest(await readFile(ownedFixture)), digest(await readFile(fixtureSource)))
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = '--version' ]; then printf 'Private codex fixture 1\\n'; exit 0; fi\nexec ${quote(process.execPath)} ${quote(ownedFixture)} "$@"\n`, { mode: 0o700 })
  client = await core.connectLocalAgentMux({ store: new core.AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json')) })
  session = await client.createAgent({ createOperationId: randomUUID(), providerId: 'codex', executorId: 'width-probe', commandOverride: executable,
    workspacePath, injectAgentMuxGuide: false, env: fixtureEnvironment, cols: 100, rows: 30 })
  receipt.originalSession = { agentSessionId: session.agentSessionId, run: { ...session.run } }
  originalRun = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(originalRun?.state, 'running'); assert.ok(originalRun.pid > 1); receipt.originalRun = originalRun; receipt.runtimeBefore = client.runtimeIdentity()
  await writeFile(join(workspacePath, 'sibling.txt'), 'The original sibling Region remains visible\n')
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private width fixture' }],
    executors: { 'width-probe': { label: 'Private width Agent', providerId: 'codex', command: executable, args: [], env: fixtureEnvironment, injectAgentMuxGuide: false } },
    workspaces: [{ id: '__scratch__', name: 'Private Topics', hostId: 'local', path: topicsPath, kind: 'folder' }, { id: workspaceId, name: 'Width retained work', hostId: 'local', path: workspacePath, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'agents', focusTimelineHeight: 208, focusTimelineNameWidth: 112,
    agentFocus: { execution: { sessionId: session.agentSessionId, history: [{ sessionId: session.agentSessionId, focusedAt: Date.now() - 60 * 60000,
      identity: { kind: 'agent', providerId: 'codex', name: 'Private width retained Agent', hostId: 'local', workspacePath, project: { id: workspaceId, name: 'Width retained work' } } }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.agentSessionId]: draft }, restoredWorkbench: { tabs: { [tabId]: { id: tabId, workspaceId, titleRegionId: agentRegionId,
      layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.61, first: { type: 'leaf', regionId: agentRegionId }, second: { type: 'leaf', regionId: fileRegionId } }, activeRegionId: agentRegionId },
      regions: { [agentRegionId]: { regionId: agentRegionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: session.agentSessionId }, [fileRegionId]: { regionId: fileRegionId, kind: 'file', workspaceId, path: 'sibling.txt' } } } },
      layouts: { [workspaceId]: { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: groupId },
        __scratch__: { root: { type: 'leaf', groupId: 'width-scratch-group' }, groups: [{ id: 'width-scratch-group', tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: 'width-scratch-group' } } } } }
  const spaceId = directoryIdentity('local', workspacePath)
  seed.state.workbenchSpaceSelection = { spaceId, zoneId: JSON.stringify([spaceId, 'workspace', workspaceId]), workspaceId,
    topicId: null, tabId, groupId, regionId: agentRegionId }
  receipt.originalSelection = seed.state.workbenchSpaceSelection
  seed.state.viewModes = { [session.agentSessionId]: 'terminal' }
  await seedOriginalSpatialWorkface(seed)
  await startPrivateSemanticHost()
  stage = 'first-seeded-launch'
  const first = await launch('first', seed), before = await surface(first)
  if (collectionLayoutJoin) {
    assert.equal(before.topicPresentation, 'cards'); assert.ok(before.regions.includes(agentRegionId)); assert.ok(before.regions.includes(fileRegionId))
    assert.deepEqual(before.selection, receipt.originalSelection)
    assert.ok(before.workbench.regions.some(region => region.regionId === agentRegionId && region.agentSessionId === session.agentSessionId))
    receipt.workfaceGraphs = { before: await hostArtifact('first-before-core-graph.json', before.workbench) }
  } else { assert.equal(before.width, 112); assert.equal(before.renderedWidth, 112); assert.ok(before.tracks.includes(session.agentSessionId)); assert.ok(before.projects.length > 0) }
  assert.equal(before.draft, draft)
  receipt.seedReport = first.seedReport
  if(rulerJoin){
    assert.equal(before.hours,4)
    await joinChange(first,'[aria-label=\"Focus window size\"]','6')
    const preferred=await setJoinPreferences(first);assert.equal(preferred.hours,6);assert.equal(preferred.width,112);assert.deepEqual(preferred.workbench,before.workbench);assert.equal(preferred.draft,draft)
    receipt.joinInitial={before,preferred};
  }
  stage = 'first-original-run-input-ready'
  await waitFor('first original Run is input ready', async () => { const value = await inspectRegion(first); return value.terminalView?.liveReady && value.terminalView.acceptsInput ? value : null })
  const widthRunBefore = await run()
  const originalTerminal = await actualTerminal(first), edited = collectionLayoutJoin ? await setCollectionPresentation(first) : await adjust(first, 244), laterTerminal = await actualTerminal(first)
  const same = await first.cdp.call('Runtime.callFunctionOn', { objectId: originalTerminal, arguments: [{ objectId: laterTerminal }], functionDeclaration: 'function(current){return this===current}', returnByValue: true })
  assert.equal(same.exceptionDetails, undefined); assert.equal(same.result.value, true); receipt.sameProcessXtermPreserved = true
  if (collectionLayoutJoin) {
    receipt.workfaceGraphs.edited = await hostArtifact('first-after-core-graph.json', edited.workbench)
    assert.deepEqual(originalWorkfaceScope(edited.workbench), originalWorkfaceScope(before.workbench))
  } else assert.deepEqual(edited.workbench, before.workbench)
  assert.deepEqual(edited.focus, before.focus); assert.equal(edited.draft, draft)
  if (collectionLayoutJoin) assert.deepEqual(edited.selection, before.selection)
  if (collectionLayoutJoin) { assert.equal(edited.topicPresentation, 'sections'); assert.deepEqual(edited.regions, before.regions) }
  else assert.equal(edited.height, before.height)
  if(rulerJoin){assert.deepEqual(edited.ruler,joinPreferences);assert.equal(edited.hours,6);await joinChange(first,'[aria-label=\"Focus window size\"]','4');await waitFor('first returns actual local4h',async()=>{const value=await surface(first);return value.hours===4?value:null});await joinShot(first,'ordinary-first-prefs-width')}
  const widthRunAfter = await run()
  assert.equal(widthRunAfter.acceptedInputBytes, widthRunBefore.acceptedInputBytes, 'Presentation changes never submit the draft')
  receipt[collectionLayoutJoin ? 'collectionInputBoundary' : 'widthInputBoundary'] = { beforeByte: widthRunBefore.acceptedInputBytes, afterByte: widthRunAfter.acceptedInputBytes, permitsOriginalAttachProtocol: true }
  stage = 'first-normal-quit'
  receipt.processes.push({ pid: first.child.pid, seedWrites: 1, before, after: edited, exit: await normalQuit(first) })
  const preservedAfterQuit = await run(); stage = 'second-launch-without-seed'
  const second = await launch('second'), restored = await surface(second)
  const secondProcess = { pid: second.child.pid, seedWrites: 0, before: restored }
  receipt.processes.push(secondProcess)
  receipt.originalRunAfterQuit = preservedAfterQuit
  await writeFile(join(output, 'second-process-restored-checkpoint.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (collectionLayoutJoin) {
    receipt.workfaceGraphs.restored = await hostArtifact('second-restored-core-graph.json', restored.workbench)
    assert.deepEqual(originalWorkfaceScope(restored.workbench), originalWorkfaceScope(edited.workbench))
  } else assert.deepEqual(restored.workbench, edited.workbench)
  assert.deepEqual(restored.focus, edited.focus); assert.equal(restored.draft, draft)
  if (collectionLayoutJoin) assert.deepEqual(restored.selection, before.selection)
  if (collectionLayoutJoin) {
    stage = 'collection-preference-and-workface-restored'
    assert.equal(restored.topicPresentation, 'sections'); assert.deepEqual(restored.regions, before.regions)
    receipt.collectionConfigAfterRestart = await durableCollectionPreference('sections', 'after-restart'); receipt.collectionPreferencesRestored = true
  } else { assert.equal(restored.width, 244); assert.equal(restored.renderedWidth, 244); assert.equal(restored.height, before.height); assert.deepEqual(restored.tracks, edited.tracks) }
  if(rulerJoin){assert.deepEqual(restored.ruler,joinPreferences);assert.equal(restored.mode,'uniform');assert.equal(restored.zone,joinPreferences.timeZone);assert.equal(restored.hours,4);receipt.rulerPreferencesRestored=true;receipt.hoursBoundary={firstEdited:6,firstBeforeQuit:4,second:restored.hours,changedHourDurable:false};await joinShot(second,'ordinary-second-restored-prefs-width')}
  stage = 'restored-original-run-input-ready'
  const inspected = await waitFor('restored same Run is input ready', async () => { const value = await inspectRegion(second); return value.terminalView?.liveReady && value.terminalView.acceptsInput ? value : null })
  receipt.restoredRegion = { kind: inspected.kind, agentSessionId: inspected.agentSessionId,
    terminalView: { runId: inspected.terminalView.runId, liveReady: inspected.terminalView.liveReady, acceptsInput: inspected.terminalView.acceptsInput } }
  await writeFile(join(output, 'second-process-ready-checkpoint.json'), JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(inspected.kind, 'agent'); assert.equal(inspected.agentSessionId, session.agentSessionId)
  assert.equal(inspected.terminalView.runId, session.run.runId)
  receipt.crossProcessXterm = { firstPid: first.child.pid, secondPid: second.child.pid, newInstanceExpected: true }
  stage = 'restored-original-private-ack'
  const ackBefore = await run(), ack = await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'w\r', source: 'user' })
  assert.ok(ack.appliedByteRange); assert.equal(ack.appliedByteRange.endByte - ack.appliedByteRange.startByte, 2)
  const after = await waitFor('same original private Run ACK', async () => { const value = await run(); return value.acceptedInputBytes === ackBefore.acceptedInputBytes + 2 ? value : null })
  receipt.runs = [{ before: { runId: originalRun.runId, pid: originalRun.pid }, after: { runId: after.runId, pid: after.pid }, ack: { passed: true, beforeByte: ackBefore.acceptedInputBytes, afterByte: after.acceptedInputBytes, appliedByteRange: ack.appliedByteRange } }]
  secondProcess.exit = await normalQuit(second); assert.notEqual(receipt.processes[0].pid, receipt.processes[1].pid)
  receipt.originalRunAfterQuit = preservedAfterQuit
  if (collectionLayoutJoin) { receipt.originalWorkfacePreserved = true; receipt.fullCatalogMayGainIndependentResources = true }
  else { receipt.widthRestored = true; receipt.workbenchPreserved = true }
  const freshRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
  const freshVerifier = await core.connectHostedAgentMux({ rpc: freshRpc, expectedStorePath: join(userData, 'agent-sessions.json') })
  try {
    receipt.runtimeAfter = freshVerifier.runtimeIdentity(); assert.deepEqual(receipt.runtimeAfter, receipt.runtimeBefore)
    const identity = await freshRpc.call('runtime.owner.identity', {})
    assert.equal(identity.owner.processId, hostProcess.pid)
    const beforeIdentity = JSON.parse(await readFile(join(output, receipt.semanticHost.ownerIdentity.file), 'utf8')).owner
    assert.equal(identity.owner.runtimeId, beforeIdentity.runtimeId); assert.equal(identity.owner.ownerInstanceId, beforeIdentity.ownerInstanceId)
    receipt.semanticHost.afterIdentity = await hostArtifact('host-owner-after.identity.json', identity)
  } finally { await freshVerifier.dispose(); await freshRpc.dispose() }
  stage = 'source-and-compiled-input-stability'
  receipt.inputsAfter = await binding(); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore); receipt.passed = true
} catch (error) { failure = error; receipt.failure = { stage, name: error.name, message: error.message, stack: error.stack } }
finally {
  clearTimeout(watchdog); process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigint)
  for (const socket of diagnosticSockets) socket.close()
  const errors = [], attempt = async operation => { try { await operation() } catch (error) { errors.push(error.message) } }
  await attempt(async () => {
    try { const bytes = await readFile(join(userData, 'agentmux-host.log')); await writeFile(join(output, 'ordinary-agentmux-host.log'), bytes); receipt.ordinaryHostLog = { file: 'ordinary-agentmux-host.log', sha256: digest(bytes) } }
    catch (error) { if (error.code !== 'ENOENT') throw error; receipt.ordinaryHostLog = { unavailable: 'ENOENT' } }
  })
  for (const connection of connections) { await attempt(async () => { await connection.call('Debugger.resume').catch(() => {}); connection.close() }) }
  await attempt(async () => { if (client) { try { if (session) await client.stopAgent(session.agentSessionId, session.run) } finally { await client.dispose() } } })
  await attempt(async () => { await hostRpc?.dispose() })
  await attempt(async () => {
    if (await macosHostServiceRegistration(privateService)) {
      receipt.cleanup.unexpectedPrivateRegistration = privateService
      const result = await exec('/bin/launchctl', ['bootout', privateService.target], { timeout: 10_000 })
      receipt.cleanup.privateRegistrationRemoval = { stdout: result.stdout, stderr: result.stderr }
      errors.push('Private Desktop unexpectedly registered a platform Host instead of borrowing the original live Node Host')
    }
    assert.equal(await macosHostServiceRegistration(privateService), null); receipt.cleanup.privateServiceAbsent = true
  })
  await attempt(async () => {
    if (!hostProcess) return
    if (hostProcess.exitCode === null && hostProcess.signalCode === null) {
      assert.deepEqual(await inspectMacosHostProcess(hostProcess.pid), hostBirth)
      hostProcess.kill('SIGTERM')
      await waitFor('owned private semantic Host exit', () => hostProcess.exitCode !== null || hostProcess.signalCode !== null)
    }
    children.delete(hostProcess); receipt.cleanup.privateHostExited = true
    receipt.cleanup.privateHostExit = { pid: hostProcess.pid, exitCode: hostProcess.exitCode, signal: hostProcess.signalCode }
  })
  for (const child of children) await attempt(async () => { if (child.pid) await stopProbeProcesses(child.pid, privateRoot) })
  await attempt(async () => { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot); receipt.cleanup.remainingOwnedProcesses = await listProbeProcesses(-1, privateRoot); assert.deepEqual(receipt.cleanup.remainingOwnedProcesses, []); await rm(privateRoot, { recursive: true }); receipt.cleanup.ownedPrivateRootsRemoved = true })
  for (const [name, value] of previous) value === undefined ? delete process.env[name] : process.env[name] = value
  if (errors.length) { receipt.cleanup.errors = errors; receipt.passed = false; failure ??= new Error(errors.join('; ')) }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(output, 'receipt.json'), failure: receipt.failure, cleanup: receipt.cleanup }))
if (failure || !receipt.passed) process.exitCode = 1
