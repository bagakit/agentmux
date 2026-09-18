import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp, lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { brandApplication, copyRuntimeApplication, installApplication, reportInstallTransaction } from './package-macos.mjs'
import { observeUiClient } from './package-runtime-upgrade.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { classifyApplicationProcesses } from './package-process-scope.mjs'
import { packageIdentityPath } from './package-identity.mjs'

// Real signed private Apps, compiled product Main/preload/Renderer, public Control,
// original SDK listener and installer directory transaction. Launch/ordinary quit IO
// use the existing private pre-home Inspector seam, not LaunchServices or user UI.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const coldOnly = process.argv.includes('--cold-only')
const candidateInput = process.env.AGENTMUX_VERIFY_CANDIDATE_APP ?? null
const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-ui-install-'), home = join(root, 'home'), userData = join(root, 'user-data')
const runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), workspaceId = 'private-ui-install'
const destination = join(home, 'Applications/AgentMux.app'), candidate = join(root, 'candidate/AgentMux.app')
const failedCandidate = join(root, 'failed/AgentMux.app'), unrestoredCandidate = join(root, 'unrestored/AgentMux.app'), socketPath = join(runtimeDirectory, 'ctxmux.sock')
const oldArtifacts = process.env.AGENTMUX_VERIFY_PREVIOUS_ARTIFACTS ?? join(repositoryRoot, '.tmp/ctxmux-wal-capacity-worktree/.tmp/wal-release-artifacts')
const fixtureEnvironment = { HOME: home, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: join(home, 'codex') }
const environmentBefore = new Map(Object.keys(fixtureEnvironment).map(key => [key, process.env[key]]))
const children = new Set(), connections = new Set(), owners = new Map(), probes = []
const deadline = Date.now() + 300000
const receipt = { schema: 'agentmux.ui-native-install-continuity.v1', passed: false, userRuntimeTouched: false,
  temporaryRoot: root, startedAt: Date.now(), limitations: ['Actual private compiled Apps; launch and graceful quit IO use public Electron Inspector isolation, not OS LaunchServices.',
    'Both observation-capable GUI bundles use the recorded candidate input; installer source is separately bound. Original Native differs from bundled Native.',
    'This does not qualify the currently installed old1b user GUI or prove all terminal performance/codec behavior.'], cleanup: {} }
