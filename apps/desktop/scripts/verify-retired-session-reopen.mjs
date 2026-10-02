import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// The first ordinary GUI loader receives one explicit private seed through the
// existing seed helper; the second GUI starts unseeded. Both keep the actual
// compiled Main/preload/Renderer, public owners and original Region action.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-retired-continue-")), home = join(root, 'home'), userData = join(root, 'user-data')
const runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), workspaceId = 'private-retired-continue'
const socketPath = join(runtimeDirectory, 'ctxmux.sock'), deadline = Date.now() + 180000
const fixtureEnvironment = { HOME: home, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: join(home, 'codex') }
const environmentBefore = new Map(Object.keys(fixtureEnvironment).map(key => [key, process.env[key]]))
const cwdEnv = { ...process.env, ...fixtureEnvironment }
for (const key of Object.keys(cwdEnv)) if (key.startsWith('AGENTMUX_') && !Object.hasOwn(fixtureEnvironment, key)) delete cwdEnv[key]
Object.assign(process.env, fixtureEnvironment)
const { CtxmuxClient } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
const { connectLocalAgentMux, AgentMuxFileAgentSessionStore, connectAgentMuxRpc } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const receipt = { schema: 'agentmux.retired-native-reopen-recovery.v1', passed: false, temporaryRoot: root, userRuntimeTouched: false,
  startedAt: Date.now(), limitations: ['Private ordinary compiled GUI processes; no installed-package qualification.',
    'The first GUI wraps its first ordinary loadFile only to install the explicit private seed with the existing helper, preserving the original loader and token handshake. The second GUI has no wrapper, seed or ready flags.',
    'Explicit continue retains the original AgentSession/native conversation and creates a new Run. No original target PTY continuity claim.'], cleanup: {} }
