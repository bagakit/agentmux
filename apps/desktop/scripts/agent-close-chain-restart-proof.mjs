import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const buildPath = process.env.AGENTMUX_CLOSE_CHAIN_BUILD_RECEIPT
assert.ok(buildPath, 'Use verify-agent-close-chain.mjs to capture and build the private product')
const build = JSON.parse(await readFile(buildPath, 'utf8')), repository = resolve(import.meta.dirname, '../../..')
assert.equal(build.privateRoot, repository); assert.equal(process.env.HOME, build.privateHome.path); assert.equal(homedir(), build.privateHome.path)
const receiptPath = process.argv.find(a => a.startsWith('--receipt-path='))?.slice('--receipt-path='.length)
assert.ok(receiptPath && !receiptPath.startsWith(repository + '/'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), exec = promisify(execFile), require = createRequire(import.meta.url)
await writeFile(join(dirname(buildPath), 'worker-home.json'), JSON.stringify({ pid: process.pid, privateRoot: repository,
  sourceCommit: build.sourceCommit, home: process.env.HOME, nodeHome: homedir(), beforeCoreImports: true,
  workerSHA256: sha(await readFile(import.meta.filename)) }, null, 2))
const privateRoot = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp/' : tmpdir(), 'amx-close-')))
const runtime = join(privateRoot, 'r'), state = join(privateRoot, 's'), userData = join(privateRoot, 'user'), workspace = join(privateRoot, 'work')
for (const path of [runtime, state, userData, workspace]) await mkdir(path, { recursive: true, mode: 0o700 })
for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) delete process.env[name]
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_SPATIAL_STATE_STORE: join(state, 'spatial-state.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'),
  AGENTMUX_DESKTOP_USER_DATA: userData, CODEX_HOME: join(privateRoot, 'codex') })
delete process.env.ELECTRON_RUN_AS_NODE
const { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, defineAgentProvider, connectAgentMuxRpc } = await import('../../../packages/core/dist/index.js')
const { macosHostServiceAddress, macosHostServiceRegistration } = await import('../../host/dist/macos-service.js')
const privateService = macosHostServiceAddress(join(runtime, 'control.sock'))
assert.equal(await macosHostServiceRegistration(privateService), null, 'This new private namespace must have no platform service')
const desktop = join(repository, 'apps/desktop'), storePath = join(userData, 'agent-sessions.json')
const provider = defineAgentProvider({ catalog: { id: 'codex', label: 'Private close protocol', executable: process.execPath,
  expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
  hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
  buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, _prompt, args) => [...args, id], hook: { rules: [] } })
const report = { schema: 'agentmux.agent-close-chain-restart.v1', passed: false, agentCloseChain: { passed: false },
  userRunTouched: false, buildReceipt: buildPath, phases: [], scenarios: [], appStarts: [], cli: [],
  boundary: 'Complete production Desktop Main/Renderer, original Core File Store, real ctxmux Run and public CLI. The private Provider protocol is controlled. The prepared resume freezes its real request, then its Runtime Start dispatch is deliberately withheld before CONTROL_UNAVAILABLE; this scene does not claim applied Start or lost acknowledgement after dispatch. T-011 separately proves an actually retained Run. No user Runtime or native conversation is accessed.' }