let phase = 'prepare', failure, daemon, sdk, creator, active, server, agent, terminal
const cwdEnv = { ...process.env, ...fixtureEnvironment }
for (const key of Object.keys(cwdEnv)) if (key.startsWith('AGENTMUX_') && !Object.hasOwn(fixtureEnvironment, key)) delete cwdEnv[key]
Object.assign(process.env, fixtureEnvironment)
const { CtxmuxClient } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
const { connectLocalAgentMux, AgentMuxFileAgentSessionStore, requestAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 1500 })).stdout.trim() }
  catch (error) { if (error.code === 1) return ''; throw error }
}
async function own(child) { assert.ok(child.pid > 1); const birth = await identity(child.pid); assert.ok(birth); owners.set(child.pid, birth) }
async function waitFor(label, read, budget = 25000, cleanup = false) {
  const end = cleanup ? Date.now() + budget : Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(60) }
  throw new Error(`UI install gate timed out: ${label}`)
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
async function launch(appPath) {
  phase = 'launch-private-gui'
  const child = spawn(join(appPath, 'Contents/MacOS/AgentMux'), ['--inspect-brk=0', '--remote-debugging-port=0'], {
    cwd: root, env: cwdEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  children.add(child); let spawnError, diagnostics = '', mainUrl, rendererUrl, main
  child.on('error', error => { spawnError = error }); child.stderr.on('data', bytes => {
    diagnostics = (diagnostics + bytes.toString()).slice(-16384)
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    if (diagnostics.includes('Waiting for the debugger to disconnect')) main?.close()
  })
  await own(child)
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Private GUI exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  main = await cdpConnect(await waitFor('Main inspector', () => { alive(); return mainUrl }))
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  const mainPath = join(appPath, 'Contents/Resources/app/out/main/index.js'), lines = (await readFile(mainPath, 'utf8')).split('\n')
  const anchors = lines.flatMap((line, index) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [index] : [])
  assert.equal(anchors.length, 1, 'Exactly one compiled pre-home boundary is required')
  const breakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor('initial Main pause', () => main.pauses.shift())
  if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) { await main.call('Debugger.resume'); paused = await waitFor('exact pre-home pause', () => main.pauses.shift()) }
  assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId))
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: `(() => { app.setPath('home',${JSON.stringify(home)}); return app.getPath('home') })()`, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined); assert.equal(isolated.result.value, home)
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await main.call('Debugger.resume')
  const probe = { child, main, appPath, diagnostics: () => diagnostics }; probes.push(probe); active = probe
  const endpoint = new URL(await waitFor('Renderer debugger', () => { alive(); return rendererUrl }))
  const page = await waitFor('real loaded Renderer', async () => { alive(); return (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(row => row.type === 'page' && row.url.startsWith('file:')) })
  probe.cdp = await cdpConnect(page.webSocketDebuggerUrl); await probe.cdp.call('Runtime.enable')
  // Let startup create its actual Browser/Renderer helpers before collecting
  // the process scope. This checks readiness only, never the original workbench
  // or serving/Run agreement that the installer must independently qualify.
  await waitFor('public IPC and loaded Store', () => probe.cdp.evaluate('Boolean(window.agentmux && document.querySelector(".project-list"))'))
  await waitFor('current client readiness', async () => { try { const observed = await observeUiClient(appPath); return !observed.workbench.loading && observed.main.package ? observed : null } catch (error) { alive(); return null } })
  const processes = classifyApplicationProcesses((await exec('/bin/ps', ['-axo', 'pid=,command='])).stdout, {
    executable: join(appPath, 'Contents/MacOS/AgentMux'), helperRoot: join(appPath, 'Contents/Frameworks') + '/'
  }).serving
  assert.ok(processes.includes(child.pid)); probe.servingPids = processes
  return processes
}
async function quit(appPath, cleanup = false) {
  const probe = active; assert.equal(probe.appPath, appPath)
  assert.equal(await identity(probe.child.pid), owners.get(probe.child.pid))
  let responseError = null
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(appPath,'Contents/Resources/app/package.json'))})('electron').app.quit()`) }
  catch (error) { responseError = error.message }
  probe.main.close(); probe.cdp?.close()
  await waitFor('ordinary GUI exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null, 25000, cleanup)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null)
  probe.exit = { code: 0, signal: null, responseError }; probe.main.close(); probe.cdp?.close()
  return { wasRunning: true, pids: [probe.child.pid] }
}
async function click(selector) {
  const point = await waitFor('exact actual UI control', () => active.cdp.evaluate(`(() => { const es=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getClientRects().length); if(es.length!==1)return null; const r=es[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function control(operation, fields = {}) { return requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation, ...fields }, join(runtimeDirectory, 'control.sock')) }
