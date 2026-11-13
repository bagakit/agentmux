import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../../../src/main/browser-operation-journal'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets'
import { projectBrowserControlResult } from '../../../src/main/browser-completion-control'
import { executeBrowserTaskControl } from '../../../src/main/browser-task-control'

app.on('window-all-closed', () => {})
const root = process.env.AGENTMUX_TOUCH_ROOT!, source = process.env.AGENTMUX_TOUCH_SOURCE!, node = process.env.AGENTMUX_TOUCH_NODE!
const receipt: any = { schema: 'agentmux.browser-touch.native.v1', passed: false, cases: [], cli: [], native: [],
  boundary: 'Private actual Electron BrowserViewManager and original Renderer browser.run consumer, built public CLI, task editor callbacks and immutable task execution. HTML5 and pointer capture use native Input commands; no page dispatchEvent/DataTransfer synthesis or user Browser/Agent/Run.' }
let contents: Electron.WebContents
console.error('touch-proof:module')
let win: BrowserWindow, manager: BrowserViewManager, control: AgentMuxControlServer, server: ReturnType<typeof createServer>
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px system-ui}button{position:absolute;top:40px;width:240px;height:260px;touch-action:none}#surface{left:20px}#end{left:330px}</style><button id="surface" aria-label="Touch surface">Surface</button><button id="end" aria-label="Touch end">End</button><script>
globalThis.mode='normal';globalThis.proof={events:[],ends:0,starts:0,clicks:0};
for(const type of ['touchstart','touchmove','touchend','touchcancel','pointerdown','pointermove','pointerup'])addEventListener(type,e=>{proof.events.push({type,target:e.target.id,trusted:e.isTrusted,time:e.timeStamp,pointerType:e.pointerType,touches:e.touches?[...e.touches].map(t=>({id:t.identifier,x:t.clientX,y:t.clientY})):null});if(type==='touchstart')proof.starts++;if(type==='touchend')proof.ends++});
surface.addEventListener('touchstart',()=>{if(mode==='navigate')location.href='/after';if(mode==='replace')end.outerHTML='<button id="replacement" aria-label="Touch end" style="left:330px">Replacement</button>'});surface.onclick=()=>proof.clicks++;
</script>`
const gesture = (kind: string, options?: unknown) => `const page=await snapshot();const source=page.nodes.find(n=>n.name==='Touch surface');const destination=page.nodes.find(n=>n.name==='Touch end');if(!source||!destination)throw Error('Native touch endpoints missing');await ${kind}(source.ref${kind==='swipe'?',destination.ref':options===undefined?'':','+JSON.stringify(options)});return 'native gesture acknowledged'`
const inspectFailure = (kind: string) => `try {${gesture(kind).replace("return 'native gesture acknowledged'","return {effects:'acknowledged'}")}} catch(error) {return {effects:error.effects,kind:error.kind}}`
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read: () => Promise<any>, label: string) { for (let i = 0; i < 150; i++) { const value = await read(); if (value) return value; await pause(20) } throw new Error('Native drag proof did not observe ' + label) }
async function cli(args: string[], code = '') {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  const result: any = await new Promise((resolve, reject) => {
    const child = spawn(node, [join(source, 'packages/core/bin/amux'), '--endpoint', `unix:${join(root, 'control.sock')}`, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private Browser CLI timed out')) }, 20000)
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ args, code, stdout, stderr }) }); child.stdin.end(code)
  }); receipt.cli.push(result); return result
}
async function run() {
  await app.whenReady(); console.error('touch-proof:ready')
  if(process.env.AGENTMUX_TOUCH_PHASE==='restart'){
    const descriptor=JSON.parse(await readFile(join(root,'task-descriptor.json'),'utf8')),before=await readFile(join(root,'tasks.json'),'utf8')
    const assets=new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(root,'tasks.json'))),state=await assets.state('page'),asset=state.assets.find(item=>item.id===descriptor.assetId)
    assert.deepEqual(asset?.versions,descriptor.versions,'Original immutable gesture definitions must survive a real process restart')
    assert.deepEqual(state.runs,descriptor.runs,'A restart cannot replay or replace the original failed task cursor')
    assert.equal(await readFile(join(root,'tasks.json'),'utf8'),before)
    receipt.cases.push({label:'original-gesture-file-restart',assetId:asset!.id,runs:state.runs});receipt.restart=true;receipt.passed=true;return
  }

  server = createServer((req, res) => { console.error('touch-proof:http',req.url);res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url === '/after' ? '<button id="new-target">New document</button><script>globalThis.releases=0;globalThis.clicks=0;globalThis.inputs=[];for(const type of ["pointermove","pointerdown","pointerup","mousemove","mousedown","mouseup","click"])addEventListener(type,e=>inputs.push({type,target:e.target.id,buttons:e.buttons,trusted:e.isTrusted}));addEventListener("mouseup",()=>releases++);document.querySelector("button").onclick=()=>clicks++</script>' : html) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(server.address() as any).port}/drag`
  console.error('touch-proof:server-ready')
  win = new BrowserWindow({ width: 1040, height: 820, show: false, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  console.error('touch-proof:window-created')
  const tasks = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(root, 'tasks.json')))
  manager = new BrowserViewManager(win, { defaultProfileId: () => 'private', resolvePartition: id => 'persist:touch-' + id }, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => { throw Error('No app links') }, openExternal: async () => { throw Error('No app handoff') } },
    new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'operations.sqlite'))), undefined, undefined, undefined, tasks)
  console.error('touch-proof:manager-created')
  await manager.create('page', url, 'workspace'); console.error('touch-proof:page-created'); manager.setBounds('page', { x: 400, y: 0, width: 620, height: 700 })
  contents = manager.nativeOwner('page')!.view.webContents
  const originalSend = contents.debugger.sendCommand.bind(contents.debugger)
  let takeOverAfterTouch = false
  contents.debugger.sendCommand = async (method: string, params?: any, sessionId?: string) => {
    if (method.startsWith('Input.')) receipt.native.push({ method, params: method === 'Input.dispatchDragEvent' ? { ...params, data: { originalData: true } } : params, sessionId })
    const result = await originalSend(method, params, sessionId)
    if (takeOverAfterTouch && method === 'Input.dispatchTouchEvent' && params.type === 'touchStart') { takeOverAfterTouch = false; manager.takeControl('page') }
    return result
  }
  win.showInactive()
  contents.on('did-finish-load',()=>console.error('touch-proof:did-finish-load',contents.getURL()));contents.on('did-fail-load',(_event,code,reason,url)=>console.error('touch-proof:did-fail-load',code,reason,url));
  console.error('touch-proof:await-document',JSON.stringify({url:contents.getURL(),loading:contents.isLoadingMainFrame()}));
  await waitFor(() => contents.executeJavaScript('!!document.querySelector("#surface")'), 'original document')
  const api = { browser: { listTargets: async () => ({ targets: manager.resourceTargets(new Map(app.getAppMetrics().map(p => [p.pid, p.creationTime]))), coverage: 'complete' }), runScript: (...args: any[]) => manager.runScript(args[0], args[1], args[2], undefined, args[3]) } }
  const store = await readFile(join(source, 'apps/desktop/src/renderer/src/store.ts'), 'utf8'), from = store.indexOf("    if (request.operation === 'browser.targets')"), until = store.indexOf("    if (request.operation === 'browser.task.assets'", from)
  assert.ok(from >= 0 && until > from, 'Actual Renderer public consumer slice is nonempty')
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('request', 'api', 'requireActive', 'get', 'browserOperatorForSession', store.slice(from, until))
  control = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => request.operation.startsWith('browser.task.')
    ? executeBrowserTaskControl(request, manager, true)
    : projectBrowserControlResult(await execute(request, api, () => {}, () => ({ sessions: [] }), () => { throw Error('No forged Agent') })) }); await control.start()
  const discovery = await cli(['browser', 'run', '--help']); assert.equal(discovery.code, 0); assert.ok(discovery.stdout.includes('longPress(ref')&&discovery.stdout.includes('pinch(ref'),'Current CLI help must discover the concrete touch signatures')
  const invoke = async (label: string, code: string) => { console.error('touch-proof:start', label); const result = await cli(['browser', 'run', '--browser', 'page', '--operation-id', label], code); const report = JSON.parse(result.stdout).result; receipt.cases.push({ label, code: result.code, report }); await writeFile(join(root, 'progress.json'), JSON.stringify(receipt)); console.error('touch-proof:done', label); return report }
  const originalEvents = async () => await contents.executeJavaScript('proof')
  const tap = await invoke('native-tap', gesture('tap')); receipt.tapPage = await originalEvents(); assert.equal(tap.outcome.kind, 'completed', JSON.stringify(tap))
  let actual = await originalEvents(); assert.equal(actual.ends, 1, 'The native tap must end once on the original target'); assert.ok(actual.events.some((e: any) => e.type === 'touchstart' && e.target === 'surface' && e.trusted))
  assert.equal(await contents.executeJavaScript('navigator.maxTouchPoints'), 0, 'Touch actions must not manufacture a device identity')
  const hold = await invoke('native-long-press', gesture('longPress', { durationMs: 650 })); assert.equal(hold.outcome.kind, 'completed', JSON.stringify(hold))
  actual = await originalEvents(); const held = actual.events.filter((e: any) => e.type === 'touchstart' || e.type === 'touchend').slice(-2)
  assert.ok(held[1].time - held[0].time >= 600, 'The original native contact must remain held for the declared duration')
  const swipe = await invoke('native-swipe', gesture('swipe')); assert.equal(swipe.outcome.kind, 'completed', JSON.stringify(swipe))
  actual = await originalEvents(); assert.ok(actual.events.some((e: any) => e.type === 'touchmove' && e.trusted && e.touches[0].x > 400), 'Native swipe must reach its independently resolved destination')
  const step = swipe.runOperation.steps.find((s: any) => s.method === 'swipe'); assert.equal(step.replay.target.name, 'Touch surface'); assert.equal(step.replay.destination.name, 'Touch end'); assert.deepEqual(step.replay.args, [])
  const pinch = await invoke('native-pinch', gesture('pinch', { scale: 2 })); assert.equal(pinch.outcome.kind, 'completed', JSON.stringify(pinch))
  actual = await originalEvents(); assert.ok(actual.events.some((e: any) => e.type === 'touchmove' && e.trusted && e.touches.length === 2 && e.touches[1].x - e.touches[0].x >= 110), 'Native pinch must move two original contacts')
  receipt.originalGestures = actual
  await contents.executeJavaScript("mode='navigate'"); const beforeNavigation = receipt.native.length
  const navigation = await invoke('navigation-during-touch', inspectFailure('tap')); assert.equal(navigation.result.effects, 'unknown', 'An interrupted original native touch must retain unknown effects')
  await waitFor(() => contents.executeJavaScript('location.pathname==="/after"'), 'original touch navigation')
  assert.equal(receipt.native.slice(beforeNavigation).some((e: any) => e.params?.type === 'touchEnd'), false, 'No old contact may end in a replacement document')
  const click = await invoke('fresh-click-after-touch-navigation', `const p=await snapshot();await click(p.nodes.find(n=>n.name==='New document').ref);return 'clicked'`); assert.equal(click.outcome.kind, 'completed'); assert.equal(await contents.executeJavaScript('clicks'), 1)
  await contents.loadURL(url); await waitFor(() => contents.executeJavaScript('!!document.querySelector("#surface")'), 'fresh gesture page')
  let asset = await tasks.importRecording({ id: 'original-empty', browserId: 'page', navigationId: 'native', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const trusted = (event: Electron.IpcMainInvokeEvent) => { assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame) }
  ipcMain.handle('touch-proof:initial', event => { trusted(event); return asset })
  ipcMain.handle('touch-proof:current', async event => { trusted(event); const state = await manager.getTaskAssets('page'); return {asset:state.assets.find(item=>item.id===asset.id),run:state.runs.find(item=>item.id===state.selectedRunId)??null} })
  ipcMain.handle('touch-proof:save', async (event, draft) => { trusted(event); asset = await manager.saveTaskAssetVersion('page', asset.id, asset.revision, draft); receipt.savedVersion = asset; return asset })
  ipcMain.handle('touch-proof:run', async (event, version) => { trusted(event); receipt.taskRun = await manager.runTaskAsset({ browserId: 'page', assetId: asset.id, version, parameters: {} }); return receipt.taskRun })
  await win.loadFile(join(root, 'index.html')); win.showInactive(); win.webContents.debugger.attach('1.3')
  const gui = win.webContents.debugger.sendCommand.bind(win.webContents.debugger)
  const find = async (selector: string) => await waitFor(() => win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), selector)
  const press = async (selector: string) => { const point = await find(selector); for (const type of ['mouseMoved','mousePressed','mouseReleased']) await gui('Input.dispatchMouseEvent',{type,...point,button:type==='mouseMoved'?'none':'left',buttons:type==='mousePressed'?1:0,clickCount:1}) }
  const button = async (text: string) => { const selector = await waitFor(() => win.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(text)})&&!e.disabled);if(!e)return null;e.dataset.proofAction=${JSON.stringify(text)};return '[data-proof-action='+JSON.stringify(${JSON.stringify(text)})+']'})()`),'enabled '+text);await press(selector) }
  await waitFor(() => win.webContents.executeJavaScript('!!document.querySelector(".browser-task-asset")'), 'actual gesture task editor')
  await button('Add touch gesture')
  for(const [field,value] of [['role','button'],['name','Touch surface']]){await press(`[aria-label="Task step 1 target ${field}"]`);await gui('Input.insertText',{text:value})}
  await press('[aria-label="Review task step 1"]');await button('Save version');await waitFor(async()=>receipt.savedVersion?.versions.length,'original immutable tap version');await button('Run version');await waitFor(async()=>receipt.taskRun,'GUI tap run')
  assert.equal(receipt.taskRun.status,'completed');assert.equal((await originalEvents()).ends,1,'GUI-authored native tap must execute once');receipt.cases.push({label:'gui-native-tap',run:receipt.taskRun})
  const identity = { role:'button',name:'Touch surface',ordinal:1,count:1 }, end = { ...identity,name:'Touch end' }, original = structuredClone(asset.versions[0])
  const content = {name:'Public native gestures',url,parameters:[],steps:[{id:'tap',kind:'tap',url,target:identity,reviewed:true},{id:'hold',kind:'longPress',url,target:identity,durationMs:40,reviewed:true},{id:'swipe',kind:'swipe',url,target:identity,destination:end,reviewed:true},{id:'pinch',kind:'pinch',url,target:identity,scale:2,reviewed:true}]}
  const edited=await cli(['browser','task','edit','--browser','page','--asset',asset.id,'--expected-revision',String(asset.revision),'--input','-'],JSON.stringify(content));assert.equal(edited.code,0,edited.stderr)
  const published=await cli(['browser','task','publish','--browser','page','--asset',asset.id,'--expected-revision',String(asset.revision+1)]);assert.equal(published.code,0,published.stderr)
  const run=await cli(['browser','task','run','--browser','page','--asset',asset.id,'--version','2'],'{}');assert.equal(run.code,0,run.stderr);const publicRun=JSON.parse(run.stdout).result.run;assert.equal(publicRun.status,'completed',JSON.stringify(publicRun));assert.equal(publicRun.operationIds.length,4)
  asset=(await tasks.get(asset.id))!;assert.deepEqual(asset.versions[0],original);receipt.cases.push({label:'public-gesture-version-run',run:publicRun})
  // Current editor source renders all four declarations; only its next explicit save can publish them.
  await win.webContents.executeJavaScript('touchProofReload()');await waitFor(()=>win.webContents.executeJavaScript('document.querySelectorAll("[data-task-kind]").length===4'),'current original task projection')
  const capture = async (name:string) => await writeFile(join(root,name+'.png'),(await win.webContents.capturePage({x:0,y:0,width:Number(name.includes('310')?310:390),height:650})).toPNG())
  for(const [mode,width,kind] of [['dark',390,'tap'],['light',390,'longPress'],['dark',310,'swipe'],['light',310,'pinch']] as const){await win.webContents.executeJavaScript(`touchProofAppearance(${JSON.stringify(mode)},${width});document.querySelector('[data-task-kind="${kind}"]').scrollIntoView({block:'center'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);await capture(`task-touch-${mode}-${width}`)}
  const unknownDefinition={...content,steps:[{...content.steps[2],retry:3}]};asset=await manager.saveTaskAssetVersion('page',asset.id,asset.revision,unknownDefinition)
  await contents.executeJavaScript("mode='replace'");const beforeUnknown=receipt.native.length
  const unknown=await manager.runTaskAsset({browserId:'page',assetId:asset.id,version:3,parameters:{}});assert.equal(unknown.operationIds.length,1,'Unknown native gesture effects must never spend task retries');assert.equal(unknown.status,'failed');assert.equal(receipt.native.slice(beforeUnknown).filter((e:any)=>e.params?.type==='touchStart').length,1);assert.equal(receipt.native.slice(beforeUnknown).some((e:any)=>e.params?.type==='touchMove'||e.params?.type==='touchEnd'),false,'A pressed swipe must never move into a replacement endpoint');receipt.cases.push({label:'unknown-gesture-not-replayed',run:unknown})
  await contents.loadURL(url);await waitFor(()=>contents.executeJavaScript('!!document.querySelector("#surface")'),'original page before Take control');takeOverAfterTouch=true;const beforeTakeover=receipt.native.length
  const takeover=await invoke('takeover-during-contact',gesture('longPress',{durationMs:2000}));assert.notEqual(takeover.outcome.kind,'completed');assert.equal(receipt.native.slice(beforeTakeover).some((e:any)=>e.params?.type==='touchEnd'),false,'A cancelled hold must never send a delayed end after Take control')
  await waitFor(async()=>!manager.nativeOwner('page')!.inputShield,'original human input surface')
  const human=await contents.executeJavaScript('(()=>{const r=surface.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');for(const type of ['mouseMove','mouseDown','mouseUp'])contents.sendInputEvent({type,...human,button:'left',clickCount:1} as Electron.MouseInputEvent)
  await waitFor(()=>contents.executeJavaScript('proof.clicks===1'),'human click after cancelled touch');receipt.cases.push({label:'human-click-after-touch-stop',passed:true});await writeFile(join(root,'task-descriptor.json'),JSON.stringify({assetId:asset.id,versions:asset.versions,runs:(await tasks.state('page')).runs}));receipt.passed=true
}
run().catch(error=>{receipt.failure={message:error.message,stack:error.stack};console.error(error)}).finally(async()=>{if(contents&&!contents.isDestroyed()&&contents.debugger.isAttached())await contents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}).catch(()=>{});await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2));await control?.stop();await manager?.dispose();server?.closeAllConnections();server?.close();win?.destroy();app.exit(receipt.passed?0:1)})
