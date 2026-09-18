import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Actual private Core Hook / Runtime / native Desktop. The private cat emits no model output.
// Public Electron home isolation happens before the home constant; no Store setters or seed flush.
const repositoryRoot = process.env.AGENTMUX_VERIFY_REPOSITORY_ROOT ?? resolve(import.meta.dirname, '../../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
const { requestAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxFileAgentSessionStore, connectLocalAgentMux } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-state-time-')
const userData=join(root,'user-data'), privateHome=join(root,'home'), runtimeDirectory=join(root,'runtime')
const workspacePath=join(root,'workspace'), codexHome=join(privateHome,'codex')
const workspaceId='private-state-time', workspaceName='Private state time'
const fixtureEnvironment={AGENTMUX_DESKTOP_USER_DATA:userData,AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory,AGENTMUX_MESSAGE_QUEUE_PATH:join(userData,'messages.ndjson'),CODEX_HOME:codexHome}
const initialEnvironment=new Map(['AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','CODEX_HOME'].map(name=>[name,process.env[name]]))
const children=new Set(),childIdentities=new Map(),connections=new Set(),runIdentities=new Map(),sessions=new Map()
const deadline=Date.now()+180_000
const receipt={schema:'agentmux.agent-state-time-restart.v1',completeGate:false,syntheticProducer:true,executedSlices:[],cleanup:{}}
let phase='prepare',failure,first,second,client
const store=new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))
async function waitFor(label, read, budget = 25_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(70) }
  throw new Error(`Agent state time timed out: ${label}`)
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
  const childIdentity=await processIdentity(child.pid);assert.ok(childIdentity);assert.equal(childIdentity.group,child.pid);childIdentities.set(child.pid,childIdentity)
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
async function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid)&&pid>1)
  let stdout;try{({stdout}=await exec('ps',['-p',String(pid),'-o','pgid=,lstart='],{timeout:5_000}))}catch(error){if(error.code===1)return null;throw error}
  const match=/^\s*(\d+)\s+(.+)$/.exec(stdout.trim());assert.ok(match)
  return {pid,group:Number(match[1]),born:match[2]}
}

