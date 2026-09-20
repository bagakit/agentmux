import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Final product seam: ordinary compiled Main/preload/Renderer + public Control/Core + pinned
// release Runtime. No sessions stub, Store setter, fabricated replay/seed or programmatic scroll.
// CDP observes the actual xterm public buffers and delivers trusted input to this private page;
// this proves Chromium delivery, not physical macOS trackpad behavior. No user daemon or Home.
const repositoryRoot = resolve(process.env.AGENTMUX_VERIFY_REPOSITORY_ROOT ?? resolve(import.meta.dirname, '../../..'))
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const ts = require('typescript')
const { requestAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxFileAgentSessionStore, connectLocalAgentMux } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
const exec = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-region-refresh-')
const userData = join(root, 'user-data'), privateHome = join(root, 'home'), runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), codexHome = join(root, 'codex-home')
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA:userData, AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH:join(userData,'messages.ndjson'), CODEX_HOME:codexHome }
const initialEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','CODEX_HOME'].map(name=>[name,process.env[name]]))
const connections = new Set(), children = new Set(), runs = [], phases = []
const receipt = { schema:'agentmux.region-terminal-refresh.v1',passed:false,cleanup:{},phases,limitations:[
 'Actual private generic Agent PTY and compiled Desktop; no user Run, model call or native vendor CLI behavior is implied.',
 'Ordinary product quit/restart, not sudden-exit durability or physical fsync evidence.',
 'This fixture proves known-origin normal Basic VT continuation; an existing unknown-origin Run remains unknown.',
 'Trusted CDP delivery to this private page, not physical macOS trackpad or measured production latency.'
] }
const deadline = Date.now()+180_000
let phase='prepare',client,first,second,third,failure,interrupted,session,hiddenSocket
const abort = signal => {
 interrupted=new Error('Private continuation probe interrupted: '+signal)
 for(const child of children){try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')receipt.cleanup.interruptError=error.message}}
}
const watchdog=setTimeout(()=>abort('deadline'),180_000)
const onSigterm=()=>abort('SIGTERM'),onSigint=()=>abort('SIGINT')
process.on('SIGTERM',onSigterm);process.on('SIGINT',onSigint)
async function waitFor(label, read, budget=25_000) {
 const end=label==='strict private process cleanup'?Date.now()+budget:Math.min(deadline,Date.now()+budget)
 while(Date.now()<end){if(interrupted&&label!=='strict private process cleanup')throw interrupted;const result=await read();if(result)return result;await delay(50)}
 throw new Error('Terminal continuation timed out: '+label)
}
async function connectCdp(url) {
  const socket = new WebSocket(url), pending = new Map(), pauses = []
  const cdp = { pauses, close: () => socket.close() }
  connections.add(cdp)
  let serial = 0
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Private CDP handshake timed out')), 12_000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', error => { clearTimeout(timer); fail(error) }, { once: true })
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Debugger.paused') pauses.push(message.params)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.fail(new Error(message.error.message)) : request.done(message.result)
  })
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error('Private CDP closed')) }; pending.clear() })
  const call = (method, params = {}) => new Promise((done, fail) => {
    if (socket.readyState !== WebSocket.OPEN) { fail(new Error('Private CDP is not open')); return }
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timed out: ${method}`)) }, 12_000)
    pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  Object.assign(cdp, { call, async evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  } })
  return cdp
}
async function launch(label) {
  phase = `launch-${label}`
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY']) assert.equal(process.env[name], undefined, `Ordinary launch inherited ${name}`)
  for(const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','AGENTMUX_DESKTOP_FILE_EDITING_REPORT','AGENTMUX_DESKTOP_RESOURCE_REPORT'])assert.equal(process.env[name],undefined,`Production launch inherited ${name}`)
  const readyFile = join(root, `ready-${label}.json`)
  const child = spawn(require('electron'), ['--inspect-brk=0', join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...fixtureEnvironment, AGENTMUX_DESKTOP_READY_FILE: readyFile }
  })
  children.add(child)
  const launchRecord={pid:child.pid,readyFile,startedAt:Date.now()}
  ;(receipt.launches??={})[label]=launchRecord
  let diagnostics = '', mainUrl, rendererUrl, spawnError
  child.on('error', error => { spawnError = error })
  assert.ok(child.pid > 1)
  child.stderr.on('data', bytes => {
    diagnostics = (diagnostics + bytes).slice(-16_384)
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
  })
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  const main = await connectCdp(await waitFor(`${label} Main inspector`, () => { alive(); return mainUrl }))
  await main.call('Runtime.enable')
  // Imports must finish before querying Electron. Pause before the first home-dependent constant;
  // require() during Node's --inspect-brk bootstrap can run an uninitialized module loader.
  await main.call('Debugger.enable')
  const mainPath = join(desktopRoot, 'out/main/index.js')
  const lines = (await readFile(mainPath, 'utf8')).split('\n')
  const anchors = lines.flatMap((line, index) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [index] : [])
  assert.equal(anchors.length, 1, 'The compiled home boundary must exist exactly once')
  const breakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor(`${label} initial Main pause`, () => main.pauses.shift())
  if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) {
    await main.call('Debugger.resume')
    paused = await waitFor(`${label} home boundary`, () => main.pauses.shift())
  }
  assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId), 'Only the exact pre-home pause permits fixture isolation')
  const isolated = await main.call('Debugger.evaluateOnCallFrame', {
    callFrameId: paused.callFrames[0].callFrameId,
    expression: `(() => { app.setPath('home', ${JSON.stringify(privateHome)}); return app.getPath('home') })()`, returnByValue: true
  })
  assert.equal(isolated.exceptionDetails, undefined, 'Public Electron home isolation must succeed')
  const home = isolated.result.value
  assert.equal(home, privateHome, 'Home must be private before the home-dependent constant is evaluated')
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId })
  await main.call('Debugger.resume')
  let ready
  try { ready = await waitFor(`${label} ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }) }
  catch(error){
    Object.assign(launchRecord,{phase,elapsedMs:Date.now()-launchRecord.startedAt,exitCode:child.exitCode,signalCode:child.signalCode,stderrTail:diagnostics,
      queuedDebuggerPauses:main.pauses.map(pause=>({reason:pause.reason,hitBreakpoints:pause.hitBreakpoints,callFrames:pause.callFrames.slice(0,4).map(frame=>({url:frame.url,functionName:frame.functionName,lineNumber:frame.location.lineNumber,columnNumber:frame.location.columnNumber}))}))})
    const diagnostic=async work=>{
      let timer
      try{return await Promise.race([work(),new Promise(resolve=>{timer=setTimeout(()=>resolve({unavailable:'bounded diagnostic deadline'}),2000)})])}
      catch(error){return {unavailable:error.message}}
      finally{clearTimeout(timer)}
    }
    launchRecord.birth=await diagnostic(async()=>({birth:(await exec('/bin/ps',['-p',String(child.pid),'-o','pid=,uid=,lstart='],{timeout:2000,maxBuffer:4096})).stdout.trim()}))
    launchRecord.main=await diagnostic(()=>main.evaluate(`(() => {const e=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');return {ready:e.app.isReady(),home:e.app.getPath('home'),userData:e.app.getPath('userData'),windows:e.BrowserWindow.getAllWindows().map(w=>({id:w.id,destroyed:w.isDestroyed(),loading:w.webContents.isLoading(),url:w.webContents.getURL()}))}})()`))
    throw error
  }
  const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
  const target = await waitFor(`${label} Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl); await cdp.call('Runtime.enable')
  await waitFor(`${label} trusted UI`, () => cdp.evaluate('Boolean(window.agentmux && document.querySelector(".project-list"))'))
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  const nativeHome = await cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, privateHome)
  receipt[label] = { pid: child.pid, home, nativeHome, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  return { child, main, cdp }
}
async function normalQuit(probe) {
 phase='normal-first-process-quit'
 let inspectorReplyFailure
 try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app.quit()`) }
 catch(error){inspectorReplyFailure=error.message}
 // Node's inspector can keep a quitting Main alive until the debugger disconnects.
 probe.cdp.close();probe.main.close()
 await waitFor('ordinary first Desktop exit',()=>probe.child.exitCode!==null||probe.child.signalCode!==null)
 assert.equal(probe.child.exitCode,0);assert.equal(probe.child.signalCode,null)
 children.delete(probe.child)
 return {exitCode:0,signal:null,inspectorReplyFailure:inspectorReplyFailure??null}
}
async function control(operation, fields={}) {
 const reply=await requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation,...fields},join(runtimeDirectory,'control.sock'))
 assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result
}
async function inspected(regionId){return (await control('inspect.region',{target:{kind:'region',regionId}})).region}
async function localState(cdp){return cdp.evaluate(`(() => {const record=localStorage.getItem('agentmux-workbench-v1');return record?JSON.parse(record).state:null})()`)}
async function click(cdp, selector) {
 const point=await waitFor('visible private control',()=>cdp.evaluate(`(() => {const items=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[inert]')&&!e.disabled);if(items.length!==1)return null;const r=items[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`))
 await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
 await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
}
async function keyboard(cdp, regionId, letter) {
 const point=await cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="${regionId}"] .xterm-screen');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+16,y:r.y+16}})()`)
 assert.ok(point);await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
 await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
 await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:letter,code:'Key'+letter.toUpperCase(),text:letter,unmodifiedText:letter})
 await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:letter,code:'Key'+letter.toUpperCase()})
}
async function frame(cdp) {
 await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
 const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});assert.ok(image.data.length>0)
 return digest(Buffer.from(image.data,'base64'))
}
async function wheel(cdp, regionId, deltaY) {
 await frame(cdp)
 const point=await cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="${regionId}"] .xterm-screen');if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+Math.min(48,r.height/2);return r.width>32&&r.height>32&&e.contains(document.elementFromPoint(x,y))?{x,y}:null})()`)
 assert.ok(point,'The exact terminal must have a rendered hit-test surface')
 await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY,modifiers:0})
}
async function status(item){return JSON.parse(await readFile(item.statusPath,'utf8'))}
async function exactRun(item){const run=(await client.listRuns()).find(r=>r.runId===item.runId);assert.ok(run);assert.equal(run.state,'running');assert.equal(run.pid,item.pid);return run}

