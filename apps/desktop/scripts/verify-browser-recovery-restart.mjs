import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { captureOsWindow } from './browser-window-visual-capture.mjs'
import { installNativeBoundsObserver } from './browser-native-bounds-observer.mjs'
import { observeOriginalStageDelivery } from './browser-stage-delivery-observer.mjs'

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
const launchedProbes = new Set()
const deadline = Date.now() + 120_000
const receipt = { schema: 'agentmux.browser-recovery-restart.v1', completeGate: false, cleanup: {} }
const downloadCase = process.argv.includes('--case-download')
const demonstrationCase = process.argv.includes('--case-demonstration')
const overlayCase = process.argv.includes('--case-overlay')
const taskAssetsCase = process.argv.includes('--case-task-assets')
const browserToolsCase = process.argv.includes('--case-browser-tools')
const structuredCase = process.argv.includes('--case-structured-output')
const observeStageDelivery = process.argv.includes('--observe-stage-delivery')
const observeNativeBounds = observeStageDelivery || process.argv.includes('--observe-native-bounds')
assert.ok(!observeStageDelivery || structuredCase, 'Stage delivery observation belongs to one private structured-output diagnostic')
assert.ok(!observeNativeBounds || structuredCase, 'Main bounds observation belongs to one private structured-output diagnostic')
if(observeStageDelivery)receipt.diagnosticMode='original-stage-conditional-breakpoints'
if(overlayCase && process.env.AGENTMUX_OVERLAY_OBSERVE_ORIGINAL_PAINT === '1')receipt.diagnosticMode='original-overlay-paint-conditional-breakpoints'
assert.ok([downloadCase,demonstrationCase,overlayCase,taskAssetsCase,browserToolsCase,structuredCase].filter(Boolean).length<=1,'A product scenario has one owning outcome')
const downloadPayload = Buffer.from([0,255,128,13,10,1,2,0,254])
const downloadRequests = []
if(downloadCase)receipt.case='download'
if(demonstrationCase)receipt.case='demonstration'
if(overlayCase)receipt.case='overlay'
if(taskAssetsCase)receipt.case='task-assets'
if(browserToolsCase)receipt.case='browser-tools'
if(structuredCase)receipt.case='structured-output'
await mkdir(join(repositoryRoot,'.tmp'),{recursive:true})
const captureDirectory = await mkdtemp(join(repositoryRoot,'.tmp/browser-operation-visual-'))
receipt.visual = { captureDirectory, captureOnly: true, aestheticReview: 'not-performed', frames: [],
  compositorBoundary: 'The original Renderer webContents and native Browser WebContentsView are captured separately without compositing. These images are not an OS whole-window capture. Actual DOM and native bounds prove their shared geometry.' }
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
    'apps/desktop/src/main/browser-operation-journal.ts', 'apps/desktop/src/main/browser-step-evidence.ts',
    'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/lib/browser-state.ts',
    'apps/desktop/src/renderer/src/lib/browser-stage-geometry.ts', 'apps/desktop/package.json', 'pnpm-lock.yaml',
    'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx', 'apps/desktop/src/renderer/src/styles/browser-operation-surface.css',
    'apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx', 'apps/desktop/src/renderer/src/styles/browser-step-evidence.css',
    'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/src/renderer/src/styles/index.css',
    'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/verify-browser-recovery-restart.mjs',
    'apps/desktop/scripts/browser-window-visual-capture.mjs',
    ...(observeNativeBounds ? ['apps/desktop/scripts/browser-native-bounds-observer.mjs'] : []),
    ...(observeStageDelivery ? ['apps/desktop/scripts/browser-stage-delivery-observer.mjs'] : []),
    ...(demonstrationCase || taskAssetsCase ? ['apps/desktop/src/main/browser-demonstration-recorder.ts','apps/desktop/src/main/browser-demonstration-capture.ts',
      'apps/desktop/src/main/browser-semantic-target.ts','apps/desktop/src/shared/browser-demonstration.ts','apps/desktop/src/main/browser-cdp-session.ts',
      'apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx','apps/desktop/scripts/browser-demonstration-probe-scenario.mjs',
      'apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs',
      'apps/desktop/scripts/verify-browser-demonstration.mjs'] : []),
    ...(taskAssetsCase ? ['apps/desktop/src/main/browser-task-assets.ts','apps/desktop/src/main/browser-replay-compiler.ts',
      'apps/desktop/src/shared/browser-task-assets.ts','apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx',
      'apps/desktop/src/renderer/src/styles/browser-task-assets.css','apps/desktop/scripts/browser-task-assets-probe-scenario.mjs',
      'apps/desktop/scripts/verify-browser-task-assets.mjs'] : []),
    ...(overlayCase ? ['apps/desktop/src/main/native-overlay-surfaces.ts','apps/desktop/src/shared/native-overlay.ts',
      'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts','apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts',
      'apps/desktop/scripts/browser-overlay-probe-scenario.mjs','apps/desktop/scripts/browser-native-chrome-stage-observer.mjs',
      'apps/desktop/scripts/verify-browser-overlay-visibility.mjs'] : []),
    ...(overlayCase && process.env.AGENTMUX_OVERLAY_OBSERVE_ORIGINAL_PAINT === '1' ? ['apps/desktop/scripts/browser-overlay-paint-observer.mjs'] : []),
    ...(downloadCase ? ['apps/desktop/src/main/browser-downloads.ts','apps/desktop/src/shared/browser-download.ts',
      'apps/desktop/src/main/workspace-files.ts','apps/desktop/src/shared/workspace-file-bytes.ts',
      'packages/core/src/browser-page-capability.ts','apps/desktop/scripts/verify-browser-files.mjs'] : []),
    ...(browserToolsCase ? ['apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx',
      'apps/desktop/src/renderer/src/components/BrowserProfilesPanel.tsx','apps/desktop/src/renderer/src/lib/browser-annotations.ts',
      'apps/desktop/src/main/browser-profile-store.ts','apps/desktop/src/main/browser-profile-manager.ts',
      'apps/desktop/src/main/config-owner.ts','apps/desktop/src/main/config-store.ts',
      'apps/desktop/scripts/browser-tools-probe-scenario.mjs','apps/desktop/scripts/verify-browser-tools.mjs',
      'apps/desktop/scripts/browser-demonstration-probe-scenario.mjs','apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs'] : []),
    ...(structuredCase ? ['apps/desktop/src/main/browser-structured-output.ts','apps/desktop/src/main/browser-structured-target.ts',
      'apps/desktop/src/main/browser-page-dispatch.ts','apps/desktop/src/main/browser-page-snapshot.ts',
      'apps/desktop/src/main/browser-snapshot-query.ts','apps/desktop/src/main/browser-frame-documents.ts',
      'apps/desktop/src/main/browser-cdp-session.ts','apps/desktop/src/main/browser-result-artifact.ts',
      'apps/desktop/src/shared/browser-structured-output.ts','apps/desktop/src/shared/browser-result-artifact.ts',
      'apps/desktop/src/shared/browser-step-evidence.ts','apps/desktop/src/renderer/src/components/BrowserStructuredFields.tsx',
      'apps/desktop/src/renderer/src/styles/browser-structured-fields.css','packages/core/src/browser-page-capability.ts',
      'packages/core/src/control.ts','packages/core/src/control-host.ts','packages/core/dist/browser-page-capability.js',
      'apps/desktop/scripts/browser-structured-probe-scenario.mjs','apps/desktop/scripts/verify-browser-structured-output.mjs'] : [])]
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
  const probe = { child, main }
  launchedProbes.add(probe)
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
  if (observeNativeBounds) {
    const observed = await main.call('Debugger.evaluateOnCallFrame', {
      callFrameId: paused.callFrames[0].callFrameId,
      expression: `(() => { app.once('browser-window-created', () => {
        try { globalThis.__agentMuxPrivateBoundsObserver = (${installNativeBoundsObserver.toString()})(BrowserViewManager.prototype) }
        catch { globalThis.__agentMuxPrivateBoundsObserverError = 'Original Main bounds observer could not be installed' }
      }); return true })()`, returnByValue: true
    })
    assert.equal(observed.exceptionDetails, undefined, 'Private passive observer bootstrap must install without replacing any Browser fact')
  }
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId })
  await main.call('Debugger.resume')
  let ready
  try { ready = await waitFor(`${label} ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }) }
  catch (error) {
    const observed = { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, stderr: diagnostics,
      mainUrl, rendererUrl, readyFile: { exists: false }, mainPauses: main.pauses.slice(-4).map(pause => ({ reason: pause.reason,
        hitBreakpoints: pause.hitBreakpoints, frames: pause.callFrames.slice(0,4).map(frame => ({ name: frame.functionName, url: frame.url, location: frame.location })) })) }
    const bounded = action => Promise.race([action, new Promise((_, reject) => setTimeout(() => reject(new Error('Launch diagnostic timed out after 2s')), 2000))])
    try { observed.readyFile = { exists: true, text: (await readFile(readyFile, 'utf8')).slice(0,4096) } }
    catch (failure) { observed.readyFile.error = failure.code ?? failure.message }
    try { observed.main = await bounded(main.evaluate(`(()=>{const {app,BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');return{ready:app.isReady(),windows:BrowserWindow.getAllWindows().slice(0,8).map(window=>({id:window.id,visible:window.isVisible(),minimized:window.isMinimized(),focused:window.isFocused(),bounds:window.getBounds(),url:window.webContents.getURL(),loading:window.webContents.isLoading(),views:window.contentView.children.slice(0,16).map(view=>({id:view.webContents?.id,url:view.webContents?.getURL(),visible:view.getVisible(),bounds:view.getBounds()}))}))}})()`)) }
    catch (failure) { observed.mainError = failure.message }
    if (rendererUrl) {
      try { observed.rendererTargets = (await (await fetch(`http://${new URL(rendererUrl).host}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).slice(0,8).map(target=>({id:target.id,type:target.type,url:target.url,title:target.title})) }
      catch (failure) { observed.rendererError = failure.message }
    }
    receipt.launchDiagnostics ??= {}; receipt.launchDiagnostics[label] = observed
    throw error
  }
  const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
  const target = await waitFor(`${label} Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl); await cdp.call('Runtime.enable')
  probe.cdp = cdp
  receipt.launchUiObservations ??= {}
  receipt.launchUiObservations[label] = await cdp.evaluate('({bridgePresent:Boolean(window.agentmux),projectListPresent:Boolean(document.querySelector(".project-list")),navigationPresent:Boolean(document.querySelector(".surface-navigation")),regionCount:document.querySelectorAll("[data-workbench-region-id]").length,body:document.body.innerText.slice(0,1500)})')
  try {
    // The project sidebar is a persisted user choice. Original window navigation
    // confirms the mounted product shell; actualWorkbench verifies the retained regions below.
    await waitFor(`${label} trusted UI`, () => cdp.evaluate('Boolean(window.agentmux && document.querySelector(".surface-navigation"))'))
  } catch (error) {
    receipt.launchUiObservations[label].afterOriginalTimeout = await cdp.evaluate('({bridgePresent:Boolean(window.agentmux),projectListPresent:Boolean(document.querySelector(".project-list")),navigationPresent:Boolean(document.querySelector(".surface-navigation")),regionCount:document.querySelectorAll("[data-workbench-region-id]").length,body:document.body.innerText.slice(0,2000)})')
    throw error
  }
  const nativeHome = await cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, privateHome)
  const drainStageDelivery = observeStageDelivery ? await observeOriginalStageDelivery(cdp,desktopRoot) : undefined
  receipt[label] = { pid: child.pid, home, nativeHome, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  probe.drainStageDelivery = drainStageDelivery
  return probe
}
async function click(cdp, expression, button = 'left') {
  let point
  try { point = await waitFor('exact visible UI control', () => cdp.evaluate(`(async () => {
    const matches = ${expression}; if (matches.length !== 1) return null;
    const element = matches[0]; if (element.disabled || !element.getClientRects().length) return null;
    element.scrollIntoView({block:'nearest'}); await new Promise(done=>requestAnimationFrame(done));
    if(!element.isConnected)return null;
    const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    if(!r.width||!r.height||!hit||!element.contains(hit))return null;
    const observed={received:null,ariaLabel:element.getAttribute('aria-label'),tag:element.tagName};
    const listener=event=>{observed.received=event.isTrusted&&element.contains(event.target)};
    document.addEventListener('pointerdown',listener,{capture:true,once:true});
    globalThis.__privateBrowserRecoveryClick={observed,dispose:()=>document.removeEventListener('pointerdown',listener,true)};
    return {x,y};
  })()`)) } catch(error) {
    receipt.visual.failedClick={expression,candidates:await cdp.evaluate(`(()=>(${expression}).slice(0,8).map(element=>{
      const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      const identity=e=>({tag:e.tagName,ariaLabel:e.getAttribute('aria-label'),classes:typeof e.className==='string'?e.className:undefined,regionId:e.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId});
      return {expected:identity(element),rect:{x:r.x,y:r.y,width:r.width,height:r.height},center:{x,y},disabled:Boolean(element.disabled),connected:element.isConnected,hits:document.elementsFromPoint(x,y).slice(0,8).map(identity)};
    }))()`)}
    throw error
  }
  try {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
    const observed=await cdp.evaluate('globalThis.__privateBrowserRecoveryClick?.observed')
    receipt.visual.clicks??=[]; assert.ok(receipt.visual.clicks.length<256,'Private UI click observation budget')
    receipt.visual.clicks.push({point,...observed})
    assert.equal(observed?.received,true,'Trusted native UI input must reach the intended control')
  } finally { await cdp.evaluate('globalThis.__privateBrowserRecoveryClick?.dispose();delete globalThis.__privateBrowserRecoveryClick;null') }
}
const selectors = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`
async function state(cdp) { return cdp.evaluate(`(() => { const raw = localStorage.getItem('agentmux-workbench-v1'); return raw ? JSON.parse(raw).state.restoredWorkbench : null })()`) }
async function control(operation, target) { return requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation,target}, join(runtimeDirectory,'control.sock')) }
async function runBrowser(browserId, code) {
  const operationId=randomUUID()
  const reply=await requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation:'browser.run',browserId,operationId,code},join(runtimeDirectory,'control.sock'))
  assert.equal(reply.operation,'browser.run');assert.equal(reply.result.runOperation.id,operationId)
  return reply.result
}
async function openBrowser(url, destination) { const result=await requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation:'open.browser',url,destination},join(runtimeDirectory,'control.sock')); assert.equal(result.operation,'open.browser');return result.result.region }
async function normalQuit(probe) {
  phase = 'normal-quit'
  if(probe.drainStageDelivery){
    receipt.stageDelivery??={}
    try{receipt.stageDelivery[probe.child.pid]=await probe.drainStageDelivery()}
    catch(error){receipt.stageDelivery[probe.child.pid]={installed:false,error:String(error.message).slice(0,512)}}
    probe.drainStageDelivery=undefined
  }
  if (observeNativeBounds) {
    receipt.boundsStages ??= {}
    if (!Object.hasOwn(receipt.boundsStages, String(probe.child.pid))) {
      try {
        receipt.boundsStages[probe.child.pid] = await probe.main.evaluate(`(() => {
          const observer=globalThis.__agentMuxPrivateBoundsObserver;
          return observer ? {installed:true,...observer.restore()} : {installed:false,error:globalThis.__agentMuxPrivateBoundsObserverError??'Private observer was unavailable'};
        })()`)
      } catch (error) {
        receipt.boundsStages[probe.child.pid] = {installed:false,error:String(error.message).slice(0,512)}
      }
    }
  }
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
      if(contents.isLoading()||!contents.getTitle()||!text.includes('Private recovery '+new URL(url).pathname.slice(1)))return null;
      found.push({url,title:contents.getTitle(),text,webContentsId:contents.id,bounds:matches[0].getBounds()});}
    return found;
  })()`))
}
async function actualWorkbench(probe, expected) {
  const restored=await waitFor('durable Browser identity and exact focus',async()=>{
    const value=await state(probe.cdp);if(!value)return null;
    const tab=value.tabs[expected.tabId];if(!tab||tab.layout.activeRegionId!==expected.focus)return null;
    const browserRegions=Object.values(tab.regions).filter(r=>r.kind==='browser');
    return browserRegions.length===2&&expected.regions.every(e=>browserRegions.some(r=>r.browserId===e.browserId&&r.regionId===e.regionId&&r.url===e.url&&r.title===e.title))?value:null
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
  await waitFor('actual Renderer resize',()=>probe.cdp.evaluate(`Math.abs(innerWidth-${actual[0]}/window.agentmux.ui.getZoomFactor())<=1`))
  return actual
}
async function observeNativeFrameReady(probe, url) {
  const attempts = []
  receipt.visual.nativeFramePreflight ??= { captureOnly: true, runs: [] }
  receipt.visual.nativeFramePreflight.runs.push({url,attempts})
  return waitFor('visible, loaded native page with a nonempty compositor frame', async () => {
    const stage = await probe.cdp.evaluate(`(() => {const surfaces=Array.from(document.querySelectorAll('.browser-surface')).filter(surface=>surface.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${JSON.stringify(url)});if(surfaces.length!==1)return null;const e=surfaces[0].querySelector('[data-native-browser-stage]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,visible:!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'};})()`)
    const state = await probe.main.evaluate(`(async () => {const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');const win=BrowserWindow.getAllWindows()[0];
      const view=win.contentView.children.find(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL()===${JSON.stringify(url)});
      const window={visible:win.isVisible(),minimized:win.isMinimized(),focused:win.isFocused(),bounds:win.getBounds()};
      if(!view)return {window,view:null};
      const native={url:view.webContents.getURL(),visible:view.getVisible(),bounds:view.getBounds(),loading:view.webContents.isLoading()};
      if(!window.visible||window.minimized||!native.visible||native.loading||!native.bounds.width||!native.bounds.height)return {window,view:native,frame:null};
      try {const image=await view.webContents.capturePage();return {window,view:native,frame:{empty:image.isEmpty(),size:image.getSize()}};}
      catch(error){return {window,view:native,frame:{error:String(error)}};}})()`)
    const observation = { stage, ...state }
    attempts.push(observation)
    const bounds = state.view?.bounds
    const insideStage = stage?.visible && bounds && bounds.x >= stage.x - 1 && bounds.y >= stage.y - 1 &&
      bounds.x + bounds.width <= stage.x + stage.width + 1 && bounds.y + bounds.height <= stage.y + stage.height + 1
    return insideStage && state.frame?.empty === false ? observation : null
  }, 5_000)
}
async function capture(probe, label, content = 'operations', pageUrl) {
  await probe.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const observation = await probe.cdp.evaluate(`(() => {
    const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const rows=Array.from(document.querySelectorAll('.browser-rsi-timeline__step')).filter(visible);
    const rail=Array.from(document.querySelectorAll('.browser-trace-rail')).find(visible),stage=rail?.previousElementSibling??Array.from(document.querySelectorAll('[data-native-browser-stage]')).find(visible);
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    return {viewport:{width:innerWidth,height:innerHeight},rows:rows.map(e=>({sequence:e.dataset.sequence,status:e.querySelector('.browser-rsi-timeline__status').textContent,
      selected:e.querySelector('button').getAttribute('aria-pressed'),expanded:e.querySelector('button').getAttribute('aria-expanded')})),
      operationStatus:(()=>{const s=document.querySelector('.browser-operation-status');return s&&{phase:s.dataset.phase,control:s.dataset.control,operationId:s.dataset.operationId,
        taskRunId:s.dataset.taskRunId,taskVersion:s.dataset.taskVersion,trigger:s.querySelector('button')?.getAttribute('aria-label'),insideToolbar:!!s.closest('.browser-toolbar')};})(),
      trace:rail&&rect(rail),stage:stage&&rect(stage),payloadCount:document.querySelectorAll('.browser-rsi-timeline__step-detail').length,
      demonstration:(()=>{const surface=document.querySelector('[aria-label="Human demonstration draft"]');return surface&&{id:surface.dataset.demonstrationId,
        status:surface.querySelector('[role="status"]')?.textContent,stepsOpen:surface.querySelector('.browser-demonstration__steps')?.open,
        steps:Array.from(surface.querySelectorAll('[data-sequence]')).map(step=>({sequence:step.dataset.sequence,text:step.textContent}))};})(),
      taskAsset:(()=>{const surface=document.querySelector('[aria-label="Editable Browser task asset"]');return surface&&{id:surface.dataset.taskAssetId,
        steps:Array.from(surface.querySelectorAll('[data-task-step-id]')).map(step=>({id:step.dataset.taskStepId,text:step.textContent})),
        version:surface.querySelector('[aria-label="Task asset version"]')?.value,progress:(()=>{const p=surface.querySelector('.browser-task-asset__progress');return p&&{text:p.textContent,status:p.dataset.runStatus,runId:p.dataset.runId,version:p.dataset.runVersion,bounds:rect(p)}})()};})(),
      structured:(()=>{const surface=document.querySelector('[aria-label="Recorded structured fields"]');return surface&&{summary:surface.querySelector('.browser-structured-fields__summary')?.textContent,
        fields:Array.from(surface.querySelectorAll('.browser-structured-fields__values > div')).map(field=>({key:field.querySelector('dt')?.textContent,status:field.dataset.fieldStatus,text:field.querySelector('dd')?.textContent})),
        rawRange:surface.querySelector('.browser-structured-fields__range')?.textContent,rawCharacters:surface.querySelector('pre')?.textContent.length??0};})(),
      floatingContent:Array.from(document.body.children).filter(node=>node.id!=='root').flatMap(node=>[node,...node.querySelectorAll('[data-state="open"],[role="tooltip"],[role="dialog"],[role="menu"]')]).filter(visible).map(node=>({role:node.getAttribute('role'),state:node.getAttribute('data-state'),bounds:rect(node)})),
      focus:document.activeElement?.getAttribute('aria-label'),focusVisible:document.activeElement?.matches(':focus-visible')??false};
  })()`)
  observation.uiZoomFactor=await probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');return BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()})()`)
  assert.ok(Number.isFinite(observation.uiZoomFactor)&&observation.uiZoomFactor>0,'Actual Renderer zoom is required for native geometry')
  observation.coordinateSpace='renderer-css'
  receipt.visual.lastCaptureObservation={label,content,observation}
  if(content==='demonstration')assert.ok(observation.demonstration?.id&&observation.demonstration.steps.length>0,'Demonstration review must contain real recorded steps')
  else if(content==='task-assets')assert.ok(observation.taskAsset?.id&&observation.taskAsset.steps.length>0&&Number(observation.taskAsset.version)>0,'Asset review must contain a real editable draft and saved version')
  else if(content==='structured-output')assert.ok(observation.rows.length>0&&observation.structured?.fields.length>0,'Structured review contains the actual selected operation and nonempty retained fields')
  else if(content==='operations')assert.ok(observation.rows.length>0,'Visual review must contain real operation steps')
  assert.ok(observation.stage.width>0&&observation.stage.height>0,'The actual page keeps positive visible geometry')
  if(observation.trace)assert.ok(observation.stage.x+observation.stage.width<=observation.trace.x+1,'Trace does not overlay the native stage')
  else assert.ok(content==='overlay'||content==='page','Operation and demonstration review requires its actual details surface')
  const nativeBounds=await waitFor('native page bounds inside the actual stage',async()=>{
    const bounds=await probe.main.evaluate(`(() => { const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
      return BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&${pageUrl ? `v.webContents.getURL().split('#')[0]===${JSON.stringify(pageUrl)}` : "v.webContents.getURL().startsWith('http://127.0.0.1:')"}).map(v=>v.getBounds()); })()`)
    const factor=observation.uiZoomFactor,s={x:observation.stage.x*factor,y:observation.stage.y*factor,width:observation.stage.width*factor,height:observation.stage.height*factor}
    return bounds.length===1&&bounds[0].width>0&&bounds[0].height>0&&bounds[0].x>=s.x-1&&bounds[0].y>=s.y-1&&
      bounds[0].x+bounds[0].width<=s.x+s.width+1&&bounds[0].y+bounds[0].height<=s.y+s.height+1?bounds:null
  })
  if (!receipt.visual.osFrames?.some(frame => frame.label === label)) {
    await captureOsWindow({probe,desktopRoot,receipt},label)
  }
  const file=join(captureDirectory,`${label}.png`)
  const frame=await probe.main.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage();if(image.isEmpty())throw new Error('Empty Renderer frame');
    const png=image.toPNG();process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(file)},png);
    return {captureSource:'renderer-webcontents',size:image.getSize(),sha256:process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex')};})()`)
  const pageFile=join(captureDirectory,`${label}-native-page.png`)
  const nativePage=await probe.main.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const view=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents&&!v.webContents.isDestroyed()&&${pageUrl ? `v.webContents.getURL().split('#')[0]===${JSON.stringify(pageUrl)}` : "v.webContents.getURL().startsWith('http://127.0.0.1:')"});
    const image=await view.webContents.capturePage();if(image.isEmpty())throw new Error('Empty native page frame');const png=image.toPNG();
    process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(pageFile)},png);return {captureSource:'native-browser-webcontents',file:${JSON.stringify(pageFile)},bounds:view.getBounds(),size:image.getSize(),
      sha256:process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex')};})()`)
  receipt.visual.frames.push({label,file,...frame,observation,nativeBounds,nativePage})
}
async function openActivityTimeline(probe) {
  await click(probe.cdp,selectors('.browser-operation-status__trigger'))
  await click(probe.cdp,selectors('[aria-label="Open browser activity timeline"]'))
}
async function pressKey(probe, key, code = key, windowsVirtualKeyCode) {
  const value = {key,code,...(windowsVirtualKeyCode ? {windowsVirtualKeyCode} : {})}
  await probe.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',...value})
  await probe.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',...value})
}
async function nativePageScript(probe, expression, pageUrl) {
  assert.ok(typeof pageUrl==='string'&&pageUrl.length>0,'The fixture read requires the actual scenario page URL')
  return probe.main.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const views=BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL().split('#')[0]===${JSON.stringify(pageUrl)});
    if(views.length!==1)throw new Error('Expected exactly one native owner for the actual scenario page');return views[0].webContents.executeJavaScript(${JSON.stringify(expression)});})()`)
}
async function reviewOperationStates(probe, browserId, pageUrl) {
  const pageScript=expression=>nativePageScript(probe,expression,pageUrl)
  const operator={id:'private-browser-status',name:'Private Browser status'}
  const start=async code=>{
    const expression=`globalThis.__privateStatusRun=window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(code)},${JSON.stringify(operator)})`
    const result=await probe.cdp.call('Runtime.evaluate',{expression,awaitPromise:false})
    assert.equal(result.exceptionDetails,undefined)
  }
  const status=async expected=>waitFor(`actual Browser ${expected} state`,()=>probe.cdp.evaluate(`document.querySelector('.browser-operation-status')?.dataset.phase===${JSON.stringify(expected)}`))
  const frames=async expected=>{
    await status(expected);await openActivityTimeline(probe)
    await waitFor('nonempty actual operation timeline',()=>probe.cdp.evaluate('document.querySelectorAll(".browser-rsi-timeline__step").length>0'))
    for(const [label,width,height] of [['normal',1440,900],['narrow',980,700],['short-window',1440,560]]){
      await resize(probe,width,height);await capture(probe,`${label}-${expected}-status`)
      const actual=receipt.visual.frames.at(-1).observation.operationStatus
      assert.equal(actual.phase,expected);assert.equal(actual.insideToolbar,true)
    }
    await resize(probe,1440,900)
  }
  const held='await js("new Promise(resolve => { globalThis.__finishPrivateStatus = resolve })"); return "private observed operation";'
  receipt.visual.states={}
  await start(held);await frames('running')
  await click(probe.cdp,selectors('.browser-operation-status__trigger'))
  await capture(probe,'normal-running-actions')
  const navigation=[]
  for(let index=0;index<4;index++){
    await pressKey(probe,'ArrowDown','ArrowDown',40)
    const focused=await probe.cdp.evaluate('({role:document.activeElement?.getAttribute("role"),label:document.activeElement?.getAttribute("aria-label"),text:document.activeElement?.textContent})')
    navigation.push(focused)
    if(focused.label==='Stop browser operation')break
  }
  assert.equal(navigation.at(-1).label,'Stop browser operation','Keyboard can reach the real Stop item')
  await pressKey(probe,'Enter','Enter',13)
  await pageScript('globalThis.__finishPrivateStatus?.();null')
  const stopped=await probe.cdp.evaluate('globalThis.__privateStatusRun')
  assert.equal(stopped.outcome.kind,'stopped')
  receipt.visual.states.running={operation:stopped.runOperation,keyboard:navigation,outcome:stopped.outcome}
  await probe.cdp.evaluate(`window.agentmux.browser.returnControl(${JSON.stringify(browserId)})`)
  await start('await waitForElement("Private delayed ready",30000); return "observed ready element";')
  await frames('waiting')
  await pageScript('(()=>{const button=document.createElement("button");button.id="private-delayed-ready";button.textContent="Private delayed ready";document.body.append(button);return true})()')
  const waited=await probe.cdp.evaluate('globalThis.__privateStatusRun')
  assert.equal(waited.outcome.kind,'completed')
  receipt.visual.states.waiting={operation:waited.runOperation,outcome:waited.outcome}
  await pageScript('document.querySelector("#private-delayed-ready").remove();null')
  await start(held);await status('running')
  await pageScript('globalThis.__privateTrustedInput=0;document.addEventListener("mousedown",event=>{if(event.isTrusted)globalThis.__privateTrustedInput++},{once:true});null')
  const nativeInput=await probe.main.evaluate(`(async()=>{const {app,BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
    const window=BrowserWindow.getAllWindows()[0],views=window.contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL().startsWith('http://127.0.0.1:'));
    if(views.length!==1)throw new Error('Expected exactly one private native input owner');const view=views[0],bounds=view.getBounds();
    if(!window.isVisible()||window.isMinimized()||!view.getVisible()||bounds.width<=0||bounds.height<=0)throw new Error('Human input requires the actual visible page and window');
    app.focus({steal:true});window.focus();view.webContents.focus();const focusDeadline=Date.now()+2000;
    while(!window.isFocused()&&Date.now()<focusDeadline)await new Promise(done=>setTimeout(done,30));
    if(!window.isFocused())throw new Error('Native input requires the actual BrowserWindow focused');
    const observed={windowFocused:window.isFocused(),pageFocused:view.webContents.isFocused(),visible:view.getVisible(),bounds};
    for(const type of ['mouseDown','mouseUp'])view.webContents.sendInputEvent({type,button:'left',clickCount:1,x:20,y:80});return observed;})()`)
  const trustedInput=await waitFor('trusted native page input',async()=>{const count=await pageScript('globalThis.__privateTrustedInput');return count>0?count:null},2000)
  await frames('human')
  assert.ok(trustedInput>0,'The native page received trusted input, not a page-authored event')
  await pageScript('globalThis.__finishPrivateStatus?.();null')
  const human=await probe.cdp.evaluate('globalThis.__privateStatusRun')
  assert.equal(human.outcome.kind,'stopped')
  receipt.visual.states.human={operation:human.runOperation,nativeInput,trustedInput,inputSource:'Electron native sendInputEvent; physical hardware not tested',outcome:human.outcome}
  await probe.cdp.evaluate(`window.agentmux.browser.returnControl(${JSON.stringify(browserId)})`)
  await click(probe.cdp,selectors('[aria-label="Close browser activity timeline"]'))
}
async function reviewOperationRows(probe, browserId) {
  const operator={id:'private-browser-review',name:'Private Browser review'}
  const run=async code=>probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(code)},${JSON.stringify(operator)})`)
  const completed=await run('await snapshot({scope:"page",maxNodes:20}); await pageInfo(); await captureScreenshot(); return "private observed page";')
  assert.equal(completed.outcome.kind,'completed')
  await openActivityTimeline(probe)
  await waitFor('real completed timeline',()=>probe.cdp.evaluate(`document.querySelectorAll('.browser-rsi-timeline__step').length>=2`))
  await resize(probe,1440,900);await capture(probe,'normal-completed-collapsed')
  await resize(probe,980,700);await capture(probe,'narrow-completed-collapsed')
  await click(probe.cdp,selectors('.browser-rsi-timeline__step[data-sequence="1"] button'))
  await waitFor('actual recorded page evidence',()=>probe.cdp.evaluate(`Boolean(document.querySelector('.browser-step-evidence pre'))`))
  await capture(probe,'narrow-recorded-page-evidence')
  await click(probe.cdp,selectors('.browser-rsi-timeline__step[data-sequence="3"] button'))
  await waitFor('actual recorded screenshot evidence',()=>probe.cdp.evaluate(`Boolean(document.querySelector('.browser-step-evidence img')?.naturalWidth)`))
  await click(probe.cdp,selectors('.browser-step-evidence details summary'))
  await capture(probe,'narrow-recorded-screenshot-source')
  const failed=await run('await snapshot({scope:"page",maxNodes:20}); await click("not-a-recorded-ref");')
  assert.equal(failed.outcome.kind,'script-failed')
  await waitFor('real failed row',()=>probe.cdp.evaluate(`Boolean(document.querySelector('.browser-rsi-timeline__step--failed'))`))
  await resize(probe,1440,900);await capture(probe,'normal-failed-status')
  assert.equal(receipt.visual.frames.at(-1).observation.operationStatus.phase,'failed')
  await resize(probe,980,700)
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
async function reviewDownloads(probe,browserId) {
  phase='native-event-first-downloads'
  const operator={id:'private-browser-files',name:'Private Browser files'}
  const results=[]
  for(const [name,path] of [['Download attribute','attribute.bin'],['Navigation attachment','attachment.bin']]){
    const code=`const page=await snapshot({scope:'page',maxNodes:40});const targets=page.nodes.filter(node=>node.role==='link'&&node.name===${JSON.stringify(name)});if(targets.length!==1)throw new Error('Expected one actual download ref');return {observed:{url:page.url,navigationId:page.navigationId},download:await download(targets[0].ref,{path:${JSON.stringify(path)},timeoutMs:5000})};`
    const report=await probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(code)},${JSON.stringify(operator)})`)
    assert.equal(report.outcome.kind,'completed',JSON.stringify(report.outcome))
    const transfer=report.result.download, reference=transfer.reference
    assert.equal(transfer.status,'completed');assert.ok(reference)
    assert.equal(reference.workspaceId,workspaceId);assert.equal(reference.browserId,browserId)
    assert.equal(reference.operationId,report.runOperation.id);assert.equal(reference.navigationId,report.result.observed.navigationId)
    assert.equal(reference.url,report.result.observed.url);assert.equal(reference.byteLength,downloadPayload.length)
    assert.deepEqual(await readFile(join(workspacePath,path)),downloadPayload)
    await openActivityTimeline(probe)
    await waitFor('nonempty actual download operation timeline',()=>probe.cdp.evaluate('document.querySelectorAll(".browser-rsi-timeline__step").length>0'))
    await click(probe.cdp,`${selectors('.browser-rsi-timeline__step > button')}.slice(-1)`)
    for(const [size,width,height] of [['normal',1440,900],['narrow',980,700]]){
      await resize(probe,width,height);await capture(probe,`${size}-${path}-completed`)
    }
    await resize(probe,1440,900)
    await click(probe.cdp,selectors('[aria-label="Close browser activity timeline"]'))
    const readCode=`return await readDownload(${JSON.stringify(reference)},{offset:1,maxBytes:4});`
    const read=await probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(readCode)},${JSON.stringify(operator)})`)
    assert.equal(read.outcome.kind,'completed',JSON.stringify(read.outcome));assert.deepEqual(Buffer.from(read.result.data,'base64'),downloadPayload.subarray(1,5))
    assert.equal(read.result.offset,1);assert.equal(read.result.returnedBytes,4);assert.equal(read.result.totalBytes,downloadPayload.length)
    assert.deepEqual(read.result.reference,reference)
    results.push({trigger:name,operation:report.runOperation,reference,publicToolRead:read.result})
  }
  const entries=await probe.cdp.evaluate(`window.agentmux.files.readDirectory(${JSON.stringify(workspaceId)},'.')`)
  assert.ok(entries.length>0);for(const path of ['attribute.bin','attachment.bin'])assert.ok(entries.some(entry=>entry.name===path&&!entry.isDirectory))
  receipt.downloads={complete:results,workspaceEntries:entries,requests:downloadRequests,payloadSha256:digest(downloadPayload)}
}
async function startUnfinishedDownload(probe,browserId) {
  phase='native-unfinished-download-before-ordinary-quit'
  const code="const page=await snapshot({scope:'page',maxNodes:40});const targets=page.nodes.filter(node=>node.role==='link'&&node.name==='Unfinished attachment');if(targets.length!==1)throw new Error('Expected one actual unfinished download ref');return await download(targets[0].ref,{path:'unfinished.bin',timeoutMs:120000});"
  const start=await probe.cdp.call('Runtime.evaluate',{expression:`globalThis.__privateUnfinishedDownload=window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(code)},{id:'private-browser-files',name:'Private Browser files'})`,awaitPromise:false})
  assert.equal(start.exceptionDetails,undefined)
  await waitFor('actual server-held attachment response',()=>downloadRequests.some(request=>request.path==='/unfinished.bin'))
  const ownedReceipt=await waitFor('durable unfinished receipt from the actual Main owner',async()=>{
    const directory=join(userData,'browser-downloads')
    try{
      for(const name of await readdir(directory)){
        if(!name.endsWith('.json'))continue
        const record=JSON.parse(await readFile(join(directory,name),'utf8'))
        if(record.receipt?.browserId===browserId&&record.receipt.path==='unfinished.bin')return record.receipt
      }
    }catch(error){if(error.code!=='ENOENT')throw error}
    return null
  })
  await waitFor('actual pending download operation visible in its split',()=>probe.cdp.evaluate(`Array.from(document.querySelectorAll('.browser-operation-status')).map(element=>element.dataset.operationId).includes(${JSON.stringify(ownedReceipt.operationId)})`))
  assert.equal(ownedReceipt.workspaceId,workspaceId);assert.equal(ownedReceipt.browserId,browserId)
  assert.notEqual(ownedReceipt.status,'completed');assert.equal(ownedReceipt.reference,undefined)
  await assert.rejects(readFile(join(workspacePath,'unfinished.bin')),{code:'ENOENT'})
  receipt.downloads.unfinishedBeforeQuit=ownedReceipt
}
async function recoverDownloads(probe,browserId) {
  phase='native-download-file-read-after-ordinary-restart'
  for(const completed of receipt.downloads.complete){
    const code=`return await readDownload(${JSON.stringify(completed.reference)},{offset:0,maxBytes:64});`
    const report=await probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(code)},{id:'private-browser-files',name:'Private Browser files'})`)
    assert.equal(report.outcome.kind,'completed',JSON.stringify(report.outcome));assert.deepEqual(Buffer.from(report.result.data,'base64'),downloadPayload)
    assert.deepEqual(report.result.reference,completed.reference)
    completed.afterRestartPublicToolRead=report.result
  }
  const before=receipt.downloads.unfinishedBeforeQuit
  const record=JSON.parse(await readFile(join(userData,'browser-downloads',`${before.id}.json`),'utf8')).receipt
  assert.ok(['failed','cancelled'].includes(record.status));assert.equal(record.reference,undefined)
  await assert.rejects(readFile(join(workspacePath,'unfinished.bin')),{code:'ENOENT'})
  const forged={...receipt.downloads.complete[0].reference,id:before.id,path:'unfinished.bin',operationId:before.operationId}
  const rejection=await probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(browserId)},${JSON.stringify(`return await readDownload(${JSON.stringify(forged)});`)})`)
  assert.notEqual(rejection.outcome.kind,'completed')
  receipt.downloads.unfinishedAfterRestart={receipt:record,publicToolRejected:rejection.outcome}
}
try {
  const demonstration = demonstrationCase || taskAssetsCase ? await import('./browser-demonstration-probe-scenario.mjs') : null
  const overlay = overlayCase ? await import('./browser-overlay-probe-scenario.mjs') : null
  const taskAssets = taskAssetsCase ? await import('./browser-task-assets-probe-scenario.mjs') : null
  const browserTools = browserToolsCase ? await import('./browser-tools-probe-scenario.mjs') : null
  const structured = structuredCase ? await import('./browser-structured-probe-scenario.mjs') : null
  const scenarioContext = (probe,browserId,pageUrl)=>({probe,browserId,pageUrl,urls,receipt,click,selectors,waitFor,runBrowser,setPhase:value=>{phase=value},nativeFrameReady:actualPageUrl=>observeNativeFrameReady(probe,actualPageUrl),nativePageScript:(target,expression,actualPageUrl=pageUrl)=>nativePageScript(target,expression,actualPageUrl),resize,
    diagnoseTarget:process.argv.includes('--diagnose-demonstration-target'),
    capture:(probe,label,content,actualPageUrl=pageUrl)=>capture(probe,label,content??(demonstrationCase||taskAssetsCase?'demonstration':overlayCase?'overlay':browserToolsCase?'page':structuredCase?'structured-output':'operations'),actualPageUrl),desktopRoot,userData,repositoryRoot})
  await Promise.all([mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(codexHome,{recursive:true,mode:0o700}),mkdir(runtimeDirectory,{recursive:true})])
  receipt.identityBefore=await identity();receipt.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repositoryRoot})).stdout.trim()
  server=createServer((request,response)=>{
    if(downloadCase&&['/attribute.bin','/attachment.bin','/unfinished.bin'].includes(request.url)){
      downloadRequests.push({path:request.url,at:Date.now()})
      const headers={'content-type':'text/plain','content-length':request.url==='/unfinished.bin'?1024:downloadPayload.length,
        ...(request.url==='/attribute.bin'?{}:{'content-disposition':`attachment; filename="${request.url.slice(1)}"`})}
      response.writeHead(200,headers)
      if(request.url==='/unfinished.bin'){response.flushHeaders();response.write(downloadPayload.subarray(0,2));return}
      response.end(downloadPayload);return
    }
    response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><html><head><title>Private Browser '+request.url+'</title></head><body><h1>Private recovery '+request.url.slice(1)+'</h1>'+
      (downloadCase?'<a download="attribute.bin" href="/attribute.bin">Download attribute</a><a href="/attachment.bin">Navigation attachment</a><a href="/unfinished.bin">Unfinished attachment</a>':overlay?overlay.overlayFixture:browserTools?browserTools.browserToolsFixture:structured?structured.structuredFixture(request.url):demonstration?demonstration.demonstrationFixture:'')+'</body></html>')
  })
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
  const address=server.address();assert.ok(address&&typeof address==='object');const urls=['a','b'].map(path=>`http://127.0.0.1:${address.port}/${path}`)
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{},workspaces:[{id:workspaceId,name:workspaceName,hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:true,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
  first=await launch('first');phase='create-actual-browser-split'
  await click(first.cdp,selectors(`.project-rail-row[data-workspace-id="${workspaceId}"]`))
  await click(first.cdp,selectors('[aria-label="Browser Tools"]'))
  await click(first.cdp,selectors('[aria-label="New Browser"]'))
  const initial=await waitFor('actual UI-created Browser Region',async()=>{const s=await state(first.cdp);if(!s)return null;return Object.values(s.tabs).flatMap(tab=>Object.values(tab.regions).map(surface=>({tab,surface}))).find(x=>x.surface.kind==='browser'&&x.surface.workspaceId===workspaceId)})
  await first.cdp.evaluate(`window.agentmux.browser.navigate(${JSON.stringify(initial.surface.browserId)},${JSON.stringify(urls[0])})`)
  await waitFor('actual first page before visual operation',()=>nativePages(first,[urls[0]]))
  // Observe genuine readiness; do not override the product's overlay/focus visibility decisions.
  await observeNativeFrameReady(first,urls[0])
  receipt.visual.beforeOperation=await first.main.evaluate(`(() => {const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');const win=BrowserWindow.getAllWindows()[0];return {window:{visible:win.isVisible(),minimized:win.isMinimized(),bounds:win.getBounds()},views:win.contentView.children.filter(v=>v.webContents).map(v=>({url:v.webContents.getURL(),visible:v.getVisible(),bounds:v.getBounds(),loading:v.webContents.isLoading()}))};})()`)
  if(downloadCase)await reviewDownloads(first,initial.surface.browserId)
  else if(browserTools)await browserTools.reviewBrowserTools(scenarioContext(first,initial.surface.browserId,urls[0]))
  else if(structured)await structured.reviewStructuredOutput(scenarioContext(first,initial.surface.browserId,urls[0]))
  else if(taskAssets)await taskAssets.reviewTaskAssets(scenarioContext(first,initial.surface.browserId,urls[0]))
  else if(demonstration)await demonstration.reviewDemonstration(scenarioContext(first,initial.surface.browserId,urls[0]))
  else if(overlay)await overlay.reviewOverlay(scenarioContext(first,initial.surface.browserId,urls[0]))
  else{
    await reviewOperationStates(first,initial.surface.browserId,urls[0])
    receipt.visual.operations=await reviewOperationRows(first,initial.surface.browserId)
  }
  const sibling=await openBrowser(urls[1],{kind:'split',direction:'right',region:{kind:'region',regionId:initial.surface.regionId}})
  await control('focus',{kind:'region',regionId:initial.surface.regionId})
  const pages=await nativePages(first,urls)
  const expected={tabId:initial.tab.id,focus:initial.surface.regionId,regions:[{browserId:initial.surface.browserId,regionId:initial.surface.regionId,url:urls[0],title:pages[0].title},{browserId:sibling.browserId,regionId:sibling.regionId,url:urls[1],title:pages[1].title}]}
  const before=await actualWorkbench(first,expected)
  if(downloadCase)await startUnfinishedDownload(first,initial.surface.browserId)
  if(demonstrationCase)await demonstration.startInterruptedDemonstration(scenarioContext(first,initial.surface.browserId,urls[0]))
  // The ordinary product quit path itself is the acceptance boundary. No manual flush or seed.
  receipt.firstUi={expected,pages,...before};receipt.firstExit=await normalQuit(first)
  second=await launch('second');phase='actual-second-process-recovery'
  const after=await actualWorkbench(second,expected), restoredPages=await nativePages(second,urls)
  assert.deepEqual(after.restored,before.restored)
  const ensure=await second.cdp.evaluate(`window.agentmux.browser.create(${JSON.stringify(expected.regions[0].browserId)},'http://127.0.0.1:1/stale')`)
  assert.equal(ensure.id,expected.regions[0].browserId);assert.equal(ensure.url,urls[0]);assert.equal(ensure.error,null)
  const pagesAfterEnsure=await nativePages(second,urls);assert.deepEqual(pagesAfterEnsure,restoredPages)
  if(downloadCase)await recoverDownloads(second,expected.regions[0].browserId)
  if(demonstrationCase)await demonstration.recoverDemonstration(scenarioContext(second,expected.regions[0].browserId,urls[0]))
  if(taskAssets)await taskAssets.recoverTaskAssets(scenarioContext(second,expected.regions[0].browserId,urls[0]))
  if(browserTools)await browserTools.recoverBrowserTools(scenarioContext(second,expected.regions[0].browserId,urls[0]))
  if(structured)await structured.recoverStructuredOutput(scenarioContext(second,expected.regions[0].browserId,urls[0]))
  if(overlay)await overlay.recoverOverlay(scenarioContext(second,expected.regions[0].browserId,urls[0]))
  receipt.secondUi={...after,pages:restoredPages,ensure};receipt.secondExit=await normalQuit(second)
  receipt.identityAfter=await identity();assert.deepEqual(receipt.identityAfter,receipt.identityBefore)
  receipt.completeGate=true
} catch(error) {
  failure={phase,message:error.message,stack:error.stack};const active=second??first
  if(active&&active.child.exitCode===null&&active.child.signalCode===null){try{receipt.failureWorkbench=await state(active.cdp);receipt.failureDom=await active.cdp.evaluate('document.body.innerText.slice(-5000)')}catch(error){receipt.diagnosticError=error.message}}
} finally {
  const errors=[]
  for(const probe of [...launchedProbes].reverse()){if(probe.child.exitCode===null&&probe.child.signalCode===null){try{await normalQuit(probe)}catch(error){errors.push(error.message)}}}
  for(const connection of connections){try{connection.close()}catch(error){errors.push(error.message)}}
  for(const child of children){if(child.pid===undefined)continue;try{assert.ok(child.pid>1);await stopProbeProcesses(child.pid,root)}catch(error){errors.push(error.message)}}
  const sentinel=process.pid+1_000_000_000
  try{await stopProbeProcesses(sentinel,root)}catch(error){errors.push(error.message)}
  let remaining;try{remaining=await listProbeProcesses(sentinel,root);assert.deepEqual(remaining,[])}catch(error){errors.push(error.message)}
  try{if(server){server.closeAllConnections();await new Promise((done,fail)=>server.close(error=>error?fail(error):done()))}}catch(error){errors.push(error.message)}
  receipt.cleanup={remaining:remaining??null,errors,privateProcessesReaped:errors.length===0&&remaining?.length===0,temporaryRootRemoved:false}
  if(receipt.cleanup.privateProcessesReaped){try{await rm(root,{recursive:true,force:true});receipt.cleanup.temporaryRootRemoved=true}catch(error){errors.push(error.message)}}
  if(errors.length&&!failure)failure={phase:'cleanup',message:errors.join('; ')}
}
receipt.passed=!failure&&receipt.completeGate;receipt.failure=failure??null
await mkdir(join(repositoryRoot,'.tmp'),{recursive:true})
await writeFile(join(repositoryRoot,'.tmp',downloadCase?'browser-files-download-last.json':demonstrationCase?'browser-demonstration-last.json':overlayCase?'browser-overlay-last.json':taskAssetsCase?'browser-task-assets-last.json':browserToolsCase?'browser-tools-last.json':structuredCase?'browser-structured-output-last.json':'browser-recovery-restart-last.json'),JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,completeGate:receipt.completeGate,failure:receipt.failure,cleanup:receipt.cleanup})+'\n')
process.exitCode=receipt.passed?0:1
