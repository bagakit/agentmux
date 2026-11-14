import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { desktopBusinessSocketPath } from '../../../src/main/desktop-host'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { access as fsAccess } from 'node:fs/promises'
import { mintObjectId } from '@agentmux/core/object-id'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { AgentMuxMemoryAgentSessionStore, DurableWriteError } from '@agentmux/core'
import { AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { ContinuousProgressLoopStore } from '../../../../host/src/continuous-progress-loop-store'
import { ContinuousProgressLoopManager } from '../../../../host/src/continuous-progress-loop-manager'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { registerIpc } from '../../../src/main/ipc'
import { topFrameNavigationGuard, topFrameOrigin } from '../../../src/main/top-frame-navigation'

const out = process.env.AGENTMUX_TRASH_OUT!, assets = process.env.AGENTMUX_TRASH_ASSETS!, home = process.env.AGENTMUX_TRASH_HOME!
const urls = JSON.parse(process.env.AGENTMUX_TRASH_URLS!) as { page:string;worker:string;held:string;download:string;finish:string }, phase = process.env.AGENTMUX_TRASH_PHASE!
const receipt: any = { passed: false, phase, cases: [], images: [], calls: [], cleanup: [], runtimeConnections: 0, versions: process.versions }
const stage = (value: string) => console.log('Profile trash proof: ' + value)
let win: BrowserWindow | undefined, outsider: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, manager: BrowserViewManager | undefined
const evaluate = (code: string) => win!.webContents.executeJavaScript(code)
const pause = () => new Promise(done => setTimeout(done, 60))
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 25)) }
  throw new Error('Private Profile trash observation expired: ' + label)
}
const nativePage = (id = 'original') => (manager as any).entries.get(id)?.view.webContents as Electron.WebContents
async function key(key: string, code: string, windowsVirtualKeyCode: number) {
  for (const type of ['keyDown', 'keyUp']) await win!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
  await pause()
}
async function loaded(id: string) { const page = nativePage(id); await until(() => page && !page.isLoading() && page.getURL().startsWith('http:'), 'loaded exact native page ' + id); return page }
async function cli(args: string[]) {
  const result = await promisify(execFile)(process.env.AGENTMUX_TRASH_NODE!, [process.env.AGENTMUX_TRASH_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY'].includes(key))) })
  return JSON.parse(result.stdout).result
}
async function click(selector: string) {
  const point = await until(async () => evaluate(`(()=>{const e=${selector};if(!e)return null;const initial=e.getBoundingClientRect();if(!initial.width||!initial.height)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return hit&&(hit===e||e.contains(hit))?{x,y}:null})()`), 'trusted actual App control')
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y,
    ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
  await pause()
}
const textButton = (text: string) => `[...document.querySelectorAll('button,[role="menuitem"]')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`
async function input(selector: string, text: string) {
  await click(selector); await win!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
  await win!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 });
  await win!.webContents.debugger.sendCommand('Input.insertText', { text }); await pause()
}
async function capture(name: string, width = 1100, height = 780, theme = 'light', target?: string) {
  if (process.env.AGENTMUX_TRASH_CAPTURE !== '1') return
  win!.setContentSize(width, height); await evaluate(`trashProof.theme(${JSON.stringify(theme)})`); await pause()
  await evaluate(`(()=>{for(const selector of ['.browser-profile-library','.settings-resource-editor','[data-settings-pane="browser-profiles"]']){const e=document.querySelector(selector);if(e)e.scrollTop=0}})()`); await pause()
  if (target) { await evaluate(`document.querySelector(${JSON.stringify(target)})?.scrollIntoView({block:'center'})`); await pause() }
  const bytes = (await win!.webContents.capturePage()).toPNG(); await writeFile(join(out, name + '.png'), bytes)
  receipt.images.push({ name, width, height, theme, file: name + '.png', sha256: createHash('sha256').update(bytes).digest('hex') })
}
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  stage('private App owners starting')
  app.setActivationPolicy?.('prohibited')
  await mkdir(join(home, 'workspace'), { recursive: true })
  stage('private workspace ready')
  win = new BrowserWindow({ width: 1100, height: 780, show: false, webPreferences: {
    preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const html = join(assets, 'renderer/index.html'), guard = topFrameNavigationGuard(topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: html }))
  win.webContents.on('will-navigate', guard); win.webContents.on('will-redirect', guard)
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => originalHandle(channel, (event, ...args) => {
    const call = ['browser:create', 'browser:deleteProfile', 'browser:restoreProfile', 'browser:readProfileTrash', 'browser:updateProfile', 'browser:purgeProfile', 'browser:setProfileTrashRetention', 'browser:inspectProfilePurge'].includes(channel) ? { channel, args, completed: false,
      exactSender: event.sender === win!.webContents, exactFrame: event.senderFrame === event.sender.mainFrame } : null
    if (call) receipt.calls.push(call)
    return Promise.resolve().then(() => listener(event, ...args)).then(async value => { if (call) { call.completed = true; (call as any).receipt = value } if(process.env.AGENTMUX_TRASH_ACK==='1' && channel==='browser:purgeProfile' && !receipt.ackDropped) { const previous=JSON.parse(await readFile(join(home,'trash-identities.json'),'utf8')); if(args[0]===previous.ack.archive.id) { receipt.ackDropped={archiveId:args[0],purgeId:args[2],originalReply:value};throw new Error('Controlled original deletion acknowledgement lost after commit') } } return value },error=>{if(call){call.completed=true;(call as any).failed={code:error.code,message:error.message}}throw error})
  })
  const originalCreate = BrowserViewManager.prototype.create
  BrowserViewManager.prototype.create = async function(...args) { manager = this; return originalCreate.apply(this, args) }
  const scratchTopics = new ScratchTopics()
  runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { receipt.runtimeConnections++; throw new Error('Private permission proof cannot connect a Runtime') }, scratchTopics)
  runtime.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const configStore = new ConfigStore(join(home, 'config.json')), config = structuredClone(DEFAULT_CONFIG)
  config.workspaces = [{ id: 'trash-workspace', name: 'Private Profile trash', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
  windows = new WorkbenchWindows(win, new WorkbenchWindowStore(join(home, 'windows.json')), () => [])
  access = createDesktopApplicationAccessOwner(runtime, join(home, 'applications.sqlite'))
  progress = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(home, 'progress.json')), async () => { throw new Error('No progress input is allowed') }, undefined, async () => { throw new Error('No Agent observation is allowed') })
  stage('private owner constructors ready')
  await mkdir(process.env.AGENTMUX_STATE_DIRECTORY!, { recursive: true })
  const privateNotes = new AgentMuxNotesStorage(undefined, join(home, 'notes'))
  if (!await privateNotes.hasLocation()) await writeFile(privateNotes.locatorPath, JSON.stringify({ schemaVersion: 1, directory: join(home, 'notes'), operations: {}, pending: null }))
  assert.ok((await privateNotes.inspect()).directory.startsWith(home + '/'), 'All optional Notes storage stays inside this private fixture')
  stage('private Notes locator ready')
  dispose = await registerIpc({ workbenchUserState: new WorkbenchUserStateStore(join(home, 'workbench-user-state.json')), appDocumentSources: () => ({ current: { mode: 'prod', filePath: html }, loading: null }), window: win, workbenchWindows: windows, runtime, configStore, initialConfig: config,
    scratchTopics, applicationAccess: access, progressLoops: progress })
  stage('production IPC ready')
  await win.loadFile(html); await until(() => evaluate('Boolean(globalThis.trashProof)'), 'production Renderer entry')
  stage('actual Renderer ready')

  const previous = phase === 'restart' ? JSON.parse(await readFile(join(home, 'trash-identities.json'), 'utf8')) : null
  const original = await evaluate(`trashProof.setup(${JSON.stringify(config)},${JSON.stringify(urls.page)},${JSON.stringify(previous?.sourceId)},${Boolean(previous)})`)
  const sourceId = original.profileId
  await until(() => evaluate('Boolean(document.querySelector("textarea[aria-label=\\\"Sibling draft\\\"]"))'), 'the actual Renderer sibling draft mounted')
  if (previous) {
    assert.equal(original.restoredFromCore, true)
    receipt.restoredBeforeNative = await evaluate('trashProof.savedWorkface()')
    assert.deepEqual(receipt.restoredBeforeNative.currentLayouts, previous.workface.currentLayouts)
    assert.deepEqual(receipt.restoredBeforeNative.surfaces, previous.workface.surfaces)
    await evaluate('trashProof.resumeOriginal()')
  }
  const page = await loaded('original'), sourceContentsId = page.id
  const profiles = (manager as any).profiles as import('../../../src/main/browser-profile-manager').BrowserProfileManager
  win.webContents.debugger.attach('1.3')
  const list = () => cli(['browser', 'profile', 'ls'])
  const edit = async (id: string, flags: string[]) => cli(['browser', 'profile', 'update', '--profile', id, '--expected-revision', (await list()).profiles.find((value: any) => value.id === id).revision, ...flags])
  const choose = async (label: string, value: string) => {
    const selector = `document.querySelector('select[aria-label="${label}"]')`
    // The option itself is a native select value; this calls the actual React change consumer.
    await evaluate(`(()=>{const e=${selector};Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await pause()
  }
  const assertOriginal = async () => {
    assert.equal(page.id, sourceContentsId)
    assert.equal(await page.executeJavaScript('document.getElementById("draft").value'), 'Keep this original page draft')
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'), 'keep original')
    assert.ok((await page.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in' && value.value === 'original'))
    assert.equal((await evaluate('trashProof.facts()')).sibling, 'Keep this sibling draft')
  }
  const recycle = async (id: string, token: string) => evaluate(`trashProof.recycle(${JSON.stringify(id)},${JSON.stringify(token)}).then(value=>({value}),error=>({code:error.code,message:error.message}))`)
  const archiveList = () => cli(['browser', 'profile', 'trash', 'ls'])
  const token = async (id: string) => (await list()).profiles.find((p: any) => p.id === id).revision
  assert.equal(app.hasSingleInstanceLock(), true, 'Actual App storage owner holds its original single-instance lock')
  const absent = async (path:string) => fsAccess(path).then(()=>false,(error)=>error.code==='ENOENT')
  const inspect = (purgeId:string) => cli(['browser','profile','trash','inspect','--purge-id',purgeId])
  const purge = (entry:any,purgeId:string) => cli(['browser','profile','trash','purge','--archive',entry.id,'--expected-revision',entry.revision,'--purge-id',purgeId])
  const archived = async (id:string) => (await archiveList()).entries.find((entry:any)=>entry.profile.id===id)
  const makeArchived = async (label:string, data=false) => {
    const profile=(await cli(['browser','profile','create','--label',label])).profile
    const id='private-'+profile.id
    await evaluate(`trashProof.createAdmission(${JSON.stringify(id)},${JSON.stringify(profile.id)},${JSON.stringify(urls.page)})`)
    const native=await loaded(id)
    if(data) {
      await native.executeJavaScript(`localStorage.setItem('retained-key','original persistent value');new Promise((resolve,reject)=>{const r=indexedDB.open('retained-database',1);r.onupgradeneeded=()=>r.result.createObjectStore('records');r.onsuccess=()=>{const db=r.result,t=db.transaction('records','readwrite');t.objectStore('records').put('original indexed value','key');t.oncomplete=()=>{db.close();resolve(true)};t.onerror=()=>reject(t.error)};r.onerror=()=>reject(r.error)})`)
      await native.session.cookies.set({url:urls.page,name:'retained-cookie',value:'original-cookie',expirationDate:Math.floor(Date.now()/1000)+3600})
      native.session.flushStorageData();await native.session.cookies.flushStore()
    }
    const storagePath=native.session.storagePath!
    await evaluate(`trashProof.closeAdmission(${JSON.stringify(id)})`);await until(()=>native.isDestroyed(),'exact private target native view closed')
    if(data){await writeFile(join(storagePath,'native-proof.bin'),'complete original marker');await writeFile(join(storagePath,'second-proof.bin'),'second original marker')}
    const entry=(await cli(['browser','profile','delete','--profile',profile.id,'--expected-revision',await token(profile.id)])).archive
    return {profileId:profile.id,storagePath,archive:entry}
  }
  if(process.env.AGENTMUX_TRASH_ACK==='1') {
    if(phase==='seed') {
      await page.executeJavaScript('document.getElementById("draft").value="Keep this original page draft";localStorage.setItem("source-only","keep original")')
      await page.session.cookies.set({url:urls.page,name:'source-sign-in',value:'original',expirationDate:Math.floor(Date.now()/1000)+3600});page.session.flushStorageData();await page.session.cookies.flushStore()
      const ack=await makeArchived('Verified cleanup result Profile')
      await evaluate('trashProof.persist()')
      await writeFile(join(home,'trash-identities.json'),JSON.stringify({sourceId,ack,workface:await evaluate('trashProof.savedWorkface()')}))
      receipt.cases.push('exact-cold-archive-prepared-only-for-result-surface')
    } else {
      assert.ok(previous.ack)
      await page.executeJavaScript('document.getElementById("draft").value="Keep this original page draft"')
      await click(textButton('Recycled Profiles'))
      await until(()=>evaluate('!document.querySelector(".browser-profile-trash").hidden'),'actual original trash surface')
      await click(textButton('Delete permanently'))
      await click(textButton('Confirm permanent deletion'))
      await until(()=>evaluate('document.querySelector(".browser-profile-trash")?.textContent.includes("No recycled Profiles.") && document.querySelector("[role=alertdialog]")?.textContent.includes("Controlled original deletion acknowledgement lost")'),'committed original entry moved out while original confirmation remains')
      assert.ok(receipt.ackDropped)
      const originalId=receipt.ackDropped.purgeId
      assert.equal((await inspect(originalId)).purge.status,'deleted')
      assert.equal(await absent(previous.ack.storagePath),true)
      assert.equal(await evaluate(`document.querySelector('[role=alertdialog]')?.textContent.includes(${JSON.stringify(originalId)})`),true)
      await capture('lost-ack-narrow-light',560,920,'light','[role="alertdialog"]')
      await click(textButton('Check original action'))
      await until(()=>evaluate('!document.querySelector("[role=alertdialog]") && document.querySelector(".browser-profile-trash")?.textContent.includes("Profile data and saved settings removed")'),'same-original-action inspection renders exact completed owner outcomes')
      await capture('inspected-result-narrow-dark',560,920,'dark','.browser-profile-trash')
      const text=await evaluate('document.querySelector(".browser-profile-trash")?.textContent')
      assert.ok(text.includes(originalId));assert.ok(text.includes('Credential cleanup: confirmed'));assert.ok(text.includes('Site permission cleanup: confirmed'))
      assert.equal(receipt.calls.filter((call:any)=>call.channel==='browser:purgeProfile').length,1,'Reading the original receipt never repeats deletion')
      assert.ok(receipt.calls.some((call:any)=>call.channel==='browser:inspectProfilePurge'&&call.exactSender&&call.exactFrame&&call.args[0]===originalId))
      await assertOriginal()
      receipt.cases.push('actual-trusted-purge-committed-then-Main-IPC-ack-lost-original-action-visible-without-entry','actual-inspect-click-reads-same-purge-ID-once-and-renders-independent-owner-confirmations')
    }
  } else if(phase==='seed') {
    const lockProbe=join(out,'same-root-lock-probe.cjs')
    await writeFile(lockProbe,`const{app}=require('electron');app.setPath('userData',${JSON.stringify(app.getPath('userData'))});app.setPath('sessionData',${JSON.stringify(app.getPath('sessionData'))});const acquired=app.requestSingleInstanceLock();console.log(JSON.stringify({acquired}));app.exit(0)`)
    const lockResult=await promisify(execFile)(process.env.AGENTMUX_TRASH_ELECTRON!,[lockProbe],{env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ELECTRON_RUN_AS_NODE'))})
    receipt.lockProbe=JSON.parse(lockResult.stdout.trim());assert.equal(receipt.lockProbe.acquired,false,'Another real Main process cannot acquire this original storage root')
    await page.executeJavaScript('document.getElementById("draft").value="Keep this original page draft";localStorage.setItem("source-only","keep original")')
    await page.session.cookies.set({url:urls.page,name:'source-sign-in',value:'original',expirationDate:Math.floor(Date.now()/1000)+3600});page.session.flushStorageData();await page.session.cookies.flushStore()
    const removed=await makeArchived('Permanently removed Profile',true),failed=await makeArchived('Recovered original Profile',true)
    const removedId=mintObjectId(),failedId=mintObjectId()
    assert.equal((await purge(removed.archive,removedId)).purge.status,'waiting-for-restart')
    assert.equal((await purge(failed.archive,failedId)).purge.status,'waiting-for-restart')
    assert.equal(await absent(removed.storagePath),false);assert.equal(await absent(failed.storagePath),false)
    await assertOriginal();await evaluate('trashProof.persist()')
    const workface=await evaluate('trashProof.savedWorkface()')
    await writeFile(join(home,'trash-identities.json'),JSON.stringify({sourceId,removed:{...removed,purgeId:removedId},failed:{...failed,purgeId:failedId},workface}))
    receipt.cases.push('actual-compiled-public-CLI-stores-exact-purge-intent-without-copying-process-admitted-native-SQLite','unrelated-live-native-Profile-and-actual-Core-workface-preserved')
  } else {
    assert.ok(previous)
    const removed=await until(async()=>{const result=(await inspect(previous.removed.purgeId)).purge;return result?.status==='deleted'?result:null},'original approved purge completed after restart without native admission')
    const failed=await until(async()=>{const result=(await inspect(previous.failed.purgeId)).purge;return result?.status==='failed'?result:null},'actual partial rm rollback recorded under original purge ID')
    assert.equal(removed.credentialCleanup,'confirmed');assert.equal(removed.permissionCleanup,'confirmed')
    assert.equal(await absent(previous.removed.storagePath),true)
    assert.equal(await readFile(join(previous.failed.storagePath,'native-proof.bin'),'utf8'),'complete original marker')
    assert.equal(await readFile(join(previous.failed.storagePath,'second-proof.bin'),'utf8'),'second original marker')
    const partial=JSON.parse(await readFile(join(home,'partial-rm-observed.json'),'utf8'));assert.equal(partial.path,previous.failed.storagePath)
    assert.equal((profiles as any).sessions.nativeSessionAdmitted(previous.failed.profileId),false)
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'),'keep original')
    assert.ok((await page.session.cookies.get({url:urls.page})).some(value=>value.name==='source-sign-in'&&value.value==='original'))
    await page.executeJavaScript('document.getElementById("draft").value="Keep this original page draft"')
    await click(textButton('Recycled Profiles'))
    await until(()=>evaluate('!document.querySelector(".browser-profile-trash").hidden'),'actual recycled Profiles settings')
    await capture('rollback-wide-light',1100,820,'light','.browser-profile-trash__entry')
    await capture('rollback-narrow-dark',560,920,'dark','.browser-profile-trash__entry')
    const failedEntry=await archived(previous.failed.profileId)
    await click(textButton('Restore '+failedEntry.profile.label))
    await until(async()=>!(await archived(previous.failed.profileId)),'actual trusted App same-original-ID Restore')
    const restored=(await list()).profiles.find((profile:any)=>profile.id===previous.failed.profileId)
    assert.ok(restored);assert.notEqual(restored.revision,previous.failed.archive.profile.revision)
    await evaluate(`trashProof.createAdmission('restored-native',${JSON.stringify(restored.id)},${JSON.stringify(urls.page)})`)
    const restoredPage=await loaded('restored-native')
    assert.equal(await restoredPage.executeJavaScript('localStorage.getItem("retained-key")'),'original persistent value')
    assert.ok((await restoredPage.session.cookies.get({url:urls.page})).some(value=>value.name==='retained-cookie'&&value.value==='original-cookie'))
    assert.equal(await restoredPage.executeJavaScript(`new Promise((resolve,reject)=>{const r=indexedDB.open('retained-database',1);r.onsuccess=()=>{const db=r.result,t=db.transaction('records');const get=t.objectStore('records').get('key');get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=()=>reject(get.error)};r.onerror=()=>reject(r.error)})`),'original indexed value')
    await evaluate("trashProof.closeAdmission('restored-native')")
    const pending=await makeArchived('Later cleanup Profile')
    await until(()=>evaluate('[...document.querySelectorAll(".browser-profile-trash__entry")].some(e=>e.textContent.includes("Later cleanup Profile"))'),'new same-owner archived entry')
    await click(textButton('Approve expiry'))
    await capture('retention-confirm-wide-light',1100,820,'light','[role="alertdialog"]')
    await capture('retention-confirm-narrow-dark',560,920,'dark','[role="alertdialog"]')
    await click(textButton('Confirm retention deadline'))
    const retained=await until(async()=>{const entry=await archived(pending.profileId);return entry?.retention?entry:null},'actual GUI-approved retention receipt from same original Store')
    assert.ok(retained.retention.deleteAfter>Date.now())
    await capture('retention-wide-dark',1100,820,'dark','.browser-profile-trash__entry')
    await capture('retention-narrow-light',560,920,'light','.browser-profile-trash__entry')
    await click(textButton('Delete permanently'))
    await capture('purge-confirm-wide-dark',1100,820,'dark','[role="alertdialog"]')
    await capture('purge-confirm-narrow-light',560,920,'light','[role="alertdialog"]')
    await click(textButton('Confirm permanent deletion'))
    const waiting=await until(async()=>{const entry=await archived(pending.profileId);return entry?.purge?entry:null},'actual GUI purge reuses original Manager and records intent')
    assert.equal(waiting.purge.status,'waiting-for-restart')
    await capture('pending-wide-light',1100,820,'light','.browser-profile-trash__entry')
    await capture('pending-narrow-dark',560,920,'dark','.browser-profile-trash__entry')
    await assertOriginal()
    assert.ok(receipt.calls.some((call:any)=>call.channel==='browser:purgeProfile'&&call.exactSender&&call.exactFrame&&call.completed))
    assert.ok(receipt.calls.some((call:any)=>call.channel==='browser:setProfileTrashRetention'&&call.exactSender&&call.exactFrame&&call.completed))
    receipt.cases.push('real-process-restart-original-Core-workface-and-neighbor-Profile-data-restored','exclusive-never-admitted-partition-whole-copy-and-public-CLI-inspection-confirmed','real-one-file-rm-then-EIO-full-original-partition-rollback-confirmed','trusted-App-Restore-same-Profile-new-token-native-cookie-localStorage-IndexedDB-original-values','trusted-App-retention-and-purge-confirmation-actual-preload-IPC-and-owner')
    receipt.removed=removed;receipt.failed=failed;receipt.pending=waiting.purge;receipt.partialRemoval=partial
  }
  receipt.passed = true

}).catch(async error => {
  console.error('Profile trash proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets()
  try { receipt.renderer = await evaluate('({ ...trashProof.facts(), mountedBody: document.body.innerHTML.slice(0, 6000) })'); await capture('failure-observation') } catch { /* diagnostic only; never substitutes a business result */ }
}).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', () => win && !win.isDestroyed() ? evaluate('globalThis.trashProof?.dispose()') : undefined],
    ['foreign-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()],
    ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()], ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }] ] as const) {
    stage('cleanup ' + owner)
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
