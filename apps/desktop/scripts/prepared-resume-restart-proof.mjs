import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// One current-source real Native + Desktop scene. The existing private builder owns
// source capture, dependencies, typing, nonactivating windows and all build cleanup.
const buildPath = process.env.AGENTMUX_PREPARED_RESUME_BUILD_RECEIPT
assert.ok(buildPath, 'Use verify-workbench-persistence-restart --prepared-resume')
const build = JSON.parse(await readFile(buildPath, 'utf8')), repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const receiptPath = process.argv.find(a => a.startsWith('--receipt-path='))?.slice('--receipt-path='.length)
assert.ok(receiptPath && !receiptPath.startsWith(repository + '/'))
assert.equal(build.privateRoot, repository); assert.equal(process.env.HOME, build.privateHome.path); assert.equal(homedir(), build.privateHome.path)
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), exec = promisify(execFile), require = createRequire(import.meta.url)
await writeFile(join(dirname(buildPath), 'worker-home.json'), JSON.stringify({ pid: process.pid, privateRoot: repository,
  sourceCommit: build.sourceCommit, home: process.env.HOME, nodeHome: homedir(), beforeCoreImports: true,
  workerSHA256: sha(await readFile(import.meta.filename)) }, null, 2))
const nativeExecutable = process.env.AGENTMUX_REAL_CODEX_COMMAND ?? 'codex'
const root = await realpath(await mkdtemp(join(repository, 'resume-scene-'))), userData = join(root, 'ui'), runtime = join(root, 'rt'), workspace = join(root, 'ws'), codexHome = join(root, 'codex')
for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) delete process.env[name]
const namespace = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'),
  AGENTMUX_SPATIAL_STATE_STORE: join(runtime, 'state/spatial.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), CODEX_HOME: codexHome,
  AGENTMUX_CONNECTOR_DIRECTORY: join(root, 'connectors'), AGENTMUX_MOTE_CONFIGURATION_PATH: join(root, 'motes.json') }
