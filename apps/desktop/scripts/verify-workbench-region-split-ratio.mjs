import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Ordinary compiled Main/preload/Renderer and public Core/SDK owners. The existing
// pre-home Inspector seam isolates the fixture; no Store seeding or handle drag.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-split-ratio-'), home = join(root, 'home'), userData = join(root, 'user-data')
const runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), workspaceId = 'private-split-ratio'
const socketPath = join(runtimeDirectory, 'ctxmux.sock'), deadline = Date.now() + 180000
const fixtureEnvironment = { HOME: home, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: join(home, 'codex') }
const environmentBefore = new Map(Object.keys(fixtureEnvironment).map(key => [key, process.env[key]]))
const cwdEnv = { ...process.env, ...fixtureEnvironment }
for (const key of Object.keys(cwdEnv)) if (key.startsWith('AGENTMUX_') && !Object.hasOwn(fixtureEnvironment, key)) delete cwdEnv[key]
Object.assign(process.env, fixtureEnvironment)
const { CtxmuxClient } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
const { connectLocalAgentMux, AgentMuxFileAgentSessionStore, requestAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const receipt = { schema: 'agentmux.workbench-split-ratio-sync.v1', passed: false, temporaryRoot: root, userRuntimeTouched: false,
  startedAt: Date.now(), limitations: ['Private ordinary compiled GUI processes; no installed-package qualification.',
    'Same-process xterm reference is read from its real React owner after the two splits and through a same-value public balance; restart creates a new xterm.'], cleanup: {} }
const children = new Set(), owners = new Map(), connections = new Set(), probes = []
let phase = 'prepare', failure, daemon, sdk, creator, active, server, agent, terminal
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 1500 })).stdout.trim() }
  catch (error) { if (error.code === 1) return ''; throw error }
}
async function own(pid) { assert.ok(pid > 1); const birth = await identity(pid); assert.ok(birth); owners.set(pid, birth) }
async function waitFor(label, read, budget = 25000, cleanup = false) {
  const end = cleanup ? Date.now() + budget : Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
  throw new Error(`Split ratio gate timed out: ${label}`)
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
async function control(operation, fields = {}) {
  const reply = await requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation, ...fields }, join(runtimeDirectory, 'control.sock'))
  assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal(reply.operation, operation); return reply.result
}
async function observe() { return (await control('inspect.client')).observation }
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
  await waitFor('public IPC and loaded Store', () => probe.cdp.evaluate('Boolean(window.agentmux && document.querySelector(".project-list"))'))
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
  const point = await waitFor('exact visible control', () => active.cdp.evaluate(`(() => { const es=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getClientRects().length);if(es.length!==1)return null;const r=es[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function geometry(browser, pageUrl) {
  return waitFor('real Browser bounds and mounted Terminal fit', async () => {
    await active.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const dom = await active.cdp.evaluate(`(() => {const stage=document.querySelector('[data-native-browser-stage]'),split=Array.from(document.querySelectorAll('.workbench-region-split')).find(e=>e.getClientRects().length),region=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(terminal.regionId)}+'"]'),viewport=region?.querySelector('.terminal-view__xterm'),screen=region?.querySelector('.xterm-screen');if(!stage||!split||!viewport||!screen)return null;const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};const panels=Array.from(split.children).filter(e=>e.hasAttribute('data-panel-id'));return{stage:rect(stage),split:rect(split),panels:panels.map(e=>({bounds:rect(e),grow:Number(e.style.flexGrow)})),viewport:rect(viewport),screen:rect(screen)}})()`)
    if (!dom || dom.panels.length !== 2 || dom.viewport.width < 50 || dom.screen.width > dom.viewport.width + 1 || dom.screen.width < dom.viewport.width - 32) return null
    const native = await active.main.evaluate(`(async()=>{const{BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');const w=BrowserWindow.getAllWindows()[0];if(!w)return null;const vs=w.contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL()===${JSON.stringify(pageUrl)});if(vs.length!==1)return null;return{bounds:vs[0].getBounds(),webContentsId:vs[0].webContents.id,text:await vs[0].webContents.executeJavaScript('document.querySelector("h1")?.textContent'),windowBounds:w.getBounds()}})()`)
    if (!native || native.text !== 'Private split ratio Browser' || !['x','y','width','height'].every(key => Math.abs(native.bounds[key] - dom.stage[key]) < 2)) return null
    const view = (await control('inspect.region', { target: { kind: 'region', regionId: terminal.regionId } })).region.terminalView, run = await sdk.status(terminal.runId)
    if (!view?.liveReady || view.runId !== terminal.runId || view.viewGrid.cols !== run.current_size?.cols || view.viewGrid.rows !== run.current_size?.rows) return null
    return { native, dom, grid: view.viewGrid, run: { id: run.id, pid: run.pid, current_size: run.current_size }, browserRegionId: browser.regionId }
  })
}
// Read the actual Terminal ref from its mounted React owner. This fixture keeps
// references only in the private Renderer; it neither replaces nor wraps xterm.
async function xtermReference(capture) {
  return active.cdp.evaluate(`(() => {const region=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(terminal.regionId)}+'"]'),element=region?.querySelector('.xterm');if(!element)return null;const key=Object.keys(region).find(k=>k.startsWith('__reactFiber$'));let fiber=key&&region[key],found=[];const seen=new Set();function walk(f){if(!f||seen.has(f))return;seen.add(f);for(let h=f.memoizedState;h&&typeof h==='object';h=h.next){const value=h.memoizedState?.current;if(value?.element===element&&typeof value.dispose==='function'&&typeof value.write==='function')found.push(value)}walk(f.child);walk(f.sibling)}walk(fiber);found=[...new Set(found)];if(found.length!==1)return null;${capture ? 'window.__privateRatioXterm={terminal:found[0],element,region};' : ''}return{candidates:found.length,sameTerminal:window.__privateRatioXterm?.terminal===found[0],sameElement:window.__privateRatioXterm?.element===element,sameRegion:window.__privateRatioXterm?.region===region,cols:found[0].cols,rows:found[0].rows}})()`)
}
async function healthyInput(regionId, runId, label) {
  const snapshot = await active.cdp.evaluate('(async()=>await window.agentmux.sessions.snapshot())()')
  const session = snapshot.sessions.find(session => session.control.run.runId === runId)
  assert.equal(session?.processState, 'running'); const before = await sdk.status(runId)
  await active.cdp.evaluate(`window.agentmux.sessions.write(${JSON.stringify(session.control)},${JSON.stringify(label)},'user')`)
  const after = await waitFor('original Run input ACK', async () => { const row = await sdk.status(runId); return row.applied_input_bytes === before.applied_input_bytes + Buffer.byteLength(label) ? row : null })
  assert.equal(after.pid, before.pid); assert.equal(after.state.type, 'running')
  // PTY output can convert the input LF to CRLF. Match the nonempty payload;
  // the input receipt above still checks every transmitted byte, including LF.
  const needle = Buffer.from(label.replace(/[\r\n]+$/, '')); assert.ok(needle.length > 0)
  const replay = await waitFor('original PTY output ACK', async () => { const attachment = await sdk.attach(runId, 0); try { const bytes = Buffer.concat(attachment.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data))); return bytes.includes(needle) ? bytes : null } finally { attachment.close() } })
  return { regionId, runId, pid: after.pid, inputBefore: before.applied_input_bytes, inputAfter: after.applied_input_bytes, outputBytes: after.latest_output_bytes, outputReplayBase64: replay.toString('base64') }
}
async function inputs() {
  const manifestPath = process.env.AGENTMUX_VERIFY_SOURCE_MANIFEST
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null, paths = []
  if (manifest) { assert.equal(manifest.sourceRoot, repositoryRoot); assert.ok(Object.keys(manifest.files).length > 5000); paths.push(...Object.keys(manifest.files)) }
  else for (const directory of ['apps/desktop/src','packages/core/src','packages/layout/src','packages/demand/src']) await visit(join(repositoryRoot, directory))
  async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path) } }
  await visit(join(desktopRoot, 'out')); await visit(join(repositoryRoot, 'packages/core/dist')); await visit(join(repositoryRoot, 'packages/demand/dist'))
  paths.push('pnpm-lock.yaml','pnpm-workspace.yaml','apps/desktop/scripts/verify-workbench-region-split-ratio.mjs',
    'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd','packages/core/vendor/ctxmux/darwin-arm64/manifest.json',
    'packages/core/node_modules/@ctxmux/sdk/dist/index.js','apps/desktop/node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js',require('electron'))
  const result = Object.fromEntries(await Promise.all([...new Set(paths)].map(async path => { const full = resolve(repositoryRoot,path), bytes = await readFile(full); assert.ok(bytes.length > 0 || manifest?.files[path] === hash(bytes)); return [full, hash(bytes)] })))
  if (manifest) for (const [path, expected] of Object.entries(manifest.files)) assert.equal(result[resolve(repositoryRoot,path)], expected, path)
  receipt.source = manifest ? { originCommit: manifest.originCommit, fileCount: Object.keys(manifest.files).length, manifestSha256: hash(await readFile(manifestPath)) } : { kind: 'current Source directories' }
  return result
}
try {
  await Promise.all([mkdir(home,{recursive:true}),mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(runtimeDirectory,{recursive:true}),mkdir(join(home,'codex'),{recursive:true})])
  receipt.inputsBefore = await inputs()
  daemon = spawn(join(repositoryRoot,'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'), ['--socket',socketPath,'--state-dir',join(runtimeDirectory,'state','ctxmux')], {detached:true,stdio:['ignore','ignore','pipe']});children.add(daemon);daemon.stderr.on('data',()=>{});await own(daemon.pid)
  sdk = new CtxmuxClient({socketPath});receipt.runtime = await waitFor('public private Runtime',async()=>{try{return await sdk.runtimeInfo()}catch{return null}});receipt.daemonPid=daemon.pid
  const executable=join(root,'private-agent.sh');await writeFile(executable,"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.159.2'; exit 0; fi\nstty -echo -icanon\nprintf 'Private Agent ready\\r\\n'\nexec /bin/cat\n",{mode:0o700})
  creator=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
  agent=await creator.createAgent({createOperationId:randomUUID(),executorId:'private-agent',providerId:'codex',commandOverride:executable,workspacePath,env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false,cols:90,rows:25})
  await own((await sdk.status(agent.run.runId)).pid);await creator.dispose();creator=null
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{'private-agent':{label:'Private Agent',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false}},workspaces:[{id:workspaceId,name:'Private split ratio',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
  server=createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><title>Private Browser</title><h1>Private split ratio Browser</h1>')});await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
  const pageUrl=`http://127.0.0.1:${server.address().port}/page`
  await launch('before');await click(`.project-rail-row[data-workspace-id="${workspaceId}"]`);await click('[aria-label="Browser Tools"]')
  const button=await waitFor('New Browser menu',()=>active.cdp.evaluate(`(()=>{const es=Array.from(document.querySelectorAll('button')).filter(e=>e.getClientRects().length&&e.textContent.trim()==='New Browser');if(es.length!==1)return null;const r=es[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`))
  await active.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...button});await active.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...button})
  const browser=await waitFor('UI-created Browser',async()=>{const value=await observe();return value.workbench.tabs.flatMap(tab=>tab.regions).find(region=>region.kind==='browser')})
  await active.cdp.evaluate(`window.agentmux.browser.navigate(${JSON.stringify(browser.browserId)},${JSON.stringify(pageUrl)})`)
  phase='two-public-splits'
  const opened=await control('agent.open',{content:{kind:'agent-session',agentSessionId:agent.agentSessionId},destination:{regionId:browser.regionId,split:'right'},focus:true});assert.equal(opened.outcome,'opened');assert.ok(opened.to)
  terminal=(await control('open.terminal',{shellCommand:'/bin/cat',destination:{kind:'split',direction:'down',region:{kind:'region',regionId:opened.to.regionId}}})).region;await own((await sdk.status(terminal.runId)).pid)
  await control('focus',{inputPolicy:'preserve',target:{kind:'space',regionId:browser.regionId}})
  receipt.before=await waitFor('public Browser descriptor reaches the actual page',async()=>{const value=await observe(),region=value.workbench.tabs.flatMap(tab=>tab.regions).find(region=>region.regionId===browser.regionId);return region?.kind==='browser'&&region.url===pageUrl?value:null});const tab=receipt.before.workbench.tabs.find(tab=>tab.regions.some(region=>region.regionId===terminal.regionId));assert.ok(tab);assert.equal(tab.regions.length,3);assert.equal(tab.layout.root.type,'split');assert.equal(tab.layout.root.ratio,1/3)
  receipt.geometryBefore=await geometry(browser,pageUrl);assert.equal(receipt.geometryBefore.dom.panels[0].grow,33.3)
  const widths=receipt.geometryBefore.dom.panels.map(panel=>panel.bounds.width);assert.ok(Math.abs(widths[0]/(widths[0]+widths[1])-1/3)<0.002)
  receipt.xtermBefore=await waitFor('real xterm owner ref',()=>xtermReference(true));assert.equal(receipt.xtermBefore.candidates,1)
  await control('arrange',{target:{kind:'tab',tabId:tab.id},mode:{kind:'balance'}})
  receipt.sameValue=await observe();assert.deepEqual(durableWorkbench(receipt.sameValue),durableWorkbench(receipt.before))
  receipt.xtermSameProcess=await xtermReference(false);assert.deepEqual(receipt.xtermSameProcess,{...receipt.xtermBefore,sameTerminal:true,sameElement:true,sameRegion:true})
  receipt.acksBefore=[];receipt.acksBefore.push(await healthyInput(opened.to.regionId,agent.run.runId,'PRIVATE_RATIO_AGENT_BEFORE'));receipt.acksBefore.push(await healthyInput(terminal.regionId,terminal.runId,'PRIVATE_RATIO_TERMINAL_BEFORE\n'))
  const targetIds=[agent.run.runId,terminal.runId];assert.equal(new Set(targetIds).size,2)
  receipt.allRunsBefore=await sdk.list();receipt.runsBefore=receipt.allRunsBefore.filter(run=>targetIds.includes(run.id));assert.equal(receipt.runsBefore.length,2);assert.deepEqual(receipt.runsBefore.map(run=>run.id).sort(),[...targetIds].sort());receipt.firstQuit=await quit(active)
  phase='ordinary-restart';await launch('after');receipt.after=await observe();assert.notEqual(receipt.after.main.pid,receipt.before.main.pid);assert.deepEqual(durableWorkbench(receipt.after),durableWorkbench(receipt.before))
  receipt.geometryAfter=await geometry(browser,pageUrl);assert.deepEqual(receipt.geometryAfter.native.bounds,receipt.geometryBefore.native.bounds);assert.deepEqual(receipt.geometryAfter.native.windowBounds,receipt.geometryBefore.native.windowBounds);assert.deepEqual(receipt.geometryAfter.grid,receipt.geometryBefore.grid);assert.deepEqual(receipt.geometryAfter.dom.panels,receipt.geometryBefore.dom.panels)
  assert.equal(await active.cdp.evaluate('window.__privateRatioXterm === undefined'),true)
  receipt.xtermAfter=await waitFor('new process real xterm owner ref',()=>xtermReference(true));assert.equal(receipt.xtermAfter.candidates,1);receipt.crossProcessXterm={newRendererProcess:true,previousFixtureReferenceAbsent:true,originalObjectComparisonPossible:false}
  receipt.acksAfter=[];receipt.acksAfter.push(await healthyInput(opened.to.regionId,agent.run.runId,'PRIVATE_RATIO_AGENT_AFTER'));receipt.acksAfter.push(await healthyInput(terminal.regionId,terminal.runId,'PRIVATE_RATIO_TERMINAL_AFTER\n'))
  receipt.allRunsAfter=await sdk.list();receipt.runsAfter=receipt.allRunsAfter.filter(run=>targetIds.includes(run.id));assert.equal(receipt.runsAfter.length,2);assert.deepEqual(receipt.runsAfter.map(run=>({id:run.id,pid:run.pid,state:run.state})),receipt.runsBefore.map(run=>({id:run.id,pid:run.pid,state:run.state})));receipt.otherRunDelta={added:receipt.allRunsAfter.filter(run=>!receipt.allRunsBefore.some(before=>before.id===run.id)),removed:receipt.allRunsBefore.filter(run=>!receipt.allRunsAfter.some(after=>after.id===run.id))};assert.deepEqual(await sdk.runtimeInfo(),receipt.runtime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid))
  receipt.inputsAfter=await inputs();assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore);receipt.secondQuit=await quit(active);receipt.passed=true
} catch(error) { failure={phase,message:error.message,stack:error.stack};receipt.passed=false }
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
  if(server)try{await new Promise((done,fail)=>server.close(error=>error?fail(error):done()))}catch(error){errors.push(error.message)}
  receipt.cleanup={errors,remaining,rootRemoved:false};if(!errors.length&&!remaining.length){await rm(root,{recursive:true,force:true});receipt.cleanup.rootRemoved=true}
  for(const[key,value]of environmentBefore)value===undefined?delete process.env[key]:process.env[key]=value
  if(errors.length||remaining.length){receipt.passed=false;failure??={phase:'cleanup',message:errors.join('; ')||remaining.join(',')}}
}
receipt.guis=probes.map(probe=>({label:probe.label,pid:probe.child.pid,exitCode:probe.child.exitCode,signalCode:probe.child.signalCode,ordinaryQuit:probe.exit??null,diagnostics:probe.diagnostics()}));receipt.finishedAt=Date.now();receipt.failure=failure??null
const output=process.env.AGENTMUX_VERIFY_RECEIPT??join(repositoryRoot,'.tmp/workbench-region-split-ratio-last.json');await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,failure:receipt.failure,cleanup:receipt.cleanup})+'\n');process.exitCode=receipt.passed?0:1