async function dragOriginalSplit() {
  const before=await observeUiClient(destination), tab=before.workbench.tabs.find(tab=>tab.regions.some(region=>region.regionId===terminal.regionId))
  assert.equal(tab.layout.root.type,'split');const ratio=tab.layout.root.ratio
  const point=await active.cdp.evaluate(`(() => {const split=Array.from(document.querySelectorAll('.workbench-region-split')).find(e=>e.getClientRects().length);const handle=split&&Array.from(split.children).find(e=>e.classList.contains('workbench-region-resize-handle'));if(!handle)return null;const r=handle.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  assert.ok(point)
  await active.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
  await active.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point})
  await active.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:point.x+24,y:point.y})
  await active.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x+24,y:point.y})
  const changed=await waitFor('actual split gesture persisted by its product owner',async()=>{const observed=await observeUiClient(destination),root=observed.workbench.tabs.find(row=>row.id===tab.id)?.layout.root;return root?.type==='split'&&Math.abs(root.ratio-ratio)>0.001?root.ratio:null})
  receipt.actualSplitGesture={beforeRatio:ratio,afterRatio:changed}
}
async function mountedTerminal() {
  return await waitFor('actual mounted Terminal and authoritative grid', async () => {
    await active.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const fits = await active.cdp.evaluate(`(() => { const region=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(terminal.regionId)}+'"]');const viewport=region?.querySelector('.terminal-view__xterm'),screen=region?.querySelector('.xterm-screen');if(!viewport||!screen)return false;const a=viewport.getBoundingClientRect(),b=screen.getBoundingClientRect();return a.width>50&&b.width<=a.width+1&&b.width>a.width-32 })()`)
    const inspected = await control('inspect.region', { target: { kind: 'region', regionId: terminal.regionId } })
    const view = inspected.result.region.terminalView, run = await sdk.status(terminal.runId)
    return fits && view?.runId === terminal.runId && view.liveReady && view.viewGrid.cols === run.current_size?.cols &&
      view.viewGrid.rows === run.current_size?.rows ? run : null
  })
}
async function nativePages(url) {
  return await waitFor('actual visible Browser owner and current DOM bounds', async () => {
    const stage = await active.cdp.evaluate(`(() => {const e=document.querySelector('[data-native-browser-stage]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    const page = await active.main.evaluate(`(async () => { const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(active.appPath,'Contents/Resources/app/package.json'))})('electron');const w=BrowserWindow.getAllWindows()[0];if(!w)return null; const matches=w.contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL()===${JSON.stringify(url)});if(matches.length!==1)return null;const v=matches[0],b=v.getBounds();if(b.width<50||b.height<50)return null;const text=await v.webContents.executeJavaScript('document.querySelector("h1")?.textContent');return text==='Private install Browser'?{url:v.webContents.getURL(),text,bounds:b}:null })()`)
    return page && stage && ['x','y','width','height'].every(key => Math.abs(page.bounds[key]-stage[key])<2) ? page : null
  })
}
function projectObservation(observation) { return { pid: observation.main.pid, package: observation.main.package, renderer: observation.main.renderer,
  runtime: observation.main.runtimes, workbench: observation.workbench } }
function retainedWorkbench(workbench) { return { activeWorkspaceId: workbench.activeWorkspaceId,
  mainSurface: workbench.mainSurface, focus: workbench.focus, layouts: workbench.layouts,
  tabs: workbench.tabs.map(tab => ({ ...tab,
  regions: tab.regions.map(region => { if(region.kind!=='browser')return region;const {navigationId,loading,error,...descriptor}=region;return descriptor }) })) } }