async function identity() {
  const sources=['packages/core/src/agent-semantic-state.ts','packages/core/src/client.ts','packages/core/src/types.ts',
    'apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/session-state.ts','apps/desktop/src/renderer/src/lib/agent-state-time.ts',
    'apps/desktop/src/renderer/src/lib/project-activity-row.ts','apps/desktop/src/renderer/src/components/ProjectActivity.tsx',
    'apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx','apps/desktop/src/shared/contracts.ts',
    'apps/desktop/scripts/verify-agent-state-time-restart.mjs','apps/desktop/scripts/probe-process.mjs']
  const assets=(await readdir(join(desktopRoot,'out/renderer/assets'))).filter(name=>name.endsWith('.js')).sort()
  const core=(await readdir(join(repositoryRoot,'packages/core/dist'))).filter(name=>name.endsWith('.js')).sort()
  assert.ok(assets.length>0&&core.length>0)
  const paths=[...sources,'apps/desktop/out/main/index.js','apps/desktop/out/preload/index.cjs','apps/desktop/out/renderer/index.html',
    ...assets.map(name=>'apps/desktop/out/renderer/assets/'+name),...core.map(name=>'packages/core/dist/'+name)]
  const files=Object.fromEntries(await Promise.all(paths.map(async path=>{const bytes=await readFile(join(repositoryRoot,path));assert.ok(bytes.length>0,path);return [path,digest(bytes)]})))
  const electron=require('electron');assert.ok((await readFile(electron)).length>0)
  return {files,electron:{path:electron,sha256:digest(await readFile(electron))}}
}
async function stored(label) {
  const value=(await store.load()).find(item=>item.agentSessionId===sessions.get(label).agentSessionId)
  assert.ok(value,'Nonempty exact stored Session '+label);return value
}
async function post(label,eventName,receiptId=randomUUID()) {
  const id=sessions.get(label).agentSessionId
  const binding=await waitFor('private binding '+label,async()=>{try{return JSON.parse(await readFile(join(root,'binding-'+id+'.json'),'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}})
  assert.equal(binding.agentSessionId,id)
  const postedAt=Date.now()
  const response=await fetch(binding.url,{method:'POST',headers:{authorization:'Bearer '+binding.token,'content-type':'application/json'},
    body:JSON.stringify({receiptId,eventName,payload:{}}),signal:AbortSignal.timeout(3000)})
  assert.equal(response.status,204,'Actual accepted private Core Hook')
  return await waitFor('durable semantic '+label,async()=>{const s=await stored(label);return s.semanticStatus?.state===({UserPromptSubmit:'working',PermissionRequest:'waiting',Stop:'done'})[eventName]&&s.semanticStatus.observedAt>=postedAt?s.semanticStatus:null})
}
async function control(operation,options) {
  return requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation,...options},join(runtimeDirectory,'control.sock'))
}
async function uiSnapshot(cdp) {return cdp.evaluate('window.agentmux.sessions.snapshot()')}
async function durableLayout(cdp) {
  return cdp.evaluate(`(()=>{const raw=localStorage.getItem('agentmux-workbench-v1');if(!raw)return null;const s=JSON.parse(raw).state;return {workbench:s.restoredWorkbench,activeWorkspaceId:s.activeWorkspaceId,focus:s.agentFocus}})()`)
}
async function actualGeometry(cdp) {
  const value=await cdp.evaluate(`(()=>Array.from(document.querySelectorAll('[data-workbench-region-id]')).filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.workbenchRegionId,x:r.x,y:r.y,width:r.width,height:r.height}}).sort((a,b)=>a.id.localeCompare(b.id)))()`)
  assert.equal(value.length,2,'Both actual Region geometries are required');return value
}
async function actualActivity(cdp) {
  const values=await cdp.evaluate(`(()=>{const rows=Array.from(document.querySelectorAll('.project-activity-menu__item')).filter(e=>e.getClientRects().length);return {at:Date.now(),rows:rows.map(e=>({label:e.querySelector('strong')?.textContent,meta:e.querySelector('.project-activity-menu__meta')?.textContent,reason:e.querySelector('.project-activity-menu__reason')?.textContent}))}})()`)
  assert.equal(values.rows.length,2,'Both actual Agent rows must be visible');return values
}
async function openActivity(cdp) {
  await click(cdp,selectors(`.project-rail-entry:has(.project-rail-row[data-workspace-id="${workspaceId}"]) > .project-activity`))
  const disclosures=await cdp.evaluate(`${selectors('.project-activity-group__disclosure')}.map(e=>e.getAttribute('aria-expanded'))`)
  assert.equal(disclosures.length,1)
  if(disclosures[0]!=='true')await click(cdp,selectors('.project-activity-group__disclosure'))
  return await waitFor('two real Activity rows',async()=>{const count=await cdp.evaluate(`${selectors('.project-activity-menu__item')}.length`);return count===2?actualActivity(cdp):null})
}
function verifyAge(actual,label,state,entry) {
  const row=actual.rows.find(row=>row.label.startsWith(label));assert.ok(row,'Exact labelled actual row '+label)
  const age=/^(?:working|waiting) (\d+)([smh])$|^(\d+)([smh]) idle$/.exec(row.meta)
  assert.ok(age,'Actual known state duration '+JSON.stringify(row))
  const shown=Number(age[1]??age[3]),unit=age[2]??age[4],unitMs={s:1000,m:60_000,h:3_600_000}[unit]
  const expected=Math.floor((actual.at-entry)/unitMs)
  assert.ok(expected>=0&&Math.abs(shown-expected)<=1,'Visible tick must agree with Core epoch at the displayed precision')
  if(state==='done')assert.ok(row.meta.endsWith(' idle'));else assert.ok(row.meta.startsWith(state+' '))
  return shown
}
async function sameRuns(cdp) {
  const snapshot=await uiSnapshot(cdp)
  assert.equal(snapshot.sessions.filter(s=>s.kind==='agent').length,2)
  for(const [label,session] of sessions) {
    const actual=snapshot.sessions.find(s=>s.id===session.agentSessionId);assert.ok(actual)
    assert.equal(actual.processState,'running');assert.deepEqual(actual.control.run,session.run)
  }
  return snapshot
}
try {
  await Promise.all([mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(codexHome,{recursive:true,mode:0o700}),mkdir(runtimeDirectory,{recursive:true}),mkdir(privateHome,{recursive:true})])
  receipt.identityBefore=await identity();receipt.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repositoryRoot})).stdout.trim()
  Object.assign(process.env,{AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory,AGENTMUX_MESSAGE_QUEUE_PATH:fixtureEnvironment.AGENTMUX_MESSAGE_QUEUE_PATH,CODEX_HOME:codexHome})
  const executable=join(root,'private-cat.sh')
  await writeFile(executable,`#!/bin/sh\numask 077\nprintf '{"url":"%s","token":"%s","agentSessionId":"%s"}\\n' "$AGENTMUX_HOOK_URL" "$AGENTMUX_HOOK_TOKEN" "$AGENTMUX_AGENT_SESSION_ID" > '${root}/binding-'"$AGENTMUX_AGENT_SESSION_ID".json\nstty -echo -icanon\nprintf 'Private state time cat ready\\n'\nexec /bin/cat\n`,{mode:0o700})
  receipt.fixture={executableSha256:digest(await readFile(executable)),syntheticPty:true,syntheticNativeHook:true}
  client=await connectLocalAgentMux({store})
  for(const label of ['Known clock','Unknown clock']) {
    const session=await client.createAgent({createOperationId:randomUUID(),executorId:label.toLowerCase().replaceAll(' ','-'),providerId:'codex',commandOverride:executable,workspacePath,env:{CODEX_HOME:codexHome},injectAgentMuxGuide:false,cols:100,rows:30})
    sessions.set(label,session)
    const run=(await client.listRuns()).find(r=>r.runId===session.run.runId);assert.equal(run?.state,'running');assert.ok(Number.isFinite(run.acceptedInputBytes))
    const process=await processIdentity(run.pid);assert.ok(process?.group>1);runIdentities.set(label,{...process,runId:run.runId,inputBytes:run.acceptedInputBytes})
  }
  await client.dispose();client=null
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],
    executors:Object.fromEntries([...sessions.keys()].map(label=>[label.toLowerCase().replaceAll(' ','-'),{label,providerId:'codex',command:executable,args:[],env:{CODEX_HOME:codexHome},injectAgentMuxGuide:false}])),
    workspaces:[{id:workspaceId,name:workspaceName,hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},
    browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
  first=await launch('first');phase='real-live-semantic'
  await click(first.cdp,selectors(`.project-rail-row[data-workspace-id="${workspaceId}"]`))
  const known=sessions.get('Known clock'),unknown=sessions.get('Unknown clock')
  // An empty ordinary Workspace has no durable Launcher Region. Open the existing
  // Session through the actual Activity row, then use its real durable Region identity.
  await openActivity(first.cdp)
  await click(first.cdp,`${selectors('.project-activity-menu__item')}.filter(e=>e.querySelector('strong')?.textContent.startsWith('Known clock'))`)
  const opened=await waitFor('real Activity navigation opens exact Session',async()=>{const value=await durableLayout(first.cdp);return Object.values(value?.workbench?.tabs??{}).flatMap(t=>Object.values(t.regions)).find(r=>r.kind==='agent'&&r.sessionId===known.agentSessionId)})
  const inspected=await control('inspect.region',{target:{kind:'region',regionId:opened.regionId}})
  const region=inspected.result.region;assert.equal(region.agentSessionId,known.agentSessionId)
  const split=await control('open.agent',{content:{kind:'agent-session',agentSessionId:unknown.agentSessionId},destination:{kind:'split',region:{kind:'region',regionId:region.regionId},direction:'right'}})
  assert.equal(split.result.region.agentSessionId,unknown.agentSessionId)
  await control('focus',{target:{kind:'region',regionId:region.regionId}})
  const working=await post('Known clock','UserPromptSubmit');assert.ok(Number.isSafeInteger(working.stateEnteredAt))
  await waitFor('native working reaches actual snapshot',async()=>{const s=await sameRuns(first.cdp);return s.sessions.find(s=>s.id===known.agentSessionId)?.semanticStatus?.observedAt===working.observedAt})
  const beforeMenuGeometry=await actualGeometry(first.cdp)
  phase='visible-working-clock'
  await openActivity(first.cdp)
  // The public Main snapshot precedes the Renderer event/effect. Observe the actual
  // mounted menu becoming current; never force its Store or clock from this probe.
  let activity=await waitFor('known native duration reaches actual menu',async()=>{const a=await actualActivity(first.cdp);return /^working \d+[smh]$/.test(a.rows.find(r=>r.label.startsWith('Known clock'))?.meta??'')?a:null},5000)
  const firstAge=verifyAge(activity,'Known clock','working',working.stateEnteredAt)
  assert.equal(activity.rows.find(r=>r.label.startsWith('Unknown clock'))?.meta,'start time unknown')
  await delay(1200)
  activity=await actualActivity(first.cdp);assert.ok(verifyAge(activity,'Known clock','working',working.stateEnteredAt)>firstAge,'Visible silent menu actually advances')
  assert.deepEqual(await actualGeometry(first.cdp),beforeMenuGeometry,'Hover/menu/time ticks cannot resize terminal Regions')
  const repeated=await post('Known clock','UserPromptSubmit');assert.equal(repeated.stateEnteredAt,working.stateEnteredAt);assert.ok(repeated.observedAt>working.observedAt)
  await waitFor('repeated live observation visible',async()=>{const s=await sameRuns(first.cdp);return s.sessions.find(s=>s.id===known.agentSessionId)?.semanticStatus?.observedAt===repeated.observedAt})
  const repeatedUi=await actualActivity(first.cdp);verifyAge(repeatedUi,'Known clock','working',working.stateEnteredAt)
  phase='visible-waiting-clock'
  const waitingReceiptId=randomUUID()
  const waiting=await post('Known clock','PermissionRequest',waitingReceiptId);assert.ok(waiting.stateEnteredAt>working.stateEnteredAt)
  await waitFor('actual waiting duration',async()=>{const a=await actualActivity(first.cdp);return a.rows.find(r=>r.label.startsWith('Known clock'))?.meta?.startsWith('waiting ')?a:null})
  const waitingUi=await actualActivity(first.cdp);verifyAge(waitingUi,'Known clock','waiting',waiting.stateEnteredAt)
  // Native Hook retries retain their receipt identity. A different permission
  // request would correctly conflict with the first still-pending request.
  const repeatedWaiting=await post('Known clock','PermissionRequest',waitingReceiptId);assert.equal(repeatedWaiting.stateEnteredAt,waiting.stateEnteredAt)
  receipt.firstUi={beforeMenuGeometry,working,repeated,repeatedUi,waiting,repeatedWaiting,waitingUi,unknownUi:activity.rows.find(r=>r.label.startsWith('Unknown clock'))}
  await first.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await first.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  const layout=await waitFor('ordinary durable split/focus',async()=>{const s=await durableLayout(first.cdp);const tabs=Object.values(s?.workbench?.tabs??{});return tabs.length===1&&Object.values(tabs[0].regions).length===2&&tabs[0].layout.activeRegionId===region.regionId?s:null})
  receipt.layoutBefore=layout;receipt.firstExit=await normalQuit(first)
  second=await launch('second');phase='normal-restart'
  const snapshot=await sameRuns(second.cdp),persisted=await waitFor('same normal durable workbench',()=>durableLayout(second.cdp))
  assert.deepEqual(persisted,layout)
  const restoredKnown=snapshot.sessions.find(s=>s.id===known.agentSessionId);assert.equal(restoredKnown.semanticStatus.stateEnteredAt,waiting.stateEnteredAt)
  assert.equal(restoredKnown.semanticStatus.observedAt,repeatedWaiting.observedAt)
  assert.equal(snapshot.sessions.find(s=>s.id===unknown.agentSessionId).semanticStatus,undefined)
  const restoredGeometry=await actualGeometry(second.cdp)
  assert.deepEqual(restoredGeometry,beforeMenuGeometry,'Actual restored Region identities and geometry must match')
  const activeRegions=await second.cdp.evaluate(`${selectors('.workbench-region--active[data-workbench-region-id]')}.map(e=>e.dataset.workbenchRegionId)`)
  assert.deepEqual(activeRegions,[region.regionId],'Actual UI focus must restore before any focus operation')
  const restoredTab=await control('inspect.tab',{target:{kind:'tab',tabId:Object.values(layout.workbench.tabs)[0].id}})
  assert.deepEqual(restoredTab.result.tab.regions.map(r=>({id:r.regionId,kind:r.kind,session:r.agentSessionId})).sort((a,b)=>a.id.localeCompare(b.id)),
    [{id:region.regionId,kind:'agent',session:known.agentSessionId},{id:split.result.region.regionId,kind:'agent',session:unknown.agentSessionId}].sort((a,b)=>a.id.localeCompare(b.id)))
  const restartUi=await openActivity(second.cdp);verifyAge(restartUi,'Known clock','waiting',waiting.stateEnteredAt)
  assert.equal(restartUi.rows.find(r=>r.label.startsWith('Unknown clock'))?.meta,'start time unknown')
  receipt.secondUi={persisted,restoredGeometry,activeRegions,restoredTab:restoredTab.result.tab,restartUi,sessionFacts:snapshot.sessions.map(s=>({id:s.id,processState:s.processState,control:s.control,semanticStatus:s.semanticStatus}))}
  const marker='private-state-time-after-restart-'+randomUUID()
  await second.cdp.evaluate(`(async()=>{const s=(await window.agentmux.sessions.snapshot()).sessions.find(s=>s.id===${JSON.stringify(unknown.agentSessionId)});await window.agentmux.sessions.write(s.control,${JSON.stringify(marker+'\r')},'user');return true})()`)
  // The exact public Core reader observes the native output after UI->registered Main->Core input.
  client=await connectLocalAgentMux({store})
  const output=await waitFor('actual nonempty private output',async()=>{const replay=await client.readRunReplay(unknown.run);const text=replay.replay.map(e=>e.data).join('');return text.includes(marker)?{pid:replay.run.pid,acceptedInputBytes:replay.run.acceptedInputBytes,events:replay.replay.length,textSha256:digest(text),gap:replay.gap}:null})
  assert.equal(output.pid,runIdentities.get('Unknown clock').pid);assert.ok(output.events>0);assert.ok(output.acceptedInputBytes>runIdentities.get('Unknown clock').inputBytes)
  const runs=await client.listRuns();for(const [label,identity]of runIdentities){const run=runs.find(r=>r.runId===identity.runId);assert.equal(run?.pid,identity.pid);assert.equal(run?.state,'running')}
  receipt.healthyInput={marker,output,runIdentities:Object.fromEntries(runIdentities)}
  await client.dispose();client=null
  receipt.secondExit=await normalQuit(second)
  receipt.identityAfter=await identity();assert.deepEqual(receipt.identityAfter,receipt.identityBefore)
  assert.equal(digest(await readFile(executable)),receipt.fixture.executableSha256)
  receipt.executedSlices=['real-private-native-Hook-live-copy-and-repeat','real-visible-Activity-single-tick-known-unknown','normal-two-process-durable-entry-layout-focus','unknown-clock-still-accepts-real-UI-input-and-output']
  receipt.completeGate=true
}catch(error){
  failure={phase,name:error.name,message:error.message,stack:error.stack}
  const probe=second??first
  if(probe)try{
    receipt.failureObservation=await probe.cdp.evaluate(`(async()=>{const snapshot=await window.agentmux.sessions.snapshot();return {at:Date.now(),visibility:document.visibilityState,sessions:snapshot.sessions.map(s=>({id:s.id,kind:s.kind,processState:s.processState,status:s.status,semanticStatus:s.semanticStatus,control:s.control})),menu:Array.from(document.querySelectorAll('.project-activity-menu')).filter(e=>e.getClientRects().length).map(e=>e.textContent),regions:Array.from(document.querySelectorAll('[data-workbench-region-id]')).filter(e=>e.getClientRects().length).map(e=>({id:e.dataset.workbenchRegionId,className:e.className}))}})()`)
  }catch(observationError){receipt.failureObservation={error:observationError.message}}
}
finally {
  const errors=[]
  for(const probe of [second,first])if(probe&&probe.child.exitCode===null&&probe.child.signalCode===null){try{await normalQuit(probe)}catch(error){errors.push(error.message)}}
  try{await client?.dispose()}catch(error){errors.push(error.message)}
  for(const c of connections)try{c.close()}catch(error){errors.push(error.message)}
  for(const child of children)if(child.pid>1){try{const original=childIdentities.get(child.pid),actual=await processIdentity(child.pid);if(original&&actual&&original.born===actual.born){assert.equal(actual.group,original.group);await stopProbeProcesses(actual.group,root)}}catch(error){errors.push(error.message)}}
  for(const identity of runIdentities.values())try{const actual=await processIdentity(identity.pid);if(actual&&actual.born===identity.born){assert.equal(actual.group,identity.group);await stopProbeProcesses(actual.group,root)}}catch(error){errors.push(error.message)}
  const sentinel=process.pid+1_000_000_000
  let remaining
  try{await stopProbeProcesses(sentinel,root);remaining=await listProbeProcesses(sentinel,root);assert.deepEqual(remaining,[])}catch(error){errors.push(error.message)}
  for(const original of childIdentities.values())try{assert.deepEqual(await listProbeProcesses(original.group,root),[],'No original private child group may remain')}catch(error){errors.push(error.message)}
  for(const identity of runIdentities.values())try{const actual=await processIdentity(identity.pid);assert.ok(!actual||actual.born!==identity.born,'Exact private Agent must be reaped')}catch(error){errors.push(error.message)}
  receipt.cleanup={remaining:remaining??null,errors,privateProcessesReaped:!errors.length&&remaining?.length===0,temporaryRootRemoved:false}
  if(receipt.cleanup.privateProcessesReaped)try{await rm(root,{recursive:true,force:true});receipt.cleanup.temporaryRootRemoved=true}catch(error){errors.push(error.message)}
  if(errors.length&&!failure)failure={phase:'cleanup',message:errors.join('; ')}
  for(const[name,value]of initialEnvironment){if(value===undefined)delete process.env[name];else process.env[name]=value}
}
receipt.passed=!failure;receipt.failure=failure??null
await mkdir(join(repositoryRoot,'.tmp'),{recursive:true});await writeFile(join(repositoryRoot,'.tmp/agent-state-time-restart-last.json'),JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,completeGate:receipt.completeGate,phase:failure?.phase??'complete',executedSlices:receipt.executedSlices,cleanup:receipt.cleanup,failure:receipt.failure})+'\n')
process.exitCode=receipt.passed?0:1
