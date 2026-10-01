import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from '../../probe-process.mjs'

// Ordinary compiled Main/preload/Renderer and public Core/SDK owners. Recovery is
// triggered from its real Region button; private home is isolated before startup.
const repositoryRoot = resolve(import.meta.dirname, '../../../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-resume-recap-")), home = join(root, 'home'), userData = join(root, 'user-data')
const runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), workspaceId = 'private-resume-recap'
const socketPath = join(runtimeDirectory, 'ctxmux.sock'), deadline = Date.now() + 240000
const fixtureEnvironment = { HOME: home, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: join(home, 'codex') }
const environmentBefore = new Map(Object.keys(fixtureEnvironment).map(key => [key, process.env[key]]))
const cwdEnv = { ...process.env, ...fixtureEnvironment }
for (const key of Object.keys(cwdEnv)) if (key.startsWith('AGENTMUX_') && !Object.hasOwn(fixtureEnvironment, key)) delete cwdEnv[key]
Object.assign(process.env, fixtureEnvironment)
const { CtxmuxClient } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
const { connectLocalAgentMux, AgentMuxFileAgentSessionStore, requestAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const receipt = { schema: 'agentmux.terminal-resume-recap-scene.v1', passed: false, temporaryRoot: root, userRuntimeTouched: false,
  captureOnly: true, aestheticReview: 'not-performed',
  startedAt: Date.now(), limitations: ['Private ordinary compiled GUI processes; no installed-package qualification.',
    'Synthetic private conversations are persisted through the public Core FileStore; no model-generated recap or real Provider conversation is claimed.'], cleanup: {} }
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
  throw new Error(`Terminal recap gate timed out: ${label}`)
}
async function cdpConnect(url) {
  const socket = new WebSocket(url), pending = new Map(), pauses = [], scripts = new Map(); let serial = 0
  const cdp = { pauses, scripts, close: () => socket.close() }; connections.add(cdp)
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Private CDP handshake timed out')), 12000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', error => { clearTimeout(timer); fail(error) }, { once: true })
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data); if (message.method === 'Debugger.scriptParsed' && message.params.url) scripts.set(message.params.url, message.params.scriptId); if (message.method === 'Debugger.paused') pauses.push(message.params)
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
  probe.cdp = await cdpConnect(page.webSocketDebuggerUrl); await probe.cdp.call('Runtime.enable'); await probe.cdp.call('Debugger.enable')
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
async function inputs() {
  const manifestPath = process.env.AGENTMUX_VERIFY_SOURCE_MANIFEST
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null, paths = []
  if (manifest) { assert.equal(manifest.sourceRoot, repositoryRoot); assert.ok(Object.keys(manifest.files).length > 5000); paths.push(...Object.keys(manifest.files)) }
  else for (const directory of ['apps/desktop/src','packages/core/src','packages/layout/src','packages/demand/src']) await visit(join(repositoryRoot, directory))
  async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path) } }
  await visit(join(desktopRoot, 'out')); await visit(join(repositoryRoot, 'packages/core/dist')); await visit(join(repositoryRoot, 'packages/demand/dist'))
  paths.push('pnpm-lock.yaml','pnpm-workspace.yaml','apps/desktop/scripts/verify-terminal-resume-recap.mjs','apps/desktop/scripts/fixtures/terminal-resume-recap/scene.mjs',
    'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd','packages/core/vendor/ctxmux/darwin-arm64/manifest.json',
    'packages/core/node_modules/@ctxmux/sdk/dist/index.js','apps/desktop/node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js',require('electron'))
  const result = Object.fromEntries(await Promise.all([...new Set(paths)].map(async path => { const full = resolve(repositoryRoot,path), bytes = await readFile(full); assert.ok(bytes.length > 0 || manifest?.files[path] === hash(bytes)); return [full, hash(bytes)] })))
  if (manifest) for (const [path, expected] of Object.entries(manifest.files)) assert.equal(result[resolve(repositoryRoot,path)], expected, path)
  receipt.source = manifest ? { originCommit: manifest.originCommit, fileCount: Object.keys(manifest.files).length, manifestSha256: hash(await readFile(manifestPath)) } : { kind: 'current Source directories' }
  return result
}
async function screenshot(label) {
  const path=join(resolve(process.env.AGENTMUX_VERIFY_RECEIPT,'..'),label+'.png')
  await mkdir(resolve(path,'..'),{recursive:true})
  await active.cdp.call('Page.enable')
  const {data}=await active.cdp.call('Page.captureScreenshot',{format:'png'})
  await writeFile(path,Buffer.from(data,'base64'))
  return {path,sha256:hash(Buffer.from(data,'base64'))}
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
let saved, empty, savedRegion, healthyRegion
async function size(width,height){await active.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').BrowserWindow.getAllWindows()[0].setSize(${width},${height})`);await delay(250)}
async function loadedRenderer(){
 const prefix=pathToFileURL(join(desktopRoot,'out/renderer/')).href
 const result={}
 for(const[url,scriptId]of active.cdp.scripts)if(url.startsWith(prefix)&&url.endsWith('.js')){
  const file=await readFile(fileURLToPath(url)), actual=await active.cdp.call('Debugger.getScriptSource',{scriptId})
  assert.equal(hash(Buffer.from(actual.scriptSource)),hash(file),`Loaded bytes differ: ${url}`);result[url]=hash(file)
 }
 assert.ok(Object.keys(result).length>0,'Actual loaded Renderer modules must be nonempty')
 return result
}
async function recap(regionId,needle){
 return waitFor('actual visible sourced recap',()=>active.cdp.evaluate(`(()=>{const rs=Array.from(document.querySelectorAll('[data-workbench-region-id="'+${JSON.stringify(regionId)}+'"]')).filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);if(rs.length!==1)return null;const e=rs[0].querySelector('.session-recap'),stage=rs[0].querySelector('.full-page-loading');if(!e||!stage||!e.textContent.includes(${JSON.stringify(needle)}))return null;const r=e.getBoundingClientRect();return {text:e.textContent,state:e.dataset.recapState,title:stage.querySelector('h1')?.textContent,width:r.width,height:r.height}})()`))
}
try {
 await Promise.all([mkdir(home,{recursive:true}),mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(runtimeDirectory,{recursive:true}),mkdir(join(home,'codex'),{recursive:true})])
 assert.ok(process.env.AGENTMUX_VERIFY_RECEIPT,'Explicit owning receipt path required')
 receipt.inputsBefore=await inputs()
 const stateDirectory=join(runtimeDirectory,'state','ctxmux');await mkdir(stateDirectory,{recursive:true,mode:0o700})
 let daemonDiagnostic=''
 daemon=spawn(join(repositoryRoot,'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),['--socket',socketPath,'--state-dir',stateDirectory],{detached:true,stdio:['ignore','ignore','pipe']});children.add(daemon);daemon.stderr.on('data',bytes=>{daemonDiagnostic=(daemonDiagnostic+bytes.toString()).slice(-16384)});await own(daemon.pid)
 sdk=new CtxmuxClient({socketPath});receipt.runtime=await waitFor('private native Runtime',async()=>{if(daemon.exitCode!==null||daemon.signalCode!==null)throw new Error(daemonDiagnostic);try{return await sdk.runtimeInfo()}catch{return null}})
 const executable=join(root,'private-agent.sh'),writer=join(root,'private-writer.sh')
 await writeFile(executable,"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.159.2'; exit 0; fi\nstty -echo -icanon\nprintf 'Private Agent ready\\r\\n'\nexec /bin/cat\n",{mode:0o700})
 await writeFile(writer,`#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli 0.159.2'; exit 0; fi\nfor arg in "$@"; do if [ "$arg" = resume ]; then sleep 3; break; fi; done\nexec ${quote(process.execPath)} ${quote(join(repositoryRoot,'packages/core/test/fixtures/fake-codex-cli.mjs'))} "$@"\n`,{mode:0o700})
 const store=new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))
 creator=await connectLocalAgentMux({store})
 const create=async(executorId,commandOverride)=>{const value=await creator.createAgent({createOperationId:randomUUID(),executorId,providerId:'codex',commandOverride,workspacePath,env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false,cols:90,rows:25});await own((await sdk.status(value.run.runId)).pid);return value}
 agent=await create('private-agent',executable);saved=await create('private-writer',writer);empty=await create('private-agent',executable)
 await waitFor('native synthetic handle',async()=>{const value=(await store.load()).find(s=>s.agentSessionId===saved.agentSessionId);return value?.nativeHandle?.sessionId?value:null})
 const body='已完成终端输入确认和恢复检查。下一步核对 Session 的上下文摘录、原工作区布局和持续读写。 Resume keeps the same conversation; this excerpt is a captured private fixture, with no model request. '
 receipt.fixtureRecap=body.repeat(6)
 await store.applyTimelineMutation({type:'append',agentSessionId:saved.agentSessionId,item:{id:'private-recap-assistant',agentSessionId:saved.agentSessionId,kind:'assistant_message',status:'complete',source:'native-hook',createdAt:Date.now(),updatedAt:Date.now(),title:'Private captured reply',content:receipt.fixtureRecap}})
 for(const target of [saved,empty]){const operation=await sdk.prepareStop(target.run.runId);await sdk.stop(operation);await waitFor('exact private target ended',async()=>(await sdk.status(target.run.runId)).state.type!=='running')}
 await creator.dispose();creator=null
 // Fixture entry state: retained conversations with no completed idle eligibility. Never user state.
 for(const target of [saved,empty]){const current=(await store.load()).find(s=>s.agentSessionId===target.agentSessionId);assert.ok(current);const now=Date.now();await store.compareAndSwap(current,{...current,updatedAt:now,semanticStatus:{state:'working',source:'native-hook',observedAt:now,stateEnteredAt:now}})}
 await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{'private-agent':{label:'Private Agent',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false},'private-writer':{label:'Private writer',providerId:'codex',command:writer,args:[],env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false}},workspaces:[{id:workspaceId,name:'Resume recap',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
 await launch('before');await click(`.project-rail-row[data-workspace-id="${workspaceId}"]`);await click('button[title="New tab"]')
 const launcher=await waitFor('workspace launcher',async()=>{const value=await observe();return value.workbench.tabs.filter(tab=>tab.workspaceId===workspaceId).flatMap(tab=>tab.regions).find(region=>region.kind==='launcher')})
 const opened=await control('agent.open',{content:{kind:'agent-session',agentSessionId:agent.agentSessionId},destination:{regionId:launcher.regionId},focus:true});assert.equal(opened.outcome,'opened');healthyRegion=opened.to
 await control('agent.view',{agentSessionId:agent.agentSessionId,mode:'terminal'})
 const restored=await control('agent.open',{content:{kind:'agent-session',agentSessionId:saved.agentSessionId},destination:{regionId:healthyRegion.regionId,split:'right'},focus:true});assert.equal(restored.outcome,'opened');savedRegion=restored.to
 await control('agent.view',{agentSessionId:saved.agentSessionId,mode:'terminal'})
 await size(1320,820);receipt.ready=await recap(savedRegion.regionId,'下一步核对');assert.equal(receipt.ready.title,'Ready to restore');assert.ok(receipt.ready.text.includes('Last assistant message'));receipt.screenshotNormal=await screenshot('normal-ready')
 await size(920,520);receipt.narrow=await recap(savedRegion.regionId,'下一步核对');receipt.screenshotNarrow=await screenshot('narrow-long-recap')
 assert.ok(savedRegion.spaceId,'The real private Space must exist')
 const newTab=await control('agent.open',{content:{kind:'agent-session',agentSessionId:empty.agentSessionId},destination:{spaceId:savedRegion.spaceId,newTab:true},focus:true});assert.equal(newTab.outcome,'opened')
 await control('agent.view',{agentSessionId:empty.agentSessionId,mode:'terminal'})
 receipt.empty=await waitFor('honest unavailable recap',()=>active.cdp.evaluate(`(()=>{const e=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(newTab.to.regionId)}+'"] .session-recap');return e&&e.dataset.recapState!=='loading'?{text:e.textContent,state:e.dataset.recapState}:null})()`));assert.notEqual(receipt.empty.state,'ready');receipt.screenshotEmpty=await screenshot('unavailable-recap')
 await control('focus',{target:{kind:'space',regionId:savedRegion.regionId},inputPolicy:'preserve'});await size(1320,820)
 // A real draft is entered through the product's controlled input and survives quit/relaunch.
 const draft='UNSENT RECAP RECOVERY DRAFT'
 const composerSelector=`[data-workbench-region-id="${savedRegion.regionId}"] .composer__editor [contenteditable="true"]`
 await click(composerSelector);await active.cdp.call('Input.insertText',{text:draft})
 receipt.draftBefore=await waitFor('actual ProseMirror draft input',()=>active.cdp.evaluate(`document.querySelector(${JSON.stringify(composerSelector)})?.textContent===${JSON.stringify(draft)}?${JSON.stringify(draft)}:null`));assert.equal(receipt.draftBefore,draft)
 receipt.inputBefore=await healthyInput(healthyRegion.regionId,agent.run.runId,'PRIVATE_RECAP_HEALTHY_BEFORE')
 receipt.before=await observe();receipt.loadedBefore=await loadedRenderer();const healthyBefore=await sdk.status(agent.run.runId)
 receipt.firstQuit=await quit(active);await launch('after');receipt.after=await observe();assert.notEqual(receipt.before.main.pid,receipt.after.main.pid);assert.deepEqual(durableWorkbench(receipt.after),durableWorkbench(receipt.before))
 receipt.recappedAfter=await recap(savedRegion.regionId,'下一步核对');assert.equal(receipt.recappedAfter.text,receipt.ready.text)
 receipt.draftAfter=await waitFor('durable ProseMirror draft',()=>active.cdp.evaluate(`document.querySelector(${JSON.stringify(composerSelector)})?.textContent===${JSON.stringify(draft)}?${JSON.stringify(draft)}:null`));assert.equal(receipt.draftAfter,draft)
 receipt.inputAfter=await healthyInput(healthyRegion.regionId,agent.run.runId,'PRIVATE_RECAP_HEALTHY_AFTER');const healthyAfter=await sdk.status(agent.run.runId);assert.equal(healthyAfter.pid,healthyBefore.pid);assert.equal(healthyAfter.state.type,'running');receipt.healthyRun={id:healthyAfter.id,pid:healthyAfter.pid,state:healthyAfter.state};receipt.screenshotRestart=await screenshot('after-process-restart')
 receipt.loadedAfter=await loadedRenderer();assert.deepEqual(receipt.loadedAfter,receipt.loadedBefore)
 phase='actual-resume';const resumeSelector=`[data-workbench-region-id="${savedRegion.regionId}"] .terminal-recovery__actions button`
 await click(resumeSelector);receipt.resuming=await waitFor('actual Resume remains alongside recap',()=>active.cdp.evaluate(`(()=>{const r=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(savedRegion.regionId)}+'"]'),b=r.querySelector('.terminal-recovery__actions button'),e=r.querySelector('.session-recap');return b?.textContent.includes('Resuming')&&e?.textContent.includes('下一步核对')?{button:b.textContent,disabled:b.disabled,recap:e.textContent}:null})()`));receipt.screenshotResuming=await screenshot('actual-resuming')
 receipt.resumed=await waitFor('same Session genuinely resumed',async()=>{const snapshot=await active.cdp.evaluate('(async()=>await window.agentmux.sessions.snapshot())()');const s=snapshot.sessions.find(s=>s.id===saved.agentSessionId);return s?.processState==='running'&&s.control.run.runId!==saved.run.runId?{sessionId:s.id,runId:s.control.run.runId}:null});await own((await sdk.status(receipt.resumed.runId)).pid)
 receipt.inputAfterResume=await healthyInput(healthyRegion.regionId,agent.run.runId,'PRIVATE_RECAP_HEALTHY_AFTER_RESUME')
 assert.deepEqual(await sdk.runtimeInfo(),receipt.runtime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid));receipt.inputsAfter=await inputs();assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore)
 receipt.secondQuit=await quit(active);receipt.passed=true
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
const output=process.env.AGENTMUX_VERIFY_RECEIPT??join(repositoryRoot,'.tmp/terminal-resume-recap/scene.json');await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,failure:receipt.failure,cleanup:receipt.cleanup})+'\n');process.exitCode=receipt.passed?0:1