async function healthyInput(label) {
  const snapshot = await active.cdp.evaluate('(async()=>await window.agentmux.sessions.snapshot())()')
  const current = snapshot.sessions.find(session => session.id === agent.agentSessionId)
  assert.equal(current?.processState, 'running'); assert.deepEqual(current.control.run, agent.run)
  const before = await sdk.status(agent.run.runId)
  await active.cdp.evaluate(`window.agentmux.sessions.write(${JSON.stringify(current.control)},${JSON.stringify(label)},'user')`)
  const after = await waitFor('actual original Agent input receipt', () => sdk.status(agent.run.runId), 10000).then(async row => {
    if (row.applied_input_bytes < before.applied_input_bytes + Buffer.byteLength(label)) return await waitFor('original Agent input bytes', async () => { const run = await sdk.status(agent.run.runId); return run.applied_input_bytes === before.applied_input_bytes + Buffer.byteLength(label) ? run : null })
    return row
  })
  assert.equal(after.pid, before.pid); assert.equal(after.state.type, 'running')
  assert.equal(after.applied_input_bytes, before.applied_input_bytes + Buffer.byteLength(label))
  await waitFor('original PTY nonempty output', async () => { const attachment=await sdk.attach(agent.run.runId,0);try{return Buffer.concat(attachment.snapshot.replay.chunks.map(chunk=>Buffer.from(chunk.data))).includes(Buffer.from(label))}finally{attachment.close()} })
  return { pid: after.pid, run: after.id, inputBefore: before.applied_input_bytes, inputAfter: after.applied_input_bytes, outputBytes: after.latest_output_bytes }
}
async function inputs() {
  const paths = ['apps/desktop/scripts/package-macos.mjs','apps/desktop/scripts/package-runtime-upgrade.mjs','apps/desktop/scripts/verify-terminal-ui-install-continuity.mjs',
    'apps/desktop/src/shared/client-observation.ts','apps/desktop/src/main/client-observation.ts','apps/desktop/src/main/renderer-updates.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/renderer/src/store.ts',
    'packages/core/src/control.ts','packages/core/src/control-host.ts','packages/core/src/ctxmux-run-adapter.ts','packages/core/src/runtime-paths.ts','pnpm-lock.yaml']
  async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path=join(directory,entry.name); if(entry.isDirectory())await visit(path);else if(entry.isFile())paths.push(path) } }
  await visit(join(repositoryRoot,'apps/desktop/out')); await visit(join(repositoryRoot,'packages/core/dist'))
  if(candidateInput){
    const app=join(candidateInput,'Contents/Resources/app')
    for(const directory of ['out','node_modules/@agentmux/core/dist','node_modules/@agentmux/core/vendor'])await visit(join(app,directory))
    paths.push(packageIdentityPath(candidateInput),join(candidateInput,'Contents/MacOS/AgentMux'))
  }
  paths.push(join(oldArtifacts,'bin/ctxmuxd'),join(oldArtifacts,'manifest.json'),join(oldArtifacts,'ctxmux-sdk-0.0.0.tgz'),require('electron'))
  return Object.fromEntries(await Promise.all(paths.map(async path=>{const full=path.startsWith('/')?path:join(repositoryRoot,path);return [full,hash(await readFile(full))]})))
}
const hardDeadline = setTimeout(() => { failure ??= {phase,message:'Private UI transaction exceeded its 300s deadline'}; for(const child of children) { if(child.pid>1) void identity(child.pid).then(birth=>birth&&birth===owners.get(child.pid)?stopProbeProcesses(child.pid,root):undefined).catch(()=>{}) } }, 300000)
hardDeadline.unref()
try {
  await Promise.all([mkdir(home,{recursive:true}),mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(runtimeDirectory,{recursive:true}),mkdir(join(home,'codex'),{recursive:true})])
  receipt.inputsBefore=await inputs(); receipt.source={commit:(await exec('git',['rev-parse','HEAD'],{cwd:repositoryRoot})).stdout.trim(),tree:(await exec('git',['rev-parse','HEAD^{tree}'],{cwd:repositoryRoot})).stdout.trim()}
  const fixtureRoot=join(root,'original-native');await cp(oldArtifacts,fixtureRoot,{recursive:true})
  const oldDaemon=join(fixtureRoot,'bin/ctxmuxd');receipt.originalNativeSha256=hash(await readFile(oldDaemon));receipt.bundleNativeSha256=hash(await readFile(join(repositoryRoot,'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd')));assert.notEqual(receipt.originalNativeSha256,receipt.bundleNativeSha256)
  daemon=spawn(oldDaemon,['--socket',socketPath,'--state-dir',join(runtimeDirectory,'state')],{detached:true,stdio:['ignore','ignore','pipe']});children.add(daemon)
  let daemonError;daemon.on('error',error=>{daemonError=error});daemon.stderr.on('data',()=>{});await own(daemon)
  sdk=new CtxmuxClient({socketPath});const originalRuntime=await waitFor('original public Native',async()=>{if(daemonError)throw daemonError;try{return await sdk.runtimeInfo()}catch{return null}});receipt.originalRuntime=originalRuntime;receipt.daemonPid=daemon.pid
  const executable=join(root,'private-agent.sh');await writeFile(executable,"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.159.2'; exit 0; fi\nstty -echo -icanon\nprintf 'Private Agent ready\\r\\n'\nexec /bin/cat\n",{mode:0o700})
  creator=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
  agent=await creator.createAgent({createOperationId:randomUUID(),executorId:'private-agent',providerId:'codex',commandOverride:executable,workspacePath,env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false,cols:90,rows:25})
  const agentRun=await sdk.status(agent.run.runId);assert.equal(agentRun.state.type,'running');owners.set(agentRun.pid,await identity(agentRun.pid));receipt.agent={session:agent.agentSessionId,run:agent.run.runId,pid:agentRun.pid}
  await creator.dispose();creator=null
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{'private-agent':{label:'Private Agent',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false}},workspaces:[{id:workspaceId,name:'Private UI install',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
  await mkdir(join(root,'candidate'),{recursive:true})
  if(candidateInput){
    await exec('/bin/cp',['-cR',candidateInput,candidate],{timeout:90000})
    receipt.candidateInput={path:candidateInput,package:JSON.parse(await readFile(packageIdentityPath(candidateInput),'utf8')),
      mainSha256:hash(await readFile(join(candidateInput,'Contents/Resources/app/out/main/index.js')))}
  }else{
    await exec('/bin/cp',['-cR',join(require.resolve('electron/package.json'),'../dist/Electron.app'),candidate],{timeout:30000})
    await brandApplication(candidate);await copyRuntimeApplication(candidate,receipt.source)
  }
  await exec('/usr/bin/plutil',['-replace','CFBundleIdentifier','-string',`dev.agentmux.private-ui-${randomUUID()}`,join(candidate,'Contents/Info.plist')])
  await exec('/usr/bin/codesign',['--force','--deep','--sign','-',candidate],{timeout:30000,maxBuffer:1024*1024})
  await mkdir(join(home,'Applications'),{recursive:true});await exec('/usr/bin/ditto',[candidate,destination],{timeout:30000})
  server=createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><title>Private Browser</title><h1>Private install Browser</h1>')});await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
  const pageUrl=`http://127.0.0.1:${server.address().port}/page`
  await launch(destination)
  await waitFor('initial public IPC and loaded Store', () => active.cdp.evaluate('Boolean(window.agentmux && document.querySelector(".project-list"))'))
  await click(`.project-rail-row[data-workspace-id="${workspaceId}"]`)
  await click('[aria-label="Browser Tools"]');
  const button = await waitFor('New Browser menu', () => active.cdp.evaluate(`(() => { const es=Array.from(document.querySelectorAll('button')).filter(e=>e.getClientRects().length&&e.textContent.trim()==='New Browser');if(es.length!==1)return null;const r=es[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`));
  await active.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...button});await active.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...button})
  const initial=await waitFor('UI-created Browser descriptor',async()=>{const observation=await observeUiClient(destination);return observation.workbench.tabs.flatMap(tab=>tab.regions).find(region=>region.kind==='browser')})
  await active.cdp.evaluate(`window.agentmux.browser.navigate(${JSON.stringify(initial.browserId)},${JSON.stringify(pageUrl)})`)
  const opened=await control('open.agent',{content:{kind:'agent-session',agentSessionId:agent.agentSessionId},destination:{kind:'split',direction:'right',region:{kind:'region',regionId:initial.regionId}}})
  const command=`/bin/cat`;const openedTerminal=await control('open.terminal',{shellCommand:command,destination:{kind:'split',direction:'down',region:{kind:'region',regionId:opened.result.region.regionId}}})
  terminal=openedTerminal.result.region;let terminalRun=await sdk.status(terminal.runId);owners.set(terminalRun.pid,await identity(terminalRun.pid));receipt.terminal={run:terminal.runId,pid:terminalRun.pid}
  // A real user resize supplies the durable ratio through the existing committer.
  // The earlier programmatic nested-split/defaultSize mismatch is retained separately.
  await dragOriginalSplit()
  await control('focus',{target:{kind:'region',regionId:initial.regionId}})
  receipt.browserBefore=await nativePages(pageUrl);receipt.before=projectObservation(await observeUiClient(destination));assert.equal(receipt.before.workbench.tabs.flatMap(tab=>tab.regions).length,3)
  const loadedIdentityPath=packageIdentityPath(destination), loadedIdentityBytes=await readFile(loadedIdentityPath)
  try {
    await writeFile(loadedIdentityPath,JSON.stringify({...JSON.parse(loadedIdentityBytes),sourceCommit:'private-replaced-canonical-metadata'}))
    const loaded=await observeUiClient(destination);assert.deepEqual(loaded.main.package,receipt.before.package)
    receipt.loadedMetadataCheck={diskChanged:true,reportedOriginal:true,pid:loaded.main.pid}
  } finally {await writeFile(loadedIdentityPath,loadedIdentityBytes)}
  receipt.inputBefore=await healthyInput('A')
  terminalRun=await mountedTerminal();receipt.terminal.currentSize=terminalRun.current_size
  let nativeSignals=0;const originalKill=process.kill;process.kill=function(pid,signal){if(pid===daemon.pid&&signal!==0)nativeSignals++;return originalKill.call(process,pid,signal)}
  try {
    // The fixture knows its original nonempty workbench. The installer receives
    // no fabricated outgoing observation after this ordinary process exit.
    phase='ordinary-exit-before-cold-ui-only';await quit(destination)
    phase='actual-cold-ui-only-transaction'
    let coldQuitCalls=0
    const coldResult=await installApplication(candidate,{intent:'ui-only',homeDirectory:home,launch,
      quit:async()=>{coldQuitCalls++;throw new Error('Cold installation must not request outgoing quit')}})
    receipt.cold={result:coldResult,quitCalls:coldQuitCalls}
    assert.equal(coldQuitCalls,0);assert.equal(coldResult.ui.status,'unknown');assert.equal(coldResult.native.status,'deferred')
    assert.ok(coldResult.ui.reason.includes('Without an outgoing workbench observation'))
    receipt.cold.browser=await nativePages(pageUrl)
    receipt.cold.after=projectObservation(await waitFor('original nonempty cold workbench',async()=>{
      const observed=await observeUiClient(destination)
      return JSON.stringify(retainedWorkbench(observed.workbench))===JSON.stringify(retainedWorkbench(receipt.before.workbench))?observed:null
    }))
    assert.deepEqual(retainedWorkbench(receipt.cold.after.workbench),retainedWorkbench(receipt.before.workbench))
    assert.equal(coldResult.ui.observation.main.pid,receipt.cold.after.pid)
    assert.notEqual(receipt.cold.after.pid,receipt.before.pid)
    receipt.cold.input=await healthyInput('K')
    assert.deepEqual(await sdk.runtimeInfo(),originalRuntime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid))
    const coldTerminal=await mountedTerminal();assert.equal(coldTerminal.pid,terminalRun.pid);assert.deepEqual(coldTerminal.current_size,terminalRun.current_size)
    assert.equal(nativeSignals,0);reportInstallTransaction(coldResult)
    if(!coldOnly){
    phase='actual-ui-only-transaction';let result, installError
    try { result=await installApplication(candidate,{intent:'ui-only',homeDirectory:home,quit,launch}) }
    catch(error){installError=error;receipt.unexpectedInstallFailure={message:error.message,transaction:error.transaction};receipt.nativeSignals=nativeSignals}
    phase='actual-ui-only-transaction'
    assert.equal(installError,undefined,'An actual UI-only transaction must not enter Native preparation')
    receipt.success=result
    assert.equal(result.ui.status,'committed');assert.equal(result.native.status,'deferred');assert.equal(nativeSignals,0)
    reportInstallTransaction(result)
    receipt.after=projectObservation(await observeUiClient(destination));assert.notEqual(receipt.after.pid,receipt.before.pid)
    receipt.browserAfter=await nativePages(pageUrl);receipt.inputAfter=await healthyInput('B')
    assert.deepEqual(await sdk.runtimeInfo(),originalRuntime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid));const keptTerminal=await mountedTerminal();assert.equal(keptTerminal.pid,terminalRun.pid);assert.deepEqual(keptTerminal.current_size,terminalRun.current_size)
    // The candidate process really starts but cannot load its original Renderer.
    // No opaque handshake mock or forced old-GUI teardown substitutes for this failure.
    await mkdir(join(root,'failed'),{recursive:true});await exec('/bin/cp',['-cR',candidate,failedCandidate],{timeout:30000})
    const failedApp=join(failedCandidate,'Contents/Resources/app'), failedMain=join(failedApp,'out/main/index.js');
    await writeFile(failedMain,(await readFile(failedMain,'utf8'))+"\napp.whenReady().then(() => app.quit())\n");receipt.activationFault={kind:'private-source-early-ordinary-quit',sha256:hash(await readFile(failedMain))}
    await exec('/usr/bin/codesign',['--force','--deep','--sign','-',failedCandidate],{timeout:30000,maxBuffer:1024*1024})
    phase='actual-candidate-activation-failure';let rejected
    try { await installApplication(failedCandidate,{intent:'ui-only',homeDirectory:home,quit,launch}) }
    catch(error){rejected=error;receipt.negative={message:error.message,transaction:error.transaction}}
    assert.ok(rejected);assert.equal(rejected.transaction?.ui.status,'restored');assert.equal(rejected.transaction?.native.status,'deferred');assert.equal(nativeSignals,0)
    reportInstallTransaction(rejected.transaction)
    receipt.restored=projectObservation(await observeUiClient(destination));receipt.inputAfterRollback=await healthyInput('C');receipt.browserAfterRollback=await nativePages(pageUrl)
    assert.deepEqual(await sdk.runtimeInfo(),originalRuntime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid))
    // The next GUI is genuinely live and loaded, but starts with an empty private
    // userData. Basic process/identity appearance cannot confirm workbench recovery.
    // This fault does not alter the original durable Store or inject a fake reply.
    await mkdir(join(root,'unrestored'),{recursive:true});await exec('/bin/cp',['-cR',candidate,unrestoredCandidate],{timeout:30000})
    const emptyUserData=join(root,'unrestored-user-data');await mkdir(emptyUserData,{recursive:true})
    const unrestoredMain=join(unrestoredCandidate,'Contents/Resources/app/out/main/index.js'), originalMain=await readFile(unrestoredMain,'utf8')
    const userDataAnchor='app.setPath("userData", process.env.AGENTMUX_DESKTOP_USER_DATA ?? packagedUserDataPath);'
    assert.equal(originalMain.split(userDataAnchor).length,2)
    await writeFile(unrestoredMain,originalMain.replace(userDataAnchor,`app.setPath("userData", ${JSON.stringify(emptyUserData)});`))
    receipt.unrestoredFault={kind:'private-source-empty-user-data',sha256:hash(await readFile(unrestoredMain))}
    await exec('/usr/bin/codesign',['--force','--deep','--sign','-',unrestoredCandidate],{timeout:30000,maxBuffer:1024*1024})
    phase='actual-live-unrestored-candidate';let unrestoredError, unrestoredResult
    try {unrestoredResult=await installApplication(unrestoredCandidate,{intent:'ui-only',homeDirectory:home,quit,launch})}
    catch(error){unrestoredError=error;receipt.unrestored={message:error.message,transaction:error.transaction}}
    const emptyObservation=await observeUiClient(destination)
    receipt.unrestoredObservation=projectObservation(emptyObservation);receipt.unrestoredUnexpectedResult=unrestoredResult??null
    assert.equal(emptyObservation.workbench.loading,false);assert.equal(emptyObservation.workbench.tabs.length,0)
    assert.ok(emptyObservation.main.package);assert.ok(active.child.exitCode===null&&active.child.signalCode===null)
    phase='actual-live-unrestored-candidate'
    assert.ok(unrestoredError,'A live loaded GUI without the original workbench must not commit')
    assert.equal(unrestoredError.transaction?.ui.status,'unknown');assert.equal(unrestoredError.transaction?.native.status,'deferred')
    assert.equal((await lstat(unrestoredError.transaction.candidate)).isDirectory(),true)
    assert.equal((await lstat(unrestoredError.transaction.previous)).isDirectory(),true)
    reportInstallTransaction(unrestoredError.transaction)
    assert.deepEqual(await sdk.runtimeInfo(),originalRuntime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid))
    creator=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
    const beforeDirect=await sdk.status(agent.run.runId)
    await creator.writeAgent({agentSessionId:agent.agentSessionId,expectedRun:agent.run,data:'D',source:'user'})
    const afterDirect=await waitFor('original Core input while GUI recovery is unknown',async()=>{const row=await sdk.status(agent.run.runId);return row.applied_input_bytes===beforeDirect.applied_input_bytes+1?row:null})
    assert.equal(afterDirect.pid,beforeDirect.pid);assert.equal(afterDirect.state.type,'running')
    await waitFor('original Core input nonempty output',async()=>{const attachment=await sdk.attach(agent.run.runId,0);try{return Buffer.concat(attachment.snapshot.replay.chunks.map(chunk=>Buffer.from(chunk.data))).includes(Buffer.from('D'))}finally{attachment.close()}})
    receipt.inputWhileUiUnknown={pid:afterDirect.pid,run:afterDirect.id,inputBefore:beforeDirect.applied_input_bytes,inputAfter:afterDirect.applied_input_bytes,outputBytes:afterDirect.latest_output_bytes}
    await creator.dispose();creator=null
    }
    assert.equal(nativeSignals,0);receipt.nativeSignals=nativeSignals
  } finally {process.kill=originalKill}
  receipt.inputsAfter=await inputs();assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore)
  receipt.passed=true
} catch(error){failure={phase,message:error.message,stack:error.stack,code:error.code??null,signal:error.signal??null,
  killed:error.killed??null,stderr:error.stderr??null};receipt.passed=false}
