import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
const root = await mkdtemp('/tmp/amx-checkpoint-desktop-')
const userData = join(root, 'user-data'), privateHome = join(root, 'home'), runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), codexHome = join(root, 'codex-home')
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA:userData, AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory, AGENTMUX_MESSAGE_QUEUE_PATH:join(userData,'messages.ndjson'), CODEX_HOME:codexHome }
const initialEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','CODEX_HOME'].map(name=>[name,process.env[name]]))
const connections = new Set(), children = new Set(), runs = [], phases = []
const receipt = { schema:'agentmux.terminal-checkpoint-desktop.v1',passed:false,cleanup:{},phases,limitations:[
 'Actual release18 Generic private PTY and production Desktop path; no user Run, model call or native Agent CLI behavior is implied.',
 'Ordinary product quit/restart, not sudden-exit durability or physical fsync evidence.',
 'Known-origin normal and alternate Basic VT continuation; an existing unknown-origin Run remains unknown.',
 'Trusted CDP delivery to this private page, not physical macOS trackpad or measured production latency.'
] }
const deadline = Date.now()+150_000
let phase='prepare',client,first,second,failure,interrupted
const abort = signal => {
 interrupted=new Error('Private continuation probe interrupted: '+signal)
 for(const child of children){try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')receipt.cleanup.interruptError=error.message}}
}
const watchdog=setTimeout(()=>abort('deadline'),150_000)
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
  const readyFile = join(root, `ready-${label}.json`)
  const child = spawn(require('electron'), ['--inspect-brk=0', join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...fixtureEnvironment, AGENTMUX_DESKTOP_READY_FILE: readyFile }
  })
  children.add(child)
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
  const ready = await waitFor(`${label} ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })
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
 await waitFor('ordinary first Desktop exit',()=>probe.child.exitCode!==null||probe.child.signalCode!==null)
 assert.equal(probe.child.exitCode,0);assert.equal(probe.child.signalCode,null)
 probe.cdp.close();probe.main.close();children.delete(probe.child)
 return {exitCode:0,signal:null,inspectorReplyFailure:inspectorReplyFailure??null}
}
async function control(operation, fields={}) {
 const reply=await requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation,...fields},join(runtimeDirectory,'control.sock'))
 assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result
}
async function inspected(regionId){return (await control('inspect.region',{target:{kind:'region',regionId}})).region}
async function localState(cdp){return cdp.evaluate(`(() => {const record=localStorage.getItem('agentmux-workbench-v1');return record?JSON.parse(record).state:null})()`)}
async function click(cdp, selector) {
 const point=await waitFor('visible private control',()=>cdp.evaluate(`(() => {const items=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getClientRects().length);if(items.length!==1)return null;const r=items[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`))
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
async function exactRun(item){const run=(await client.listRuns()).find(r=>r.runId===item.region.runId);assert.ok(run);assert.equal(run.state,'running');assert.equal(run.pid,item.pid);return run}

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
  const value=await cdp.call('Debugger.evaluateOnCallFrame',{callFrameId:paused.callFrames[0].callFrameId,expression:target.identifier,returnByValue:false,objectGroup:'checkpoint-observation'})
  assert.equal(value.exceptionDetails,undefined);assert.ok(value.result.objectId)
  return value.result.objectId
 } finally {
  await cdp.call('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId})
  if(paused)await cdp.call('Debugger.resume')
  await request
 }
}
async function buffer(cdp, objectId) {
 const value=await cdp.call('Runtime.callFunctionOn',{objectId,returnByValue:true,functionDeclaration:`function(){const b=this.buffer.active;return {cols:this.cols,rows:this.rows,type:b.type,baseY:b.baseY,viewportY:b.viewportY,length:b.length,mouse:this.modes.mouseTrackingMode,lines:Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true))}}`})
 assert.equal(value.exceptionDetails,undefined);return value.result.value
}
const python=String.raw`import os,sys,termios,re,json
attrs=termios.tcgetattr(0);attrs[3]&=~(termios.ICANON|termios.ECHO);attrs[1]&=~termios.OPOST
attrs[6][termios.VMIN]=1;attrs[6][termios.VTIME]=0;termios.tcsetattr(0,termios.TCSANOW,attrs)
mode=sys.argv[1];target=sys.argv[2];index=500;reports=0;z=0;total=0;pending=b''
def state():
 p=target+'.new'
 with open(p,'w') as f:json.dump({'mode':mode,'index':index,'reports':reports,'z':z,'bytes':total},f)
 os.replace(p,target)
os.write(1,b''.join(('ROW%03d\r\n'%i).encode() for i in range(300)))
if mode=='alternate':os.write(1,b'\x1b[?1049h\x1b[?1003h\x1b[?1006h')
os.write(1,b'\x1b[1;1Hframe'*450000+b'\x1b[2;1HREADY500')
state()
while True:
 chunk=os.read(0,4096)
 if not chunk:break
 total+=len(chunk);pending+=chunk
 while True:
  match=re.search(rb'\x1b\[<(64|65);\d+;\d+M',pending)
  if not match:break
  reports+=1;index+=-1 if match.group(1)==b'64' else 1
  os.write(1,('\x1b[2;1HREADY%03d'%index).encode());pending=pending[match.end():]
 if b'z' in pending:z+=pending.count(b'z');os.write(1,b'\x1b[3;1H\x1b[2KZ');pending=pending.replace(b'z',b'')
 if b'x' in pending and mode=='alternate':os.write(1,b'\x1b[?1003l\x1b[?1006l\x1b[?1049l');mode='normal';pending=pending.replace(b'x',b'')
 state()
`
async function opened(cdp, mode, destination) {
 const statusPath=join(root,mode+'-status.json'), programPath=join(root,'terminal-program.py')
 const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'"
 const answer=await control('open.terminal',{shellCommand:['/usr/bin/python3',programPath,mode,statusPath].map(quote).join(' '),destination})
 assert.equal(answer.region.kind,'terminal')
 const item={region:answer.region,statusPath}
 await waitFor(mode+' actual program output',()=>status(item).catch(error=>{if(error.code==='ENOENT')return null;throw error}))
 const run=(await client.listRuns()).find(run=>run.runId===item.region.runId);assert.ok(run?.pid);item.pid=run.pid
 runs.push(item)
 await waitFor(mode+' actual live view',async()=>{const observation=(await inspected(item.region.regionId)).terminalView;return observation?.liveReady&&observation.acceptsInput?observation:null})
 const raw=await client.readRunReplay({runId:item.region.runId},0,'raw')
 assert.ok(raw.gap?.firstAvailableByte>0,'The real Runtime must have evicted an original prefix')
 assert.ok(raw.run.latestOutputBytes>4*1024*1024)
 phases.push({phase:mode+'-original-prefix-evicted',runId:item.region.runId,pid:item.pid,latest:raw.run.latestOutputBytes,head:raw.gap.firstAvailableByte})
 return item
}
async function verifyNormal(probe,item) {
 phase='normal-restored-reader'
 await control('focus',{target:{kind:'region',regionId:item.region.regionId}})
 const handle=await terminalHandle(probe.cdp,item.region.regionId)
 const before=await buffer(probe.cdp,handle);assert.equal(before.type,'normal');assert.equal(before.mouse,'none')
 assert.ok(before.lines.includes('ROW000'),'Normal origin history must survive actual raw prefix eviction and app restart')
 assert.ok(before.baseY>0);assert.ok(before.lines.length>before.rows)
 const runBefore=await exactRun(item), statusBefore=await status(item)
 await wheel(probe.cdp,item.region.regionId,-240)
 const up=await waitFor('real normal viewport scroll up',async()=>{const value=await buffer(probe.cdp,handle);return value.viewportY<before.viewportY?value:null})
 await wheel(probe.cdp,item.region.regionId,120)
 const down=await waitFor('real normal viewport scroll down',async()=>{const value=await buffer(probe.cdp,handle);return value.viewportY>up.viewportY?value:null})
 const after=await exactRun(item);assert.equal(after.acceptedInputBytes,runBefore.acceptedInputBytes)
 assert.deepEqual(await status(item),statusBefore,'Local scroll must not become PTY input')
 await keyboard(probe.cdp,item.region.regionId,'z')
 await waitFor('normal same Run keyboard repaint',async()=>{const value=await buffer(probe.cdp,handle);return value.lines.some(line=>line==='Z')&&(await status(item)).z===statusBefore.z+1?value:null})
 phases.push({phase,runId:item.region.runId,pid:item.pid,normalHistoryRow:'ROW000',before:{viewportY:before.viewportY,baseY:before.baseY,rows:before.rows},up:up.viewportY,down:down.viewportY,wheelAcceptedBytes:after.acceptedInputBytes-runBefore.acceptedInputBytes,keyboardAcceptedBytes:(await exactRun(item)).acceptedInputBytes-after.acceptedInputBytes})
}
async function verifyAlternate(probe,item) {
 phase='alternate-mouse-restored'
 await control('focus',{target:{kind:'region',regionId:item.region.regionId}})
 const handle=await terminalHandle(probe.cdp,item.region.regionId)
 const before=await buffer(probe.cdp,handle);assert.equal(before.type,'alternate');assert.equal(before.mouse,'any');assert.ok(before.lines.some(line=>line.includes('READY500')))
 const start=await status(item),firstRun=await exactRun(item)
 await wheel(probe.cdp,item.region.regionId,-240)
 const up=await waitFor('actual private TUI wheel repaint up',async()=>{const value=await status(item);const screen=await buffer(probe.cdp,handle);return value.index<start.index&&value.reports>start.reports&&screen.lines.some(line=>line.includes('READY'+String(value.index).padStart(3,'0')))?{value,screen}:null})
 await wheel(probe.cdp,item.region.regionId,240)
 const down=await waitFor('actual private TUI wheel repaint down',async()=>{const value=await status(item);const screen=await buffer(probe.cdp,handle);return value.index>up.value.index&&value.reports>up.value.reports&&screen.lines.some(line=>line.includes('READY'+String(value.index).padStart(3,'0')))?{value,screen}:null})
 const lastRun=await exactRun(item);assert.ok(lastRun.acceptedInputBytes>firstRun.acceptedInputBytes)
 await keyboard(probe.cdp,item.region.regionId,'z')
 await waitFor('alternate same Run keyboard repaint',async()=>{const value=await buffer(probe.cdp,handle);return value.lines.some(line=>line==='Z')&&(await status(item)).z===start.z+1?value:null})
 await keyboard(probe.cdp,item.region.regionId,'x')
 const normal=await waitFor('actual alternate exit restores original normal history',async()=>{const value=await buffer(probe.cdp,handle);return value.type==='normal'&&value.lines.includes('ROW000')?value:null})
 phases.push({phase,runId:item.region.runId,pid:item.pid,mouse:before.mouse,upIndex:up.value.index,downIndex:down.value.index,reports:down.value.reports-start.reports,acceptedMouseBytes:lastRun.acceptedInputBytes-firstRun.acceptedInputBytes,exitAltNormalFirstRow:normal.lines.find(line=>line==='ROW000')})
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
 'apps/desktop/scripts/verify-terminal-checkpoint-continuation.mjs','apps/desktop/scripts/probe-process.mjs']
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
try {
 receipt.before=await identity()
 await Promise.all([userData,privateHome,runtimeDirectory,workspacePath,codexHome].map(path=>mkdir(path,{recursive:true,mode:0o700})))
 Object.assign(process.env,{AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory,AGENTMUX_MESSAGE_QUEUE_PATH:fixtureEnvironment.AGENTMUX_MESSAGE_QUEUE_PATH,CODEX_HOME:codexHome})
 await writeFile(join(root,'terminal-program.py'),python,{mode:0o700})
 await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private Runtime'}],executors:{},
 workspaces:[{id:'checkpoint-fixture',name:'Private checkpoint fixture',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{}}}))
 first=await launch('first')
 client=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
 await click(first.cdp,'[data-workspace-id="checkpoint-fixture"]')
 await click(first.cdp,'button[title="New tab"]')
 const launcher=await waitFor('actual new workspace launcher',()=>first.cdp.evaluate("document.querySelector('[data-workbench-region-id]:has(.launch-surface)')?.dataset.workbenchRegionId ?? null"))
 const normal=await opened(first.cdp,'normal',{kind:'launcher',regionId:launcher})
 const alternate=await opened(first.cdp,'alternate',{kind:'split',region:{kind:'region',regionId:normal.region.regionId},direction:'right'})
 await control('focus',{target:{kind:'region',regionId:normal.region.regionId}})
 const durable=await waitFor('actual durable workface',async()=>{const state=await localState(first.cdp);const tab=state?.restoredWorkbench?.tabs?.[normal.region.tabId];return tab?.layout.activeRegionId===normal.region.regionId&&Object.values(tab.regions).some(r=>r.sessionId===normal.region.runId)&&Object.values(tab.regions).some(r=>r.sessionId===alternate.region.runId)?state.restoredWorkbench:null})
 const native=client.runtimeIdentity();assert.equal(native.protocolVersion,18);receipt.runtimeBefore=native
 const before=await Promise.all(runs.map(exactRun));assert.equal(before.length,2)
 // This join uses the product's ordinary quit/restart. Renderer localStorage alone is
 // not a physical disk-commit oracle; crash durability is proved by its separate owning gate.
 for(const item of runs){const {stdout}=await exec('/bin/ps',['-p',String(item.pid),'-o','pgid=']);assert.notEqual(Number(stdout.trim()),first.child.pid,'PTY must survive the private application group exit')}
 const quit=await normalQuit(first)
 for(const item of runs)await exactRun(item)
 phases.push({phase:'first-process-exited',quit,restartBoundary:'ordinary-quit-not-crash',runtime:native.instanceId,runIds:runs.map(item=>item.region.runId),pids:runs.map(item=>item.pid)})
 second=await launch('second')
 const restored=await waitFor('same durable workface after actual second process',async()=>{const state=await localState(second.cdp);return state?.restoredWorkbench?.tabs?.[normal.region.tabId]?state.restoredWorkbench:null})
 assert.deepEqual(restored,durable)
 assert.equal(client.runtimeIdentity().instanceId,native.instanceId)
 for(const item of runs)await waitFor('restored same Run input ready',async()=>{const region=await inspected(item.region.regionId);assert.equal(region.runId,item.region.runId);return region.terminalView?.liveReady&&region.terminalView.acceptsInput?region:null})
 await verifyNormal(second,normal);await verifyAlternate(second,alternate)
 receipt.after=await identity();assert.deepEqual(receipt.after,receipt.before)
 assert.equal(interrupted,undefined)
 receipt.passed=true;phase='complete'
} catch(error) {failure=error;receipt.failure={phase,name:error.name,message:error.message}} finally {
 clearTimeout(watchdog);process.off('SIGTERM',onSigterm);process.off('SIGINT',onSigint)
 for(const cdp of connections){try{await cdp.call('Debugger.resume')}catch{};try{cdp.close()}catch{}}
 if(client){for(const item of runs){try{await client.stopTerminal({runId:item.region.runId})}catch(error){receipt.cleanup.stopError=error.message;failure??=error}};try{await client.dispose()}catch(error){failure??=error}}
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
 await writeFile(join(repositoryRoot,'.tmp/terminal-checkpoint-continuation-last.json'),JSON.stringify(receipt,null,2)+'\n')
}
if(failure)throw failure
process.stdout.write(JSON.stringify({passed:receipt.passed,phases:phases.map(p=>p.phase),cleanup:receipt.cleanup})+'\n')