// Observe a real Terminal through its already-public control-inspection getter. The breakpoint
// is AST-derived from the compiled getter; no source replacement, API override or scroll call.
async function terminalHandle(cdp, regionId) {
 await cdp.call('Debugger.enable')
 const candidates=[]
 for(const asset of (await readdir(join(desktopRoot,'out/renderer/assets'))).filter(name=>name.endsWith('.js'))){
  const path=join(desktopRoot,'out/renderer/assets',asset), source=await readFile(path,'utf8')
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  function visit(node){
   if(ts.isObjectLiteralExpression(node)){
    const names=new Set(node.properties.map(p=>p.name?.getText(ast).replace(/^['"]|['"]$/g,'')))
    if(['sampledAt','viewGrid','mouseTrackingMode','buffer','liveReady'].every(name=>names.has(name))){
     let owner=node.parent
     while(owner&&!ts.isArrowFunction(owner)&&!ts.isFunctionExpression(owner)&&!ts.isFunctionDeclaration(owner))owner=owner.parent
     assert.ok(owner,'The actual inspection getter must have a lexical owner')
     const objects=[]
     function find(current){if(ts.isPropertyAccessExpression(current)&&current.name.text==='active'&&ts.isPropertyAccessExpression(current.expression)&&current.expression.name.text==='buffer'&&ts.isIdentifier(current.expression.expression))objects.push(current.expression.expression.text);ts.forEachChild(current,find)}
     find(owner);assert.equal(new Set(objects).size,1,'The getter must read exactly one actual terminal')
     const pos=ast.getLineAndCharacterOfPosition(node.getStart(ast));candidates.push({url:pathToFileURL(path).href,...pos,identifier:objects[0]})
    }
   }
   ts.forEachChild(node,visit)
  }
  visit(ast)
 }
 assert.equal(candidates.length,1,'Actual compiled terminal observation getter must be nonempty and unique')
 const target=candidates[0]
 const bp=await cdp.call('Debugger.setBreakpointByUrl',{url:target.url,lineNumber:target.line,columnNumber:target.character})
 let request=inspected(regionId),paused
 try {
  paused=await waitFor('private terminal getter pause',()=>cdp.pauses.shift(),10_000)
  assert.ok(paused.hitBreakpoints.includes(bp.breakpointId))
  const value=await cdp.call('Debugger.evaluateOnCallFrame',{callFrameId:paused.callFrames[0].callFrameId,expression:target.identifier,returnByValue:false,objectGroup:'region-refresh-observation'})
  assert.equal(value.exceptionDetails,undefined);assert.ok(value.result.objectId)
  return value.result.objectId
 } finally {
  await cdp.call('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId})
  if(paused)await cdp.call('Debugger.resume')
  await request
 }
}
async function buffer(cdp, objectId) {
 const value=await cdp.call('Runtime.callFunctionOn',{objectId,returnByValue:true,functionDeclaration:`function(){const b=this.buffer.active;return {cols:this.cols,rows:this.rows,type:b.type,baseY:b.baseY,viewportY:b.viewportY,length:b.length,mouse:this.modes.mouseTrackingMode,selection:this.getSelection(),lines:Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true))}}`})
 assert.equal(value.exceptionDetails,undefined);return value.result.value
}
async function colorCells(cdp,objectId){
 const value=await cdp.call('Runtime.callFunctionOn',{objectId,returnByValue:true,functionDeclaration:`function(){const b=this.buffer.active;return ['ROW300','ROW301'].map(text=>{for(let y=0;y<b.length;y++){const line=b.getLine(y);if(line.translateToString(true)===text){const cell=line.getCell(0);return {text,fgMode:cell.getFgColorMode(),fg:cell.getFgColor(),bgMode:cell.getBgColorMode(),bg:cell.getBgColor(),bold:cell.isBold()}}}return null})}`})
 assert.equal(value.exceptionDetails,undefined)
 assert.deepEqual(value.result.value,[{text:'ROW300',fgMode:33554432,fg:208,bgMode:50331648,bg:462364,bold:0},
  {text:'ROW301',fgMode:50331648,fg:4822483,bgMode:0,bg:-1,bold:134217728}])
 return value.result.value
}
function retainedReading(value) {
 // A nearby service window changes the available rows. Preserve the actual populated
 // history and reading state; trailing unused screen rows follow that real geometry.
 const lines=[...value.lines]
 while(lines.at(-1)==='')lines.pop()
 return {cols:value.cols,type:value.type,baseY:value.baseY,viewportY:value.viewportY,mouse:value.mouse,selection:value.selection,lines}
}
async function selectVisibleWord(cdp,regionId){
 const point=await cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="${regionId}"] .xterm-screen');const r=e.getBoundingClientRect();return {x:r.x+24,y:r.y+9}})()`)
 await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:2,...point})
 await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:2,...point})
}
async function identity() {
 const vendor='packages/core/vendor/ctxmux/'+process.platform+'-'+process.arch
 const manifestPath=vendor+'/manifest.json',manifest=JSON.parse(await readFile(join(repositoryRoot,manifestPath),'utf8'))
 assert.equal(manifest.product.protocol,18,'This gate requires the actual release18 artifact')
 assert.equal(manifest.source.worktree_clean,true)
 assert.equal(manifest.build.profile,'release')
 assert.equal(manifest.build.locked,true)
 const assets=(await readdir(join(desktopRoot,'out/renderer/assets'))).filter(name=>name.endsWith('.js')).sort();assert.ok(assets.length>0)
 const core=(await readdir(join(repositoryRoot,'packages/core/dist'))).filter(name=>name.endsWith('.js')).sort();assert.ok(core.length>0)
 const files=['apps/desktop/out/main/index.js','apps/desktop/out/preload/index.cjs','apps/desktop/out/renderer/index.html',manifestPath,
 ...assets.map(name=>'apps/desktop/out/renderer/assets/'+name),...core.map(name=>'packages/core/dist/'+name),
 ...manifest.binaries.map(binary=>vendor+'/'+binary.path),vendor+'/'+manifest.sdk.archive.path,
 'apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/preload/index.ts','apps/desktop/src/shared/contracts.ts',
 'apps/desktop/src/renderer/src/components/TerminalView.tsx','apps/desktop/src/renderer/src/lib/session-events.ts','apps/desktop/src/renderer/src/lib/terminal-live-output.ts',
 'packages/core/src/ctxmux-run-adapter.ts','packages/core/src/terminal-continuation.ts','packages/core/src/types.ts','packages/core/src/client.ts',
 'apps/desktop/scripts/verify-region-terminal-refresh.mjs',
 'apps/desktop/src/renderer/src/store.ts','apps/desktop/src/renderer/src/components/SessionPane.tsx',
 'apps/desktop/src/renderer/src/components/AgentRegionHeader.tsx','apps/desktop/src/renderer/src/components/AgentLifecycleFeedback.tsx',
 'apps/desktop/src/renderer/src/lib/service-window-notice.ts','packages/core/src/client-event-publisher.ts','apps/desktop/scripts/probe-process.mjs']
 const hashes=Object.fromEntries(await Promise.all(files.map(async name=>{const bytes=await readFile(join(repositoryRoot,name));assert.ok(bytes.length>0,name);return [name,digest(bytes)]})))
 // Resolve with Node's real ESM import conditions from the Core package owner.
 // The SDK deliberately exposes import only; CJS require.resolve is a different contract.
 const {stdout:sdkUrl}=await exec(process.execPath,['--input-type=module','-e',"process.stdout.write(import.meta.resolve('@ctxmux/sdk'))"],{cwd:join(repositoryRoot,'packages/core'),timeout:5000,maxBuffer:4096})
 const sdkPath=new URL(sdkUrl),sdkBytes=await readFile(sdkPath);assert.ok(sdkBytes.length>0)
 const sdk=await import(sdkPath);assert.equal(sdk.PROTOCOL_VERSION,18,'The actual Core SDK must be protocol18')
 for(const binary of manifest.binaries)assert.equal(hashes[vendor+'/'+binary.path],binary.sha256)
 assert.equal(hashes[vendor+'/'+manifest.sdk.archive.path],manifest.sdk.archive.sha256)
 return {nodeVersion:process.version,manifest:manifest.product,hashes,electronSha:digest(await readFile(require('electron'))),sdkResolved:{url:sdkPath.href,protocolVersion:sdk.PROTOCOL_VERSION,sha256:digest(sdkBytes)},typescriptSha:digest(await readFile(require.resolve('typescript')))}
}
async function captureDesktopCore(probe, trigger) {
 const path=join(repositoryRoot,'packages/core/dist/client.js'),source=await readFile(path,'utf8')
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),found=[]
 function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='reattachAgent')found.push(node);ts.forEachChild(node,visit)}visit(ast)
 assert.equal(found.length,1,'One actual public Core attachment method must be collected')
 const at=ast.getLineAndCharacterOfPosition(found[0].body.statements[0].getStart(ast))
 const bp=await probe.main.call('Debugger.setBreakpointByUrl',{url:pathToFileURL(path).href,lineNumber:at.line,columnNumber:at.character})
 const request=trigger();let paused
 try {
  paused=await waitFor('actual Desktop Core attach boundary',()=>probe.main.pauses.shift())
  assert.ok(paused.hitBreakpoints.includes(bp.breakpointId))
  const core=await probe.main.call('Debugger.evaluateOnCallFrame',{callFrameId:paused.callFrames[0].callFrameId,expression:'this',returnByValue:false})
  assert.equal(core.exceptionDetails,undefined);assert.ok(core.result.objectId)
  let controller
  for(const frame of paused.callFrames.slice(1)){
   const candidate=await probe.main.call('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,
    expression:'typeof this?.resourceOwnerCounts === "function" ? this : null',returnByValue:false})
   if(candidate.result?.objectId){controller=candidate.result.objectId;break}
  }
  assert.ok(controller,'The actual Main attachment owner must be in the product call stack')
  return {core:core.result.objectId,controller,request}
 } finally {await probe.main.call('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});if(paused)await probe.main.call('Debugger.resume')}
}
async function attachmentHandle(probe,core,runId){
 const result=await probe.main.call('Runtime.callFunctionOn',{objectId:core,arguments:[{value:runId}],returnByValue:false,
  functionDeclaration:'function(runId){return this.kernel.attachments.get(runId)?.attachment}'});
 assert.equal(result.exceptionDetails,undefined);assert.ok(result.result.objectId,'One actual retained SDK attachment must exist');return result.result.objectId
}
async function ownerCounts(probe,controller){
 const result=await probe.main.call('Runtime.callFunctionOn',{objectId:controller,returnByValue:true,
  functionDeclaration:'function(){return this.resourceOwnerCounts()}'});assert.equal(result.exceptionDetails,undefined);return result.result.value
}
async function refresh(probe,regionId){
 const button=await probe.cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="${regionId}"]');const b=[...e.querySelectorAll('.terminal-service-window button')].find(b=>b.textContent==='Refresh observation');if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
 if(button){await probe.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...button});await probe.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...button});return}
 await click(probe.cdp,`[data-workbench-region-id="${regionId}"] .agent-region-header__more`)
 const point=await waitFor('actual Region refresh menu action',()=>probe.cdp.evaluate(`(() => {const e=document.querySelector('.agent-region-menu[data-owner-region-id="${regionId}"]');const b=[...e?.querySelectorAll('[role="menuitem"]')??[]].find(b=>b.textContent==='Refresh observation');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`))
 await probe.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await probe.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
}
async function sameWorkbench(probe,durable,draft){
 const state=await waitFor('actual restored durable Region workbench',async()=>{const state=await localState(probe.cdp);return state?.restoredWorkbench?.tabs?.[durable.tabId]?state:null})
 assert.deepEqual(state.restoredWorkbench,durable.workbench);assert.equal(state.agentComposerDrafts[session.agentSessionId],draft)
 for(const id of durable.regionIds){const region=await waitFor('same Session Region actually attached',async()=>{const r=await inspected(id);return r.terminalView?.liveReady?r:null});assert.equal(region.agentSessionId,session.agentSessionId);assert.equal(region.terminalView.runId,session.run.runId)
  await colorCells(probe.cdp,await terminalHandle(probe.cdp,id))}
 return state
}
async function freshLive(probe,durable,item){
 const count=(await status(item)).z
 await keyboard(probe.cdp,durable.regionIds[0],'z')
 await waitFor('original private child accepted one explicit new byte',async()=> (await status(item)).z===count+1)
 const handles=[]
 for(const regionId of durable.regionIds){const handle=await terminalHandle(probe.cdp,regionId);handles.push(handle)
  await waitFor('actual shared live output reaches both Regions',async()=>{const value=await buffer(probe.cdp,handle);return value.lines.includes('LIVE'+(count+1))?value:null})}
 return handles
}
const python=String.raw`#!/usr/bin/python3
import os,json,termios
attrs=termios.tcgetattr(0);attrs[3]&=~(termios.ICANON|termios.ECHO);attrs[1]&=~termios.OPOST
attrs[6][termios.VMIN]=1;attrs[6][termios.VTIME]=0;termios.tcsetattr(0,termios.TCSANOW,attrs)
path=os.environ['REGION_REFRESH_STATUS'];z=0;total=0
def state():
 with open(path+'.new','w') as f:json.dump({'z':z,'bytes':total},f)
 os.replace(path+'.new',path)
def row(i):
 text=('ROW%03d\r\n'%i).encode()
 if i==300:return b'\x1b[38;5;208;48;2;7;14;28m'+text+b'\x1b[0m'
 if i==301:return b'\x1b[38;2;73;149;211;1m'+text+b'\x1b[0m'
 return text
os.write(1,b''.join(row(i) for i in range(600)));state()
while True:
 chunk=os.read(0,4096)
 if not chunk:break
 total+=len(chunk)
 if b'z' in chunk:z+=chunk.count(b'z');os.write(1,('LIVE%d\r\n'%z).encode())
 state()
`
try {
 receipt.before=await identity()
 await Promise.all([userData,privateHome,runtimeDirectory,workspacePath,codexHome].map(path=>mkdir(path,{recursive:true,mode:0o700})))
 Object.assign(process.env,{AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory,AGENTMUX_STATE_DIRECTORY:fixtureEnvironment.AGENTMUX_STATE_DIRECTORY,AGENTMUX_MESSAGE_QUEUE_PATH:fixtureEnvironment.AGENTMUX_MESSAGE_QUEUE_PATH,CODEX_HOME:codexHome})
 const program=join(workspacePath,'private-agent.py'),statusPath=join(root,'private-agent-status.json')
 await writeFile(program,python,{mode:0o700})
 client=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
 session=await client.createAgent({createOperationId:randomUUID(),executorId:'private',providerId:'codex',commandOverride:program,
  workspacePath,env:{CODEX_HOME:codexHome,REGION_REFRESH_STATUS:statusPath},injectAgentMuxGuide:false,cols:80,rows:24})
 const original=(await client.listRuns()).find(run=>run.runId===session.run.runId);assert.equal(original?.state,'running');assert.ok(original.pid)
 const item={runId:session.run.runId,pid:original.pid,statusPath};runs.push(item)
 await waitFor('actual private Agent output',()=>status(item).catch(error=>{if(error.code==='ENOENT')return null;throw error}))
 await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private Runtime'}],
  executors:{private:{label:'Private Agent',providerId:'codex',command:program,args:[],env:{CODEX_HOME:codexHome,REGION_REFRESH_STATUS:statusPath},injectAgentMuxGuide:false}},
  workspaces:[{id:'checkpoint-fixture',name:'Private Region fixture',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},
  browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}))
 first=await launch('first')
 await click(first.cdp,'[data-workspace-id="checkpoint-fixture"]')
 await click(first.cdp,'button[aria-label="Space: show terminal and file workbench"]')
 await click(first.cdp,'button[title="New tab"]')
 const launcher=await waitFor('actual launcher',()=>first.cdp.evaluate("document.querySelector('[data-workbench-region-id]:has(.launch-surface)')?.dataset.workbenchRegionId ?? null"))
 const captured=await captureDesktopCore(first,()=>control('open.agent',{content:{kind:'agent-session',agentSessionId:session.agentSessionId},destination:{kind:'launcher',regionId:launcher}}))
 const left=(await captured.request).region;assert.equal(left.agentSessionId,session.agentSessionId)
 await waitFor('first live attachment',async()=> (await inspected(left.regionId)).terminalView?.liveReady)
 const right=(await control('open.agent',{content:{kind:'agent-session',agentSessionId:session.agentSessionId},
  destination:{kind:'split',region:{kind:'region',regionId:left.regionId},direction:'right'}})).region
 await waitFor('second shared Region',async()=> (await inspected(right.regionId)).terminalView?.liveReady)
 await control('focus',{target:{kind:'region',regionId:left.regionId}})
 const draft='Unsent exact Region draft survives failed observation and two restarts'
 await click(first.cdp,`[data-workbench-region-id="${left.regionId}"] .composer [role="textbox"]`)
 await first.cdp.call('Input.insertText',{text:draft})
 const state=await waitFor('actual draft persisted by product',async()=>{const state=await localState(first.cdp);return state?.agentComposerDrafts?.[session.agentSessionId]===draft?state:null})
 const durable={tabId:left.tabId,workbench:state.restoredWorkbench,regionIds:[left.regionId,right.regionId]}
 assert.equal(durable.workbench.tabs[left.tabId].layout.activeRegionId,left.regionId)
 assert.deepEqual(await ownerCounts(first,captured.controller),{sessionAttachmentOwners:1,sessionAttachmentLeases:2})
 const handles=await freshLive(first,durable,item)
 await wheel(first.cdp,left.regionId,-3000)
 await waitFor('actual history viewport moved by trusted wheel',async()=>{const value=await buffer(first.cdp,handles[0]);return value.viewportY<value.baseY?value:null})
 await selectVisibleWord(first.cdp,left.regionId)
 await waitFor('actual nonempty selected history word',async()=> (await buffer(first.cdp,handles[0])).selection.startsWith('ROW'))
 const before=await Promise.all(handles.map(handle=>buffer(first.cdp,handle)))
 receipt.initialColorCells=await colorCells(first.cdp,handles[0])
 assert.ok(before.length===2&&before.every(value=>value.lines.includes('ROW300')),'Both actual Region histories must be nonempty')
 const oldPump=await attachmentHandle(first,captured.core,item.runId),accepted=(await exactRun(item)).acceptedInputBytes
 const socket=join(runtimeDirectory,'ctxmux.sock');hiddenSocket=socket+'.held'
 await rename(socket,hiddenSocket)
 phase='actual-private-observation-failure'
 await refresh(first,left.regionId)
 const failureText=await waitFor('persistent same Region actual cause',()=>first.cdp.evaluate(`(() => {const t=document.querySelector('[data-workbench-region-id="${left.regionId}"] .terminal-service-window')?.textContent;return t?.includes('ctxmux.sock')&&t.includes('input delivery are unconfirmed')?t:null})()`))
 const afterFailure=await localState(first.cdp);assert.deepEqual(afterFailure.restoredWorkbench,durable.workbench);assert.equal(afterFailure.agentComposerDrafts[session.agentSessionId],draft)
 assert.equal((await status(item)).z,1);assert.deepEqual(await ownerCounts(first,captured.controller),{sessionAttachmentOwners:1,sessionAttachmentLeases:2})
 const failedBuffers=await Promise.all(handles.map(handle=>buffer(first.cdp,handle)))
 assert.deepEqual(failedBuffers.map(retainedReading),before.map(retainedReading))
 assert.equal(await first.cdp.evaluate(`document.querySelector('[data-workbench-region-id="${right.regionId}"] .terminal-service-window')?.textContent.includes('ctxmux.sock')??false`),false)
 phases.push({phase,runId:item.runId,pid:item.pid,retainedRegions:durable.regionIds,cause:failureText,unknownDelivery:true,
  beforeGeometry:before.map(({cols,rows})=>({cols,rows})),afterGeometry:failedBuffers.map(({cols,rows})=>({cols,rows})),selectedHistory:before[0].selection,viewportY:before[0].viewportY})
 await rename(hiddenSocket,socket);hiddenSocket=null
 phase='actual-shared-observation-reopened'
 await refresh(first,left.regionId)
 await waitFor('actual scoped failure cleared after attachment',()=>first.cdp.evaluate(`!document.querySelector('[data-workbench-region-id="${left.regionId}"] .terminal-service-window')?.textContent.includes('ctxmux.sock')`))
 const newPump=await attachmentHandle(first,captured.core,item.runId)
 const same=await first.main.call('Runtime.callFunctionOn',{objectId:oldPump,arguments:[{objectId:newPump}],returnByValue:true,functionDeclaration:'function(other){return this===other}'})
 assert.equal(same.result.value,false,'A metadata/snapshot RPC must not be signed as actual pump replacement')
 assert.deepEqual(await ownerCounts(first,captured.controller),{sessionAttachmentOwners:1,sessionAttachmentLeases:2})
 assert.equal((await exactRun(item)).acceptedInputBytes,accepted,'Observation refresh must not dispatch Input')
 assert.deepEqual((await Promise.all(handles.map(handle=>buffer(first.cdp,handle)))).map(retainedReading),before.map(retainedReading))
 phases.push({phase,runId:item.runId,pid:item.pid,pumpReplaced:true,leases:2,refreshAcceptedInputBytes:0,
  populatedHistoryLines:retainedReading(before[0]).lines.length,retainedSelection:before[0].selection,viewportY:before[0].viewportY})
 await freshLive(first,durable,item)
 const native=client.runtimeIdentity();receipt.runtimeBefore=native
 receipt.firstQuit=await normalQuit(first);await exactRun(item)
 second=await launch('second');await sameWorkbench(second,durable,draft);await freshLive(second,durable,item)
 phases.push({phase:'first-ordinary-restart',runId:item.runId,pid:item.pid,regions:durable.regionIds,draftRetained:true})
 receipt.secondQuit=await normalQuit(second);await exactRun(item)
 third=await launch('third');await sameWorkbench(third,durable,draft);await freshLive(third,durable,item)
 phases.push({phase:'second-ordinary-restart',runId:item.runId,pid:item.pid,regions:durable.regionIds,draftRetained:true})
 const verifier=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
 try{receipt.runtimeAfter=verifier.runtimeIdentity();assert.equal(receipt.runtimeAfter.instanceId,native.instanceId)}finally{await verifier.dispose()}
 receipt.after=await identity();assert.deepEqual(receipt.after,receipt.before);assert.equal(interrupted,undefined)
 receipt.passed=true;phase='complete'
} catch(error) {failure=error;receipt.failure={phase,name:error.name,message:error.message}} finally {
 clearTimeout(watchdog);process.off('SIGTERM',onSigterm);process.off('SIGINT',onSigint)
 for(const cdp of connections){try{await cdp.call('Debugger.resume')}catch{};try{cdp.close()}catch{}}
 if(hiddenSocket){try{await rename(hiddenSocket,join(runtimeDirectory,'ctxmux.sock'));hiddenSocket=null}catch(error){failure??=error}}
 if(client){for(const item of runs){try{await client.stopAgent(session.agentSessionId,{runId:item.runId})}catch(error){receipt.cleanup.stopError=error.message;failure??=error}};try{await client.dispose()}catch(error){failure??=error}}
 for(const child of children){try{await stopProbeProcesses(child.pid,root)}catch(error){failure??=error;receipt.cleanup.processError=error.message}}
 // Includes detached daemon/helpers identified exclusively by this invocation's private root.
 try{
  let remaining=await listProbeProcesses(-1,root)
  for(const pid of remaining){try{process.kill(pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}}
  const grace=Date.now()+2000
  while(remaining.length&&Date.now()<grace){await delay(50);remaining=await listProbeProcesses(-1,root)}
  for(const pid of remaining){try{process.kill(pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}}
  remaining=await waitFor('strict private process cleanup',async()=>{const pids=await listProbeProcesses(-1,root);return pids.length?null:{pids}},3000)
  assert.deepEqual(remaining.pids,[]);receipt.cleanup.privateProcessesRemaining=remaining.pids
 }catch(error){failure??=error;receipt.cleanup.processError=error.message}
 for(const[name,value]of initialEnvironment)value===undefined?delete process.env[name]:process.env[name]=value
 if(!receipt.cleanup.processError&&!receipt.cleanup.stopError){await rm(root,{recursive:true,force:true});receipt.cleanup.rootRemoved=true}
 receipt.passed=receipt.passed&&!failure
 await writeFile(join(repositoryRoot,'.tmp/region-terminal-refresh-last.json'),JSON.stringify(receipt,null,2)+'\n')
}
if(failure)throw failure
process.stdout.write(JSON.stringify({passed:receipt.passed,phases:phases.map(p=>p.phase),cleanup:receipt.cleanup})+'\n')
