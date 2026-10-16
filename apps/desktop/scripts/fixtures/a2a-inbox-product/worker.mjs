import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const root = process.env.AGENTMUX_A2A_PROOF_BUILD, evidence = resolve(process.argv[2]), exec = promisify(execFile)
assert.ok(root?.startsWith('/private/tmp/amx-a2-') || root?.startsWith('/tmp/amx-a2-'))
assert.equal(process.env.HOME, join(root, 'home'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const runtime = join(root, 'runtime'), state = join(runtime, 'state'), userData = join(root, 'user-data'), workspace = join(root, 'workspace')
const nativeHome = join(root, 'codex-home'), controls = join(root, 'native-control'), storePath = join(userData, 'agent-sessions.json')
for (const path of [runtime, state, userData, workspace, nativeHome, controls, join(evidence, 'frames')]) await mkdir(path, { recursive: true, mode: 0o700 })
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'),
  AGENTMUX_SPATIAL_STATE_STORE: join(state, 'spatial-state.json'), AGENTMUX_A2A_PROOF_DIRECTORY: controls,
  AGENTMUX_DESKTOP_USER_DATA: userData, CODEX_HOME: nativeHome })
const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href)
const { connectAgentMuxRpc } = await import(pathToFileURL(join(root, 'packages/core/dist/public-rpc-client.js')).href)
const cliPath = join(root, 'packages/core/bin/amux'), endpoint = join(runtime, 'control.sock.desktop')
const executable = join(root, 'private-native-agent')
await writeFile(executable, '#!' + process.execPath + '\nawait import(' + JSON.stringify(pathToFileURL(join(root, 'apps/desktop/scripts/fixtures/a2a-inbox-product/native-agent.mjs')).href) + ');\n', { mode: 0o700 })
const originalConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private A2A proof' }],
  executors: { proof: { providerId: 'codex', label: 'Synthetic native protocol', command: executable, args: [],
    env: { HOME: process.env.HOME, CODEX_HOME: nativeHome, AGENTMUX_A2A_PROOF_DIRECTORY: controls }, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'proof-workspace', name: 'A2A private workspace', hostId: 'local', path: workspace, kind: 'folder' }],
  appearance: { appAppearance: 'dark', terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(originalConfig))
