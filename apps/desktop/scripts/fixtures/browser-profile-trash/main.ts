import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { desktopBusinessSocketPath } from '../../../src/main/desktop-host'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
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
    const call = ['browser:create', 'browser:deleteProfile', 'browser:restoreProfile', 'browser:readProfileTrash', 'browser:updateProfile'].includes(channel) ? { channel, args, completed: false,
      exactSender: event.sender === win!.webContents, exactFrame: event.senderFrame === event.sender.mainFrame } : null
    if (call) receipt.calls.push(call)
    return Promise.resolve().then(() => listener(event, ...args)).then(value => { if (call) { call.completed = true; (call as any).receipt = value } return value },error=>{if(call){call.completed=true;(call as any).failed={code:error.code,message:error.message}}throw error})
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
  if(phase==='admission') {
    await page.executeJavaScript('document.getElementById("draft").value="Keep this original page draft";localStorage.setItem("source-only","keep original")')
    await page.session.cookies.set({url:urls.page,name:'source-sign-in',value:'original',expirationDate:Math.floor(Date.now()/1000)+3600})
    const profile=(await cli(['browser','profile','create','--label','Exact admission Profile'])).profile
    await evaluate(`trashProof.createAdmission('admission-source',${JSON.stringify(profile.id)},${JSON.stringify(urls.page)})`);const admissionSource=await loaded('admission-source')
    await evaluate(`trashProof.closeAdmission('admission-source')`);await until(()=>admissionSource.isDestroyed(),'original admission source fully closed')
    const store=(profiles as any).store, archive=store.archiveProfile.bind(store)
    let release!:()=>void, entered!:()=>void,writerEntered=false
    const hold=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{entered=resolve})
    store.archiveProfile=async(...args:any[])=>{writerEntered=true;entered();await hold;return archive(...args)}
    // Start the App call without keeping an executeJavaScript invocation awaiting its own IPC.
    await evaluate(`globalThis.admissionWrite={pending:true};void trashProof.recycle(${JSON.stringify(profile.id)},${JSON.stringify(profile.revision)}).then(value=>globalThis.admissionWrite={value},error=>globalThis.admissionWrite={code:error.code,message:error.message});true`)
    try {
      await until(async()=>{if(writerEntered)return true;const result=await evaluate('globalThis.admissionWrite');if(!result.pending)throw new Error('Recycle ended before the held writer: '+JSON.stringify(result));return false},'original archive writer entered')
      stage('original archive writer held')
      assert.ok((await list()).profiles.some((p:any)=>p.id===profile.id),'Original active record remains visible before its commit')
      const refused=await evaluate(`trashProof.createAdmission('fenced-target',${JSON.stringify(profile.id)},${JSON.stringify(urls.page)}).then(value=>({value}),error=>({rejected:true,message:error.message}))`)
      assert.equal(refused.rejected,true);assert.equal((manager as any).entries.has('fenced-target'),false)
      assert.ok(receipt.calls.some((call:any)=>call.channel==='browser:create'&&call.args[0]==='fenced-target'&&call.exactSender&&call.failed?.code==='BROWSER_PROFILE_RETIREMENT_PENDING'),'Original Main producer confirms exact temporary fence; Electron message-only rejection is not parsed')
      const unrelated=await evaluate(`trashProof.createAdmission('healthy-unrelated',${JSON.stringify(sourceId)},${JSON.stringify(urls.page)})`)
      assert.equal(unrelated.profileId,sourceId);await loaded('healthy-unrelated')
      await evaluate(`trashProof.closeAdmission('healthy-unrelated')`)
      await assertOriginal()
      release();const result=await until(async()=>{const result=await evaluate('globalThis.admissionWrite');return result.pending?null:result},'original archive receipt after hold')
      assert.equal(result.value.archive.profile.id,profile.id)
      const restored=await cli(['browser','profile','trash','restore','--archive',result.value.archive.id,'--expected-revision',result.value.archive.revision])
      assert.equal(restored.profile.id,profile.id);assert.notEqual(restored.profile.revision,profile.revision)
      const admitted=await evaluate(`trashProof.createAdmission('fenced-target',${JSON.stringify(profile.id)},${JSON.stringify(urls.page)})`)
      assert.equal(admitted.profileId,profile.id);await loaded('fenced-target')
      await assertOriginal()
      receipt.cases.push('actual-BrowserViewManager-new-native-admission-refused-during-original-metadata-write-fence','unrelated-native-Browser-and-original-draft-stay-usable-during-target-retirement','same-Profile-admission-restored-after-confirmed-same-ID-restore')
    } finally {release();store.archiveProfile=archive}
    stage('original native admission fence verified')
    const legacy=(await cli(['browser','profile','create','--label','Earlier cleanup Profile'])).profile
    await edit(legacy.id,['--network','http://127.0.0.1:49189']);await evaluate(`trashProof.signIn(${JSON.stringify(legacy.id)})`)
    const metadataPath=join(app.getPath('userData'),'browser-profiles.json'),authPath=join(app.getPath('userData'),'browser-profile-proxy-auth.json')
    const beforeAuth=JSON.parse(await readFile(authPath,'utf8')).profiles[legacy.id]
    assert.ok(beforeAuth)
    const legacyMetadata=JSON.parse(await readFile(metadataPath,'utf8'))
    legacyMetadata.profiles=legacyMetadata.profiles.filter((p:any)=>p.id!==legacy.id);legacyMetadata.pendingDeletes=[legacy.id]
    await writeFile(metadataPath,JSON.stringify(legacyMetadata))
    const unrelatedOwner=(await cli(['browser','profile','create','--label','Unrelated confirmed write'])).profile
    await until(()=>profiles.listLegacyPendingDeletes().includes(legacy.id),'original tombstone adopted by normal Store write')
    await evaluate(`trashProof.clearSignIn(${JSON.stringify(unrelatedOwner.id)})`) // same original auth serial queue ACK after forgetExcept
    const retainedAuth=JSON.parse(await readFile(authPath,'utf8')).profiles[legacy.id]
    const authHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex')
    assert.equal(authHash(retainedAuth),authHash(beforeAuth),'Original encrypted credential row was discarded')
    assert.equal(profiles.proxyOf(legacy.id),null,'Incomplete legacy record cannot answer a proxy challenge')
    receipt.cases.push('original-legacy-tombstone-retains-exact-encrypted-credential-row-on-unrelated-confirmed-write-without-granting-auth')
    stage('legacy retained credential owner verified')
    const ack=(await cli(['browser','profile','create','--label','Unconfirmed recycle Profile'])).profile
    await evaluate(`trashProof.createAdmission('ack-source',${JSON.stringify(ack.id)},${JSON.stringify(urls.page)})`);const ackPage=await loaded('ack-source')
    await evaluate(`trashProof.closeAdmission('ack-source')`);await until(()=>ackPage.isDestroyed(),'original ACK source page fully closed')
    await click(`document.querySelector('[data-resource-row="${ack.id}"]')`)
    await until(()=>evaluate(`document.querySelector('article.browser-profile-editor')?.getAttribute('aria-label')==='Unconfirmed recycle Profile'`),'exact unconfirmed-write editor')
    const write=store.writeMetadata.bind(store);let loseAck=true
    store.writeMetadata=async(metadata:any,strict:boolean)=>{await write(metadata,strict);if(strict&&loseAck&&metadata.trash?.some((entry:any)=>entry.profile.id===ack.id)){loseAck=false;throw new DurableWriteError(metadataPath,'after-replace',new Error('Injected owner acknowledgement loss after original replacement'))}}
    try {
      await click(`document.querySelector('[aria-label="More for Unconfirmed recycle Profile"]')`);await click(textButton('Recycle Profile…'));await click(textButton('Recycle Unconfirmed recycle Profile'))
      await until(()=>evaluate(`document.querySelector('.browser-profiles-settings__service')?.textContent.includes('could not be confirmed')`),'unknown original write acknowledgement stays visible outside retired editor')
      assert.equal((await list()).profiles.some((p:any)=>p.id===ack.id),false)
      const entry=(await archiveList()).entries.find((entry:any)=>entry.profile.id===ack.id);assert.ok(entry)
      assert.ok(receipt.calls.some((call:any)=>call.channel==='browser:deleteProfile'&&call.args[0]===ack.id&&call.receipt?.error?.code==='BROWSER_PROFILE_WRITE_UNCONFIRMED'))
      await capture('recycle-write-unconfirmed-narrow-light',560,920,'light','.browser-profiles-settings__service')
      await click(textButton('Show recycled Profiles'))
      await until(()=>evaluate(`document.querySelector('.browser-profile-trash')?.textContent.includes('Unconfirmed recycle Profile')`),'same original archive discovered after unknown ACK')
      await assertOriginal()
      receipt.cases.push('injected-original-owner-ACK-loss-after-real-replacement-returns-WRITE_UNCONFIRMED-and-readback-keeps-archive-with-service-window-no-replay')
    }finally{store.writeMetadata=write}
    receipt.passed=true;return
  }
  if (previous) {
    assert.equal(original.profileId, previous.sourceId)
    assert.ok((await page.session.cookies.get({url:urls.page})).some(cookie=>cookie.name==='source-sign-in' && cookie.value==='original'))
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'), 'keep original')
    const archive = (await archiveList()).entries.find((entry:any)=>entry.id===previous.archive.id)
    assert.equal(archive.profile.id, previous.targetId); assert.equal(archive.profile.revision, previous.originalToken)
    assert.equal((await list()).profiles.some((p:any)=>p.id===previous.targetId), false)
    const sourcePath = previous.storagePath, held = sourcePath + '.retained'
    await rename(sourcePath, held)
    const unavailable = await evaluate(`trashProof.restore(${JSON.stringify(archive)}).then(value=>({value}),error=>({code:error.code}))`)
    assert.equal(unavailable.code, 'BROWSER_PROFILE_DATA_UNAVAILABLE'); assert.equal((await archiveList()).entries.length,1)
    await rename(held, sourcePath)
    await click(textButton('Recycled Profiles'))
    await until(()=>evaluate(`document.querySelector('.browser-profile-trash')?.textContent.includes(${JSON.stringify(archive.profile.label)})`),'original archived GUI after restart')
    await click(textButton('Restore ' + archive.profile.label))
    const restored = await until(async()=> (await list()).profiles.find((p:any)=>p.id===previous.targetId), 'same original identity restored')
    assert.notEqual(restored.revision, previous.originalToken)
    assert.equal((await archiveList()).entries.length,0)
    assert.deepEqual(await evaluate(`trashProof.username(${JSON.stringify(previous.targetId)})`), previous.username)
    await evaluate(`trashProof.createTarget(${JSON.stringify(previous.targetId)},${JSON.stringify(urls.page)})`)
    const target = await loaded('recycle-target')
    assert.equal(target.session.storagePath, previous.storagePath)
    assert.ok((await target.session.cookies.get({url:urls.page})).some(cookie=>cookie.name==='retained-sign-in' && cookie.value==='same-original-data'))
    assert.equal(await target.executeJavaScript('localStorage.getItem("retained-site")'),'same-original-data')
    assert.equal(await target.executeJavaScript(`new Promise((resolve,reject)=>{const request=indexedDB.open('retained-db',1);request.onsuccess=()=>{const query=request.result.transaction('original').objectStore('original').get('identity');query.onsuccess=()=>resolve(query.result);query.onerror=()=>reject(query.error)}})`),'retained-indexed-db')
    const policies = await readFile(join(app.getPath('userData'),'browser-site-permissions.json'))
    assert.equal(createHash('sha256').update(policies).digest('hex'),previous.permissionsHash)
    await evaluate('trashProof.showBrowser("recycle-target")')
    await until(()=>evaluate(`document.querySelector('[aria-label="Site permissions"]')?.textContent.includes('This Profile')`),'original remembered site permission after restore')
    receipt.cases.push('real-process-restart-original-Core-layout-before-native-and-same-ID-partition-cookies-localStorage-IndexedDB-credential-permission-restore-new-token', 'missing-retained-source-refuses-without-empty-session-replacement')
    receipt.restore = { profileId:restored.id,oldToken:previous.originalToken,newToken:restored.revision,storagePath:target.session.storagePath }
  } else {
    await page.executeJavaScript('document.getElementById("draft").value="Keep this original page draft";localStorage.setItem("source-only","keep original")')
    await page.session.cookies.set({url:urls.page,name:'source-sign-in',value:'original',expirationDate:Math.floor(Date.now()/1000)+3600})
    const fresh=(await cli(['browser','profile','create','--label','Unused new Profile'])).profile
    await profiles.sessions.nativeSession(fresh.id).cookies.flushStore() // initialize this genuinely new, never-opened native cookie owner, not a substitute for archived data
    const freshRecycled=await recycle(fresh.id,fresh.revision)
    assert.ok(freshRecycled.value?.archive,JSON.stringify(freshRecycled))
    const freshRestored=await cli(['browser','profile','trash','restore','--archive',freshRecycled.value.archive.id,'--expected-revision',freshRecycled.value.archive.revision])
    assert.equal(freshRestored.profile.id,fresh.id);assert.notEqual(freshRestored.profile.revision,fresh.revision)
    receipt.cases.push('never-opened-new-Profile-original-native-partition-recycle-and-restore')
    const targetProfile = (await cli(['browser','profile','create','--label','Retained work Profile'])).profile
    const targetId = targetProfile.id
    await edit(targetId,['--notes','Original saved notes','--network','http://127.0.0.1:49189'])
    await evaluate(`trashProof.signIn(${JSON.stringify(targetId)})`)
    const username = await evaluate(`trashProof.username(${JSON.stringify(targetId)})`); assert.deepEqual(username,{username:'retained-user'})
    await evaluate(`trashProof.createTarget(${JSON.stringify(targetId)},${JSON.stringify(urls.page)})`)
    const target = await loaded('recycle-target'), targetSession=target.session, storagePath=targetSession.storagePath
    assert.ok(storagePath?.startsWith(app.getPath('sessionData')+'/'))
    await target.session.cookies.set({url:urls.page,name:'retained-sign-in',value:'same-original-data',expirationDate:Math.floor(Date.now()/1000)+3600})
    await target.executeJavaScript('localStorage.setItem("retained-site","same-original-data")')
    await target.executeJavaScript(`new Promise((resolve,reject)=>{const request=indexedDB.open('retained-db',1);request.onupgradeneeded=()=>request.result.createObjectStore('original');request.onsuccess=()=>{const tx=request.result.transaction('original','readwrite');tx.objectStore('original').put('retained-indexed-db','identity');tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error)}})`)
    const initialToken=await token(targetId)
    assert.equal((await recycle(targetId,initialToken)).code,'BROWSER_PROFILE_IN_USE')
    await evaluate('trashProof.showBrowser("recycle-target")')
    await target.executeJavaScript('globalThis.permissionResult="pending";void Notification.requestPermission().then(value=>globalThis.permissionResult=value);true')
    await until(()=>evaluate(`document.querySelector('[aria-label="Site permissions"] input[type="checkbox"]')!==null`),'actual native site permission in trusted App')
    await click(`document.querySelector('[aria-label="Site permissions"] input[type="checkbox"]')`)
    await click(textButton('Allow'))
    await until(()=>evaluate(`document.querySelector('[aria-label="Site permissions"]')?.textContent.includes('This Profile')`),'original remembered permission owner')
    const permissionsHash=createHash('sha256').update(await readFile(join(app.getPath('userData'),'browser-site-permissions.json'))).digest('hex')
    await evaluate('trashProof.settings(true)')
    await target.executeJavaScript(`navigator.serviceWorker.register(${JSON.stringify(urls.worker)}).then(()=>navigator.serviceWorker.ready).then(()=>true)`)
    await until(()=>profiles.nativeUse(targetId).workers!>0,'actual native worker')
    await evaluate('trashProof.persist()')
    await evaluate('trashProof.closeTarget()');await until(()=>target.isDestroyed(),'actual target native destruction')
    const cold=await recycle(targetId,initialToken);assert.equal(cold.code,'BROWSER_PROFILE_IN_USE')
    await evaluate('trashProof.detachTarget()');await evaluate('trashProof.persist()')
    assert.equal((await cli(['browser','profile','inspect','--profile',targetId])).usage.browsers.length,0,'Core no longer retains the explicitly closed fixture target Tab')
    await until(()=>profiles.nativeUse(targetId).workers!>0,'original worker remains after original native page closes')
    const workerUse=profiles.nativeUse(targetId);assert.equal(workerUse.pages,0)
    assert.equal((await recycle(targetId,initialToken)).code,'BROWSER_PROFILE_IN_USE')
    // Explicitly finish only the fixture-owned worker through Chromium's actual DevTools command.
    // This is not a production Session.stopAllWorkers API or automatic lifecycle cleanup.
    const workerController=new BrowserWindow({show:false,webPreferences:{session:targetSession}})
    workerController.webContents.debugger.attach('1.3');await workerController.webContents.debugger.sendCommand('ServiceWorker.enable');await workerController.webContents.debugger.sendCommand('ServiceWorker.stopAllWorkers');workerController.destroy()
    await until(()=>profiles.nativeUse(targetId).workers===0 && profiles.nativeUse(targetId).pages===0,'private fixture worker/controller end')
    const heldRequest=targetSession.fetch(urls.held).then(response=>response.text())
    await until(()=>profiles.nativeUse(targetId).requests!>0,'native ongoing request without WebContents')
    const requestUse=profiles.nativeUse(targetId);assert.equal(requestUse.pages,0)
    assert.equal((await recycle(targetId,initialToken)).code,'BROWSER_PROFILE_IN_USE')
    await fetch(urls.finish);await heldRequest;await until(()=>profiles.nativeUse(targetId).requests===0,'own private request finishes')
    let download: Electron.DownloadItem | undefined
    const observedDownload=(_event:Electron.Event,item:Electron.DownloadItem)=>{download=item;item.setSavePath(join(home,'private-download.bin'));item.pause()}
    targetSession.once('will-download',observedDownload);targetSession.downloadURL(urls.download)
    await until(()=>download && profiles.nativeUse(targetId).downloads!>0,'original native DownloadItem occupancy without WebContents')
    const downloadUse=profiles.nativeUse(targetId);assert.equal(downloadUse.pages,0)
    assert.equal((await recycle(targetId,initialToken)).code,'BROWSER_PROFILE_IN_USE')
    download!.cancel();await fetch(urls.finish);await until(()=>profiles.nativeUse(targetId).downloads===0,'private fixture download ends')
    await until(()=>profiles.nativeUse(targetId).status==='idle','original native use known idle')
    await click(`document.querySelector('[data-resource-row="${targetId}"]')`)
    await until(()=>evaluate(`document.querySelector('article.browser-profile-editor')?.getAttribute('aria-label')==='Retained work Profile'`),'exact retained Profile editor')
    await input(`document.querySelector('input[aria-label="Proxy server"]')`,'http://unsaved-route.example:8080')
    await click(`document.querySelector('[aria-label="More for Retained work Profile"]')`)
    await click(textButton('Recycle Profile…'))
    await capture('recycle-confirm-wide-dark',1100,800,'dark','[role="alertdialog"][aria-label="Recycle Retained work Profile"]')
    await capture('recycle-confirm-narrow-light',560,920,'light','[role="alertdialog"][aria-label="Recycle Retained work Profile"]')
    await click(textButton('Recycle Retained work Profile'))
    const archive=await until(async()=> (await archiveList()).entries.find((entry:any)=>entry.profile.id===targetId),'same-owner active-to-trash commit')
    await until(()=>evaluate('!document.querySelector(".browser-profile-trash").hidden'),'actual recycle bin visible')
    assert.equal((await evaluate('trashProof.facts()')).proxyDraft,'http://unsaved-route.example:8080')
    assert.equal((await list()).profiles.some((p:any)=>p.id===targetId),false)
    assert.equal(profiles.profileOfSession(targetSession),targetId)
    assert.deepEqual(archive.profile.network,{mode:'proxy',server:{scheme:'http',host:'127.0.0.1',port:49189}})
    assert.equal(archive.profile.revision,initialToken)
    assert.equal(createHash('sha256').update(await readFile(join(app.getPath('userData'),'browser-site-permissions.json'))).digest('hex'),permissionsHash)
    await capture('recycled-profiles-wide-light',1100,800,'light','.browser-profile-trash')
    await capture('recycled-profiles-narrow-dark',560,920,'dark','.browser-profile-trash')
    const heldSource=storagePath+'.unavailable';await rename(storagePath!,heldSource)
    await click(textButton('Restore '+archive.profile.label))
    await until(()=>evaluate(`document.querySelector('.browser-profile-trash [role="status"]')?.textContent.includes('original Profile data')`),'actual Restore source-unavailable service window')
    assert.equal((await archiveList()).entries[0].id,archive.id);assert.equal((await list()).profiles.some((p:any)=>p.id===targetId),false)
    await capture('restore-source-unavailable-narrow-light',560,920,'light','.browser-profile-trash [role="status"]')
    await rename(heldSource,storagePath!)
    await click(`document.querySelector('.browser-profile-trash [role="status"] button')`)
    await until(()=>evaluate(`!document.querySelector('.browser-profile-trash [role="status"]')`),'Retry reads original archive facts without replaying Restore')
    assert.equal((await archiveList()).entries[0].id,archive.id)
    await assertOriginal()
    const workface=await evaluate('trashProof.savedWorkface()')
    await writeFile(join(home,'trash-identities.json'),JSON.stringify({sourceId,targetId,originalToken:initialToken,archive,storagePath,permissionsHash,username,workface}))
    receipt.cases.push('native-open-cold-saved-request-worker-download-use-refusals-and-original-work-preserved','trusted-App-exact-recycle-full-original-data-owner-and-unsaved-proxy-draft-kept','actual-CLI-discovery-archive-ID-receipt-and-credential-permission-retention')
    receipt.nativeUses={requestUse,workerUse,downloadUse};receipt.archive={id:archive.id,profileId:targetId,storagePath}
  }
  receipt.passed = true

}).catch(async error => {
  console.error('Profile trash proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets()
  try { receipt.renderer = await evaluate('trashProof.facts()'); await capture('failure-observation') } catch { /* diagnostic only; never substitutes a business result */ }
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