Object.assign(process.env, namespace); delete process.env.ELECTRON_RUN_AS_NODE
for (const path of [userData, runtime, join(runtime, 'state/ctxmux'), workspace, codexHome]) await mkdir(path, { recursive: true, mode: 0o700 })
const { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, connectAgentMuxRpc, connectHostedAgentMux } = await import('../../../packages/core/dist/index.js')
const { agentLifecycleOperationIdentity } = await import('../../../packages/core/dist/agent-session-store.js')
const { macosHostServiceAddress, macosHostServiceRegistration } = await import('../../host/dist/macos-service.js')
const privateService = macosHostServiceAddress(join(runtime, 'control.sock'))
assert.equal(await macosHostServiceRegistration(privateService), null, 'This fresh private namespace must have no existing platform owner')
const id = 'private-resume-original', tabId = 'resume-tab', regionId = 'resume-agent', fileId = 'resume-neighbor', workspaceId = 'resume-workspace'
const originalPrompt = 'PRIVATE_ORIGINAL_CONTEXT retained native conversation', unknownPrompt = 'PRIVATE_UNKNOWN_INPUT_MUST_NOT_REPLAY', draft = 'Unsent original draft survives resume and Desktop restart'
const store = new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
const canonical = () => store.readMetadata(id)
const progress = async stage => { report.phases.push(stage); (report.phaseRequests ??= []).push({ stage, count: requests.length }); await writeFile(receiptPath, JSON.stringify(report, null, 2)); console.log('private_resume_stage=' + stage) }
const requests = [], children = new Set(), cleanup = {}, report = { schema: 'agentmux.prepared-resume-restart.v1', passed: false, userRunTouched: false, buildReceipt: buildPath, phases: [] }
let failure, backendFailure, daemon, client, rpc, hosted, host, hostClosed, first, second, nativeRun, originalNative, daemonClosed
const delay = ms => new Promise(done => setTimeout(done, ms))
async function until(label, read, budget = 35_000) {
  const end = Date.now() + budget
  do {
    if (backendFailure) throw backendFailure
    try { const value = await read(); if (value) return value }
    catch (error) {
      // This external polling reader can overlap the real Host writer. A failed read
      // is unknown, never an absent Session or successful transition; retain its cause.
      if (error.code !== 'AGENT_SESSION_STORE_UNAVAILABLE') throw error
      report.storeObservation ??= { failures: 0 }; report.storeObservation.failures++
      report.storeObservation.last = { label, code: error.code, detail: error.detail, observedAt: Date.now() }
    }
    await delay(40)
  } while (Date.now() < end)
  throw new Error('Private resume scene timeout: ' + label)
}
const originalRequests = () => requests.filter((_, index) => report.protocolRequests[index].metadata.session_id === originalNative.sessionId)
const textOf = request => request.input?.filter(item => item.role === 'user').at(-1)?.content?.map(part => part.text ?? '').join('') ?? ''
const backend = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk
    report.httpRequests ??= []
    report.httpRequests.push({ phase: report.phases.at(-1), method: request.method, path: request.url,
      bodySHA256: sha(body), unknownInputPresent: body.includes(unknownPrompt) })
    assert.ok(!body.includes(unknownPrompt), 'The old unknown input must not occur anywhere in any HTTP request body')
    if (request.method === 'GET') { response.end('{"data":[]}'); return }
    const value = JSON.parse(body), user = textOf(value)
    if (!user) { response.end('{}'); return }
    const metadata = JSON.parse(request.headers['x-codex-turn-metadata'] ?? 'null')
    assert.ok(metadata && typeof metadata.session_id === 'string' && typeof metadata.turn_id === 'string' && typeof metadata.thread_source === 'string')
    report.protocolRequests ??= []
    report.protocolRequests.push({ metadata, phase: report.phases.at(-1), method: request.method, path: request.url, model: value.model,
      headers: Object.fromEntries(Object.entries(request.headers).filter(([key]) => /session|turn|request-id/u.test(key))),
      user, requestSHA256: sha(body) })
    requests.push(value); response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = item => response.write('event: ' + item.type + '\ndata: ' + JSON.stringify(item) + '\n\n')
    const responseId = 'private_response_' + requests.length, text = 'PRIVATE_NATIVE_CONTEXT_ACK'
    const item = { type: 'message', id: 'private_assistant_' + requests.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    event({ type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } })
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    event({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text })
    event({ type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text })
    event({ type: 'response.output_item.done', output_index: 0, item })
    event({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } }); response.end()
  } catch (error) { backendFailure = error; response.end() }
})
await new Promise(done => backend.listen(0, '127.0.0.1', done))
async function birth(pid) {
  try { const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart=']); const fields = stdout.trim().split(/\s+/); return fields.length >= 7 ? { pid: Number(fields[0]), group: Number(fields[1]), born: fields.slice(2).join(' ') } : null }
  catch (error) { if (error.code === 1 && !error.stdout?.trim()) return null; throw error }
}
async function cdpConnect(url) {
  const socket = new WebSocket(url), pending = new Map(); let serial = 0
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  socket.addEventListener('message', ({ data }) => { const value = JSON.parse(data), request = pending.get(value.id); if (!request) return; pending.delete(value.id); clearTimeout(request.timer); value.error ? request.fail(new Error(value.error.message)) : request.done(value.result) })
  const call = (method, params = {}) => new Promise((done, fail) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error('Private CDP timeout: ' + method)) }, 10000); pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params })) })
  return { call, close: () => socket.close(), async evaluate(expression) { const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text); return value.result.value } }
}
async function launch(label, seed) {
  const ready = join(root, label + '-ready.json'), env = { ...process.env, AGENTMUX_DESKTOP_READY_FILE: ready, AGENTMUX_DESKTOP_RECOVERY_REPORT: join(root, label + '-recovery.json'),
    ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed) } : {}) }
  if (!seed) assert.equal(env.AGENTMUX_DESKTOP_RECOVERY_SEED, undefined)
  assert.equal(JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).main, './out/main/index.js')
  assert.equal(sha(await readFile(join(desktop, 'out/main/index.js'))), build.compiled['apps/desktop/out/main/index.js'])
  const child = spawn(require('electron'), [desktop, '--remote-debugging-port=0'], { cwd: desktop, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child); child.probeBirth = await birth(child.pid)
  const startedAt = Date.now(), observation = { label, pid: child.pid, birth: child.probeBirth, startedAt, stdout: '', stderr: '' }
  report.appStarts ??= []; report.appStarts.push(observation)
  child.probeClosed = new Promise(done => child.once('close', done)); child.once('exit', () => { child.stdout.destroy(); child.stderr.destroy() })
  child.stdout.on('data', bytes => { observation.stdout = (observation.stdout + bytes).slice(-32768) })
  let stderr = '', debuggerUrl
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-32768); observation.stderr = stderr; debuggerUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1] })
  const alive = () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private Desktop exited: ' + stderr) }
  const endpoint = new URL(await until(label + ' debugger', () => { alive(); return debuggerUrl }))
  const target = await until(label + ' Renderer', async () => (await (await fetch('http://' + endpoint.host + '/json/list')).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await cdpConnect(target.webSocketDebuggerUrl)
  observation.beforeVirtualFocus = await cdp.evaluate('({ready:document.readyState,visibility:document.visibilityState,focused:document.hasFocus()})')
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  observation.afterVirtualFocus = await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve({ready:document.readyState,visibility:document.visibilityState,focused:document.hasFocus(),frameObserved:true})))')
  try {
    await until(label + ' Main readiness', async () => { alive(); try { return JSON.parse(await readFile(ready, 'utf8')) } catch { return false } }, Math.max(1, 35_000 - (Date.now() - startedAt)))
    observation.readyAfterMs = Date.now() - startedAt
  } catch (error) {
    observation.failedAfterMs = Date.now() - startedAt; observation.exitCode = child.exitCode; observation.signalCode = child.signalCode
    observation.readyFile = await readFile(ready, 'utf8').catch(readError => ({ code: readError.code }))
    observation.crashLog = await readFile(join(userData, 'crash-log.ndjson'), 'utf8').catch(readError => ({ code: readError.code }))
    observation.debuggerUrl = debuggerUrl
    if (debuggerUrl) {
      let diagnostic
      try {
        const url = new URL(debuggerUrl), targets = await (await fetch('http://' + url.host + '/json/list', { signal: AbortSignal.timeout(5000) })).json()
        observation.targets = targets.map(target => ({ type: target.type, url: target.url }))
        const target = targets.find(target => target.type === 'page')
        if (target) { diagnostic = await cdpConnect(target.webSocketDebuggerUrl); observation.page = await diagnostic.evaluate('({ready:document.readyState,url:location.href,text:document.body?.innerText.slice(0,12000)})') }
      } catch (diagnosticError) { observation.diagnosticError = diagnosticError.message }
      finally { diagnostic?.close() }
    }
    cdp.close(); throw error
  }
  await until(label + ' original workface', () => cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${regionId}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${fileId}"]'))`))
  return { child, cdp }
}
async function stopApp(app) {
  if (!app) return
  app.cdp?.close(); const child = app.child ?? app
  if (child.exitCode === null && child.signalCode === null) { assert.deepEqual(await birth(child.pid), child.probeBirth); assert.equal(child.probeBirth.group, child.pid); process.kill(-child.pid, 'SIGKILL') }
  await child.probeClosed; children.delete(child)
}
async function surface(cdp) { return cdp.evaluate(`(() => {
  const state = JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state
  const visible = selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible')
  const panel = document.querySelector('[data-workbench-tab-id="${tabId}"] .workbench-region-split > [data-panel]')
  return { draft: state.agentComposerDrafts[${JSON.stringify(id)}], focus: state.agentFocus,
    editor: document.querySelector('[data-workbench-region-id="${regionId}"] .composer [role="textbox"]')?.innerText,
    tabs: visible('button.workbench-tab[data-workbench-tab-id]').map(el => el.dataset.workbenchTabId).sort(),
    regions: visible('[data-workbench-region-id]').map(el => el.dataset.workbenchRegionId).sort(),
    activeRegions: visible('.workbench-region--active[data-workbench-region-id]').map(el => el.dataset.workbenchRegionId).sort(),
    split: panel ? Number(panel.getAttribute('data-panel-size')) : null }
})()`) }
try {
  const executable = nativeExecutable
  assert.equal((await exec(executable, ['--version'])).stdout.trim(), 'codex-cli 0.160.1')
  const providerBytes = await readFile(executable), providerSHA256 = sha(providerBytes)
  assert.equal(providerBytes.byteLength, 241556032); assert.equal(providerSHA256, '09fa44fdc37a5fc70dc1ace31235f90468a2e193d0e85f7552eab068ea2582be')
  report.provider = { executable, version: 'codex-cli 0.160.1', sha256: providerSHA256, bytes: providerBytes.byteLength }
  await progress('private-native-start')
  daemon = spawn(join(repository, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(runtime, 'state/ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr.on('data', bytes => { daemonError += bytes }); daemonClosed = once(daemon, 'close')
  await Promise.race([once(daemon.stdio[3], 'data'), daemonClosed.then(() => { throw new Error(daemonError) })])
  const args = ['--no-alt-screen', '-s', 'read-only', '-a', 'on-request', '-c', 'model_provider="private_resume"', '-c', 'model="private-resume"',
    '-c', 'model_providers.private_resume.name="Private resume"', '-c', `model_providers.private_resume.base_url="http://127.0.0.1:${backend.address().port}/v1"`,
    '-c', 'model_providers.private_resume.wire_api="responses"', '-c', 'model_providers.private_resume.requires_openai_auth=false', '-c', 'model_providers.private_resume.supports_websockets=false',
    '-c', 'features.plugins=false', '-c', 'features.plugin_hooks=false', '-c', 'features.memories=false', '-c', 'features.chronicle=false', '-c', 'features.hooks=true', '-c', `projects={"${workspace}"={trust_level="trusted"}}`]
  client = new AgentMuxClient({ store }); Object.defineProperty(client.hookServer, 'port', { value: 0 }); await client.connect()
  await progress('initial-original-context')
  const initial = await client.createAgent({ agentSessionId: id, createOperationId: randomUUID(), providerId: 'codex', executorId: 'private-resume', commandOverride: executable, args,
    workspacePath: workspace, env: { CODEX_HOME: codexHome }, injectAgentMuxGuide: false, prompt: originalPrompt, cols: 120, rows: 40 })
  const identified = await until('real original native context', async () => { const value = await canonical(); return value?.nativeHandle?.transcriptPath && value.semanticStatus?.state === 'done' && value })
  originalNative = identified.nativeHandle
  assert.equal(originalRequests().length, 1); assert.equal(textOf(originalRequests()[0]), originalPrompt)
  assert.ok((await readFile(originalNative.transcriptPath, 'utf8')).includes(originalPrompt))
  report.originalNativeRun = await client.kernel.status(initial.run.runId)
  await client.kernel.stop(await client.kernel.prepareStop(initial.run.runId))
  await until('exact original Run ended', async () => (await client.kernel.status(initial.run.runId)).state.type !== 'running')
  const originalStart = client.kernel.startPrepared.bind(client.kernel)
  client.kernel.startPrepared = async () => { throw new Error('Private controlled Start outcome unknown before Native') }
  await assert.rejects(client.resumeAgent({ agentSessionId: id, operationId: 'private-unknown-start', prompt: unknownPrompt, commandOverride: executable, args, env: { CODEX_HOME: codexHome } }), { code: 'AGENT_RESUME_UNCONFIRMED' })
  client.kernel.startPrepared = originalStart
  await progress('unknown-original-prepared')
  const observe = client.kernel.observePreparedStartRetirement.bind(client.kernel)
  client.kernel.observePreparedStartRetirement = async () => { throw new Error('Private controlled pre-send resolution boundary') }
  const manualId = 'private-desktop-resolution'
  const admitted = await client.ensureAgentContinuity({ agentSessionId: id, expectedRun: initial.run, operationId: manualId, trigger: 'manual', commandOverride: executable, args, env: { CODEX_HOME: codexHome } })
  assert.equal(admitted.kind, 'pending'); assert.equal(admitted.continuity.resolution.outcome, 'pending')
  client.kernel.observePreparedStartRetirement = observe
  const oldKey = agentLifecycleOperationIdentity('resume', id, 'private-unknown-start')
  assert.equal((await client.kernel.observePreparedStartRetirement(oldKey, (await store.readLifecycleReservation(id)).preparedDispatch.runtime)).outcome, 'not_retired')
  await client.dispose(); client = null
  await progress('same-manual-durable-admission')
  await writeFile(join(workspace, 'neighbor.txt'), 'Original neighboring file remains visible\n')
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private resume' }], executors: { 'private-resume': { label: 'Private native', providerId: 'codex', command: executable, args, env: { CODEX_HOME: codexHome }, injectAgentMuxGuide: false } },
    workspaces: [{ id: workspaceId, name: 'Private resume', hostId: 'local', path: workspace, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(config))
  const tab = { id: tabId, workspaceId, titleRegionId: regionId, layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.7, first: { type: 'leaf', regionId }, second: { type: 'leaf', regionId: fileId } }, activeRegionId: regionId },
    regions: { [regionId]: { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: id }, [fileId]: { regionId: fileId, kind: 'file', workspaceId, path: 'neighbor.txt' } } }
  const workbench = { tabs: { [tabId]: tab }, layouts: { [workspaceId]: { root: { type: 'leaf', groupId: 'resume-group' }, groups: [{ id: 'resume-group', tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: 'resume-group' } } }
  const adapterPath = join(root, 'spatial-adapter.mjs')
  const built = await createRequire(require.resolve('vite/package.json'))('esbuild').build({ entryPoints: [join(desktop, 'src/renderer/src/lib/desktop-spatial-state.ts')], outfile: adapterPath, bundle: true, platform: 'node', format: 'esm', metafile: true,
    banner: { js: "import{createRequire as privateRequire}from'node:module';const require=privateRequire(import.meta.url);" }, alias: { '@agentmux/layout': join(repository, 'packages/layout/src/index.ts') }, logLevel: 'silent' })
  assert.ok(Object.keys(built.metafile.inputs).length && Object.keys(built.metafile.inputs).every(path => !/runtime-controller|public-rpc-service|electron/.test(path)))
  const { desktopSpatialGraph } = await import(pathToFileURL(adapterPath))
  const baseline = { id, kind: 'agent', hostId: 'local', workspacePath: workspace, providerId: 'codex', executorId: 'private-resume', control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: initial.run } }
  const spatial = new AgentMuxSpatialStateStore()
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, sessions: [baseline], ...workbench, spaceZoneBindings: {}, spatialRequests: {} }, []) })
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench', viewModes: { [id]: 'conversation' }, agentComposerDrafts: { [id]: draft }, agentSteerQueues: {},
    agentFocus: { execution: { sessionId: id, reference: { displayWorkspaceId: workspaceId, groupId: 'resume-group', tabId, regionId }, history: [{ sessionId: id, focusedAt: 1 }] }, pmo: { sessionId: null } } } }
  // Start the real current-source Node Host in this private namespace. Desktop uses
  // its original alive-endpoint route; platform service installation is not this task.
  await progress('private-real-node-host')
  const hostEntry = join(repository, 'apps/host/dist/index.js'), hostObservation = receiptPath + '.host-home.json'
  assert.equal(sha(await readFile(hostEntry)), build.compiled['apps/host/dist/index.js'])
  const observeHome = `import{homedir}from'node:os';import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(hostObservation)},JSON.stringify({pid:process.pid,home:process.env.HOME,nodeHome:homedir(),beforeHostImports:true}));`
  host = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(observeHome), hostEntry], { cwd: repository, detached: true,
    env: { ...process.env, AGENTMUX_AGENT_SESSION_STORE: store.path, AGENTMUX_HOST_CONFIGURATION_PATH: join(userData, 'agentmux.config.json'), AGENTMUX_MOTE_CONFIGURATION_PATH: join(userData, 'agentmux.config.json'), AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'mobile') },
    stdio: ['ignore', 'pipe', 'pipe'] })
  hostClosed = once(host, 'close'); host.probeBirth = await birth(host.pid); assert.ok(host.probeBirth)
  let hostOutput = '', hostError = ''
  host.stdout.on('data', bytes => { hostOutput += bytes }); host.stderr.on('data', bytes => { hostError += bytes })
  await until('actual private Host public endpoint', () => { if (host.exitCode !== null || host.signalCode !== null) throw new Error(hostError); return hostOutput.split('\n').find(line => line.startsWith('{') && JSON.parse(line).protocol === 'jsonrpc-2.0') })
  const home = JSON.parse(await readFile(hostObservation, 'utf8'))
  assert.deepEqual(home, { pid: host.pid, home: build.privateHome.path, nodeHome: build.privateHome.path, beforeHostImports: true })
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
  const hostIdentity = await rpc.call('runtime.owner.identity', {})
  assert.equal(hostIdentity.owner.processId, host.pid)
  await rpc.dispose(); rpc = null
  report.host = { pid: host.pid, birth: host.probeBirth, home, compiledSHA256: build.compiled['apps/host/dist/index.js'] }
  await progress('first-real-desktop')
  first = await launch('first', seed)
  const before = await surface(first.cdp); assert.ok(Number.isFinite(before.split) && before.split > 0 && before.split < 100); assert.equal(before.split, 70); assert.equal(before.draft, draft); assert.equal(before.editor, draft); assert.ok(before.regions.includes(regionId) && before.regions.includes(fileId))
  const action = `[data-workbench-region-id="${regionId}"] .session-recovery-actions > button:first-child`
  await until('actual enabled original recovery action', () => first.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(action)}) && !document.querySelector(${JSON.stringify(action)}).disabled)`))
  const pendingFrame = await first.cdp.call('Page.captureScreenshot', { format: 'png' }); await writeFile(receiptPath + '.pending.png', Buffer.from(pendingFrame.data, 'base64'))
  assert.equal(await first.cdp.evaluate(`(() => { const button=document.querySelector(${JSON.stringify(action)});button.click();return true })()`), true)
  await progress('actual-gui-retry')
  const restored = await until('same manual GUI intent completes actual Native handoff', async () => { const value = await canonical(); return value?.continuity?.operationId === manualId && value.continuity.kind === 'resumed' && value.run.runId !== initial.run.runId && value })
  assert.equal(restored.nativeHandle.sessionId, originalNative.sessionId); assert.equal(restored.continuity.resolution.outcome, 'retired')
  assert.equal(restored.continuity.resolution.originalCreationKey, oldKey); assert.equal(restored.continuity.resolution.continuedBy.operationId, manualId)
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
  hosted = await connectHostedAgentMux({ rpc })
  const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: id } }); assert.equal(inspected.session.run.runId, restored.run.runId)
  await until('actual Native context remains readable in original Region', () => first.cdp.evaluate(`document.querySelector('[data-workbench-region-id="${regionId}"]')?.innerText.includes('PRIVATE_ORIGINAL_CONTEXT')`))
  const current = await surface(first.cdp), graphBefore = (await spatial.read()).graph
  assert.equal(current.draft, draft); assert.equal(current.editor, draft); assert.deepEqual(current.regions, before.regions); assert.equal(current.split, before.split)
  const readyNative = await until('original Run terminal handshake acknowledged', async () => {
    const value = await hosted.statusAgent(id), handshake = value.session.terminalHandshake
    return handshake?.acknowledged && handshake.run.runId === restored.run.runId &&
      value.run.acceptedInputBytes >= handshake.inputByteRange.endByte && value
  })
  report.originalHandshake = readyNative.session.terminalHandshake
  nativeRun = readyNative.run; report.nativeAfterResume = nativeRun
  assert.ok(Number.isSafeInteger(nativeRun.acceptedInputBytes) && nativeRun.acceptedInputBytes >= 0)
  const nativeBirth = await birth(nativeRun.pid); assert.ok(nativeBirth)
  const transcript = await readFile(originalNative.transcriptPath, 'utf8'); assert.ok(!transcript.includes(unknownPrompt)); assert.equal(requests.filter(request => textOf(request).includes(unknownPrompt)).length, 0)
  await hosted.dispose(); hosted = null; await rpc.dispose(); rpc = null; await stopApp(first)
  await progress('second-real-desktop-no-seed')
  second = await launch('second')
  assert.notEqual(first.child.pid, second.child.pid)
  const after = await surface(second.cdp)
  assert.deepEqual(after, current); assert.deepEqual((await spatial.read()).graph, graphBefore)
  await until('restored original Native conversation visible', () => second.cdp.evaluate(`document.querySelector('[data-workbench-region-id="${regionId}"]')?.innerText.includes('PRIVATE_ORIGINAL_CONTEXT')`))
  const final = await canonical(); assert.equal(final.run.runId, restored.run.runId); assert.equal(final.nativeHandle.sessionId, originalNative.sessionId)
  assert.deepEqual(await birth(nativeRun.pid), nativeBirth)
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
  hosted = await connectHostedAgentMux({ rpc }); const afterRun = (await hosted.statusAgent(id)).run; report.nativeAfterRestart = afterRun
  assert.equal(afterRun.acceptedInputBytes, nativeRun.acceptedInputBytes); assert.equal(afterRun.pid, nativeRun.pid)
  assert.equal(originalRequests().length, 1, 'No automatic input/default reminder was sent to the original native Session on resolution or restart')
  for (const request of report.protocolRequests) {
    assert.ok(!request.user.includes(unknownPrompt), 'The old unknown input was not submitted to any native thread')
    if (request.metadata.session_id !== originalNative.sessionId) assert.equal(request.metadata.thread_source, 'thread_title', 'Every other protocol thread must be accounted for')
  }
  for (const [label, app] of [['restored', second]]) { const frame = await app.cdp.call('Page.captureScreenshot', { format: 'png' }); await writeFile(receiptPath + '.' + label + '.png', Buffer.from(frame.data, 'base64')) }
  await progress('explicit-new-input-proves-original-native-context')
  const probe = 'PRIVATE_NEW_EXPLICIT_CONTEXT_PROBE'
  const composer = `[data-workbench-region-id="${regionId}"] .composer [contenteditable="true"]`
  assert.equal(await second.cdp.evaluate(`(() => { const input=document.querySelector(${JSON.stringify(composer)});input.focus();return document.activeElement===input })()`), true)
  await second.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
  await second.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
  await second.cdp.call('Input.insertText', { text: probe })
  await until('new explicit Composer body', () => second.cdp.evaluate(`document.querySelector(${JSON.stringify(composer)})?.textContent===${JSON.stringify(probe)}`))
  const send = `[data-workbench-region-id="${regionId}"] .composer button[aria-label="Send"]`
  await until('new explicit Composer Send enabled', () => second.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(send)}) && !document.querySelector(${JSON.stringify(send)}).disabled)`))
  assert.equal(await second.cdp.evaluate(`(() => { document.querySelector(${JSON.stringify(send)}).click();return true })()`), true)
  const admission = await until('original Composer prompt receipt', async () => {
    const value = await canonical(), input = value?.promptCompletionAdmission
    return input?.acknowledged && input.intent?.prompt === probe && input.intent.admissionIntent?.kind === 'manual-actor' && value
  })
  assert.deepEqual(admission.run, final.run)
  report.explicitPromptReceipt = admission.promptCompletionAdmission
  const contextRequest = await until('new actual Native request contains both original context and new explicit input', () => {
    const found = originalRequests().filter(request => textOf(request).includes(probe))
    assert.ok(found.length <= 1, 'The explicit new probe is submitted only once')
    if (!found.length) return false
    assert.ok(JSON.stringify(found[0]).includes(originalPrompt)); assert.ok(!JSON.stringify(found[0]).includes(unknownPrompt))
    return found[0]
  })
  const observed = await until('new native record is in the original actual transcript', async () => {
    const value = await canonical(), bytes = await readFile(originalNative.transcriptPath, 'utf8')
    if (!bytes.includes(probe)) return false
    assert.equal(value.run.runId, final.run.runId); assert.equal(value.nativeHandle.sessionId, originalNative.sessionId)
    assert.ok(!bytes.includes(unknownPrompt))
    return { session: value, transcriptSHA256: sha(bytes), requestSHA256: sha(JSON.stringify(contextRequest)) }
  })
  assert.equal(originalRequests().length, 2)
  assert.equal(new Set(report.protocolRequests.filter(request => request.metadata.session_id === originalNative.sessionId).map(request => request.metadata.turn_id)).size, 2)
  Object.assign(report, { passed: true, preparedResume: { passed: true }, firstPid: first.child.pid, secondPid: second.child.pid,
    explicitProbe: { operationId: admission.promptCompletionAdmission.submissionId, originalNativeSessionId: originalNative.sessionId, run: observed.session.run,
      originalAndNewContextConfirmed: true, unknownInputAbsent: true, transcriptSHA256: observed.transcriptSHA256, requestSHA256: observed.requestSHA256 },
    original: { agentSessionId: id, run: initial.run, nativeSessionId: originalNative.sessionId, unknownOperationId: 'private-unknown-start' }, resolution: final.continuityOperations[manualId].resolution,
    before, after, graph: graphBefore, nativeRun, afterRun, nativeBirth, inputRequests: originalRequests().length, totalTransportRequests: requests.length,
    scope: 'Exact current-source private Desktop/Main/Renderer two processes; actual original Native conversation, original SID/Tab/Region/split/focus/draft, same manual GUI recovery; no user Session or terminal-reading claim.' })
} catch (error) { failure = error; report.failure = { name: error.name, code: error.code, detail: error.detail, message: error.message, stack: error.stack }; if (first) report.visible = await first.cdp.evaluate('document.body.innerText.slice(0,12000)').catch(() => null) }
finally {
  const errors = []
  try {
    const value = await canonical()
    report.crashLog = await readFile(join(userData, 'crash-log.ndjson'), 'utf8').catch(readError => ({ code: readError.code }))
    report.promptObservation = value && { run: value.run, continuity: value.continuity, operations: value.continuityOperations,
      promptCompletionAdmission: value.promptCompletionAdmission, terminalPromptDelivery: value.terminalPromptDelivery }
    if (originalNative?.transcriptPath) report.nativeProtocol = (await readFile(originalNative.transcriptPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(row => row.type === 'event_msg' || row.type === 'response_item' && row.payload?.role === 'user' || row.type === 'turn_context')
  } catch (error) { report.protocolObservationError = { code: error.code, detail: error.detail, message: error.message } }
  for (const child of [...children]) try { await stopApp(child) } catch (error) { errors.push(error.message) }
  try { await hosted?.dispose() } catch (error) { errors.push(error.message) }
  try { await rpc?.dispose() } catch (error) { errors.push(error.message) }
  try {
    if (await macosHostServiceRegistration(privateService)) {
      failure ??= new Error('The private Desktop unexpectedly installed a platform service instead of consuming its original live Node Host')
      await exec('/bin/launchctl', ['bootout', privateService.target])
      assert.equal(await macosHostServiceRegistration(privateService), null)
      cleanup.unexpectedPrivateRegistrationRemoved = privateService.label
    }
    assert.equal(await macosHostServiceRegistration(privateService), null); cleanup.privateServiceAbsent = true
  } catch (error) { errors.push(error.message) }
  try { if (host?.exitCode === null && host.signalCode === null) { assert.deepEqual(await birth(host.pid), host.probeBirth); host.kill('SIGTERM') } if (hostClosed) { await hostClosed; cleanup.privateHostExited = true } } catch (error) { errors.push(error.message) }
  try {
    if (!client) { client = new AgentMuxClient({ store }); Object.defineProperty(client.hookServer, 'port', { value: 0 }) }
    if (!client.kernel.isConnected()) await client.connect()
    const current = await canonical()
    if (current) { const run = await client.kernel.status(current.run.runId); if (run.state.type === 'running') await client.kernel.stop(await client.kernel.prepareStop(run.runId));
      if (run.pid) await until('exact private Native PID reaped', async () => !(await birth(run.pid)), 5000) }
    cleanup.exactNativeStopped = true
  } catch (error) { errors.push(error.message) }
  try { await client?.dispose() } catch (error) { errors.push(error.message) }
  try { backend.closeAllConnections(); await new Promise(done => backend.close(done)); failure ??= backendFailure } catch (error) { errors.push(error.message) }
  try { if (daemon?.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM'); await daemonClosed } catch (error) { errors.push(error.message) }
  try { await stopProbeProcesses(-1, root); assert.deepEqual(await listProbeProcesses(-1, root), []); cleanup.privateProcessesReaped = true } catch (error) { errors.push(error.message) }
  if (errors.length) { cleanup.errors = errors; failure ??= new Error(errors.join('; ')) }
  if (!failure) { await rm(root, { recursive: true }); cleanup.privateRootRemoved = true }
  if (failure) { const current = await canonical().catch(() => null); report.lastContinuity = current?.continuity; report.hostExit = host ? { code: host.exitCode, signal: host.signalCode } : null }
  if (failure && !report.failure) report.failure = { name: failure.name, message: failure.message, stack: failure.stack }
  report.cleanup = cleanup; report.passed = !failure; await writeFile(receiptPath, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, receiptPath, failure: failure?.message }))
if (failure) process.exitCode = 1