const children = new Set(), sessions = [], frames = [], cliCalls = []
const facts = { frames, chain: { scenarios: [], cliCalls, readEffects: [] }, mailbox: {}, restart: {}, cleanup: { userRunTouched: false, processesReaped: false },
  homeIsolation: { privateHome: process.env.HOME, launches: [] },
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
async function birth(pid) { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='])).stdout.trim() }
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
  const child = spawn(process.execPath, [cliPath, '--endpoint', 'unix:' + endpoint, ...args], { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child); let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  await waitFor('actual public CLI exit', () => ended(child), 35_000); children.delete(child)
  const lines = (stdout + '\n' + stderr).split('\n').filter(line => line.startsWith('{'))
  assert.ok(lines.length, 'The public CLI returns a structured operation receipt')
  const receipt = JSON.parse(lines.at(-1)); cliCalls.push({ args, code: child.exitCode, receipt, stderr })
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
async function focusReadingTarget(place, session) {
  const receipt = await cli(['space', 'focus', '--region', place.to.regionId, '--input', 'target', '--expect-session', session.agentSessionId])
  assert.equal(receipt.operation, 'space.focus')
  const { result } = receipt
  assert.equal(result.partial, false)
  assert.ok(['applied', 'unchanged'].includes(result.navigation.state))
  assert.equal(result.navigation.expectedAgentSessionId, session.agentSessionId)
  assert.equal(result.navigation.selection.space.regionId, place.to.regionId)
  assert.equal(result.navigation.selection.space.tabId, place.to.tabId)
  assert.equal(result.presentation.provenance, 'observed')
  assert.ok(['main-visible', 'window', 'floating'].includes(result.presentation.state))
  assert.equal(result.presentation.regionId, place.to.regionId); assert.equal(result.presentation.tabId, place.to.tabId)
  assert.equal(result.input.policy, 'target'); assert.equal(result.input.outcome, 'transferred')
  assert.equal(result.input.after.provenance, 'observed')
  assert.equal(result.input.after.regionId, place.to.regionId); assert.equal(result.input.after.tabId, place.to.tabId)
  assert.equal(result.input.after.sessionId, session.agentSessionId)
  assert.equal(result.input.after.connected, true); assert.equal(result.input.after.visible, true); assert.equal(result.input.after.inert, false)
  assert.equal(result.save.diskDurability, 'confirmed')
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
  const child = spawn(process.env.AGENTMUX_A2A_PROOF_ELECTRON, ['--inspect-brk=0', join(root, 'apps/desktop'), '--remote-debugging-port=0'], {
    cwd: join(root, 'apps/desktop'), env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  children.add(child); let output = '', mainUrl, debuggerUrl
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-16_384)
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(output)?.[1]
    debuggerUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1] })
  const alive = () => { if (ended(child)) throw new Error('Private Desktop exited: ' + output) }
  const main = await cdpConnect(await waitFor('private Main inspector', () => { alive(); return mainUrl }))
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  // Electron resolves its home independently of ENV HOME. Use the existing
  // pre-constant inspector seam, after imports but before any home-backed workface.
  const mainPath = join(root, 'apps/desktop/out/main/index.js'), lines = (await readFile(mainPath, 'utf8')).split('\n')
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
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: `(()=>{const originalHome=app.getPath('home');app.setPath('home',${JSON.stringify(process.env.HOME)});return{originalHome,home:app.getPath('home')}})()`, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined)
  const { originalHome, home } = isolated.result.value
  assert.equal(home, process.env.HOME, 'Public Electron home must be private before the first home-dependent constant')
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await main.call('Debugger.resume')
  await waitFor('ordinary private Desktop ready', async () => { if (ended(child)) throw new Error('Private Desktop exited: ' + output)
    try { return JSON.parse(await readFile(ready, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }, 40_000)
  const address = new URL(await waitFor('private Desktop debugger', () => debuggerUrl))
  const page = await waitFor('actual product Renderer', async () => (await (await fetch('http://' + address.host + '/json/list')).json()).find(value => value.type === 'page' && value.url.startsWith('file:')))
  const cdp = await cdpConnect(page.webSocketDebuggerUrl); await cdp.call('Runtime.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor('actual App hydration', () => cdp.evaluate("Boolean(document.querySelector('.app-shell'))"))
  const nativeHome = await cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, process.env.HOME, 'The production snapshot must confirm the actual private Electron home')
  const catalog = (await cli(['space', 'ls'])).result.catalog
  assert.ok(originalHome !== home && !JSON.stringify(catalog).includes(originalHome), 'The actual spatial catalog must not reference the original system home')
  const isolation = { label, pid: child.pid, originalHome, home, nativeHome, catalog,
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
async function snapshot(app, ids, messageIds) {
  const ui = await app.cdp.evaluate(`(()=>{const s=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;return{workbench:{tabs:s.tabs,layouts:s.layouts,agentFocus:{execution:{sessionId:s.agentFocus?.execution?.sessionId,reference:s.agentFocus?.execution?.reference},pmo:{sessionId:s.agentFocus?.pmo?.sessionId}},activeWorkspaceId:s.activeWorkspaceId,mainSurface:s.mainSurface},drafts:s.agentComposerDrafts,queue:s.agentSteerQueues}})()`)
  const runs = await client.listRuns(), runBirths = []
  for (const id of ids) { const original = sessions.find(session => session.agentSessionId === id), run = runs.find(run => run.runId === original.run.runId); assert.equal(run.state, 'running'); runBirths.push({ agentSessionId: id, runId: run.runId, pid: run.pid, birth: await birth(run.pid) }) }
  const messages = []
  for (const id of messageIds) messages.push((await cli(['message', 'read', '--host', 'local', '--message-id', id])).result.message)
  return { pid: app.child.pid, ...ui, runBirths, messages, seedControlsAbsent: app.seedControlsAbsent, origin: app.origin }
}
async function nativeRequests(session) { try { return (await readFile(join(controls, session.agentSessionId + '.requests.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
async function history(session) {
  const before = await inputEffects()
  const page = await client.readAgentSessionHistory({ hostId: 'local', agentSessionId: session.agentSessionId, source: 'native', kind: 'user-message', limit: 100 })
  const after = await inputEffects(); assert.deepEqual(after, before, 'The original native history read must produce no input effect')
  facts.chain.readEffects.push({ operation: 'nativeHistory', agentSessionId: session.agentSessionId, before, after })
  return page
}
async function conversationInput(session, messageId) {
  const before = await inputEffects()
  const page = await client.readAgentConversation({ hostId: 'local', agentSessionId: session.agentSessionId, limit: 100, maxBytes: 4 * 1024 * 1024 })
  const after = await inputEffects(); assert.deepEqual(after, before, 'The original Conversation read must produce no input effect')
  facts.chain.readEffects.push({ operation: 'conversation', agentSessionId: session.agentSessionId, before, after })
  assert.equal(page.window.complete, true); assert.equal(page.nextCursor, null)
  assert.ok(page.items.every(entry => entry.kind === 'item'), 'This bounded fixture produces complete source units')
  const units = page.items.map(entry => entry.item).filter(unit => unit.records.some(record => {
    const key = record.original.kind === 'native' ? record.original.item.conversation?.adoptedInput?.key : record.original.item.inputRef
    return key?.kind === 'message' && key.messageId === messageId && key.agentSessionId === session.agentSessionId && key.expectedRun.runId === session.run.runId
  }))
  return { page, units }
}
const inputRequests = rows => rows.filter(row => ['turn/start', 'turn/steer'].includes(row.method))
async function inputEffects() {
  return Object.fromEntries(await Promise.all(sessions.map(async session => [session.agentSessionId,
    (await nativeRequests(session)).filter(row => ['turn/start', 'turn/steer'].includes(row.method) || typeof row.manualInput === 'string') ])))
}
try {
  daemon = spawn(join(root, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'), ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], {
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
  for (const label of ['Author', 'Recipient', 'Other recipient']) {
    const session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'proof', providerId: 'codex', workspacePath: workspace,
      commandOverride: executable, env: { HOME: process.env.HOME, CODEX_HOME: nativeHome, AGENTMUX_A2A_PROOF_DIRECTORY: controls }, injectAgentMuxGuide: false, cols: 100, rows: 30 })
    sessions.push(session); await credential(session)
    await waitFor('actual native source bound', async () => (await client.refreshAgentSession(session.agentSessionId, session.run)).nativeHandle)
  }
  const [author, recipient, other] = sessions
  const catalog = first.isolation.catalog
  const zone = catalog.zones.find(zone => zone.workspaceId === 'proof-workspace'); assert.ok(zone, 'The private configured workspace has its actual Zone')
  const open = async session => (await cli(['agent', 'open', '--session', session.agentSessionId, '--zone', zone.zoneId, '--new-tab', '--focus'])).result
  const authorPlace = await open(author), recipientPlace = await open(recipient)
  assert.ok(authorPlace.to?.regionId && recipientPlace.to?.regionId)
  // Choose the existing Composer explicitly; it remains eligible across the view change.
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.composer [role="textbox"]')`)
  facts.chain.viewInput = await waitFor('original Recipient Composer owns the view-change input', async () => {
    const owner = await first.cdp.evaluate(`(()=>{const input=${region(recipientPlace.to.regionId)}.querySelector('.composer [role="textbox"]');return{active:document.activeElement===input,regionId:input.closest('[data-workbench-region-id]').dataset.workbenchRegionId,ownerKind:input.closest('.composer__editor')?'composer':'other'}})()`)
    return owner.active ? owner : null
  })
  assert.equal(facts.chain.viewInput.regionId, recipientPlace.to.regionId); assert.equal(facts.chain.viewInput.ownerKind, 'composer')
  await cli(['agent', 'view', '--session', recipient.agentSessionId, '--mode', 'activity'])
  const normalBody = 'A2A original review\n\nPlease inspect **the exact original**.\n\n```ts\nconst retained = "中🙂  exact";\n```\n\nNo expanded user permission.'
  const normalId = 'a2a-normal-' + randomUUID(), normalOperation = randomUUID()
  const sendArgs = ['agent', 'send', '--to-tab', recipientPlace.to.tabId, '--text', normalBody, '--operation-id', normalOperation, '--message-id', normalId]
  const normal = await cli(sendArgs, author)
  const readingEffectsBefore = await inputEffects()
  const original = (await cli(['message', 'read', '--host', 'local', '--message-id', normalId])).result.message
  assert.equal(original.envelope.senderSessionId, author.agentSessionId); assert.equal(original.envelope.recipientSessionId, recipient.agentSessionId); assert.equal(original.envelope.body, normalBody)
  await waitFor('native actor receives original input', async () => inputRequests(await nativeRequests(recipient)).some(row => row.params.input[0].text.includes(normalId)))
  const input = inputRequests(await nativeRequests(recipient)).filter(row => row.params.input[0].text.includes(normalId)); assert.equal(input.length, 1)
  assert.match(input[0].params.input[0].text, /<amux:a2a /); assert.match(input[0].params.input[0].text, /<reminder>/)
  const native = await history(recipient), adopted = await conversationInput(recipient, normalId)
  assert.equal(adopted.units.length, 1, 'One original input event coalesces captured and qualified native adoption')
  assert.deepEqual(adopted.units[0].event.author, { kind: 'agent', agentSessionId: author.agentSessionId })
  assert.ok(adopted.units[0].records.some(record => record.original.kind === 'native' && record.original.item.conversation?.adoptedInput?.key.messageId === normalId))
  await writeFile(join(evidence, 'native-original.json'), JSON.stringify(native, null, 2))
  await waitFor('actual Conversation adopts original body', () => first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('.activity-view')?.textContent.includes('the exact original') || ${region(recipientPlace.to.regionId)}.textContent.includes('the exact original')`))
  await screenshot(first, 'conversation-original')
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.log-turn__reminder summary')`)
  await screenshot(first, 'conversation-reminder-expanded')
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.log-turn__reminder summary')`)
  const batch = (await cli(['message', 'inbox', 'check', '--limit', '1'], recipient)).result
  assert.equal(batch.messages[0].envelope.messageId, normalId)
  await openMailbox(first.cdp, recipientPlace.to.regionId, 'inbox'); await screenshot(first, 'inbox-list')
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('[data-record-key="a2a:${normalId}"]')`)
  await waitFor('original Inbox body', () => first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail .log-turn__body')?.textContent.includes('the exact original')`))
  await screenshot(first, 'inbox-original'); await screenshot(first, 'inbox-original-narrow', 750, 900)
  const bodyCopy = await first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail .log-turn__body').textContent`)
  assert.ok(bodyCopy.includes('the exact original'))
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail [aria-label="Copy message"]')`)
  const clipboardPort = await waitFor('actual product OS clipboard port invocation', async () => { try { return JSON.parse(await readFile(process.env.AGENTMUX_A2A_PROOF_CLIPBOARD, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })
  assert.equal(clipboardPort.text, normalBody, 'Actual UI/preload/production IPC passes the exact original body to the controlled OS port')
  const copied = await first.cdp.evaluate(`(()=>{const detail=${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail');return detail.querySelector('.log-turn__actions')?.dataset.copyState})()`)
  assert.equal(copied, 'copied')
  const afterHumanRead = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result; assert.deepEqual(afterHumanRead, batch)
  await openMailbox(first.cdp, recipientPlace.to.regionId, 'user')
  await waitFor('original recipient input observations settled', () => first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]')?.getAttribute('aria-busy')==='false'`))
  const recipientUserPage = await first.cdp.evaluate(`(()=>{const page=${region(recipientPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]');return{agentSessionId:${JSON.stringify(recipient.agentSessionId)},text:page.textContent,keys:[...page.querySelectorAll('[data-record-key]')].map(row=>row.dataset.recordKey)}})()`)
  facts.mailbox.recipientUserPage = recipientUserPage
  assert.ok(!recipientUserPage.text.includes('A2A original review'), 'The receiving Agent User Messages must exclude its accepted A2A original')
  assert.ok(!recipientUserPage.keys.some(key => key.includes(normalId)))
  await screenshot(first, 'recipient-user-messages-no-a2a')
  await focusReadingTarget(authorPlace, author)
  await openMailbox(first.cdp, authorPlace.to.regionId, 'outbox'); await screenshot(first, 'outbox-list')
  await activate(first.cdp, `${region(authorPlace.to.regionId)}.querySelector('[data-record-key="a2a:${normalId}"]')`)
  await waitFor('original Outbox body', () => first.cdp.evaluate(`${region(authorPlace.to.regionId)}.querySelector('.composer-mailbox__detail .log-turn__body')?.textContent.includes('the exact original')`))
  await screenshot(first, 'outbox-original')
  const readingEffectsAfter = await inputEffects(); assert.deepEqual(readingEffectsAfter, readingEffectsBefore, 'Original reading, check, Copy and both A2A pages must produce no native input effect')
  // Local CLI ingress has a durable original but no authenticated human or Agent author.
  const localId = 'local-cli-original-' + randomUUID(), localBody = 'Local CLI original · Keep unattributed input separate from A2A'
  const localReceipt = await cli(['agent', 'send', '--to-session', author.agentSessionId, '--text', localBody, '--message-id', localId, '--operation-id', randomUUID()])
  const localReadingEffectsBefore = await inputEffects()
  const localOriginal = (await cli(['message', 'read', '--host', 'local', '--message-id', localId])).result.message
  assert.equal(localOriginal.envelope.sender.kind, 'human'); assert.equal(localOriginal.envelope.senderSessionId, null)
  await openMailbox(first.cdp, authorPlace.to.regionId, 'inbox')
  await waitFor('actual A2A Inbox completed empty observation', () => first.cdp.evaluate(`${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-inbox"]')?.textContent.includes('No A2A messages received')`))
  const inbox = await first.cdp.evaluate(`(()=>{const page=${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-inbox"]');return{agentSessionId:${JSON.stringify(author.agentSessionId)},text:page.textContent,keys:[...page.querySelectorAll('[data-record-key]')].map(row=>row.dataset.recordKey)}})()`)
  assert.ok(!inbox.text.includes(localBody), 'A durable local CLI original is outside the Agent-to-Agent Inbox')
  assert.ok(!inbox.keys.some(key => key.includes(localId)))
  await openMailbox(first.cdp, authorPlace.to.regionId, 'user')
  await waitFor('actual unattributed CLI input in User Messages', () => first.cdp.evaluate(`(()=>{const page=${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]');return [...(page?.querySelectorAll('[data-input-mailbox-key]')??[])].some(row=>row.querySelector('.input-history__excerpt')?.textContent===${JSON.stringify(localBody)})})()`))
  const userPage = await first.cdp.evaluate(`(()=>{const page=${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]');const row=[...page.querySelectorAll('[data-input-mailbox-key]')].find(row=>row.querySelector('.input-history__excerpt')?.textContent===${JSON.stringify(localBody)});return{text:page.textContent,keys:[...page.querySelectorAll('[data-record-key]')].map(row=>row.dataset.recordKey),authorLabel:row?.querySelector('[data-mailbox-author]')?.textContent}})()`)
  assert.equal(userPage.authorLabel, 'Author unknown', 'The local CLI transport kind does not authenticate a person')
  assert.ok(!userPage.text.includes('A2A original review'), 'The same accepted A2A original does not become another User Message')
  assert.ok(!userPage.keys.some(key => key.includes(normalId)))
  await screenshot(first, 'user-messages')
  const localReadingEffectsAfter = await inputEffects(); assert.deepEqual(localReadingEffectsAfter, localReadingEffectsBefore, 'Reading an unattributed original must produce no native input effect')
  facts.chain.localCli = { cli: localReceipt, original: localOriginal, body: localBody, inbox, userPage }
  facts.mailbox = { pages: ['inbox', 'outbox', 'user'], copyExact: copied === 'copied', humanReadDidNotAcknowledgeAgent: JSON.stringify(afterHumanRead) === JSON.stringify(batch), recipientUserPage, clipboardPort, clipboardBoundary: 'Only electron.clipboard.writeText is controlled; no user clipboard was read or written', beforeBatch: batch, afterHumanRead, bodyText: bodyCopy,
    readingEffects: { before: readingEffectsBefore, after: readingEffectsAfter }, localReadingEffects: { before: localReadingEffectsBefore, after: localReadingEffectsAfter } }
  facts.chain.scenarios.push({ kind: 'normal', cliMessageId: normalId, journalMessageId: original.envelope.messageId, body: normalBody, original, cli: normal })
  facts.chain.normal = { nativeInputCount: input.length, conversationCount: adopted.units.length, conversation: adopted.page, authorSessionId: adopted.units[0].event.author.agentSessionId, senderSessionId: author.agentSessionId, nativeInput: input[0], history: native }
  // Explicit native rejection and missing native receipt originate at the actor, never journal writes.
  for (const [kind, effect] of [['failed', 'reject'], ['unknown', 'lose-receipt']]) {
    await writeFile(join(controls, recipient.agentSessionId + '.control.json'), JSON.stringify({ effect }))
    const id = 'a2a-' + kind + '-' + randomUUID(), body = `Original ${kind} input ${id}`
    const args = ['agent', 'send', '--to-session', recipient.agentSessionId, '--text', body, '--message-id', id, '--operation-id', randomUUID()]
    const receipt = await cli(args, author, null)
    const claim = await client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: recipient.agentSessionId, expectedRun: recipient.run, messageId: id })
    assert.equal(claim.admission.native.outcome, kind === 'failed' ? 'not-applied' : 'unknown')
    const record = (await cli(['message', 'read', '--host', 'local', '--message-id', id])).result.message
    facts.chain.scenarios.push({ kind, cliMessageId: id, journalMessageId: record.envelope.messageId, body, original: record, cli: receipt, claim, args })
  }
  const initialOperation = randomUUID(), initialBody = 'Original first A2A message before its recipient Run is selected'
  const initialOpened = (await cli(['agent', 'open', '--executor', 'proof', '--zone', zone.zoneId, '--new-tab', '--prompt', initialBody, '--operation-id', initialOperation], author)).result
  const initialSession = (await client.readAgentSessions()).find(session => session.creation?.createOperationId === initialOperation)
  assert.ok(initialSession?.run); sessions.push(initialSession)
  const initialOriginal = (await cli(['message', 'read', '--host', 'local', '--operation-id', initialOperation])).result.message
  assert.equal(initialOriginal.envelope.recipientRunId, null); assert.equal(initialOriginal.envelope.senderSessionId, author.agentSessionId); assert.equal(initialOriginal.envelope.body, initialBody)
  assert.equal(initialOriginal.envelope.recipientSessionId, initialSession.agentSessionId)
  facts.chain.initial = { cli: initialOpened, original: initialOriginal, body: initialBody, runAtLaunch: initialSession.run }
  await writeFile(join(controls, other.agentSessionId + '.control.json'), JSON.stringify({ effect: 'unavailable' }))
  const unsubmittedId = 'a2a-unsubmitted-' + randomUUID(), unsubmittedBody = 'Original never adopted body ' + unsubmittedId
  const unsubmittedReceipt = await cli(['agent', 'send', '--to-session', other.agentSessionId, '--text', unsubmittedBody, '--message-id', unsubmittedId, '--operation-id', randomUUID()], author, null)
  const unsubmitted = (await cli(['message', 'read', '--host', 'local', '--message-id', unsubmittedId])).result.message
  assert.equal(inputRequests(await nativeRequests(other)).filter(row => row.params.input?.some(part => part.text.includes(unsubmittedId))).length, 0)
  const absentHistory = await history(other); assert.ok(!JSON.stringify(absentHistory).includes(unsubmittedBody))
  facts.chain.scenarios.push({ kind: 'unsubmitted', cliMessageId: unsubmittedId, journalMessageId: unsubmitted.envelope.messageId, body: unsubmittedBody, original: unsubmitted, cli: unsubmittedReceipt })
  const absentConversation = await conversationInput(other, unsubmittedId); assert.equal(absentConversation.units.length, 0)
  facts.chain.unsubmitted = { conversationCount: absentConversation.units.length, conversation: absentConversation.page, history: absentHistory }
  // The production CAS configuration owner and theme runtime supply both appearances.
  const originalAppearance = await first.cdp.evaluate('(async()=>(await window.agentmux.config.get()).appearance)()')
  const originalRendered = await first.cdp.evaluate('({appearance:document.documentElement.dataset.appearance,theme:document.documentElement.dataset.theme})')
  facts.mailbox.themeMatrix = { originalAppearance, originalRendered, transitions: [] }
  const themeEffectsBefore = await inputEffects()
  try {
    for (const appearance of ['dark', 'light']) {
      const committed = await first.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();return(await window.agentmux.config.save({...expected,appearance:{...expected.appearance,appAppearance:${JSON.stringify(appearance)}}},expected)).appearance})()`)
      assert.equal(committed.appAppearance, appearance)
      const rendered = await waitFor('production theme committed to the original document', () => first.cdp.evaluate(`(()=>{const root=document.documentElement;return root.dataset.appearance===${JSON.stringify(appearance)}&&!('themeChanging'in root.dataset)?{appearance:root.dataset.appearance,theme:root.dataset.theme,background:getComputedStyle(root).getPropertyValue('--bg').trim()}:null})()`))
      facts.mailbox.themeMatrix.transitions.push({ requested: appearance, committed, rendered })
      for (const [folder, place, session] of [['inbox', recipientPlace, recipient], ['outbox', authorPlace, author], ['user', authorPlace, author]]) {
        await focusReadingTarget(place, session); await openMailbox(first.cdp, place.to.regionId, folder)
        await screenshot(first, `mailbox-${folder}-${appearance}-wide`, 1440, 980)
        await screenshot(first, `mailbox-${folder}-${appearance}-narrow`, 750, 900)
      }
    }
  } finally {
    const restored = await first.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();return(await window.agentmux.config.save({...expected,appearance:${JSON.stringify(originalAppearance)}},expected)).appearance})()`)
    assert.deepEqual(restored, originalAppearance)
    facts.mailbox.themeMatrix.restoredAppearance = restored
    await waitFor('original production appearance restored', () => first.cdp.evaluate(`document.documentElement.dataset.appearance===${JSON.stringify(originalRendered.appearance)}`))
  }
  const themeEffectsAfter = await inputEffects(); assert.deepEqual(themeEffectsAfter, themeEffectsBefore, 'Theme changes and all twelve original page captures must produce no native input effect')
  facts.mailbox.themeMatrix.effects = { before: themeEffectsBefore, after: themeEffectsAfter }
  const routeEffectsBefore = await inputEffects()
  const addition = (await cli(['agent', 'open', '--session', other.agentSessionId, '--region', recipientPlace.to.regionId, '--split', 'right', '--focus'])).result
  assert.equal(addition.to.tabId, recipientPlace.to.tabId)
  const pinnedRetry = await cli(sendArgs, author); assert.equal(pinnedRetry.result.envelope.recipientSessionId, recipient.agentSessionId)
  assert.equal(inputRequests(await nativeRequests(recipient)).filter(row => row.params.input?.some(part => part.text.includes(normalId))).length, 1)
  assert.equal(inputRequests(await nativeRequests(other)).filter(row => row.params.input?.some(part => part.text.includes(normalId))).length, 0)
  facts.restart.routeChange = { subject: { kind: 'tab', tabId: recipientPlace.to.tabId }, first: recipientPlace, added: addition, operation: 'agent.open --session C --region B --split right', retry: pinnedRetry, boundary: 'Original Tab gained a second participant; no occupied Region was replaced' }
  facts.restart.reboundOccupantInputCount = 0
  const wrongRun = await cli(['message', 'inbox', 'ack', '--generation', String(batch.generation), '--reader-run', author.run.runId], recipient, false)
  assert.equal(wrongRun.error.code, 'MESSAGE_ACK_GENERATION_STALE')
  facts.restart.wrongRunAckRefused = true
  facts.restart.ackReceipts = { wrongRun, wrongReaderRun: author.run }
  const routeEffectsAfter = await inputEffects(); assert.deepEqual(routeEffectsAfter, routeEffectsBefore, 'A presentation split, same-MID replay and rejected ack must produce no native input effect')
  facts.restart.routeEffects = { before: routeEffectsBefore, after: routeEffectsAfter }
  const workfaceEffectsBefore = await inputEffects()
  await focusReadingTarget(recipientPlace, recipient); await openMailbox(first.cdp, recipientPlace.to.regionId, 'inbox')
  await screenshot(first, 'inbox-states'); await screenshot(first, 'inbox-states-narrow', 750, 900)
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.composer__mailbox')`)
  await focusReadingTarget(authorPlace, author)
  const queueEditor = `${region(authorPlace.to.regionId)}.querySelector('.composer [role="textbox"]')`
  await activate(first.cdp, queueEditor); await first.cdp.call('Input.insertText', { text: 'Original queue-only intent retained without execution' })
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const queued = await waitFor('actual queue-only Enter retained', () => first.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.agentSteerQueues[${JSON.stringify(author.agentSessionId)}]?.find(entry=>entry.text==='Original queue-only intent retained without execution')`))
  assert.equal(queued.execution, undefined); assert.equal(queued.promptCondition, null)
  await openMailbox(first.cdp, authorPlace.to.regionId, 'user'); await screenshot(first, 'user-original-and-pending')
  await activate(first.cdp, `${region(authorPlace.to.regionId)}.querySelector('.composer__mailbox')`)
  await focusReadingTarget(recipientPlace, recipient)
  const editor = `${region(recipientPlace.to.regionId)}.querySelector('.composer [role="textbox"]')`
  await activate(first.cdp, editor); await first.cdp.call('Input.insertText', { text: 'Original unsent draft retained across actual Electron restart 中🙂' })
  await waitFor('original edited draft persisted by product', () => first.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.agentComposerDrafts[${JSON.stringify(recipient.agentSessionId)}]?.includes('Original unsent draft')`))
  const messageIds = [...facts.chain.scenarios.map(item => item.cliMessageId), initialOriginal.envelope.messageId, localId], ids = sessions.map(session => session.agentSessionId)
  const before = await snapshot(first, ids, messageIds); facts.restart.first = before
  for (const run of before.runBirths) { const group = run.birth.split(/\s+/)[1]; assert.notEqual(Number(group), first.child.pid, 'Healthy Run stays outside the killed Electron group') }
  const inputBefore = await inputEffects(); assert.deepEqual(inputBefore, workfaceEffectsBefore, 'Inbox state reading, queue-only Enter, retained draft and snapshot must produce no native input effect')
  facts.restart.workfaceEditingEffects = { before: workfaceEffectsBefore, after: inputBefore }
  first.main.close(); first.cdp.close(); await stop(first.child, 'SIGKILL'); facts.restart.first.signal = first.child.signalCode
  const second = await launch('second')
  await waitFor('original Region and draft restored without a seed', () => second.cdp.evaluate(`${region(recipientPlace.to.regionId)}?.querySelector('.composer [role="textbox"]')?.textContent.includes('Original unsent draft')`))
  const after = await snapshot(second, ids, messageIds); facts.restart.second = after
  assert.deepEqual(after.workbench, before.workbench); assert.deepEqual(after.drafts, before.drafts); assert.deepEqual(after.queue, Object.fromEntries(Object.entries(before.queue).map(([id, entries]) => [id, entries.map(({ preparationWait, ...entry }) => ({ ...entry, status: entry.status === 'restoring' ? 'restoring' : 'deferred', awaitingExplicitSend: true }))])))
  assert.deepEqual(after.runBirths, before.runBirths); assert.deepEqual(after.messages, before.messages)
  await openMailbox(second.cdp, recipientPlace.to.regionId, 'inbox'); await screenshot(second, 'restored-original-inbox')
  const replay = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result; assert.deepEqual(replay, batch)
  const acknowledged = (await cli(['message', 'inbox', 'ack', '--generation', String(batch.generation), '--reader-run', batch.readerRun.runId], recipient)).result
  assert.deepEqual(acknowledged.acknowledgedMessageIds, [normalId])
  const nextBatch = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result
  const nextIds = facts.chain.scenarios.filter(item => ['failed', 'unknown'].includes(item.kind)).map(item => item.journalMessageId).sort()
  assert.deepEqual(nextBatch.messages.map(item => item.envelope.messageId).sort(), nextIds); assert.ok(nextBatch.messages.length > 0)
  assert.ok(nextBatch.generation > batch.generation); assert.deepEqual(nextBatch.readerRun, batch.readerRun)
  const lateGeneration = await cli(['message', 'inbox', 'ack', '--generation', String(batch.generation), '--reader-run', batch.readerRun.runId], recipient, false)
  assert.equal(lateGeneration.error.code, 'MESSAGE_ACK_GENERATION_STALE')
  const retainedNextBatch = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result
  assert.deepEqual(retainedNextBatch, nextBatch, 'A genuine late ack cannot advance the next original batch')
  facts.restart.staleGenerationRefused = true; facts.restart.ackReceipts.lateGeneration = lateGeneration
  facts.restart.agentConsumption = { originalBatch: batch, replay, acknowledged, nextBatch, retainedNextBatch }
  const unknownCase = facts.chain.scenarios.find(item => item.kind === 'unknown')
  const unknownRetry = await cli(unknownCase.args, author, null)
  assert.equal(unknownCase.cli.ok, false); assert.equal(unknownCase.cli.error.code, 'AGENT_PROMPT_INPUT_UNCONFIRMED')
  assert.equal(unknownRetry.ok, false); assert.equal(unknownRetry.error.code, unknownCase.cli.error.code, 'Retry must report the original unknown input, never a new conflict or authority failure')
  assert.equal(unknownRetry.operation, unknownCase.cli.operation); assert.equal(unknownRetry.operationId, unknownCase.cli.operationId)
  const retainedUnknown = await client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: recipient.agentSessionId, expectedRun: recipient.run, messageId: unknownCase.journalMessageId })
  assert.deepEqual(retainedUnknown, unknownCase.claim, 'A lost native receipt retry keeps the exact original claim')
  const unknownNativeCount = inputRequests(await nativeRequests(recipient)).filter(row => row.params.input.some(part => part.text.includes(unknownCase.journalMessageId))).length
  assert.equal(unknownNativeCount, 1)
  facts.restart.unknownReplay = { originalMessageId: unknownCase.journalMessageId, firstReceipt: unknownCase.cli, retry: unknownRetry, retainedClaim: retainedUnknown, nativeInputCount: unknownNativeCount }
  const inputAfter = await inputEffects()
  assert.deepEqual(inputAfter, inputBefore); facts.restart.replayCount = 0
  facts.restart.inputEffects = { before: inputBefore, after: inputAfter }
  const marker = 'private-manual-after-restart-' + randomUUID()
  const metadata = (await client.readAgentSessions()).find(session => session.agentSessionId === recipient.agentSessionId)
  const originalNativePath = metadata.nativeHandle.transcriptPath
  assert.ok(originalNativePath.startsWith(nativeHome + '/'))
  await rename(originalNativePath, originalNativePath + '.proof-unavailable')
  try {
    const observationEffectsBefore = await inputEffects()
    const observed = await cli(['agent', 'history', '--host', 'local', '--session', recipient.agentSessionId, '--source', 'native', '--kind', 'user-message'], null, false)
    facts.restart.observationFailure = observed
    assert.deepEqual((await cli(['message', 'read', '--host', 'local', '--message-id', normalId])).result.message, original)
    const observationEffectsAfter = await inputEffects(); assert.deepEqual(observationEffectsAfter, observationEffectsBefore, 'A failed native observation and original message read must produce no input effect')
    facts.restart.observationReadEffects = { before: observationEffectsBefore, after: observationEffectsAfter }
    await client.writeAgent({ agentSessionId: recipient.agentSessionId, expectedRun: recipient.run, data: marker + '\r', source: 'user' })
  } finally { await rename(originalNativePath + '.proof-unavailable', originalNativePath) }
  await waitFor('same healthy Run accepts manual input', async () => (await nativeRequests(recipient)).some(row => row.manualInput?.includes(marker)))
  facts.restart.healthyManualInput = true
  second.main.close(); second.cdp.close(); await stop(second.child, 'SIGKILL')
} catch (error) { failure = error; facts.error = { message: error.message, stack: error.stack } }
finally {
  if (client) {
    for (const session of sessions) { try { await client.stopAgent(session.agentSessionId, session.run) } catch (error) { facts.cleanup.stopError ??= error.message } }
    try { await client.dispose() } catch {}
  }
  try { await rpc?.dispose() } catch {}
  for (const child of [...children].reverse()) { try { await stop(child, 'SIGKILL') } catch (error) { facts.cleanup.processError ??= error.message } }
  facts.cleanup.processesReaped = !facts.cleanup.stopError && !facts.cleanup.processError && [...children].every(ended)
  if (!facts.cleanup.processesReaped) { failure ??= new Error('Private A2A product process cleanup was not confirmed'); facts.error ??= { message: failure.message } }
  await writeFile(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2) + '\n')
}
if (failure) await new Promise(done => process.stderr.write(failure.stack + '\n', done))
// All original private children are stopped and facts are durable before ending this worker.
process.exit(failure ? 1 : 0)