const children = new Set(), owners = new Map(), connections = new Set(), probes = []
let phase = 'prepare', failure, daemon, sdk, creator, active, agent, healthy
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 1500 })).stdout.trim() }
  catch (error) { if (error.code === 1) return ''; throw error }
}
async function own(pid) { assert.ok(pid > 1); const birth = await identity(pid); assert.ok(birth); owners.set(pid, birth) }
async function waitFor(label, read, budget = 25000, cleanup = false) {
  const end = cleanup ? Date.now() + budget : Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
  throw new Error(`Retired continue gate timed out: ${label}`)
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
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock.desktop') } })
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
async function launch(label, seed) {
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
  if (seed) {
    const installed = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
      expression: `(() => {
        if (typeof BrowserWindow !== 'function' || typeof installRecoverySeedBeforeLoad !== 'function') throw new Error('Compiled ordinary seed helper is unavailable');
        const original = BrowserWindow.prototype.loadFile;
        BrowserWindow.prototype.loadFile = async function(file, ...options) {
          if (file !== ${JSON.stringify(join(desktopRoot, 'out/renderer/index.html'))}) return await original.call(this, file, ...options);
          BrowserWindow.prototype.loadFile = original;
          globalThis.__privateRecoverySeedWrapperInvoked = (globalThis.__privateRecoverySeedWrapperInvoked ?? 0) + 1;
          const release = await installRecoverySeedBeforeLoad(this.webContents, file, ${JSON.stringify(JSON.stringify(seed))});
          try { return await original.call(this, file, ...options) }
          finally { await release() }
        };
        return true;
      })()`, returnByValue: true })
    assert.equal(installed.exceptionDetails, undefined); assert.equal(installed.result.value, true)
  }
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await main.call('Debugger.resume')
  const probe = { child, main, label, startup: seed ? 'ordinary-loader-with-explicit-private-seed' : 'ordinary-unseeded', diagnostics: () => diagnostics }; probes.push(probe); active = probe
  const endpoint = new URL(await waitFor('Renderer debugger', () => { alive(); return rendererUrl }))
  const page = await waitFor('real loaded Renderer', async () => { alive(); return (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(row => row.type === 'page' && row.url.startsWith('file:')) })
  probe.cdp = await cdpConnect(page.webSocketDebuggerUrl); await probe.cdp.call('Runtime.enable')
  await waitFor('public IPC and loaded Store', () => probe.cdp.evaluate('Boolean(window.agentmux && document.querySelector(".window-status-bar"))'))
  await waitFor('actual client readiness', async () => { try { const value = await observe(); return !value.workbench.loading ? value : null } catch { alive(); return null } })
  if (seed) assert.equal(await main.evaluate('globalThis.__privateRecoverySeedWrapperInvoked'), 1)
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
async function inputs() {
  const manifestPath = process.env.AGENTMUX_VERIFY_SOURCE_MANIFEST
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null, paths = []
  if (manifest) { assert.equal(manifest.sourceRoot, repositoryRoot); assert.ok(Object.keys(manifest.files).length > 5000); paths.push(...Object.keys(manifest.files)) }
  else for (const directory of ['apps/desktop/src','packages/core/src','packages/layout/src','packages/demand/src']) await visit(join(repositoryRoot, directory))
  async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path) } }
  await visit(join(desktopRoot, 'out')); await visit(join(repositoryRoot, 'packages/core/dist')); await visit(join(repositoryRoot, 'packages/demand/dist'))
  paths.push('pnpm-lock.yaml','pnpm-workspace.yaml','apps/desktop/scripts/verify-retired-session-reopen.mjs',
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
async function ownPrivateHost() {
  const storePath = join(userData, 'agent-sessions.json'), entry = join(desktopRoot, 'out/main/agentmux-host.js')
  const rows = (await exec('/bin/ps', ['-axo', 'pid=,command='])).stdout.split('\n')
    .filter(row => row.includes(entry) && row.includes(`--store ${storePath}`))
  assert.equal(rows.length, 1, 'Only one exact private semantic Host owns the fixture Store')
  const pid = Number(rows[0].trim().split(/\s+/, 1)[0]); await own(pid)
  return { pid, entry, storePath, birth: owners.get(pid) }
}
async function canonical(sid) {
  const store = new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
  return (await store.load()).find(session => session.agentSessionId === sid)
}
async function historyButton(label) {
  const expression = `(() => { const region=document.querySelector('[data-workbench-region-id="retired-region"]');
    const buttons=Array.from(region?.querySelectorAll('button')??[]).filter(button=>button.textContent.trim()===${JSON.stringify(label)}&&button.getClientRects().length);
    if(buttons.length!==1)return false;buttons[0].focus();return document.activeElement===buttons[0] })()`
  await waitFor('exact real history action '+label, () => active.cdp.evaluate(expression))
  await active.cdp.call('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:36, text:'\r', unmodifiedText:'\r' })
  await active.cdp.call('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:36 })
}

try {
  assert.ok(process.env.AGENTMUX_VERIFY_RECEIPT, 'Explicit owning receipt required')
  await Promise.all([mkdir(home,{recursive:true}),mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(runtimeDirectory,{recursive:true})])
  receipt.inputsBefore=await inputs()
  const stateDirectory=join(runtimeDirectory,'state','ctxmux');await mkdir(stateDirectory,{recursive:true,mode:0o700})
  daemon=spawn(join(repositoryRoot,'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),['--socket',socketPath,'--state-dir',stateDirectory],{detached:true,stdio:['ignore','ignore','pipe']});children.add(daemon);await own(daemon.pid)
  sdk=new CtxmuxClient({socketPath});receipt.runtime=await waitFor('private actual Runtime',async()=>{try{return await sdk.runtimeInfo()}catch{return null}})
  const cli=join(root,'private-native.mjs'), executable=join(root,'private-native.sh'), transcript=join(root,'original-native.jsonl')
  await writeFile(cli,("import {randomUUID} from 'node:crypto';import {existsSync,writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);if(args.includes('--version')){console.log('Private Claude fixture 1');process.exit(0)}\nconst sid=process.env.AGENTMUX_AGENT_SESSION_ID, resume=args.indexOf('--resume');const native=resume<0?'native-'+sid:args[resume+1];\nconst path=process.env.PRIVATE_NATIVE_PATH;if(!existsSync(path))writeFileSync(path,JSON.stringify({sessionId:native,uuid:'original-user',type:'user',timestamp:'" + _hygiene_fixtureIso(23760000000, "second") + "',message:{role:'user',content:'Original native conversation retained'}})+'\\n');\nawait fetch(process.env.AGENTMUX_HOOK_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.AGENTMUX_HOOK_TOKEN,'content-type':'application/json'},body:JSON.stringify({receiptId:randomUUID(),payload:{hook_event_name:'SessionStart',session_id:native,transcript_path:path}})});\nprocess.stdout.write('Private original-native CLI ready\\r\\n');process.stdin.on('data',data=>process.stdout.write(data));process.stdin.resume();"))
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'"
  await writeFile(executable,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,{mode:0o700})
  creator=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
  agent=await creator.createAgent({createOperationId:randomUUID(),providerId:'claude',executorId:'private-native',commandOverride:executable,workspacePath,env:{PRIVATE_NATIVE_PATH:transcript},injectAgentMuxGuide:false})
  healthy=await creator.createAgent({createOperationId:randomUUID(),providerId:'claude',executorId:'private-healthy',commandOverride:executable,workspacePath,env:{PRIVATE_NATIVE_PATH:join(root,'healthy-native.jsonl')},injectAgentMuxGuide:false})
  const original=await waitFor('actual original native Hook identity',async()=>{const value=await canonical(agent.agentSessionId);return value?.nativeHandle?.kind==='provider'?value:null})
  const healthyBefore=await sdk.status(healthy.run.runId);await own(healthyBefore.pid)
  receipt.originalIdentity={agentSessionId:original.agentSessionId,providerId:original.providerId,executorId:original.executorId,workspacePath:original.workspacePath,createdAt:original.createdAt,nativeHandle:original.nativeHandle,run:original.run}
  receipt.nativeBefore=hash(await readFile(transcript));receipt.timelineBefore=await creator.sessionTimeline(agent.agentSessionId)
  await creator.stopAgent(agent.agentSessionId,agent.run)
  receipt.retirement=(await creator.sessionHistorySources()).find(source=>source.agentSessionId===agent.agentSessionId)
  assert.equal(receipt.retirement.state,'retired');assert.equal((await sdk.status(agent.run.runId)).state.type,'exited')
  await creator.dispose();creator=null
  const config={version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{'private-native':{label:'Private native continuation',providerId:'claude',command:executable,args:[],env:{PRIVATE_NATIVE_PATH:transcript},injectAgentMuxGuide:false},'private-healthy':{label:'Unrelated healthy CLI',providerId:'claude',command:executable,args:[],env:{PRIVATE_NATIVE_PATH:join(root,'healthy-native.jsonl')},injectAgentMuxGuide:false}},workspaces:[{id:workspaceId,name:'Private continuation',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify(config))
  const region=(id,session)=>({kind:'agent',phase:'attached',regionId:id,workspaceId,sessionId:session.agentSessionId})
  const seed={version:1,state:{activeWorkspaceId:workspaceId,mainSurface:'workbench',agentComposerDrafts:{[agent.agentSessionId]:'Original unsent draft'},agentFocus:{execution:{sessionId:agent.agentSessionId,history:[]},pmo:{sessionId:null}},restoredWorkbench:{tabs:{'original-tab':{id:'original-tab',workspaceId,titleRegionId:'retired-region',layout:{root:{type:'split',direction:'horizontal',ratio:.61,first:{type:'leaf',regionId:'retired-region'},second:{type:'leaf',regionId:'healthy-region'}},activeRegionId:'retired-region'},regions:{'retired-region':region('retired-region',agent),'healthy-region':region('healthy-region',healthy)}}},layouts:{[workspaceId]:{root:{type:'leaf',groupId:'original-group'},groups:[{id:'original-group',tabOrder:['original-tab'],activeTabId:'original-tab',recentTabIds:['original-tab']}],activeGroupId:'original-group'}}}}}
  await launch('before',seed);receipt.host=await ownPrivateHost()
  await waitFor('real retired card',()=>active.cdp.evaluate(`document.querySelector('[data-workbench-region-id="retired-region"]')?.textContent.includes('Session closed')`))
  await historyButton('Read conversation history')
  await waitFor('original native body',()=>active.cdp.evaluate(`document.querySelector('[data-workbench-region-id="retired-region"]')?.textContent.includes('Original native conversation retained')`))
  receipt.before=await observe();receipt.draftBefore=await active.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.agentComposerDrafts`)
  assert.ok(receipt.before.workbench.tabs.some(tab=>tab.id==='original-tab'&&tab.regions.length===2));assert.equal(receipt.draftBefore[agent.agentSessionId],'Original unsent draft')
  receipt.runsBefore=(await sdk.list()).map(run=>run.id).sort();receipt.screenshotBefore=await screenshot('retained-history-before')
  assert.equal((await canonical(agent.agentSessionId)),undefined);assert.deepEqual((await sdk.list()).map(run=>run.id).sort(),receipt.runsBefore)
  receipt.firstQuit=await quit(active)
  await launch('after');receipt.after=await observe()
  assert.notEqual(receipt.after.main.pid,receipt.before.main.pid);assert.deepEqual(durableWorkbench(receipt.after),durableWorkbench(receipt.before))
  assert.deepEqual(await active.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.agentComposerDrafts`),receipt.draftBefore)
  await historyButton('Read conversation history');await waitFor('restored original native body',()=>active.cdp.evaluate(`document.querySelector('[data-workbench-region-id="retired-region"]')?.textContent.includes('Original native conversation retained')`))
  assert.deepEqual((await sdk.list()).map(run=>run.id).sort(),receipt.runsBefore);receipt.readingCreatedRuns=0
  phase='explicit-keyboard-continue';await historyButton('Continue session')
  const continued=await waitFor('same canonical Session continued',async()=>{const value=await canonical(agent.agentSessionId);return value&&value.run.runId!==agent.run.runId?value:null})
  for(const key of ['agentSessionId','providerId','executorId','workspacePath','createdAt','nativeHandle'])assert.deepEqual(continued[key],receipt.originalIdentity[key],key)
  assert.ok(continued.retiredRuns.some(run=>run.runId===agent.run.runId));assert.deepEqual(continued.reopenedFrom,{run:agent.run,source:'user',observedAt:receipt.retirement.retiredAt})
  const nextRun=await sdk.status(continued.run.runId);await own(nextRun.pid);assert.equal(nextRun.state.type,'running');assert.equal(nextRun.applied_input_bytes,0)
  const settled=await waitFor('original Region receives canonical new Run',async()=>{const value=await observe(),region=value.workbench.tabs.find(tab=>tab.id==='original-tab')?.regions.find(region=>region.regionId==='retired-region');return region?.control?.run?.runId===continued.run.runId&&region.processState==='running'?value:null})
  assert.equal(settled.workbench.tabs.find(tab=>tab.id==='original-tab').regions.length,2);assert.deepEqual(settled.workbench.layouts,receipt.after.workbench.layouts);assert.deepEqual(settled.workbench.focus,receipt.after.workbench.focus)
  assert.deepEqual(await active.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.agentComposerDrafts`),receipt.draftBefore)
  const healthyAfter=await sdk.status(healthy.run.runId);assert.equal(healthyAfter.pid,healthyBefore.pid);assert.equal(healthyAfter.state.type,'running');assert.equal(healthyAfter.applied_input_bytes,healthyBefore.applied_input_bytes)
  assert.equal(hash(await readFile(transcript)),receipt.nativeBefore)
  const store=new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'));const timeline=await store.loadTimeline(agent.agentSessionId)
  for(const item of receipt.timelineBefore.items)assert.deepEqual(timeline.items.find(current=>current.id===item.id),item)
  assert.deepEqual((await sdk.list()).map(run=>run.id).sort(),[...receipt.runsBefore,continued.run.runId].sort());assert.deepEqual(await sdk.runtimeInfo(),receipt.runtime)
  receipt.continued={session:continued,run:{id:nextRun.id,pid:nextRun.pid,inputBytes:nextRun.applied_input_bytes},healthy:{id:healthyAfter.id,pid:healthyAfter.pid,inputBytes:healthyAfter.applied_input_bytes},observation:settled}
  receipt.screenshotAfter=await screenshot('same-session-continued');receipt.inputsAfter=await inputs();assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore)
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
receipt.guis=probes.map(probe=>({label:probe.label,startup:probe.startup,pid:probe.child.pid,exitCode:probe.child.exitCode,signalCode:probe.child.signalCode,ordinaryQuit:probe.exit??null,diagnostics:probe.diagnostics()}));receipt.finishedAt=Date.now();receipt.failure=failure??null
const output=process.env.AGENTMUX_VERIFY_RECEIPT??join(repositoryRoot,'.tmp/retired-native-reopen-last.json');await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,failure:receipt.failure,cleanup:receipt.cleanup})+'\n');process.exitCode=receipt.passed?0:1
