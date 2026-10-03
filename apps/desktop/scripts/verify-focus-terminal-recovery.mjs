import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Ordinary compiled Main/preload/Renderer and public Core/SDK owners. Recovery is
// triggered from its real Region button; private home is isolated before startup.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const nameAuthorityMode = process.env.AGENTMUX_VERIFY_NAME_AUTHORITY === '1'
const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-focus-recovery-")), home = join(root, 'home'), userData = join(root, 'user-data')
const runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), workspaceId = 'private-focus-recovery'
const socketPath = join(runtimeDirectory, 'ctxmux.sock'), deadline = Date.now() + 180000
const fixtureEnvironment = { HOME: home, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: join(home, 'codex') }
const environmentBefore = new Map(Object.keys(fixtureEnvironment).map(key => [key, process.env[key]]))
const cwdEnv = { ...process.env, ...fixtureEnvironment }
// An Agent hosted by Electron can inherit its CLI's Node mode. This probe must
// launch an ordinary GUI; otherwise ESM 'electron' fails before the home guard.
delete cwdEnv.ELECTRON_RUN_AS_NODE
for (const key of Object.keys(cwdEnv)) if (key.startsWith('AGENTMUX_') && !Object.hasOwn(fixtureEnvironment, key)) delete cwdEnv[key]
Object.assign(process.env, fixtureEnvironment)
const { CtxmuxClient } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
const { connectLocalAgentMux, AgentMuxFileAgentSessionStore, connectAgentMuxRpc } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const receipt = { schema: 'agentmux.focus-terminal-recovery.v1', passed: false, temporaryRoot: root, userRuntimeTouched: false,
  startedAt: Date.now(), limitations: ['Private ordinary compiled GUI processes; no installed-package qualification.',
    nameAuthorityMode ? 'Both private original Runs retain PID and input/output through ordinary GUI restart; new renderer terminals attach to them.'
      : 'Target Terminal recovery creates a new Run. Ordinary GUI restart creates a new xterm; no original target PTY continuity claim.'], cleanup: {} }
