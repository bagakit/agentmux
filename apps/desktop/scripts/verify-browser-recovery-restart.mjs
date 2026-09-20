import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Actual product Main/Renderer/Browser owners, ordinary quit and the same private userData.
// No saved Workbench seeding, Store setter, bridge replacement or manual storage flush.
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
const { requestAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-browser-recovery-')
const userData = join(root, 'user-data'), privateHome = join(root, 'home'), runtimeDirectory = join(root, 'runtime')
const workspacePath = join(root, 'workspace'), codexHome = join(privateHome, 'codex')
const workspaceId = 'private-browser-recovery', workspaceName = 'Private Browser recovery'
const children = new Set(), connections = new Set()
const deadline = Date.now() + 120_000
const receipt = { schema: 'agentmux.browser-recovery-restart.v1', completeGate: false, cleanup: {} }
await mkdir(join(repositoryRoot,'.tmp'),{recursive:true})
const captureDirectory = await mkdtemp(join(repositoryRoot,'.tmp/browser-operation-visual-'))
receipt.visual = { captureDirectory, captureOnly: true, aestheticReview: 'not-performed', frames: [],
  compositorBoundary: 'Full BrowserWindow Renderer frames and native WebContentsView page frames are captured separately without compositing. Actual DOM and native bounds prove their shared geometry.' }
const fixtureEnvironment = { HOME: privateHome, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'private-messages.ndjson'), CODEX_HOME: codexHome }
let phase = 'prepare', failure, first, second, server
async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(60) }
  throw new Error(`Browser recovery timed out: ${label}`)
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
async function identity() {
  const rendererFiles = (await readdir(join(desktopRoot, 'out/renderer/assets'))).filter(name => /\.(js|css)$/.test(name))
  assert.ok(rendererFiles.length > 0)
  const files = ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs', 'apps/desktop/out/renderer/index.html',
    ...rendererFiles.map(name => `apps/desktop/out/renderer/assets/${name}`),
    'packages/core/dist/index.js', 'packages/core/dist/control-host.js',
    'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/index.ts',
    'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/lib/browser-state.ts',
    'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx', 'apps/desktop/src/renderer/src/styles/browser-operation-surface.css',
    'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/src/renderer/src/styles/index.css',
    'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/verify-browser-recovery-restart.mjs']
  const values = await Promise.all(files.map(async name => { const bytes = await readFile(join(repositoryRoot, name)); assert.ok(bytes.length > 0, name); return [name, digest(bytes)] }))
  const electron = require('electron'); values.push([electron, digest(await readFile(electron))])
  return Object.fromEntries(values)
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
  const nativeHome = await cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, privateHome)
  receipt[label] = { pid: child.pid, home, nativeHome, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  return { child, main, cdp }
}
async function click(cdp, expression, button = 'left') {
  const point = await waitFor('exact visible UI control', () => cdp.evaluate(`(() => { const matches = ${expression}; if (matches.length !== 1) return null; const element = matches[0]; if (element.disabled || !element.getClientRects().length) return null; element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
}
const selectors = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`
async function state(cdp) { return cdp.evaluate(`(() => { const raw = localStorage.getItem('agentmux-workbench-v1'); return raw ? JSON.parse(raw).state.restoredWorkbench : null })()`) }
async function control(operation, target) { return requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation,target}, join(runtimeDirectory,'control.sock')) }
async function openBrowser(url, destination) { const result=await requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation:'open.browser',url,destination},join(runtimeDirectory,'control.sock')); assert.equal(result.operation,'open.browser');return result.result.region }
async function normalQuit(probe) {
  phase = 'normal-quit'
  let replyFailure
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app.quit()` ) }
  catch (error) { replyFailure = error.message }
  probe.main.close(); probe.cdp.close()
  await waitFor('actual normal Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
  assert.equal(probe.child.exitCode,0); assert.equal(probe.child.signalCode,null)
  return {exitCode:0,signal:null,inspectorReplyFailure:replyFailure ?? null}
}
async function nativePages(probe, urls) {
  return waitFor('actual native page owners and content', () => probe.main.evaluate(`(async () => {
    const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const window=BrowserWindow.getAllWindows()[0]; if(!window)return null;
    const expected=${JSON.stringify(urls)}, views=window.contentView.children;
    const found=[];
    for(const url of expected){const matches=views.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL()===url);if(matches.length!==1)return null;
      const contents=matches[0].webContents, text=await contents.executeJavaScript('document.body.innerText');
      if(!text.includes('Private recovery '+new URL(url).pathname.slice(1)))return null;
      found.push({url,text,webContentsId:contents.id,bounds:matches[0].getBounds()});}
    return found;
  })()`))
}
async function actualWorkbench(probe, expected) {
  const restored=await waitFor('durable Browser identity and exact focus',async()=>{
    const value=await state(probe.cdp);if(!value)return null;
    const tab=value.tabs[expected.tabId];if(!tab||tab.layout.activeRegionId!==expected.focus)return null;
    const browserRegions=Object.values(tab.regions).filter(r=>r.kind==='browser');
    return browserRegions.length===2&&expected.regions.every(e=>browserRegions.some(r=>r.browserId===e.browserId&&r.regionId===e.regionId&&r.url===e.url))?value:null
  })
  const inspected=await control('inspect.tab',{kind:'tab',tabId:expected.tabId}); assert.equal(inspected.operation,'inspect.tab');
  assert.deepEqual(inspected.result.tab.regions.map(r=>r.regionId).sort(),expected.regions.map(r=>r.regionId).sort())
  const geometry=await probe.cdp.evaluate(`(${JSON.stringify(expected.regions.map(r=>r.regionId))}).map(id=>{const e=document.querySelector('[data-workbench-region-id="'+id+'"]');if(!e)return null;const r=e.getBoundingClientRect();return {id,width:r.width,height:r.height,active:e.dataset.active}})`)
  assert.equal(geometry.length,2); for(const row of geometry){assert.ok(row&&row.width>100&&row.height>100)}
  const sessions=await probe.cdp.evaluate('(async()=> (await window.agentmux.sessions.snapshot()).sessions.map(s=>({id:s.id,kind:s.kind})))()');assert.equal(sessions.filter(s=>s.kind==='agent').length,0)
  return {restored,inspected,geometry,sessions}
}
async function resize(probe, width, height) {
  const actual = await probe.main.evaluate(`(() => { const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const win=BrowserWindow.getAllWindows()[0];win.setSize(${width},${height});return win.getSize() })()`)
  await waitFor('actual Renderer resize',()=>probe.cdp.evaluate(`innerWidth===${actual[0]}`))
  return actual
}
async function capture(probe, label) {
  await probe.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const observation = await probe.cdp.evaluate(`(() => {
    const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const rows=Array.from(document.querySelectorAll('.browser-rsi-timeline__step')).filter(visible);
    const rail=Array.from(document.querySelectorAll('.browser-trace-rail')).find(visible),stage=rail?.previousElementSibling;
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    return {viewport:{width:innerWidth,height:innerHeight},rows:rows.map(e=>({sequence:e.dataset.sequence,status:e.querySelector('.browser-rsi-timeline__status').textContent,
      selected:e.querySelector('button').getAttribute('aria-pressed'),expanded:e.querySelector('button').getAttribute('aria-expanded')})),
      trace:rail&&rect(rail),stage:stage&&rect(stage),payloadCount:document.querySelectorAll('.browser-rsi-timeline__step-detail').length,
      focus:document.activeElement?.getAttribute('aria-label'),focusVisible:document.activeElement?.matches(':focus-visible')??false};
  })()`)
  assert.ok(observation.rows.length>0,'Visual review must contain real operation steps')
  assert.ok(observation.stage.width>0&&observation.stage.height>0,'The actual page keeps positive visible geometry')
  assert.ok(observation.stage.x+observation.stage.width<=observation.trace.x+1,'Trace does not overlay the native stage')
  const nativeBounds=await waitFor('native page bounds inside the actual stage',async()=>{
    const bounds=await probe.main.evaluate(`(() => { const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
      return BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL().startsWith('http://127.0.0.1:')).map(v=>v.getBounds()); })()`)
    const s=observation.stage
    return bounds.length===1&&bounds[0].width>0&&bounds[0].height>0&&bounds[0].x>=s.x-1&&bounds[0].y>=s.y-1&&
      bounds[0].x+bounds[0].width<=s.x+s.width+1&&bounds[0].y+bounds[0].height<=s.y+s.height+1?bounds:null
  })
  const file=join(captureDirectory,`${label}.png`)
  const frame=await probe.main.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const image=await BrowserWindow.getAllWindows()[0].capturePage();if(image.isEmpty())throw new Error('Empty compositor frame');
    const png=image.toPNG();process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(file)},png);
    return {size:image.getSize(),sha256:process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex')};})()`)
  const pageFile=join(captureDirectory,`${label}-native-page.png`)
  const nativePage=await probe.main.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const view=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL().startsWith('http://127.0.0.1:'));
    const image=await view.webContents.capturePage();if(image.isEmpty())throw new Error('Empty native page frame');const png=image.toPNG();
    process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(pageFile)},png);return {file:${JSON.stringify(pageFile)},bounds:view.getBounds(),size:image.getSize(),
      sha256:process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex')};})()`)
  receipt.visual.frames.push({label,file,...frame,observation,nativeBounds,nativePage})
}
async function reviewOperationRows(probe, browserId) {
  const operator={id:'private-browser-review',name:'Private Browser review'}
  const run=async code=>probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(code)},${JSON.stringify(operator)})`)
  const completed=await run('await snapshot({scope:"page",maxNodes:20}); await pageInfo(); return "private observed page";')
  assert.equal(completed.outcome.kind,'completed')
  await click(probe.cdp,selectors('[aria-label="Open browser activity timeline"]'))
  await waitFor('real completed timeline',()=>probe.cdp.evaluate(`document.querySelectorAll('.browser-rsi-timeline__step').length>=2`))
  await resize(probe,1440,900);await capture(probe,'normal-completed-collapsed')
  await resize(probe,980,700);await capture(probe,'narrow-completed-collapsed')
  const failed=await run('await snapshot({scope:"page",maxNodes:20}); await click("not-a-recorded-ref");')
  assert.equal(failed.outcome.kind,'script-failed')
  await waitFor('real failed row',()=>probe.cdp.evaluate(`Boolean(document.querySelector('.browser-rsi-timeline__step--failed'))`))
  await click(probe.cdp,selectors('.browser-rsi-timeline__step--failed button'))
  await capture(probe,'narrow-failed-selected')
  await probe.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
  await probe.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
  await waitFor('visible keyboard focus',()=>probe.cdp.evaluate('document.activeElement?.matches(":focus-visible")'))
  await capture(probe,'narrow-keyboard-focus')
  await resize(probe,1440,560);await capture(probe,'short-window-failed')
  await resize(probe,1440,900)
  await click(probe.cdp,selectors('[aria-label="Close browser activity timeline"]'))
  return {completed:completed.runOperation,failed:failed.runOperation}
}
try {
  await Promise.all([mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(codexHome,{recursive:true,mode:0o700}),mkdir(runtimeDirectory,{recursive:true})])
  receipt.identityBefore=await identity();receipt.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repositoryRoot})).stdout.trim()
  server=createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><html><head><title>Private Browser '+request.url+'</title></head><body><h1>Private recovery '+request.url.slice(1)+'</h1></body></html>')})
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
  const address=server.address();assert.ok(address&&typeof address==='object');const urls=['a','b'].map(path=>`http://127.0.0.1:${address.port}/${path}`)
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{},workspaces:[{id:workspaceId,name:workspaceName,hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:true,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
  first=await launch('first');phase='create-actual-browser-split'
  await click(first.cdp,selectors(`.project-rail-row[data-workspace-id="${workspaceId}"]`))
  await click(first.cdp,selectors('[aria-label="Browser Tools"]'))
  await click(first.cdp,`${selectors('button')}.filter(e=>e.textContent.trim()==='New Browser')`)
  const initial=await waitFor('actual UI-created Browser Region',async()=>{const s=await state(first.cdp);if(!s)return null;return Object.values(s.tabs).flatMap(tab=>Object.values(tab.regions).map(surface=>({tab,surface}))).find(x=>x.surface.kind==='browser'&&x.surface.workspaceId===workspaceId)})
  await first.cdp.evaluate(`window.agentmux.browser.navigate(${JSON.stringify(initial.surface.browserId)},${JSON.stringify(urls[0])})`)
  await waitFor('actual first page before visual operation',()=>nativePages(first,[urls[0]]))
  receipt.visual.operations=await reviewOperationRows(first,initial.surface.browserId)
  const sibling=await openBrowser(urls[1],{kind:'split',direction:'right',region:{kind:'region',regionId:initial.surface.regionId}})
  await control('focus',{kind:'region',regionId:initial.surface.regionId})
  const expected={tabId:initial.tab.id,focus:initial.surface.regionId,regions:[{browserId:initial.surface.browserId,regionId:initial.surface.regionId,url:urls[0]},{browserId:sibling.browserId,regionId:sibling.regionId,url:urls[1]}]}
  const pages=await nativePages(first,urls), before=await actualWorkbench(first,expected)
  // The ordinary product quit path itself is the acceptance boundary. No manual flush or seed.
  receipt.firstUi={expected,pages,...before};receipt.firstExit=await normalQuit(first)
  second=await launch('second');phase='actual-second-process-recovery'
  const after=await actualWorkbench(second,expected), restoredPages=await nativePages(second,urls)
  assert.deepEqual(after.restored,before.restored)
  const ensure=await second.cdp.evaluate(`window.agentmux.browser.create(${JSON.stringify(expected.regions[0].browserId)},'http://127.0.0.1:1/stale')`)
  assert.equal(ensure.id,expected.regions[0].browserId);assert.equal(ensure.url,urls[0]);assert.equal(ensure.error,null)
  const pagesAfterEnsure=await nativePages(second,urls);assert.deepEqual(pagesAfterEnsure,restoredPages)
  receipt.secondUi={...after,pages:restoredPages,ensure};receipt.secondExit=await normalQuit(second)
  receipt.identityAfter=await identity();assert.deepEqual(receipt.identityAfter,receipt.identityBefore)
  receipt.completeGate=true
} catch(error) {
  failure={phase,message:error.message,stack:error.stack};const active=second??first
  if(active&&active.child.exitCode===null&&active.child.signalCode===null){try{receipt.failureWorkbench=await state(active.cdp);receipt.failureDom=await active.cdp.evaluate('document.body.innerText.slice(-5000)')}catch(error){receipt.diagnosticError=error.message}}
} finally {
  const errors=[]
  for(const probe of [second,first]){if(probe&&probe.child.exitCode===null&&probe.child.signalCode===null){try{await normalQuit(probe)}catch(error){errors.push(error.message)}}}
  for(const connection of connections){try{connection.close()}catch(error){errors.push(error.message)}}
  for(const child of children){if(child.pid===undefined)continue;try{assert.ok(child.pid>1);await stopProbeProcesses(child.pid,root)}catch(error){errors.push(error.message)}}
  const sentinel=process.pid+1_000_000_000
  try{await stopProbeProcesses(sentinel,root)}catch(error){errors.push(error.message)}
  let remaining;try{remaining=await listProbeProcesses(sentinel,root);assert.deepEqual(remaining,[])}catch(error){errors.push(error.message)}
  try{if(server)await new Promise((done,fail)=>server.close(error=>error?fail(error):done()))}catch(error){errors.push(error.message)}
  receipt.cleanup={remaining:remaining??null,errors,privateProcessesReaped:errors.length===0&&remaining?.length===0,temporaryRootRemoved:false}
  if(receipt.cleanup.privateProcessesReaped){try{await rm(root,{recursive:true,force:true});receipt.cleanup.temporaryRootRemoved=true}catch(error){errors.push(error.message)}}
  if(errors.length&&!failure)failure={phase:'cleanup',message:errors.join('; ')}
}
receipt.passed=!failure&&receipt.completeGate;receipt.failure=failure??null
await mkdir(join(repositoryRoot,'.tmp'),{recursive:true})
await writeFile(join(repositoryRoot,'.tmp/browser-recovery-restart-last.json'),JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,completeGate:receipt.completeGate,failure:receipt.failure,cleanup:receipt.cleanup})+'\n')
process.exitCode=receipt.passed?0:1