const children = new Set(), sessions = new Map(), daemons = new Set()
let client, daemon, first, second, host, failure, daemonOrdinal = 0
const delay = ms => new Promise(done => setTimeout(done, ms)), save = async () => writeFile(receiptPath, JSON.stringify(report, null, 2))
async function phase(name) { report.phases.push(name); await save(); console.log('agent_close_phase=' + name) }
async function until(label, read, budget = 30000) {
  const end = Date.now() + budget
  do { const value = await read(); if (value) return value; await delay(50) } while (Date.now() < end)
  throw new Error('Private Agent close scene did not settle: ' + label)
}
async function launchDaemon() {
  const source = join(repository, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd')
  const executable = join(privateRoot, 'ctxmuxd-' + ++daemonOrdinal)
  await copyFile(source, executable)
  assert.equal(sha(await readFile(source)), sha(await readFile(executable)), 'Private execution copy preserves exact vendored bytes')
  report.daemon = { sha256: sha(await readFile(source)), sourceCommit: JSON.parse(await readFile(join(dirname(dirname(source)), 'manifest.json'), 'utf8')).source.commit }
  const child = spawn(executable, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  daemons.add(child); child.closed = once(child, 'close'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  await Promise.race([once(child.stdio[3], 'data'), child.closed.then(() => { throw new Error('Private daemon exited before readiness: ' + stderr) })])
  return child
}
async function reader() {
  const result = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath), providers: [provider] })
  Object.defineProperty(result.hookServer, 'port', { value: 0 }); await result.connect(); return result
}
async function create(label, ended = false) {
  const session = await client.createAgent({ createOperationId: 'close-fixture-' + label, executorId: 'private-close', providerId: provider.id,
    commandOverride: process.execPath, args: ['-e', ended ? 'process.exit(0)' : "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('PRIVATE_INPUT:'+d));console.log('PRIVATE_CLOSE_READY');setInterval(()=>{},1000)"],
    workspacePath: workspace, injectAgentMuxGuide: false, cols: 100, rows: 30 })
  sessions.set(label, session)
  await until(label + ' actual Run', async () => (await client.listRuns()).find(run => run.runId === session.run.runId && run.state === (ended ? 'exited' : 'running')))
  return session
}
async function cdpConnect(url) {
  const socket = new WebSocket(url), pending = new Map(); let serial = 0
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  socket.addEventListener('message', ({ data }) => { const message = JSON.parse(data), request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); message.error ? request.fail(new Error(message.error.message)) : request.done(message.result) })
  const call = (method, params = {}) => new Promise((done, fail) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error('Private CDP timeout: ' + method)) }, 12000); pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params })) })
  return { call, close: () => socket.close(), async evaluate(expression) { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value } }
}
async function birth(pid) {
  try { const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart=']); const fields = stdout.trim().split(/\s+/); return fields.length >= 7 ? { pid: +fields[0], group: +fields[1], born: fields.slice(2).join(' ') } : null }
  catch (error) { if (error.code === 1) return null; throw error }
}
async function launch(label, seed) {
  const ready = join(privateRoot, label + '-ready.json'), env = { ...process.env, AGENTMUX_DESKTOP_READY_FILE: ready,
    AGENTMUX_DESKTOP_RECOVERY_REPORT: join(privateRoot, label + '-report.json'), ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed) } : {}) }
  assert.equal(sha(await readFile(join(desktop, 'out/main/index.js'))), build.compiled['apps/desktop/out/main/index.js'])
  const child = spawn(require('electron'), [desktop, '--remote-debugging-port=0'], { cwd: desktop, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child); child.closed = once(child, 'close'); child.birth = await birth(child.pid)
  let stdout = '', stderr = '', url; child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16384) }); child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); url ??= /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1] })
  const alive = () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private Desktop exited: ' + stderr) }
  const endpoint = new URL(await until(label + ' debugger', () => { alive(); return url }))
  const target = await until(label + ' Renderer', async () => (await (await fetch('http://' + endpoint.host + '/json/list')).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const browserCdp = await cdpConnect(url)
  const rendererPids = (await browserCdp.call('SystemInfo.getProcessInfo')).processInfo.filter(process => process.type === 'renderer').map(process => process.id)
  browserCdp.close()
  assert.ok(rendererPids.length > 0 && rendererPids.every(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== child.pid))
  const cdp = await cdpConnect(target.webSocketDebuggerUrl)
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  const mainReady = await until(label + ' Main ready', async () => { alive(); try { return JSON.parse(await readFile(ready, 'utf8')) } catch { return false } })
  report.appStarts.push({ label, pid: child.pid, rendererPids, targetId: target.id, birth: child.birth, originalURL: target.url,
    mainReady: { source: 'original Main readiness file', value: mainReady }, compiledMainSHA256: build.compiled['apps/desktop/out/main/index.js'] })
  child.diagnostics = () => ({ stdout, stderr }); return { child, cdp }
}
async function stopApp(value) {
  if (!value) return
  value.cdp.close(); const child = value.child
  if (child.exitCode === null && child.signalCode === null) { assert.deepEqual(await birth(child.pid), child.birth); assert.equal(child.birth.group, child.pid); process.kill(-child.pid, 'SIGKILL') }
  await child.closed; children.delete(child)
}
async function click(cdp, expression) {
  const point = await cdp.evaluate(`(() => { const element=${expression}; if(!element)throw new Error('Actual control unavailable');element.scrollIntoView({block:'nearest',inline:'nearest'});const r=element.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!element.contains(document.elementFromPoint(x,y)))throw new Error('Actual control is covered');return{x,y} })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function actualFacts(cdp) {
  return cdp.evaluate(`(async () => {const original=await window.agentmux.ui.readWorkbenchState();if(original===null)throw new Error('Original Main workbench state is unavailable');const state=JSON.parse(original).state;return{source:'original Main workbench user-state owner',drafts:state.agentComposerDrafts,focus:state.agentFocus,activeWorkspaceId:state.activeWorkspaceId,tabs:Object.keys(state.tabs??{}).sort(),text:document.body.innerText}})()`)
}
async function cli(args) {
  const { stdout, stderr } = await exec(process.execPath, [join(repository, 'packages/core/bin/amux'), ...args], { env: { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(runtime, 'control.sock') }, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
  const result = JSON.parse(stdout); assert.equal(result.ok, true, JSON.stringify(result)); report.cli.push({ args, result: result.result, stderr }); return result.result
}
async function inspectClosed(label) {
  const session = sessions.get(label)
  const result = await until(label + ' retirement receipt', async () => { const value = await cli(['agent', 'stop', 'inspect', '--session', session.agentSessionId, '--run', session.run.runId]); return value.phase === 'retired' ? value : null })
  assert.equal(result.agentSessionId, session.agentSessionId)
  assert.ok(result.stages?.some(stage => stage.stage === 'retire-commit' && stage.outcome === 'ok'), JSON.stringify(result))
  report.scenarios.push({ label, session: session.agentSessionId, run: session.run, result }); await save()
}
async function closeRegionAgent(label) {
  const cdp = first.cdp, region = label + '-region'
  await click(cdp, `document.querySelector('button.workbench-tab[data-workbench-tab-id="${label}-tab"]')`)
  await until(label + ' Region', () => cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${region}"]'))`))
  const direct = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-workbench-region-id="${region}"] button')).some(el=>el.textContent.trim()==='Close Agent')`)
  if (direct) await click(cdp, `Array.from(document.querySelectorAll('[data-workbench-region-id="${region}"] button')).find(el=>el.textContent.trim()==='Close Agent')`)
  else {
    await click(cdp, `document.querySelector('[data-workbench-region-id="${region}"] .agent-region-header__more')`)
    await until(label + ' Agent menu', () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(el=>['Stop Agent','Close Agent'].includes(el.textContent.trim()))`))
    await click(cdp, `Array.from(document.querySelectorAll('[role="menuitem"]')).find(el=>['Stop Agent','Close Agent'].includes(el.textContent.trim()))`)
  }
  await until(label + ' Close confirmation', () => cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] [data-confirm-label="Close Agent"]'))`))
  await click(cdp, `document.querySelector('[role="dialog"] [data-confirm-label="Close Agent"]')`)
  await inspectClosed(label)
}
try {
  await phase('private-runtime')
  daemon = await launchDaemon(); client = await reader()
  await create('interrupted')
  await client.dispose(); client = null
  daemon.kill('SIGKILL'); await daemon.closed; daemons.delete(daemon)
  daemon = await launchDaemon(); client = await reader()
  const interrupted = sessions.get('interrupted')
  const interruption = await until('authoritative daemon restart Run', async () => (await client.listRuns()).find(run => run.runId === interrupted.run.runId && run.state === 'interrupted'))
  assert.equal(interruption.interruptionReason, 'daemon_restart')
  report.interruptedRun = interruption
  await create('healthy'); await create('browser'); await create('prepared', true)
  // Seed only this controlled Provider's retained native identity; the Session and ended Run
  // were created above by real Core/Runtime. No native-model or conversation-adoption claim.
  const original = await client.store.readMetadata(sessions.get('prepared').agentSessionId)
  await client.store.compareAndSwap(original, { ...original, nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'private-close-conversation' } })
  await client.dispose(); client = null
  await phase('prepared-resume-original-owner')
  // A separate Node process freezes the original resume, withholds Start dispatch and actually exits.
  const childSource = join(privateRoot, 'prepare-resume.mjs'), preparedReport = join(privateRoot, 'prepared.json')
  await writeFile(childSource, `import{writeFile}from'node:fs/promises';import{AgentMuxClient,AgentMuxFileAgentSessionStore,defineAgentProvider,AgentMuxError}from ${JSON.stringify(pathToFileURL(join(repository, 'packages/core/dist/index.js')).href)};
const provider=defineAgentProvider({catalog:${JSON.stringify(provider.catalog)},buildArgs:(_p,a)=>[...a],buildResumeArgs:(id,_path,_p,a)=>[...a,id],hook:{rules:[]}});
const store=new AgentMuxFileAgentSessionStore(${JSON.stringify(storePath)}),client=new AgentMuxClient({store,providers:[provider]});Object.defineProperty(client.hookServer,'port',{value:0});await client.connect();client.kernel.startPrepared=async()=>{throw new AgentMuxError('Private Start dispatch deliberately withheld','CONTROL_UNAVAILABLE')};let error;try{await client.resumeAgent({agentSessionId:${JSON.stringify(sessions.get('prepared').agentSessionId)},operationId:'private-held-resume',prompt:'Private held recovery task',commandOverride:process.execPath,args:['-e','setInterval(()=>{},1000)']})}catch(e){error={code:e.code,message:e.message}};const held=await store.readLifecycleReservation(${JSON.stringify(sessions.get('prepared').agentSessionId)});await writeFile(${JSON.stringify(preparedReport)},JSON.stringify({pid:process.pid,error,held,dispatch:'withheld-before-runtime-call'}));await client.dispose();`)
  const prepared = await exec(process.execPath, [childSource], { env: process.env, timeout: 30000 })
  report.preparedOwner = JSON.parse(await readFile(preparedReport, 'utf8'))
  assert.equal(report.preparedOwner.error?.code, 'AGENT_RESUME_UNCONFIRMED'); assert.equal(report.preparedOwner.held?.kind, 'resume'); assert.ok(report.preparedOwner.held.preparedSession)
  assert.equal(await birth(report.preparedOwner.pid), null, 'The original resume owner really ended')
  await phase('durable-original-workface')
  await writeFile(join(workspace, 'retained.txt'), 'Original other workface stays visible\n')
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private close Runtime' }], executors: { 'private-close': { label: 'Private close Agent', providerId: 'codex', command: process.execPath, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'close-workspace', name: 'Private close workspace', hostId: 'local', path: workspace, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(config))
  const tabs = {}, groupId = 'close-group', workspaceId = 'close-workspace', order = ['healthy-tab', 'interrupted-tab', 'prepared-tab', 'browser-tab']
  for (const label of ['healthy', 'interrupted', 'prepared']) {
    const regionId = label + '-region'
    tabs[label + '-tab'] = { id: label + '-tab', workspaceId, titleRegionId: regionId, layout: { root: { type: 'leaf', regionId }, activeRegionId: regionId }, regions: { [regionId]: { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions.get(label).agentSessionId } } }
  }
  tabs['healthy-tab'].regions['file-region'] = { regionId: 'file-region', kind: 'file', workspaceId, path: 'retained.txt' }
  tabs['healthy-tab'].layout.root = { type: 'split', direction: 'horizontal', ratio: .63, first: { type: 'leaf', regionId: 'healthy-region' }, second: { type: 'leaf', regionId: 'file-region' } }
  const browserAgent = sessions.get('browser')
  tabs['browser-tab'] = { id: 'browser-tab', workspaceId, titleRegionId: 'browser-region', layout: { root: { type: 'leaf', regionId: 'browser-region' }, activeRegionId: 'browser-region' }, regions: { 'browser-region': { regionId: 'browser-region', kind: 'browser', browserId: 'private-close-browser', workspaceId,
    url: 'about:blank', title: 'Private retained page', mode: 'normal', viewport: 'responsive', agent: { hostId: browserAgent.hostId, agentSessionId: browserAgent.agentSessionId } } } }
  const layouts = { [workspaceId]: { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: order, activeTabId: 'healthy-tab', recentTabIds: order }], activeGroupId: groupId } }
  const seedAdapter = join(privateRoot, 'spatial-seed.mjs'), esbuild = createRequire(require.resolve('vite/package.json'))('esbuild')
  const seedBuild = await esbuild.build({ entryPoints: [join(desktop, 'src/renderer/src/lib/desktop-spatial-state.ts')], outfile: seedAdapter,
    bundle: true, platform: 'node', format: 'esm', metafile: true,
    banner: { js: "import {createRequire as privateRequire} from 'node:module'; const require=privateRequire(import.meta.url);" },
    alias: { '@agentmux/layout': join(repository, 'packages/layout/src/index.ts') }, logLevel: 'silent' })
  const seedInputs = Object.keys(seedBuild.metafile.inputs)
  assert.ok(seedInputs.length > 0 && seedInputs.every(path => !path.includes('runtime-controller') && !path.includes('public-rpc-service') && !path.includes('/electron/')), 'The original spatial seed adapter stays pure')
  const snapshots = [...sessions.values()].map(session => ({ id: session.agentSessionId, kind: 'agent', hostId: session.hostId, workspacePath: session.workspacePath, providerId: session.providerId, executorId: session.executorId, control: { kind: 'agent', hostId: session.hostId, agentSessionId: session.agentSessionId, run: session.run } }))
  const graph = (await import(pathToFileURL(seedAdapter).href)).desktopSpatialGraph({ config, sessions: snapshots, tabs, layouts, spaceZoneBindings: {}, spatialRequests: {} }, [])
  await new AgentMuxSpatialStateStore().commit({ expectedRevision: 0, graph })
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench', agentComposerDrafts: Object.fromEntries([...sessions].map(([label, session]) => [session.agentSessionId, 'Original unsent ' + label + ' draft'])) } }
  // Reuse the full product's existing live-Node-Host route. Platform-service
  // installation is a separate product capability and is outside this close proof.
  await phase('original-live-node-host')
  const hostEntry = join(repository, 'apps/host/dist/index.js')
  assert.equal(sha(await readFile(hostEntry)), build.compiled['apps/host/dist/index.js'])
  host = spawn(process.execPath, [hostEntry], { cwd: repository, detached: true, env: { ...process.env,
    AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_HOST_CONFIGURATION_PATH: join(userData, 'agentmux.config.json'),
    AGENTMUX_MOTE_CONFIGURATION_PATH: join(userData, 'agentmux.config.json'), AGENTMUX_CONNECTOR_DIRECTORY: join(privateRoot, 'connectors'),
    AGENTMUX_MOBILE_BUILD_DIRECTORY: join(privateRoot, 'mobile') }, stdio: ['ignore', 'pipe', 'pipe'] })
  host.closed = once(host, 'close'); host.birth = await birth(host.pid)
  let hostOutput = '', hostError = ''
  host.stdout.on('data', bytes => { hostOutput = (hostOutput + bytes).slice(-65536) }); host.stderr.on('data', bytes => { hostError = (hostError + bytes).slice(-65536) })
  await until('original private Node Host endpoint', () => {
    if (host.exitCode !== null || host.signalCode !== null) throw new Error('Private Node Host exited: ' + hostError)
    return hostOutput.split('\n').slice(0, -1).some(line => { try { return JSON.parse(line).protocol === 'jsonrpc-2.0' } catch { return false } })
  })
  const originalRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
  try {
    const identity = await originalRpc.call('runtime.owner.identity', {})
    assert.equal(identity.owner.processId, host.pid)
    report.host = { pid: host.pid, birth: host.birth, identity, compiledSHA256: build.compiled['apps/host/dist/index.js'] }
  } finally { await originalRpc.dispose() }
  await phase('actual-ui-close')
  first = await launch('first', seed)
  await until('original healthy and file Regions', () => first.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="healthy-region"]')&&document.querySelector('[data-workbench-region-id="file-region"]'))`))
  await closeRegionAgent('interrupted')
  await closeRegionAgent('prepared')
  assert.ok(report.scenarios.find(one => one.label === 'prepared').result.supersededResume, 'Prepared resume must actually be taken over by this Stop')
  await click(first.cdp, `document.querySelector('button.workbench-tab[data-workbench-tab-id="browser-tab"]')`)
  await until('actual Browser linked Agent', () => first.cdp.evaluate(`Boolean(document.querySelector('button[aria-label^="Browser activity:"]'))`))
  await click(first.cdp, `document.querySelector('button[aria-label^="Browser activity:"]')`)
  await until('Browser Agent Stop menu', () => first.cdp.evaluate(`Array.from(document.querySelectorAll('.browser-operation-menu [role="menuitem"]')).some(el=>el.textContent.trim()==='Stop Agent')`))
  await click(first.cdp, `Array.from(document.querySelectorAll('.browser-operation-menu [role="menuitem"]')).find(el=>el.textContent.trim()==='Stop Agent')`)
  await until('Browser Agent stop confirmation', () => first.cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] [data-confirm-label="Stop Agent"]'))`))
  await click(first.cdp, `document.querySelector('[role="dialog"] [data-confirm-label="Stop Agent"]')`)
  await inspectClosed('browser')
  await until('Browser relation released by Core retirement', async () => (await cli(['browser', 'targets'])).targets.some(target => target.id === 'private-close-browser' && target.control?.agent === null))
  await click(first.cdp, `document.querySelector('button.workbench-tab[data-workbench-tab-id="healthy-tab"]')`)
  await click(first.cdp, `document.querySelector('[data-workbench-region-id="healthy-region"] .agent-region-header strong')`)
  const before = await until('original healthy focus saved by its owner', async () => {
    const facts = await actualFacts(first.cdp)
    return facts.focus?.execution?.sessionId === sessions.get('healthy').agentSessionId ? facts : null
  })
  report.beforeRestart = before
  report.spatialBeforeRestart = await new AgentMuxSpatialStateStore().readForLayout()
  await phase('same-data-real-app-restart')
  await stopApp(first); first = null
  second = await launch('second')
  assert.notEqual(report.appStarts[0].pid, report.appStarts[1].pid)
  assert.ok(report.appStarts[1].rendererPids.every(pid => !report.appStarts[0].rendererPids.includes(pid)))
  await until('same healthy and file workface after restart', () => second.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="healthy-region"]')&&document.querySelector('[data-workbench-region-id="file-region"]'))`))
  const after = await actualFacts(second.cdp); report.afterRestart = after
  assert.equal(after.drafts[sessions.get('healthy').agentSessionId], before.drafts[sessions.get('healthy').agentSessionId])
  assert.equal(after.focus.execution.sessionId, before.focus.execution.sessionId)
  assert.deepEqual(after.focus.execution.reference, before.focus.execution.reference)
  assert.equal(after.focus.pmo.sessionId, before.focus.pmo.sessionId)
  assert.equal(after.activeWorkspaceId, before.activeWorkspaceId)
  const persisted = await new AgentMuxSpatialStateStore().readForLayout()
  report.spatialAfterRestart = persisted
  const healthyLayout = persisted.graph.tabLayouts['healthy-tab']
  assert.equal(healthyLayout.root.ratio, .63)
  assert.deepEqual(healthyLayout, report.spatialBeforeRestart.graph.tabLayouts['healthy-tab'])
  for (const label of ['interrupted', 'prepared', 'browser']) await inspectClosed(label)
  const targets = await cli(['browser', 'targets'])
  assert.ok(targets.targets.some(target => target.id === 'private-close-browser' && target.control?.agent === null))
  client = await reader()
  assert.equal((await client.listRuns()).find(run => run.runId === sessions.get('healthy').run.runId)?.state, 'running')
  assert.equal((await client.readAgentSessions()).some(session => ['interrupted', 'prepared', 'browser'].some(label => sessions.get(label).agentSessionId === session.agentSessionId)), false)
  report.agentCloseChain.passed = true; report.passed = true
} catch (error) {
  failure = error; report.failure = { message: error.message, stack: error.stack, first: first?.child.diagnostics(), second: second?.child.diagnostics() }
  try { report.failureSurface = await actualFacts((second ?? first).cdp) } catch (observation) { report.failureSurface = { unavailable: observation.message } }
  try { report.failureSpatial = await new AgentMuxSpatialStateStore().readForLayout() } catch (observation) { report.failureSpatial = { unavailable: observation.message } }
  report.failureSessions = []
  const store = new AgentMuxFileAgentSessionStore(storePath)
  for (const [label, session] of sessions) {
    try {
      const [current, retired, reservation] = await Promise.all([store.readMetadata(session.agentSessionId), store.readRetiredAgentSession(session.agentSessionId), store.readLifecycleReservation(session.agentSessionId)])
      report.failureSessions.push({ label, agentSessionId: session.agentSessionId, originalRun: session.run, currentRun: current?.run,
        retired: retired ? { observedAt: retired.observedAt, run: retired.run, stop: retired.stop } : null,
        reservation: reservation ? { kind: reservation.kind, operationId: reservation.operationId, ownerPid: reservation.ownerPid, expectedRun: reservation.expectedRun } : null })
    } catch (observation) { report.failureSessions.push({ label, unavailable: observation.message }) }
  }
  process.exitCode = 1
} finally {
  const errors = []
  for (const app of [first, second]) try { await stopApp(app) } catch (error) { errors.push(error.message) }
  try {
    if (host) {
      if (host.exitCode === null && host.signalCode === null) { assert.deepEqual(await birth(host.pid), host.birth); assert.equal(host.birth.group, host.pid); process.kill(-host.pid, 'SIGTERM') }
      await host.closed
    }
    if (await macosHostServiceRegistration(privateService)) {
      await exec('/bin/launchctl', ['bootout', privateService.target])
      errors.push('This private proof unexpectedly installed a platform service; its exact private registration was removed.')
    }
    assert.equal(await macosHostServiceRegistration(privateService), null)
  } catch (error) { errors.push(error.message) }
  try {
    client ??= await reader()
    for (const session of sessions.values()) {
      const current = await client.readAgentSession(session.agentSessionId)
      if (current) await client.stopAgent(current.agentSessionId, current.run, { operationId: 'private-close-cleanup-' + current.agentSessionId })
    }
    await client.dispose()
  } catch (error) { errors.push(error.message) }
  for (const child of daemons) try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await child.closed } catch (error) { errors.push(error.message) }
  report.cleanup = { errors, privateRoot, removed: false }
  if (!errors.length) { await rm(privateRoot, { recursive: true, force: true }); report.cleanup.removed = true }
  else { report.passed = false; report.agentCloseChain.passed = false; process.exitCode = 1 }
  await save()
}
if (failure) console.error(failure)
console.log(JSON.stringify({ passed: report.passed, receiptPath, scenarios: report.scenarios.length, cleanup: report.cleanup }))
