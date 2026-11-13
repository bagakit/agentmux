import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Own only the current private product lifecycle, Inspector isolation and exact cleanup. */
export async function runPrivateA2aProductScenario(scenario) {
const root = process.env.AGENTMUX_A2A_PROOF_BUILD, evidence = resolve(process.argv[2])
assert.ok(root && dirname(root) === await realpath(tmpdir()) && basename(root).startsWith('amx-a2-') && basename(root).length > 'amx-a2-'.length)
assert.equal(await realpath(root), root)
assert.equal(process.env.HOME, join(root, 'home'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const runtime = join(root, 'runtime'), state = join(runtime, 'state'), userData = join(root, 'user-data'), workspace = join(root, 'workspace')
const nativeHome = join(root, 'codex-home'), controls = join(root, 'native-control'), storePath = join(userData, 'agent-sessions.json')
for (const path of [runtime, state, userData, workspace, nativeHome, controls, join(evidence, 'frames')]) await mkdir(path, { recursive: true, mode: 0o700 })
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'),
  AGENTMUX_SPATIAL_STATE_STORE: join(state, 'spatial-state.json'), AGENTMUX_A2A_PROOF_DIRECTORY: controls,
  AGENTMUX_DESKTOP_USER_DATA: userData, CODEX_HOME: nativeHome })
const initialStore = await stat(storePath).then(() => 'present', error => { if (error.code === 'ENOENT') return 'absent'; throw error })
assert.equal(initialStore, 'absent', 'The private product must start with no original Session store')
const execution = JSON.parse(await readFile(process.env.AGENTMUX_A2A_PROOF_EXECUTION, 'utf8'))
assert.ok(['source-build', 'prepared-artifact'].includes(execution.kind))
const coreRoot = execution.coreRoot
assert.ok(coreRoot.startsWith(root + '/'))
const core = await import(pathToFileURL(join(coreRoot, 'dist/index.js')).href)
const { connectAgentMuxRpc } = await import(pathToFileURL(join(coreRoot, 'dist/public-rpc-client.js')).href)
const endpoint = join(runtime, 'control.sock.desktop')
const executable = join(root, 'private-native-agent')
await writeFile(executable, '#!' + process.execPath + '\nawait import(' + JSON.stringify(pathToFileURL(join(root, 'apps/desktop/scripts/fixtures/a2a-inbox-product/native-agent.mjs')).href) + ');\n', { mode: 0o700 })
const originalConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private A2A proof' }],
  executors: { proof: { providerId: 'codex', label: 'Synthetic native protocol', command: executable, args: [],
    env: { HOME: process.env.HOME, CODEX_HOME: nativeHome, AGENTMUX_A2A_PROOF_DIRECTORY: controls }, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'proof-workspace', name: 'A2A private workspace', hostId: 'local', path: workspace, kind: 'folder' }],
  appearance: { appAppearance: 'dark', terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(originalConfig))
const children = new Set(), sessions = [], frames = [], cliCalls = []
const facts = { frames, chain: { cliCalls, readEffects: [] }, cleanup: { userRunTouched: false, processesReaped: false },
  homeIsolation: { privateHome: process.env.HOME, initialSessionStore: initialStore, launches: [] },
  syntheticNativeBoundary: 'Authenticated Codex 0.163 actor-shaped fixture, exact native UserMessage/client_id persisted by that actor. No model or vendor acceptance claim.' }
let client, daemon, rpc, failure
assert.equal(process.platform, 'darwin', 'This private native actor proof qualifies the current macOS product')
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function waitFor(label, read, budget = 25_000) {
  const end = Date.now() + budget
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(70) }
  throw new Error('Private A2A product proof timed out: ' + label)
}
const ended = child => child.exitCode !== null || child.signalCode !== null
async function stop(child, signal = 'SIGTERM') {
  if (ended(child)) return
  assert.ok(child.pid); process.kill(-child.pid, signal)
  await waitFor('exact private process exit', () => ended(child), 5000).catch(async () => {
    process.kill(-child.pid, 'SIGKILL'); await waitFor('exact private hard exit', () => ended(child), 5000)
  })
  children.delete(child)
}
async function credential(session) {
  return await waitFor('issued original Agent credential', async () => {
    try { const value = JSON.parse(await readFile(join(controls, session.agentSessionId + '.credential.json'), 'utf8')); return value.agentSessionId === session.agentSessionId ? value : null }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  })
}
async function cli(args, caller = null, expectSuccess = true) {
  const readOperation = args[0] === 'message' && args[1] === 'read' ? 'message.read'
    : args[0] === 'message' && args[1] === 'inbox' && args[2] === 'check' ? 'message.inbox.check' : null
  const readEffectsBefore = readOperation ? await inputEffects() : null
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  if (caller) { const identity = await credential(caller); env.AGENTMUX_AGENT_SESSION_ID = identity.agentSessionId; env.AGENTMUX_AGENT_CAPABILITY = identity.capability }
  else { delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY }
  const child = spawn(execution.cli.executable, [...execution.cli.argv, '--endpoint', 'unix:' + endpoint, ...args], { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child); let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  await waitFor('actual public CLI exit', () => ended(child), 35_000); children.delete(child)
  const lines = (stdout + '\n' + stderr).split('\n').filter(line => line.startsWith('{'))
  assert.ok(lines.length, 'The public CLI returns a structured operation receipt')
  const receipt = JSON.parse(lines.at(-1)); cliCalls.push({ invocation: execution.cli, args, code: child.exitCode, receipt, stderr })
  const diagnostic = JSON.stringify(receipt) + '\n' + stderr
  if (expectSuccess) { assert.equal(child.exitCode, 0, diagnostic); assert.equal(receipt.ok, true, diagnostic) }
  else if (expectSuccess === false) { assert.equal(child.exitCode, 1, diagnostic); assert.equal(receipt.ok, false, diagnostic) }
  else { assert.ok([0, 1].includes(child.exitCode), diagnostic); assert.equal(receipt.ok, child.exitCode === 0, diagnostic) }
  if (readOperation) {
    const after = await inputEffects(); assert.deepEqual(after, readEffectsBefore, readOperation + ' must produce no native input effect')
    facts.chain.readEffects.push({ operation: readOperation, args, before: readEffectsBefore, after })
  }
  return receipt
}
async function cdpConnect(url) {
  const ws = new WebSocket(url), pending = new Map(), pauses = []; let serial = 0
  await new Promise((done, fail) => { ws.addEventListener('open', done, { once: true }); ws.addEventListener('error', fail, { once: true }) })
  ws.addEventListener('message', ({ data }) => { const value = JSON.parse(data); if (value.method === 'Debugger.paused') pauses.push(value.params)
    const request = pending.get(value.id); if (!request) return
    pending.delete(value.id); clearTimeout(request.timer); value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result) })
  ws.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Original private CDP closed')) } pending.clear() })
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Private CDP timeout: ' + method)) }, 15_000)
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })) })
  return { call, pauses, close: () => ws.close(), evaluate: async expression => {
    const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  } }
}
async function launch(label) {
  const ready = join(root, 'ready-' + label + '.json')
  const env = { ...process.env, AGENTMUX_DESKTOP_READY_FILE: ready }; delete env.ELECTRON_RUN_AS_NODE
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY']) assert.equal(env[name], undefined)
  const child = spawn(execution.executable, ['--inspect-brk=0', ...execution.argv, '--remote-debugging-port=0', '--user-data-dir=' + userData], {
    cwd: execution.desktopRoot, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  children.add(child); let output = '', mainUrl, debuggerUrl
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-16_384)
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(output)?.[1]
    debuggerUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1] })
  const alive = () => { if (ended(child)) throw new Error('Private Desktop exited: ' + output) }
  const main = await cdpConnect(await waitFor('private Main inspector', () => { alive(); return mainUrl }))
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  // Electron resolves its home independently of ENV HOME. Use the existing
  // pre-constant inspector seam, after imports but before any home-backed workface.
  const mainPath = execution.mainEntry, lines = (await readFile(mainPath, 'utf8')).split('\n')
  const anchors = lines.flatMap((line, index) => line.includes('const SCRATCH_BACKING_PATH = ') && line.includes('app.getPath("home")') ? [index] : [])
  assert.equal(anchors.length, 1, 'Exactly one original compiled home boundary is required')
  const breakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor('private initial Main pause', () => main.pauses.shift())
  const homePauses = [paused]
  if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) {
    await main.call('Debugger.resume'); paused = await waitFor('private original home boundary', () => main.pauses.shift())
    homePauses.push(paused)
  }
  assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId), 'Only the original pre-home boundary permits isolation')
  const clipboardGuardPath = join(evidence, 'clipboard-guard-' + label + '.json')
  const windowGuardPath = join(evidence, 'window-guard-' + label + '.json')
  const homeExpression = `(()=>{
    app.setActivationPolicy('prohibited');
    const originalHome=app.getPath('home');
    app.setPath('home',${JSON.stringify(process.env.HOME)});app.setPath('userData',${JSON.stringify(userData)});
    const guard={reads:[],writes:[]};const save=()=>writeFileSync(${JSON.stringify(clipboardGuardPath)},JSON.stringify(guard));
    clipboard.writeText=(text,...rest)=>{guard.writes.push({text,rest});save();writeFileSync(${JSON.stringify(process.env.AGENTMUX_A2A_PROOF_CLIPBOARD)},JSON.stringify({text,port:'electron.clipboard.writeText'}))};
    clipboard.readText=(...args)=>{guard.reads.push(args);save();throw new Error('Unexpected clipboard read in the private product proof')};save();
    const geometry=windowConstructorGeometry;windowConstructorGeometry=(...args)=>({...geometry(...args),show:false,focusable:false});
    return{originalHome,home:app.getPath('home'),userData:app.getPath('userData'),activationPolicy:'prohibited'}
  })()`
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: homeExpression, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined)
  const { originalHome, home } = isolated.result.value
  assert.equal(home, process.env.HOME, 'Public Electron home must be private before the first home-dependent constant')
  assert.equal(isolated.result.value.userData, userData)
  const placements = lines.flatMap((line, index) => {
    const match = /^\s*workbenchWindow = ([A-Za-z_$][\w$]*);?$/u.exec(line)
    return match && lines.slice(Math.max(0, index - 20), index).some(line => line.includes('const ' + match[1] + ' = new BrowserWindow({'))
      ? [{ line: index, binding: match[1] }] : []
  })
  assert.equal(placements.length, 1, 'One original workbench assignment determines the private presentation target')
  const placement = placements[0]
  const windowBreakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: placement.line })
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await main.call('Debugger.resume')
  const windowPause = await waitFor('original private workbench construction', () => main.pauses.shift())
  assert.ok(windowPause.hitBreakpoints?.includes(windowBreakpoint.breakpointId))
  const windowExpression = `(()=>{const target=${placement.binding};const guard={id:target.id,focusable:target.isFocusable(),visibleBefore:target.isVisible(),focusedBefore:target.isFocused(),primary:app.hasSingleInstanceLock(),calls:[]};
    const save=()=>writeFileSync(${JSON.stringify(windowGuardPath)},JSON.stringify({...guard,visible:target.isVisible(),focused:target.isFocused()}));
    if(guard.focusable||guard.focusedBefore||!guard.primary)throw new Error('Private workbench isolation was not established');
    target.show=()=>{guard.calls.push('showInactive');target.showInactive();save()};target.focus=()=>{guard.calls.push('blocked-focus');save()};
    target.showInactive();save();return guard})()`
  const windowIsolation = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: windowPause.callFrames[0].callFrameId,
    expression: windowExpression, returnByValue: true })
  assert.equal(windowIsolation.exceptionDetails, undefined)
  assert.equal(windowIsolation.result.value.focusable, false); assert.equal(windowIsolation.result.value.primary, true)
  await main.call('Debugger.removeBreakpoint', { breakpointId: windowBreakpoint.breakpointId }); await main.call('Debugger.resume')
  await waitFor('ordinary private Desktop ready', async () => { if (ended(child)) throw new Error('Private Desktop exited: ' + output)
    try { return JSON.parse(await readFile(ready, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }, 40_000)
  const address = new URL(await waitFor('private Desktop debugger', () => debuggerUrl))
  const page = await waitFor('actual product Renderer', async () => (await (await fetch('http://' + address.host + '/json/list')).json()).find(value => value.type === 'page' && value.url.startsWith('file:')))
  const cdp = await cdpConnect(page.webSocketDebuggerUrl); await cdp.call('Runtime.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor('actual App hydration', () => cdp.evaluate("Boolean(document.querySelector('.app-shell'))"))
  const nativeHome = await cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, process.env.HOME, 'The production snapshot must confirm the actual private Electron home')
  const catalog = (await cli(['space', 'ls'])).result.catalog
  if (originalHome !== home) assert.ok(!JSON.stringify(catalog).includes(originalHome), 'The actual spatial catalog must not reference the original system home')
  assert.ok((await stat(endpoint)).isSocket(), 'The actual public Desktop endpoint must exist in the private runtime')
  const isolation = { label, pid: child.pid, originalHome, home, nativeHome, userData, catalog, endpoint,
    presentationOverlay: { mainSHA256: sha(await readFile(mainPath)), homeExpressionSHA256: sha(homeExpression), windowExpressionSHA256: sha(windowExpression),
      activationPolicy: isolated.result.value.activationPolicy, window: windowIsolation.result.value,
      clipboardGuardPath, windowGuardPath, windowBreakpoint: { id: windowBreakpoint.breakpointId, lineNumber: placement.line },
      windowPause: { hitBreakpoints: windowPause.hitBreakpoints, location: windowPause.callFrames[0].location } },
    breakpoint: { id: breakpoint.breakpointId, url: pathToFileURL(mainPath).href, lineNumber: anchors[0] },
    pauses: homePauses.map(event => ({ reason: event.reason, hitBreakpoints: event.hitBreakpoints,
      location: event.callFrames[0].location, url: event.callFrames[0].url })) }
  facts.homeIsolation.launches.push(isolation)
  return { child, main, cdp, isolation, origin: await cdp.evaluate('({url:location.href,origin:location.origin})'), seedControlsAbsent: true }
}
async function activate(cdp, expression) {
  const point = await cdp.evaluate(`(()=>{const element=${expression};if(!element)throw new Error('Missing original product action');const r=element.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Original product action is not visible');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
const region = regionId => `document.querySelector('[data-workbench-region-id="${regionId}"]')`
async function openMailbox(cdp, regionId, folder) {
  const base = region(regionId)
  if (!(await cdp.evaluate(`${base}.querySelector('.composer-mailbox')?.dataset.state==='open'`))) await activate(cdp, `${base}.querySelector('.composer__mailbox')`)
  await waitFor('native Mailbox popover', () => cdp.evaluate(`${base}.querySelector('.composer-mailbox')?.dataset.state==='open'`))
  await activate(cdp, `${base}.querySelector('[role="tab"][id$="-${folder}-tab"]')`)
  await waitFor('actual Mailbox selected page', () => cdp.evaluate(`${base}.querySelector('[role="tab"][id$="-${folder}-tab"]')?.getAttribute('aria-selected')==='true'`))
}
async function screenshot(app, name, width = 1440, height = 980) {
  await app.cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(160)
  const value = await app.cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const bytes = Buffer.from(value.data, 'base64'), path = join(evidence, 'frames', name + '.png'); await writeFile(path, bytes)
  const observed = await app.cdp.evaluate(`({title:document.title,appearance:document.documentElement.dataset.appearance,theme:document.documentElement.dataset.theme,regions:[...document.querySelectorAll('[data-workbench-region-id]')].filter(el=>el.getClientRects().length).map(el=>el.dataset.workbenchRegionId),text:document.body.innerText.slice(0,8000)})`)
  frames.push({ name, path, sha256: sha(bytes), width, height, observed })
}
async function nativeRequests(session) { try { return (await readFile(join(controls, session.agentSessionId + '.requests.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
async function inputEffects() {
  return Object.fromEntries(await Promise.all(sessions.map(async session => [session.agentSessionId,
    (await nativeRequests(session)).filter(row => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(row.method) || typeof row.manualInput === 'string') ])))
}
try {
  daemon = spawn(join(coreRoot, 'vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'), ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], {
    detached: true, env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  children.add(daemon); let ready = ''; daemon.stdio[3].on('data', bytes => { ready += bytes }); daemon.stderr.resume()
  await waitFor('actual private ctxmux readiness', async () => ready.includes('\n') && (await stat(join(runtime, 'ctxmux.sock'))).isSocket())
  // The real Desktop starts the sole semantic Host. This worker is a public
  // Hosted consumer, so it cannot compete with that Host for Hook ownership.
  const first = await launch('first')
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: core.defaultAgentMuxControlSocketPath() } })
  client = await core.connectHostedAgentMux({ rpc, expectedStorePath: storePath })
  const owner = client.runtimeOwnerIdentity()
  assert.equal(owner.availability, 'connected'); assert.notEqual(owner.processId, process.pid)
  facts.semanticOwner = { workerPid: process.pid, owner, boundary: 'Public Hosted consumer of the original product Host; no worker-local semantic Core' }
  const executor = await client.configureHostExecutor({ executorId: 'proof', config: originalConfig.executors.proof })
  assert.equal(executor.runtimeId, owner.runtimeId); assert.equal(executor.executor.executorId, 'proof')
  facts.semanticOwner.executor = executor
  await scenario({ client, first, sessions, facts, coreRoot, executable, workspace, nativeHome, controls, cli, credential, waitFor, activate, region, openMailbox, screenshot, nativeRequests, inputEffects })
} catch (error) { failure = error; facts.error = { message: error.message, stack: error.stack } }
finally {
  if (client) {
    for (const session of sessions) { try { await client.stopAgent(session.agentSessionId, session.run) } catch (error) { facts.cleanup.stopError ??= error.message } }
    try { await client.dispose() } catch {}
  }
  try { await rpc?.dispose() } catch {}
  for (const child of [...children].reverse()) { try { await stop(child, 'SIGKILL') } catch (error) { facts.cleanup.processError ??= error.message } }
  for (const launch of facts.homeIsolation.launches) {
    try {
      const clipboard = JSON.parse(await readFile(launch.presentationOverlay.clipboardGuardPath, 'utf8'))
      assert.deepEqual(clipboard.reads, [], 'The private product never reads the user clipboard')
      launch.presentationOverlay.clipboard = clipboard
      launch.presentationOverlay.windowAfter = JSON.parse(await readFile(launch.presentationOverlay.windowGuardPath, 'utf8'))
      assert.equal(launch.presentationOverlay.windowAfter.focused, false)
    } catch (error) { failure ??= error; facts.error ??= { message: error.message, stack: error.stack } }
  }
  facts.cleanup.processesReaped = !facts.cleanup.stopError && !facts.cleanup.processError && [...children].every(ended)
  if (!facts.cleanup.processesReaped) { failure ??= new Error('Private A2A product process cleanup was not confirmed'); facts.error ??= { message: failure.message } }
  await writeFile(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2) + '\n')
}
if (failure) await new Promise(done => process.stderr.write(failure.stack + '\n', done))
// All original private children are stopped and facts are durable before ending this worker.
process.exit(failure ? 1 : 0)

}
