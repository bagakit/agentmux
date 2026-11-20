import { importTaskRecording } from '../../../test/helpers/import-task-recording.js'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets'
import { projectBrowserControlResult } from '../../../src/main/browser-completion-control'
import { executeBrowserTaskControl } from '../../../src/main/browser-task-control'

app.on('window-all-closed', () => {})
const root = process.env.AGENTMUX_DRAG_ROOT!, source = process.env.AGENTMUX_DRAG_SOURCE!, node = process.env.AGENTMUX_DRAG_NODE!
const receipt: any = { schema: 'agentmux.browser-drag.native.v1', passed: false, cases: [], cli: [], native: [],
  boundary: 'Private actual Electron BrowserViewManager and original Renderer browser.run consumer, built public CLI, task editor callbacks and immutable task execution. HTML5 and pointer capture use native Input commands; no page dispatchEvent/DataTransfer synthesis or user Browser/Agent/Run.' }
let contents: Electron.WebContents
console.log('drag-proof:module')
let win: BrowserWindow, manager: BrowserViewManager, control: AgentMuxControlServer, server: ReturnType<typeof createServer>
const html = `<!doctype html><style>body{margin:0;font:16px system-ui}button{position:absolute;width:100px;height:50px}#parcel{left:30px;top:50px}#basket{left:300px;top:50px}#thumb{left:30px;top:230px;touch-action:none}#finish{left:300px;top:230px}</style>
<button id="parcel" draggable="true" aria-label="Parcel">Parcel</button><button id="basket" aria-label="Basket">Basket</button><button id="thumb" role="slider" aria-label="Slider thumb">Thumb</button><button id="finish" aria-label="Slider end">End</button>
<script>globalThis.proof={events:[],drops:0,value:0,finished:0,clicks:0};globalThis.mode='normal';
const thumb=document.querySelector('#thumb'),host=document.createElement('span');host.id='slider-host';document.body.insertBefore(host,document.querySelector('#finish'));host.attachShadow({mode:'closed'}).append(thumb);thumb.style.cssText='position:fixed;left:30px;top:230px;width:100px;height:50px;touch-action:none';
for(const k of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','dragstart','dragenter','dragover','drop','dragend','click'])document.addEventListener(k,e=>{if(k==='click'&&e.target.id==='basket')proof.clicks++;proof.events.push({type:k,target:e.target.id,trusted:e.isTrusted});});
parcel.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain','native-parcel');if(mode==='replace')basket.outerHTML='<button id="replacement" aria-label="Basket" style="left:300px;top:50px">Replacement</button>';if(mode==='navigate')location.href='/after'});
basket.addEventListener('dragover',e=>e.preventDefault());basket.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.getData('text/plain')==='native-parcel')proof.drops++});
thumb.addEventListener('pointerdown',e=>{thumb.setPointerCapture(e.pointerId);proof.down=e.clientX;proof.sliderDownTrusted=e.isTrusted});thumb.addEventListener('pointermove',e=>{if(thumb.hasPointerCapture(e.pointerId)){proof.value=e.clientX-proof.down;thumb.style.transform='translateX('+proof.value+'px)'}});thumb.addEventListener('pointerup',e=>{if(thumb.hasPointerCapture(e.pointerId)){proof.finished++;proof.sliderUpTrusted=e.isTrusted;thumb.releasePointerCapture(e.pointerId)}});
</script>`
const script = (from: string, to: string) => `const page=await snapshot();const source=page.nodes.find(n=>n.name===${JSON.stringify(from)});const destination=page.nodes.find(n=>n.name===${JSON.stringify(to)});if(!source||!destination)throw Error('Native proof endpoints missing');await Promise.all([drag(source.ref,destination.ref),pageInfo()]);return 'drag dispatched'`
const inspectFailure = (from: string, to: string) => `try {${script(from, to).replace("return 'drag dispatched'", "return {effects:'acknowledged'}")}} catch(error) { return {effects:error.effects,kind:error.kind} }`
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
  await app.whenReady(); console.log('drag-proof:ready')
  server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url === '/after' ? '<button id="new-target">New document</button><script>globalThis.releases=0;globalThis.clicks=0;globalThis.inputs=[];for(const type of ["pointermove","pointerdown","pointerup","mousemove","mousedown","mouseup","click"])addEventListener(type,e=>inputs.push({type,target:e.target.id,buttons:e.buttons,trusted:e.isTrusted}));addEventListener("mouseup",()=>releases++);document.querySelector("button").onclick=()=>clicks++</script>' : html) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(server.address() as any).port}/drag`
  console.log('drag-proof:server-ready')
  win = new BrowserWindow({ width: 1040, height: 820, show: false, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  console.log('drag-proof:window-created')
  const tasks = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(root, 'tasks.json')))
  manager = new BrowserViewManager(win, { defaultProfileId: () => 'private', resolvePartition: id => 'persist:drag-' + id }, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => { throw Error('No app links') }, openExternal: async () => { throw Error('No app handoff') } },
    new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'operations.sqlite'))), undefined, undefined, undefined, tasks)
  console.log('drag-proof:manager-created')
  await manager.create('page', url, 'workspace'); console.log('drag-proof:page-created'); manager.setBounds('page', { x: 400, y: 0, width: 620, height: 700 })
  contents = manager.nativeOwner('page')!.view.webContents
  const originalSend = contents.debugger.sendCommand.bind(contents.debugger)
  let takeOverAfterPress = false
  contents.debugger.sendCommand = async (method: string, params?: any, sessionId?: string) => {
    if (method.startsWith('Input.')) receipt.native.push({ method, params: method === 'Input.dispatchDragEvent' ? { ...params, data: { originalData: true } } : params, sessionId })
    const result = await originalSend(method, params, sessionId)
    if (takeOverAfterPress && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') { takeOverAfterPress = false; manager.takeControl('page') }
    return result
  }
  win.showInactive()
  await waitFor(() => contents.executeJavaScript('!!document.querySelector("#parcel")'), 'original document')
  const api = { browser: { listTargets: async () => ({ targets: manager.resourceTargets(new Map(app.getAppMetrics().map(p => [p.pid, p.creationTime]))), coverage: 'complete' }), runScript: (...args: any[]) => manager.runScript(args[0], args[1], args[2], undefined, args[3]) } }
  const store = await readFile(join(source, 'apps/desktop/src/renderer/src/store.ts'), 'utf8'), from = store.indexOf("    if (request.operation === 'browser.targets')"), until = store.indexOf("    if (request.operation === 'browser.task.assets'", from)
  assert.ok(from >= 0 && until > from, 'Actual Renderer public consumer slice is nonempty')
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('request', 'api', 'requireActive', 'get', 'browserOperatorForSession', store.slice(from, until))
  control = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => request.operation.startsWith('browser.task.')
    ? executeBrowserTaskControl(request, manager, true)
    : projectBrowserControlResult(await execute(request, api, () => {}, () => ({ sessions: [] }), () => { throw Error('No forged Agent') })) }); await control.start()
  const discovery = await cli(['browser', 'run', '--help']); assert.equal(discovery.code, 0); assert.match(discovery.stdout, /drag\(sourceRef, destinationRef\)/)
  const invoke = async (label: string, code: string) => { console.log('drag-proof:start', label); const result = await cli(['browser', 'run', '--browser', 'page', '--operation-id', label], code); const report = JSON.parse(result.stdout).result; receipt.cases.push({ label, code: result.code, report }); await writeFile(join(root, 'progress.json'), JSON.stringify(receipt)); console.log('drag-proof:done', label); return report }
  const html5 = await invoke('native-html5', script('Parcel', 'Basket'))
  assert.equal(html5.outcome.kind, 'completed', JSON.stringify(html5)); const dropped = await contents.executeJavaScript('proof'); assert.equal(dropped.drops, 1, 'HTML5 native drop must reach original destination exactly once')
  assert.ok(dropped.events.some((e: any) => e.type === 'dragstart' && e.trusted)); assert.ok(dropped.events.some((e: any) => e.type === 'drop' && e.target === 'basket' && e.trusted)); receipt.cases.at(-1).page = dropped
  const dragStep = html5.runOperation.steps.find((step: any) => step.method === 'drag'); assert.deepEqual(dragStep.replay.args, []); assert.equal(dragStep.replay.target.name, 'Parcel'); assert.equal(dragStep.replay.destination.name, 'Basket')
  const pointer = await invoke('native-pointer-slider', script('Slider thumb', 'Slider end')); assert.equal(pointer.outcome.kind, 'completed', JSON.stringify(pointer)); const slid = await contents.executeJavaScript('proof'); assert.equal(slid.finished, 1, 'Pointer-capture drag must finish exactly once'); assert.equal(slid.sliderDownTrusted, true); assert.equal(slid.sliderUpTrusted, true); assert.ok(slid.value >= 260 && slid.value <= 280); receipt.cases.at(-1).page = slid
  const before = receipt.native.length, invalid = await invoke('invalid-destination', `const s=await snapshot();await drag(s.nodes.find(n=>n.name==='Parcel').ref,'@e999999')`); assert.notEqual(invalid.outcome.kind, 'completed'); assert.equal(receipt.native.slice(before).some((e: any) => e.params?.type === 'mousePressed'), false)
  await contents.executeJavaScript("mode='replace'")
  const replaced = await invoke('changed-destination', inspectFailure('Parcel', 'Basket')); assert.equal(replaced.result.effects, 'unknown', 'A post-press native failure must keep effects unknown'); assert.equal(replaced.result.kind, 'locator-changed'); assert.equal((await contents.executeJavaScript('proof')).drops, 1, 'A removed destination must not drop on its same-name replacement')
  await contents.loadURL(url); await waitFor(() => contents.executeJavaScript('!!document.querySelector("#basket")'), 'fresh original document')
  await contents.executeJavaScript("mode='navigate'")
  const navigationInput = receipt.native.length, navigated = await invoke('navigation-during-drag', inspectFailure('Parcel', 'Basket'))
  assert.equal(navigated.result.effects, 'unknown'); await waitFor(() => contents.executeJavaScript('location.pathname==="/after"'), 'original navigation')
  assert.equal(await contents.executeJavaScript('releases'), 0, 'A drag cannot release on the replacement document')
  assert.equal(receipt.native.slice(navigationInput).some((e: any) => e.params?.type === 'drop' || e.params?.type === 'mouseReleased'), false)
  const restoredClick = await invoke('public-click-after-navigation', `const page=await snapshot();await click(page.nodes.find(n=>n.name==='New document').ref);return 'clicked'`)
  assert.equal(restoredClick.outcome.kind, 'completed', 'A trusted hit must keep public click available independently of CSS hover')
  assert.deepEqual(await contents.executeJavaScript('({clicks,releases})'), {clicks:1,releases:1})
  receipt.cssHoverAfterNavigation = await contents.executeJavaScript('[...document.querySelectorAll(":hover")].map(node=>node.id)')
  manager.takeControl('page')
  await waitFor(async () => !manager.nativeOwner('page')!.inputShield, 'human input after navigation')
  const afterPoint = await contents.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) contents.sendInputEvent({type,...afterPoint,button:'left',clickCount:1} as Electron.MouseInputEvent)
  const afterClick = await waitFor(() => contents.executeJavaScript('clicks===2?({clicks,releases,inputs}):null'), 'one real human click in the replacement document')
  assert.equal(afterClick.releases, 2, 'Only the new public and human clicks release in the replacement document')
  assert.ok(afterClick.inputs.some((e: any) => e.type === 'click' && e.target === 'new-target' && e.trusted))
  receipt.cases.push({label:'human-click-after-navigation',page:afterClick})
  await contents.loadURL(url); await waitFor(() => contents.executeJavaScript('!!document.querySelector("#basket")'), 'original page for task editor')
  let asset = await importTaskRecording(tasks, { id: 'empty-original', browserId: 'page', navigationId: 'native', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const trusted = (event: Electron.IpcMainInvokeEvent) => { assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame) }
  ipcMain.handle('drag-proof:initial', event => { trusted(event); return asset })
  ipcMain.handle('drag-proof:save', async (event, draft) => { trusted(event); asset = await manager.saveTaskAssetVersion('page', asset.id, asset.revision, draft); receipt.savedVersion = asset; return asset })
  ipcMain.handle('drag-proof:run', async (event, version) => { trusted(event); const run = await manager.runTaskAsset({ assetId: asset.id, browserId: 'page', version, parameters: {} }); receipt.taskRun = run; return run })
  await win.loadFile(join(root, 'index.html')); win.showInactive(); win.webContents.debugger.attach('1.3')
  const gui = win.webContents.debugger.sendCommand.bind(win.webContents.debugger)
  const find = async (selector: string) => await waitFor(() => win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), selector)
  const click = async (selector: string) => { const point = await find(selector); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await gui('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) }
  await waitFor(() => win.webContents.executeJavaScript('!!document.querySelector(".browser-task-asset")'), 'real task editor')
  const button = async (text: string) => { const id = await waitFor(() => win.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(text)})&&!e.disabled);if(!e)return null;e.dataset.proofAction=${JSON.stringify(text)};return '[data-proof-action='+JSON.stringify(${JSON.stringify(text)})+']'})()`), 'enabled GUI button '+text); await click(id) }
  console.log('drag-proof:gui-author'); await button('Add drag')
  for (const [field, value] of [['source role', 'button'], ['source name', 'Parcel'], ['destination role', 'button'], ['destination name', 'Basket']]) { await click(`[aria-label="Task step 1 ${field}"]`); await gui('Input.insertText', { text: value }) }
  await click('[aria-label="Review task step 1"]')
  await waitFor(() => win.webContents.executeJavaScript(`document.querySelector('[aria-label="Review task step 1"]').checked`), 'reviewed GUI state')
  console.log('drag-proof:gui-capture')
  for (const [mode, width] of [['dark', 390], ['light', 390], ['dark', 310], ['light', 310]] as const) {
    await win.webContents.executeJavaScript(`dragProofAppearance(${JSON.stringify(mode)}, ${width});scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    await writeFile(join(root, `task-editor-${mode}-${width}.png`), (await win.webContents.capturePage({ x: 0, y: 0, width, height: 600 })).toPNG())
  }
  await win.webContents.executeJavaScript('dragProofAppearance("dark",390)')
  console.log('drag-proof:gui-save'); await button('Save version'); await waitFor(async () => receipt.savedVersion?.versions.length, 'persisted GUI version')
  await button('Run version'); await waitFor(async () => receipt.taskRun, 'original task owner execution')
  assert.equal(receipt.taskRun.status, 'completed', JSON.stringify(receipt.taskRun)); assert.equal(receipt.taskRun.operationIds.length, 1)
  const taskOperation = await manager.getOperation(receipt.taskRun.operationIds[0]); assert.ok(taskOperation?.steps.some(step => step.method === 'drag')); receipt.taskOperation = taskOperation
  assert.equal((await contents.executeJavaScript('proof')).drops, 1, 'GUI-authored immutable drag must reach actual page through task owner')
  receipt.cases.push({ label: 'gui-save-version-run', passed: true })
  // The public authoring owner must retain both semantic endpoints through its strict parser,
  // immutable version and original native execution. GUI version 1 remains unchanged.
  const originalVersion = structuredClone(asset.versions[0])
  const authored = { ...asset.draft, name: 'Public immutable drag' }
  const edit = await cli(['browser', 'task', 'edit', '--browser', 'page', '--asset', asset.id,
    '--expected-revision', String(asset.revision), '--input', '-'], JSON.stringify(authored))
  assert.equal(edit.code, 0, edit.stderr)
  const publish = await cli(['browser', 'task', 'publish', '--browser', 'page', '--asset', asset.id,
    '--expected-revision', String(asset.revision + 1)])
  assert.equal(publish.code, 0, publish.stderr)
  assert.equal(JSON.parse(publish.stdout).result.publishedVersion, 2)
  const publicRun = await cli(['browser', 'task', 'run', '--browser', 'page', '--asset', asset.id, '--version', '2'], '{}')
  assert.equal(publicRun.code, 0, publicRun.stderr)
  const publicResult = JSON.parse(publicRun.stdout).result.run
  assert.equal(publicResult.status, 'completed', JSON.stringify(publicResult))
  assert.equal((await contents.executeJavaScript('proof')).drops, 2, 'Public edit/publish/run must execute the original native drop exactly once')
  asset = (await tasks.get(asset.id))!
  assert.deepEqual(asset.versions[0], originalVersion)
  assert.deepEqual(asset.versions[1].steps[0].destination, authored.steps[0].destination)
  receipt.cases.push({ label: 'public-edit-publish-run', run: publicResult })
  asset = await manager.saveTaskAssetVersion('page', asset.id, asset.revision, { ...asset.draft, steps: asset.draft.steps.map(step => ({ ...step, retry: 3 })) })
  await contents.executeJavaScript("mode='replace'")
  const retryInput = receipt.native.length
  const unknownTask = await manager.runTaskAsset({ assetId: asset.id, browserId: 'page', version: 3, parameters: {} })
  assert.equal(unknownTask.operationIds.length, 1, 'Unknown native effects must not spend the configured retries')
  assert.equal(unknownTask.status, 'failed'); assert.equal(unknownTask.nextStep, 0)
  assert.equal(receipt.native.slice(retryInput).filter((e: any) => e.params?.type === 'mousePressed').length, 1)
  receipt.cases.push({ label: 'unknown-task-not-replayed', run: unknownTask })
  await contents.loadURL(url); await waitFor(() => contents.executeJavaScript('!!document.querySelector("#basket")'), 'original page before takeover')
  takeOverAfterPress = true
  const takeoverInput = receipt.native.length, takeover = await invoke('takeover-during-drag', script('Slider thumb', 'Slider end'))
  assert.notEqual(takeover.outcome.kind, 'completed')
  assert.equal(receipt.native.slice(takeoverInput).some((e: any) => e.params?.type === 'drop' || e.params?.type === 'mouseReleased'), false, 'Human takeover must fence the remaining drop/release')
  assert.equal(manager.targets()[0]!.control?.owner, 'human', 'Original Browser remains with its human owner')
  await waitFor(async () => !manager.nativeOwner('page')!.inputShield, 'original input shield retired after human takeover')
  const humanPoint = await contents.executeJavaScript('(()=>{const r=basket.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) contents.sendInputEvent({ type, ...humanPoint, button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  const humanState = await waitFor(() => contents.executeJavaScript('proof.clicks===1?proof:null'), 'one real human click after cancelled pointer capture')
  assert.equal(humanState.clicks, 1); assert.ok(humanState.events.some((e: any) => e.type === 'click' && e.target === 'basket' && e.trusted))
  receipt.cases.push({ label: 'human-click-after-takeover', page: humanState })
  receipt.passed = true
}
run().catch(error => { receipt.failure = { message: error.message, stack: error.stack }; console.error(error) }).finally(async () => {
  if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) await contents.debugger.sendCommand('Input.dispatchDragEvent', {type:'dragCancel',x:0,y:0,data:{items:[],dragOperationsMask:0}}).catch(()=>{})
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); await control?.stop(); await manager?.dispose(); server?.closeAllConnections(); server?.close(); win?.destroy(); app.exit(receipt.passed ? 0 : 1)
})