const children = new Set(), owners = new Map(), connections = new Set(), probes = []
let phase = 'prepare', failure, daemon, sdk, creator, active, agent, terminal
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 1500 })).stdout.trim() }
  catch (error) { if (error.code === 1) return ''; throw error }
}
async function own(pid) { assert.ok(pid > 1); const birth = await identity(pid); assert.ok(birth); owners.set(pid, birth) }
async function waitFor(label, read, budget = 25000, cleanup = false) {
  const end = cleanup ? Date.now() + budget : Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
  throw new Error(`Focus recovery gate timed out: ${label}`)
}
async function cdpConnect(url) {
  const socket = new WebSocket(url), pending = new Map(), pauses = []; let serial = 0
  const cdp = { pauses, close: () => socket.close() }; connections.add(cdp)
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Private CDP handshake timed out')), 12000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', error => { clearTimeout(timer); fail(error) }, { once: true })
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data); if (message.method === 'Debugger.paused') pauses.push(message.params)
    const request = pending.get(message.id); if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.fail(new Error(message.error.message)) : request.done(message.result)
  })
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error('Private CDP closed')) }; pending.clear() })
  const call = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timed out: ${method}`)) }, 12000)
    pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  Object.assign(cdp, { call, async evaluate(expression) {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
    return reply.result.value
  } }); return cdp
}
async function control(method, params = {}) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
  try { return await client.call(method, params) }
  finally { await client.dispose() }
}
async function observe() { return (await control('app.inspect')).observation }
function durableWorkbench(observation) {
  const { activeWorkspaceId, mainSurface, focus, layouts, tabs } = observation.workbench
  return { activeWorkspaceId, mainSurface, focus, layouts, tabs: tabs.map(tab => ({
    id: tab.id, workspaceId: tab.workspaceId, titleRegionId: tab.titleRegionId, layout: tab.layout,
    regions: tab.regions.map(region => region.kind === 'browser'
      ? { kind: region.kind, regionId: region.regionId, workspaceId: region.workspaceId, browserId: region.browserId, url: region.url }
      : region)
  })) }
}
async function launch(label) {
  phase = `launch-${label}`
  const child = spawn(require('electron'), ['--inspect-brk=0', join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, env: cwdEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  children.add(child); let spawnError, diagnostics = '', mainUrl, rendererUrl, main
  child.on('error', error => { spawnError = error }); child.stderr.on('data', bytes => {
    diagnostics = (diagnostics + bytes.toString()).slice(-16384)
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    if (diagnostics.includes('Waiting for the debugger to disconnect')) main?.close()
  })
  await own(child.pid)
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Private GUI exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  main = await cdpConnect(await waitFor('Main inspector', () => { alive(); return mainUrl }))
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  const mainPath = join(desktopRoot, 'out/main/index.js'), lines = (await readFile(mainPath, 'utf8')).split('\n')
  const anchors = lines.flatMap((line, index) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [index] : [])
  assert.equal(anchors.length, 1)
  const breakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor('initial Main pause', () => main.pauses.shift())
  if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) { await main.call('Debugger.resume'); paused = await waitFor('exact pre-home pause', () => main.pauses.shift()) }
  assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId))
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: `(() => { app.setPath('home',${JSON.stringify(home)}); return app.getPath('home') })()`, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined); assert.equal(isolated.result.value, home)
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await main.call('Debugger.resume')
  const probe = { child, main, label, diagnostics: () => diagnostics }; probes.push(probe); active = probe
  const endpoint = new URL(await waitFor('Renderer debugger', () => { alive(); return rendererUrl }))
  const page = await waitFor('real loaded Renderer', async () => { alive(); return (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(row => row.type === 'page' && row.url.startsWith('file:')) })
  probe.cdp = await cdpConnect(page.webSocketDebuggerUrl); await probe.cdp.call('Runtime.enable')
  await waitFor('public IPC and loaded Store', () => probe.cdp.evaluate('Boolean(window.agentmux && document.querySelector(".window-status-bar"))'))
  await waitFor('actual client readiness', async () => { try { const value = await observe(); return !value.workbench.loading ? value : null } catch { alive(); return null } })
  assert.equal(await probe.cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()'), home)
  return probe
}
async function quit(probe, cleanup = false) {
  assert.equal(await identity(probe.child.pid), owners.get(probe.child.pid)); let responseError = null
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app.quit()`) }
  catch (error) { responseError = error.message }
  probe.main.close(); probe.cdp?.close()
  await waitFor('ordinary GUI exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null, 25000, cleanup)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null)
  probe.exit = { code: 0, signal: null, responseError }
  return probe.exit
}
async function click(selector) {
  const point = await waitFor('exact visible control', () => active.cdp.evaluate(`(() => { const es=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&getComputedStyle(e).visibility==='visible'&&hit&&e.contains(hit)});if(es.length!==1)return null;const r=es[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function healthyInput(regionId, runId, label, outputNeedle = label.replace(/[\r\n]+$/, '')) {
  const snapshot = await active.cdp.evaluate('(async()=>await window.agentmux.sessions.snapshot())()')
  const session = snapshot.sessions.find(session => session.control.run.runId === runId)
  assert.equal(session?.processState, 'running'); const before = await sdk.status(runId)
  await active.cdp.evaluate(`window.agentmux.sessions.write(${JSON.stringify(session.control)},${JSON.stringify(label)},'user')`)
  const after = await waitFor('original Run input ACK', async () => { const row = await sdk.status(runId); return row.applied_input_bytes === before.applied_input_bytes + Buffer.byteLength(label) ? row : null })
  assert.equal(after.pid, before.pid); assert.equal(after.state.type, 'running')
  // PTY output can convert the input LF to CRLF. Match the nonempty payload;
  // the input receipt above still checks every transmitted byte, including LF.
  const needle = Buffer.from(outputNeedle); assert.ok(needle.length > 0)
  const replay = await waitFor('original PTY output ACK', async () => { const attachment = await sdk.attach(runId, 0); try { const bytes = Buffer.concat(attachment.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data))); return bytes.includes(needle) ? bytes : null } finally { attachment.close() } })
  return { regionId, runId, pid: after.pid, inputBefore: before.applied_input_bytes, inputAfter: after.applied_input_bytes, outputBytes: after.latest_output_bytes, outputReplayBase64: replay.toString('base64') }
}
async function clickText(selector, text) {
  const point = await waitFor('exact visible text control', () => active.cdp.evaluate("(()=>{const es=Array.from(document.querySelectorAll("+JSON.stringify(selector)+")).filter(e=>e.textContent.trim()==="+JSON.stringify(text)+"&&e.getClientRects().length);if(es.length!==1)return null;const r=es[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()"))
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function nameServiceWindow() {
  phase = 'actual-private-post-replace-service-window'
  const ownerPath = join(repositoryRoot, 'packages/core/dist/spatial-state.js')
  // Select the actual name replacement, rather than counting unrelated layout
  // or previous-document writes that may legitimately precede this UI edit.
  receipt.directoryFault = await active.main.evaluate("(async()=>{const fs=process.getBuiltinModule('fs/promises'),mod=process.getBuiltinModule('module'),paths=process.getBuiltinModule('path');const owner=mod.createRequire("+JSON.stringify(join(desktopRoot,'package.json'))+")("+JSON.stringify(ownerPath)+");const path=owner.defaultAgentMuxSpatialStatePath(),directory=paths.dirname(path);globalThis.__privateNameOpen=fs.open;globalThis.__privateNameSyncs=0;fs.open=async function(...args){const handle=await globalThis.__privateNameOpen(...args);if(String(args[0])!==directory||args[1]!=='r')return handle;return new Proxy(handle,{get(object,key){if(key==='sync')return async()=>{const state=JSON.parse(await fs.readFile(path,'utf8')),record=owner.displayLabelDocument(state.graph).records.at(-1);if(record?.target.kind==='agent-session'&&record.target.id==="+JSON.stringify(agent.agentSessionId)+"&&record.requested==='Private applied name'&&record.status==='applied'&&++globalThis.__privateNameSyncs===1){globalThis.__privateNameOperation=record.id;throw new Error('Private directory confirmation fault')}await object.sync()};const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value}})};mod.syncBuiltinESMExports();return{path,directory,mainPid:process.pid,injection:'Required directory sync after this exact applied name record replaced its document'}})()")
  assert.ok(receipt.directoryFault.path.startsWith(root))
  const selector = '.focus-context[data-session-id="'+agent.agentSessionId+'"]'
  const point = await active.cdp.evaluate("(()=>{const r=document.querySelector("+JSON.stringify(selector)+").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...point })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...point })
  await clickText('[role="menuitem"]', 'Rename Agent')
  await waitFor('unconfirmed real rename input', () => active.cdp.evaluate("document.activeElement?.getAttribute('aria-label')?.startsWith('Rename Agent ')"))
  await active.cdp.call('Input.insertText', { text: 'Private applied name' })
  await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const applied = await waitFor('applied name and actual confirmation action', async () => {
    const value = await control('agent.inspect', { target: { kind: 'agent-session', agentSessionId: agent.agentSessionId } })
    const notice = await active.cdp.evaluate("Array.from(document.querySelectorAll('.global-system-notices__action')).some(e=>e.textContent==='Confirm saved name')")
    return value.displayName.override === 'Private applied name' && notice ? value : null
  })
  receipt.appliedUnknown = applied.displayName
  assert.equal(await active.main.evaluate('globalThis.__privateNameSyncs'), 1)
  receipt.directoryFault.operationId = await active.main.evaluate('globalThis.__privateNameOperation')
  assert.equal(typeof receipt.directoryFault.operationId, 'string')
  await active.main.evaluate("(async()=>{const fs=process.getBuiltinModule('fs/promises');fs.open=globalThis.__privateNameOpen;process.getBuiltinModule('module').syncBuiltinESMExports();delete globalThis.__privateNameOpen;delete globalThis.__privateNameSyncs;delete globalThis.__privateNameOperation;return true})()")
  // Cancel the preserved editor draft; the applied name remains the owner's fact.
  await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await click('.global-system-notices__trigger')
  await waitFor('real unconfirmed service window', () => active.cdp.evaluate("document.querySelector('.global-system-notices__details')?.getAttribute('data-state')==='open'&&document.querySelector('.global-system-notices__details')?.innerText.includes('Name applied')"))
  receipt.unconfirmedScreenshot = await screenshot('name-unconfirmed-service-window')
  receipt.nameHistoryUnknown = await control('name.history', { target: { kind: 'agent-session', id: agent.agentSessionId }, limit: 100 })
  assert.equal(receipt.nameHistoryUnknown.records.at(-1)?.id, receipt.directoryFault.operationId)
  await clickText('.global-system-notices__action', 'Confirm saved name')
  await waitFor('actual durable confirmation clears only its warning', () => active.cdp.evaluate("!Array.from(document.querySelectorAll('.global-system-notices__action')).some(e=>e.textContent==='Confirm saved name')"))
  assert.deepEqual(await control('name.history', { target: { kind: 'agent-session', id: agent.agentSessionId }, limit: 100 }), receipt.nameHistoryUnknown)
  assert.equal((await control('agent.inspect', { target: { kind: 'agent-session', agentSessionId: agent.agentSessionId } })).displayName.override, 'Private applied name')
  await click('.global-system-notices__trigger')
  receipt.confirmedScreenshot = await screenshot('name-confirmed-service-window')
  receipt.serviceWindowVisualReview = 'Pending independent Root review of these full actual GUI frames; capture is not aesthetic approval.'
  await click('[aria-label="Collapse system notifications"]')
  return applied
}
async function verifyNames(opened) {
  phase = 'public-and-ui-name-authority'
  await control('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: opened.regionId } })
  await click('[aria-label^="Focus: show execution contexts"]')
  const before = await control('agent.inspect', { target: { kind: 'agent-session', agentSessionId: agent.agentSessionId } })
  const cli = await exec(process.execPath, [join(repositoryRoot, 'packages/core/dist/agentmux.js'), 'agent', 'rename',
    '--session', agent.agentSessionId, '--name-revision', String(before.displayName.nameRevision), '--name', 'Private CLI name'], { env: cwdEnv, cwd: repositoryRoot })
  receipt.cliRename = JSON.parse(cli.stdout)
  await waitFor('CLI name in actual Focus consumer', () => active.cdp.evaluate(`document.querySelector('.focus-context[data-session-id="'+${JSON.stringify(agent.agentSessionId)}+'"]')?.innerText.includes('Private CLI name')`))
  const point = await active.cdp.evaluate(`(() => {const e=document.querySelector('.focus-context[data-session-id="'+${JSON.stringify(agent.agentSessionId)}+'"]'); const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...point })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...point })
  const menu = await waitFor('actual Rename Agent menu', () => active.cdp.evaluate(`(() => {const e=Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='Rename Agent'&&e.getClientRects().length);if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`))
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...menu })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...menu })
  await waitFor('real rename input focus', () => active.cdp.evaluate(`document.activeElement?.getAttribute('aria-label')?.startsWith('Rename Agent ')`))
  await active.cdp.call('Input.insertText', { text: 'Private UI name' })
  await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const ui = await waitFor('UI owning name ACK', async () => { const value = await control('agent.inspect', { target: { kind: 'agent-session', agentSessionId: agent.agentSessionId } }); return value.displayName.override === 'Private UI name' ? value : null })
  receipt.uiName = ui.displayName
  const appliedUnknown = await nameServiceWindow()
  const clear = await control('agent.rename', { agentSessionId: agent.agentSessionId, name: null, expectedNameRevision: appliedUnknown.displayName.nameRevision })
  assert.equal(clear.override, null)
  receipt.clear = clear
  receipt.lateLaunch = await active.cdp.evaluate(`window.agentmux.spatial.renameLabel(${JSON.stringify({ target: { kind: 'agent-session', id: agent.agentSessionId }, operationId: randomUUID(), value: 'Late default', source: 'launch', expectedNameRevision: 0 })})`)
  assert.equal(receipt.lateLaunch.applied, false); assert.equal(receipt.lateLaunch.label.value, null)
  const edited = await control('agent.rename', { agentSessionId: agent.agentSessionId, name: 'Private durable name', expectedNameRevision: clear.nameRevision })
  const graph = (await control('space.state')).state, tab = graph.graph.tabs.find(tab => tab.regionIds.includes(opened.regionId))
  assert.ok(tab)
  receipt.tabRename = await control('space.rename', { tabId: tab.tabId, name: 'Private durable tab', expectedNameRevision: 0 })
  const attempted = (await control('space.state')).state; attempted.graph.tabs.find(value => value.tabId === tab.tabId).name = 'Forged layout name'
  let refused = null
  try { await control('space.commit', { expectedRevision: attempted.revision, graph: attempted.graph }) } catch (error) { refused = error.code }
  assert.equal(refused, 'NAME_AUTHORITY_CONFLICT'); receipt.bulkRefusal = refused
  receipt.nameHistoryBefore = await control('name.history', { target: { kind: 'agent-session', id: agent.agentSessionId }, limit: 100 })
  assert.ok(receipt.nameHistoryBefore.records.some(record => record.context.entryPoint === 'agent.rename' &&
    record.context.actor.kind === 'device' && record.context.actor.id === `local-user:${process.getuid()}` && record.context.actor.verified === true))
  assert.ok(receipt.nameHistoryBefore.records.some(record => record.context.entryPoint === 'spatial:renameLabel' && record.context.actor.kind === 'device'))
  assert.ok(receipt.nameHistoryBefore.records.some(record => record.requested === null && record.status === 'applied'))
  receipt.screenshotBefore = await screenshot('name-authority-before')
  const runIds = [agent.run.runId, terminal.runId]
  receipt.runsBefore = (await sdk.list()).filter(run => runIds.includes(run.id)).map(run => ({ id: run.id, pid: run.pid, state: run.state }))
  assert.equal(receipt.runsBefore.length, 2)
  receipt.acksBefore = [await healthyInput(opened.regionId, agent.run.runId, 'PRIVATE_NAME_AGENT_BEFORE'), await healthyInput(terminal.regionId, terminal.runId, 'echo PRIVATE_NAME_SHELL_BEFORE\r', 'PRIVATE_NAME_SHELL_BEFORE')]
  receipt.preRestart = await observe(); receipt.firstQuit = await quit(active)
  phase = 'ordinary-name-process-restart'; await launch('after')
  receipt.after = await observe(); assert.notEqual(receipt.after.main.pid, receipt.preRestart.main.pid)
  assert.deepEqual(durableWorkbench(receipt.after), durableWorkbench(receipt.preRestart))
  receipt.nameAfter = (await control('agent.inspect', { target: { kind: 'agent-session', agentSessionId: agent.agentSessionId } })).displayName
  assert.deepEqual(receipt.nameAfter, { override: 'Private durable name', nameRevision: edited.nameRevision, availability: 'observed' })
  const tabAfter = (await control('space.inspect', { target: { tabId: tab.tabId } })).catalog.tabs.find(value => value.tabId === tab.tabId)
  assert.equal(tabAfter.name, 'Private durable tab'); assert.equal(tabAfter.nameRevision, receipt.tabRename.nameRevision)
  receipt.nameHistoryAfter = await control('name.history', { target: { kind: 'agent-session', id: agent.agentSessionId }, limit: 100 })
  assert.deepEqual(receipt.nameHistoryAfter, receipt.nameHistoryBefore)
  receipt.acksAfter = [await healthyInput(opened.regionId, agent.run.runId, 'PRIVATE_NAME_AGENT_AFTER'), await healthyInput(terminal.regionId, terminal.runId, 'echo PRIVATE_NAME_SHELL_AFTER\r', 'PRIVATE_NAME_SHELL_AFTER')]
  receipt.runsAfter = (await sdk.list()).filter(run => runIds.includes(run.id)).map(run => ({ id: run.id, pid: run.pid, state: run.state }))
  assert.deepEqual(receipt.runsAfter, receipt.runsBefore)
  await waitFor('durable name in actual reloaded consumer', () => active.cdp.evaluate(`document.querySelector('.focus-context[data-session-id="'+${JSON.stringify(agent.agentSessionId)}+'"]')?.innerText.includes('Private durable name')`))
  receipt.screenshotAfter = await screenshot('name-authority-after'); receipt.secondQuit = await quit(active)
}
async function inputs() {
  const manifestPath = process.env.AGENTMUX_VERIFY_SOURCE_MANIFEST
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null, paths = []
  if (manifest) { assert.equal(manifest.sourceRoot, repositoryRoot); assert.ok(Object.keys(manifest.files).length > 5000); paths.push(...Object.keys(manifest.files)) }
  else for (const directory of ['apps/desktop/src','packages/core/src','packages/layout/src','packages/demand/src','packages/client-ui/src']) await visit(join(repositoryRoot, directory))
  async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path) } }
  await visit(join(desktopRoot, 'out')); await visit(join(repositoryRoot, 'packages/core/dist')); await visit(join(repositoryRoot, 'packages/demand/dist'))
  paths.push('pnpm-lock.yaml','pnpm-workspace.yaml','apps/desktop/scripts/verify-focus-terminal-recovery.mjs',
    'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd','packages/core/vendor/ctxmux/darwin-arm64/manifest.json',
    'packages/core/node_modules/@ctxmux/sdk/dist/index.js','apps/desktop/node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js',require('electron'),process.execPath)
  if (nameAuthorityMode) paths.push('apps/desktop/scripts/verify-name-authority.mjs')
  const result = Object.fromEntries(await Promise.all([...new Set(paths)].map(async path => { const full = resolve(repositoryRoot,path), bytes = await readFile(full); assert.ok(bytes.length > 0 || manifest?.files[path] === hash(bytes)); return [full, hash(bytes)] })))
  if (manifest) for (const [path, expected] of Object.entries(manifest.files)) assert.equal(result[resolve(repositoryRoot,path)], expected, path)
  receipt.source = manifest ? { originCommit: manifest.originCommit, fileCount: Object.keys(manifest.files).length, manifestSha256: hash(await readFile(manifestPath)) } : { kind: 'current Source directories' }
  return result
}
async function terminalGeometry(regionId, runId) {
  return waitFor('actual recovered xterm and split geometry', async () => {
    await active.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const dom = await active.cdp.evaluate(`(() => {
      const regions=Array.from(document.querySelectorAll('[data-workbench-region-id="'+${JSON.stringify(regionId)}+'"]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});
      if(regions.length!==1)return null;
      const region=regions[0],viewport=region.querySelector('.terminal-view__xterm'),screen=region.querySelector('.xterm-screen'),split=region.closest('.workbench-region-split');
      if(!viewport||!screen||!split)return null;
      const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
      return { regionId:region.dataset.workbenchRegionId, viewport:rect(viewport),screen:rect(screen),panels:Array.from(split.children).filter(e=>e.hasAttribute('data-panel-id')).map(e=>({bounds:rect(e),grow:Number(e.style.flexGrow)})) }
    })()`)
    if (!dom || dom.panels.length !== 2 || dom.viewport.width < 50 || dom.screen.width > dom.viewport.width + 1 || dom.screen.width < dom.viewport.width - 32) return null
    const region=(await control('space.inspect',{target:{regionId}})).presentation.region, run=await sdk.status(runId)
    if (!region.terminalView?.liveReady || region.terminalView.runId!==runId || region.terminalView.viewGrid.cols!==run.current_size?.cols || region.terminalView.viewGrid.rows!==run.current_size?.rows) return null
    return { dom, view:region.terminalView, run:{id:run.id,pid:run.pid,state:run.state,current_size:run.current_size} }
  })
}
async function screenshot(label) {
  const path=join(resolve(process.env.AGENTMUX_VERIFY_RECEIPT,'..'),label+'.png')
  await mkdir(resolve(path,'..'),{recursive:true})
  await active.cdp.call('Page.enable')
  const {data}=await active.cdp.call('Page.captureScreenshot',{format:'png'})
  await writeFile(path,Buffer.from(data,'base64'))
  return {path,sha256:hash(Buffer.from(data,'base64'))}
}
try {
  await Promise.all([mkdir(home,{recursive:true}),mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(runtimeDirectory,{recursive:true}),mkdir(join(home,'codex'),{recursive:true})])
  assert.ok(process.env.AGENTMUX_VERIFY_RECEIPT,'Explicit owning receipt path required')
  receipt.inputsBefore=await inputs()
  const stateDirectory=join(runtimeDirectory,'state','ctxmux')
  await mkdir(stateDirectory,{recursive:true,mode:0o700})
  let daemonDiagnostic=''
  daemon=spawn(join(repositoryRoot,'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),['--socket',socketPath,'--state-dir',stateDirectory],{detached:true,stdio:['ignore','ignore','pipe']});children.add(daemon);daemon.stderr.on('data',bytes=>{daemonDiagnostic=(daemonDiagnostic+bytes.toString()).slice(-16384)});await own(daemon.pid)
  sdk=new CtxmuxClient({socketPath});receipt.runtime=await waitFor('public private Runtime',async()=>{
    if(daemon.exitCode!==null||daemon.signalCode!==null)throw new Error(`Private Runtime exited: ${daemonDiagnostic}`)
    try{return await sdk.runtimeInfo()}catch{return null}
  });receipt.daemonPid=daemon.pid
  const executable=join(root,'private-agent.sh');await writeFile(executable,"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.159.2'; exit 0; fi\nstty -echo -icanon\nprintf 'Private Agent ready\\r\\n'\nexec /bin/cat\n",{mode:0o700})
  creator=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
  agent=await creator.createAgent({createOperationId:randomUUID(),executorId:'private-agent',providerId:'codex',commandOverride:executable,workspacePath,env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false,cols:90,rows:25})
  await own((await sdk.status(agent.run.runId)).pid);await creator.dispose();creator=null
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{'private-agent':{label:'Private Agent',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false}},workspaces:[{id:workspaceId,name:'Private recovery',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
  await launch('before');await click(`.project-rail-row[data-workspace-id="${workspaceId}"]`);await click('button[title="New tab"]')
  const launcher=await waitFor('actual workspace launcher',async()=>{const value=await observe();return value.workbench.tabs.filter(tab=>tab.workspaceId===workspaceId).flatMap(tab=>tab.regions).find(region=>region.kind==='launcher')})
  await waitFor('exact launcher admitted to durable Core topology', async()=>{
    const state=(await control('space.state')).state
    return state?.graph.regions.some(region=>region.regionId===launcher.regionId&&region.kind==='launcher')
  })
  // The usable surface precedes the end of cold hydration. Re-focus this same
  // existing launcher with preserved input until its real save owner is ready;
  // do not retry Agent creation or reinterpret its partial receipt as opened.
  receipt.launcherSaveReadiness=[]
  await waitFor('actual Workbench save admission after hydration',async()=>{
    const focused=await control('space.focus',{inputPolicy:'preserve',target:{kind:'space',regionId:launcher.regionId}})
    receipt.launcherSaveReadiness.push(focused.save)
    if(focused.save.reason&&focused.save.reason!=='The saved Workbench is still being restored.') throw new Error(focused.save.reason)
    return focused.save.localStorageWritten&&focused.save.storageFlushRequested&&focused.save.diskDurability==='confirmed'
  })
  const openedReport=await control('agent.open',{content:{kind:'agent-session',agentSessionId:agent.agentSessionId},destination:{regionId:launcher.regionId},focus:true});receipt.openedReport=openedReport;assert.equal(openedReport.outcome,'opened',JSON.stringify(openedReport));const opened=openedReport.to;assert.ok(opened)
  terminal=(await control('terminal.open',{shellCommand:'/bin/sh',destination:{kind:'split',direction:'right',region:{kind:'region',regionId:opened.regionId}}})).region;await own((await sdk.status(terminal.runId)).pid)
  if (nameAuthorityMode) {
    receipt.schema = 'agentmux.name-authority.v1'
    receipt.constraints = ['Private ordinary Main and Renderer; real private Runtime and public CLI/RPC.', 'Both original Runs remain healthy through name edits and two GUI PIDs.']
    await verifyNames(opened)
    receipt.inputsAfter = await inputs(); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore)
    receipt.passed = true
  } else {
  const oldSnapshot=(await active.cdp.evaluate('(async()=>await window.agentmux.sessions.snapshot())()')).sessions.find(s=>s.control.run.runId===terminal.runId);assert.equal(oldSnapshot?.kind,'terminal')
  phase='natural-terminal-exit';await active.cdp.evaluate(`window.agentmux.sessions.write(${JSON.stringify(oldSnapshot.control)},${JSON.stringify('exit 7\n')},'user')`)
  const exitedRun=await waitFor('actual target Run exits',async()=>{const run=await sdk.status(terminal.runId);return run.state.type==='exited'?run:null})
  receipt.exitedRun={id:exitedRun.id,pid:exitedRun.pid,state:exitedRun.state}
  await control('space.focus',{inputPolicy:'preserve',target:{kind:'space',regionId:opened.regionId}})
  // Recover the ended Shell in the Agent's actual split workspace shown by Focus.
  await click('[aria-label^="Focus: show execution contexts"]')
  receipt.before=await observe();const tab=receipt.before.workbench.tabs.find(tab=>tab.regions.some(region=>region.regionId===terminal.regionId));assert.ok(tab);assert.equal(tab.regions.length,2);assert.equal(tab.layout.activeRegionId,opened.regionId);assert.equal(receipt.before.workbench.focus.executionSessionId,agent.agentSessionId)
  receipt.screenshotBefore=await screenshot('recovery-before')
  phase='actual-keyboard-region-recovery'
  const restartSelector=`[data-workbench-region-id="${terminal.regionId}"] .terminal-recovery__actions button`
  await waitFor('one real Restart terminal action',()=>active.cdp.evaluate(`(() => {const es=Array.from(document.querySelectorAll(${JSON.stringify(restartSelector)}));return es.length===1&&es[0].textContent.includes('Restart terminal')})()`))
  assert.equal(await active.cdp.evaluate(`(() => {const button=document.querySelector(${JSON.stringify(restartSelector)});button.focus();return document.activeElement===button})()`),true)
  await active.cdp.evaluate(`(() => {window.__privateRecoveryKeyTrace=[];for(const type of ['keydown','keypress','keyup','click'])document.addEventListener(type,event=>window.__privateRecoveryKeyTrace.push({type,key:event.key,trusted:event.isTrusted,tag:event.target.tagName,text:event.target.textContent?.slice(0,70),prevented:event.defaultPrevented}),{capture:true});})()`)
  await active.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36,text:'\r',unmodifiedText:'\r'})
  await active.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36})
  receipt.recovered=await waitFor('same Region accepted new terminal identity',async()=>{const value=await observe(),region=value.workbench.tabs.find(t=>t.id===tab.id)?.regions.find(r=>r.regionId===terminal.regionId);return region?.kind==='terminal'&&region.sessionId!==oldSnapshot.id&&region.processState==='running'?value:null})
  receipt.keyboardTrace=await active.cdp.evaluate('window.__privateRecoveryKeyTrace');
  const newRegion=receipt.recovered.workbench.tabs.find(t=>t.id===tab.id).regions.find(r=>r.regionId===terminal.regionId), newRunId=newRegion.control.run.runId
  assert.notEqual(newRunId,terminal.runId);assert.equal(receipt.recovered.workbench.focus.executionSessionId,agent.agentSessionId);assert.deepEqual(receipt.recovered.workbench.layouts,receipt.before.workbench.layouts)
  const expected=structuredClone(durableWorkbench(receipt.before))
  const expectedRegion=expected.tabs.find(t=>t.id===tab.id).regions.find(r=>r.regionId===terminal.regionId);Object.assign(expectedRegion,newRegion)
  assert.deepEqual(durableWorkbench(receipt.recovered),expected)
  await own((await sdk.status(newRunId)).pid)
  receipt.geometryBefore=await terminalGeometry(terminal.regionId,newRunId)
  assert.equal(await active.cdp.evaluate(`document.querySelector('.focus-context[data-session-id="'+${JSON.stringify(agent.agentSessionId)}+'"]')?.getAttribute('aria-pressed')`),'true')
  receipt.acksBefore=[];receipt.acksBefore.push(await healthyInput(opened.regionId,agent.run.runId,'PRIVATE_RECOVERY_AGENT_BEFORE'));receipt.acksBefore.push(await healthyInput(terminal.regionId,newRunId,'echo PRIVATE_RECOVERY_TERMINAL_BEFORE\r','PRIVATE_RECOVERY_TERMINAL_BEFORE'))
  const targetIds=[agent.run.runId,newRunId];assert.equal(new Set(targetIds).size,2)
  receipt.runsBefore=(await sdk.list()).filter(run=>targetIds.includes(run.id)).map(run=>({id:run.id,pid:run.pid,state:run.state}));assert.deepEqual(receipt.runsBefore.map(run=>run.id).sort(),[...targetIds].sort())
  receipt.preRestart=await observe();receipt.firstQuit=await quit(active)
  phase='ordinary-process-restart';await launch('after')
  receipt.after=await observe();assert.notEqual(receipt.after.main.pid,receipt.preRestart.main.pid);assert.deepEqual(durableWorkbench(receipt.after),durableWorkbench(receipt.preRestart))
  receipt.geometryAfter=await terminalGeometry(terminal.regionId,newRunId);assert.deepEqual(receipt.geometryAfter.dom.panels,receipt.geometryBefore.dom.panels);assert.deepEqual(receipt.geometryAfter.view.viewGrid,receipt.geometryBefore.view.viewGrid)
  receipt.acksAfter=[];receipt.acksAfter.push(await healthyInput(opened.regionId,agent.run.runId,'PRIVATE_RECOVERY_AGENT_AFTER'));receipt.acksAfter.push(await healthyInput(terminal.regionId,newRunId,'echo PRIVATE_RECOVERY_TERMINAL_AFTER\r','PRIVATE_RECOVERY_TERMINAL_AFTER'))
  receipt.runsAfter=(await sdk.list()).filter(run=>targetIds.includes(run.id)).map(run=>({id:run.id,pid:run.pid,state:run.state}));assert.deepEqual(receipt.runsAfter,receipt.runsBefore)
  assert.deepEqual(await sdk.runtimeInfo(),receipt.runtime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid));assert.equal((await sdk.status(terminal.runId)).state.type,'exited')
  receipt.screenshotAfter=await screenshot('recovery-after');receipt.inputsAfter=await inputs();assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore)
  receipt.secondQuit=await quit(active);receipt.passed=true
  }
} catch(error) {
  failure={phase,message:error.message,stack:error.stack};receipt.passed=false
  if(active?.cdp)try{receipt.failureObservation=await observe();receipt.failureDom=await active.cdp.evaluate('({text:document.body.innerText.slice(0,12000),keyTrace:window.__privateRecoveryKeyTrace??null,buttons:Array.from(document.querySelectorAll("button")).filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,title:e.title,aria:e.getAttribute("aria-label")}))})');receipt.failureScreenshot=await screenshot('failure')}catch(diagnosticError){receipt.diagnosticError=diagnosticError.message}
}
finally {
  const errors=[]
  if(creator)try{await creator.dispose()}catch(error){errors.push(error.message)}
  if(active&&active.child.exitCode===null&&active.child.signalCode===null)try{await quit(active,true)}catch(error){errors.push(error.message)}
  for(const cdp of connections)try{cdp.close()}catch(error){errors.push(error.message)}
  // Only after the continuity observations: terminate this private invocation's
  // owned daemon/children. Cleanup is not a stop/resume step in the experiment.
  for(const child of children)if(child.pid>1)try{if(await identity(child.pid)===owners.get(child.pid))await stopProbeProcesses(child.pid,root)}catch(error){errors.push(error.message)}
  for(const[pid,birth]of owners)try{if(await identity(pid)===birth)process.kill(pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')errors.push(error.message)}
  let remaining=[];try{await waitFor('owned private cleanup',async()=>{const paths=await listProbeProcesses(-1,root),pids=await Promise.all([...owners].map(async([pid,birth])=>await identity(pid)===birth?pid:null));remaining=[...new Set([...paths,...pids.filter(Boolean)])];return remaining.length===0?[]:null},5000,true)}catch(error){errors.push(error.message)}
  receipt.cleanup={errors,remaining,rootRemoved:false};if(!errors.length&&!remaining.length){await rm(root,{recursive:true,force:true});receipt.cleanup.rootRemoved=true}
  for(const[key,value]of environmentBefore)value===undefined?delete process.env[key]:process.env[key]=value
  if(errors.length||remaining.length){receipt.passed=false;failure??={phase:'cleanup',message:errors.join('; ')||remaining.join(',')}}
}
receipt.guis=probes.map(probe=>({label:probe.label,pid:probe.child.pid,exitCode:probe.child.exitCode,signalCode:probe.child.signalCode,ordinaryQuit:probe.exit??null,diagnostics:probe.diagnostics()}));receipt.finishedAt=Date.now();receipt.failure=failure??null
const output=process.env.AGENTMUX_VERIFY_RECEIPT??join(repositoryRoot,'.tmp/focus-terminal-recovery-last.json');await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,failure:receipt.failure,cleanup:receipt.cleanup})+'\n');process.exitCode=receipt.passed?0:1