finally {
  clearTimeout(hardDeadline);const errors=[]
  if(creator)try{await creator.dispose()}catch(error){errors.push(error.message)}
  if(active&&active.child.exitCode===null&&active.child.signalCode===null)try{await quit(active.appPath,true)}catch(error){errors.push(error.message)}
  for(const cdp of connections)try{cdp.close()}catch(error){errors.push(error.message)}
  // Cleanup is not a transaction outcome. It never changes failed activation into success.
  for(const child of children)if(child.pid>1)try{if(await identity(child.pid)===owners.get(child.pid))await stopProbeProcesses(child.pid,root)}catch(error){errors.push(error.message)}
  let remaining=[];try{remaining=await listProbeProcesses(-1,root);for(const pid of remaining){const birth=owners.get(pid);if(birth&&await identity(pid)===birth)process.kill(pid,'SIGTERM')};await waitFor('owned cleanup',async()=>{const rows=await listProbeProcesses(-1,root);return rows.length===0?[]:null},5000,true);remaining=await listProbeProcesses(-1,root)}catch(error){errors.push(error.message)}
  if(server)try{await new Promise((done,fail)=>server.close(error=>error?fail(error):done()))}catch(error){errors.push(error.message)}
  receipt.cleanup={errors,remaining,rootRemoved:false};if(!errors.length&&!remaining.length){await rm(root,{recursive:true,force:true});receipt.cleanup.rootRemoved=true}
  for(const[key,value]of environmentBefore)value===undefined?delete process.env[key]:process.env[key]=value
  if(errors.length||remaining.length){receipt.passed=false;failure??={phase:'cleanup',message:errors.join('; ')||remaining.join(',')}}
}
receipt.guis=probes.map(probe=>({pid:probe.child.pid,exitCode:probe.child.exitCode,signalCode:probe.child.signalCode,ordinaryQuit:probe.exit??null,diagnostics:probe.diagnostics()}));receipt.passed=receipt.passed&&!failure;receipt.finishedAt=Date.now();receipt.failure=failure??null;await mkdir(join(repositoryRoot,'.tmp'),{recursive:true});await writeFile(join(repositoryRoot,'.tmp/terminal-ui-install-continuity-last.json'),JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,failure:receipt.failure,cleanup:receipt.cleanup})+'\n');process.exitCode=receipt.passed?0:1
