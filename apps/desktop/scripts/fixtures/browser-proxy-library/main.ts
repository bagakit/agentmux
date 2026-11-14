import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { desktopBusinessSocketPath } from '../../../src/main/desktop-host'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
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

const out = process.env.AGENTMUX_PROXY_LIBRARY_OUT!, assets = process.env.AGENTMUX_PROXY_LIBRARY_ASSETS!, home = process.env.AGENTMUX_PROXY_LIBRARY_HOME!
const urls = JSON.parse(process.env.AGENTMUX_PROXY_LIBRARY_URLS!) as { page: string; proxyA: string; proxyB: string; stats: string }, phase = process.env.AGENTMUX_PROXY_LIBRARY_PHASE!
const receipt: any = { passed: false, phase, cases: [], images: [], calls: [], cleanup: [], runtimeConnections: 0, versions: process.versions }
const stage = (value: string) => console.log('Proxy library proof: ' + value)
let win: BrowserWindow | undefined, outsider: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, manager: BrowserViewManager | undefined
const evaluate = (code: string) => win!.webContents.executeJavaScript(code)
const pause = () => new Promise(done => setTimeout(done, 60))
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 25)) }
  throw new Error('Private Profile views observation expired: ' + label)
}
const nativePage = (id = 'original') => (manager as any).entries.get(id)?.view.webContents as Electron.WebContents
async function key(key: string, code: string, windowsVirtualKeyCode: number) {
  for (const type of ['keyDown', 'keyUp']) await win!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
  await pause()
}
async function loaded(id: string) { const page = nativePage(id); await until(() => page && !page.isLoading() && page.getURL().startsWith('http:'), 'loaded exact native page ' + id); return page }
async function cli(args: string[]) {
  const result = await promisify(execFile)(process.env.AGENTMUX_PROXY_LIBRARY_NODE!, [process.env.AGENTMUX_PROXY_LIBRARY_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], {
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
async function capture(name: string, width = 1100, height = 780, theme = 'light') {
  if (process.env.AGENTMUX_PROXY_LIBRARY_CAPTURE !== '1') return
  win!.setContentSize(width, height); await evaluate(`proxyLibraryProof.theme(${JSON.stringify(theme)})`); await pause()
  await evaluate(`(()=>{for(const selector of ['.settings-resource-editor','[data-settings-pane="browser-profiles"]']){const e=document.querySelector(selector);if(e)e.scrollTop=0}})()`); await pause()
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(name.startsWith('proxy-library')?'.browser-proxy-library':'section[aria-label="Bulk Profile results"]')});e?.scrollIntoView({block:'center'})})()`);await pause()
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
    const call = ['browser:saveProxy', 'browser:deleteProxy', 'browser:assignProxy', 'browser:updateProfile', 'browser:setProfileProxySignIn'].includes(channel) ? { channel, args: channel === 'browser:setProfileProxySignIn' ? ['redacted'] : args, completed: false,
      exactSender: event.sender === win!.webContents, exactFrame: event.senderFrame === event.sender.mainFrame } : null
    if (call) receipt.calls.push(call)
    return Promise.resolve().then(() => listener(event, ...args)).then(value => { if (call) call.completed = true; return value })
  })
  const originalCreate = BrowserViewManager.prototype.create
  BrowserViewManager.prototype.create = async function(...args) { manager = this; return originalCreate.apply(this, args) }
  const scratchTopics = new ScratchTopics()
  runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { receipt.runtimeConnections++; throw new Error('Private permission proof cannot connect a Runtime') }, scratchTopics)
  runtime.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const configStore = new ConfigStore(join(home, 'config.json')), config = structuredClone(DEFAULT_CONFIG)
  config.workspaces = [{ id: 'views-workspace', name: 'Private Profile views', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
  windows = new WorkbenchWindows(win, new WorkbenchWindowStore(join(home, 'windows.json')), () => [])
  access = createDesktopApplicationAccessOwner(runtime, join(home, 'applications.sqlite'))
  progress = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(home, 'progress.json')), async () => { throw new Error('No progress input is allowed') }, undefined, async () => { throw new Error('No Agent observation is allowed') })
  stage('private owner constructors ready')
  await mkdir(process.env.AGENTMUX_STATE_DIRECTORY!, { recursive: true })
  const privateNotes = new AgentMuxNotesStorage(undefined, join(home, 'notes'))
  if (!await privateNotes.hasLocation()) await writeFile(privateNotes.locatorPath, JSON.stringify({ schemaVersion: 1, directory: join(home, 'notes'), operations: {}, pending: null }))
  assert.ok((await privateNotes.inspect()).directory.startsWith(home + '/'), 'All optional Notes storage stays inside this private fixture')
  stage('private Notes locator ready')
  const userStatePath=join(home,'workbench-user-state.json')
  const workbenchUserState=new WorkbenchUserStateStore(userStatePath)
  dispose = await registerIpc({ workbenchUserState, appDocumentSources: () => ({ current: { mode: 'prod', filePath: html }, loading: null }), window: win, workbenchWindows: windows, runtime, configStore, initialConfig: config,
    scratchTopics, applicationAccess: access, progressLoops: progress })
  stage('production IPC ready')
  await win.loadFile(html); await until(() => evaluate('Boolean(globalThis.proxyLibraryProof)'), 'production Renderer entry')
  stage('actual Renderer ready')

  const previous = phase === 'restart' ? JSON.parse(await readFile(join(home, 'proxy-library-identities.json'), 'utf8')) : null
  const original = await evaluate(`proxyLibraryProof.setup(${JSON.stringify(config)},${JSON.stringify(urls.page)},${JSON.stringify(previous?.sourceId)},${Boolean(previous)})`)
  const sourceId = original.profileId
  if (previous) {
    assert.equal(original.restoredFromCore, true)
    receipt.restoredBeforeNative = await evaluate('proxyLibraryProof.savedWorkface()')
    assert.deepEqual(receipt.restoredBeforeNative.currentLayouts, previous.workface.currentLayouts)
    assert.deepEqual(receipt.restoredBeforeNative.surfaces, previous.workface.surfaces)
    await evaluate('proxyLibraryProof.resumeOriginal()')
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
  const selectSource = async () => { await click(`document.querySelector('[data-resource-row="${sourceId}"]')`) }
  const openLibrary = async () => {
    const back = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='All Profiles');return e&&e.getBoundingClientRect().width>0})()`)
    if(back) await click(textButton('All Profiles'))
    await click(`document.querySelector('.browser-proxy-library > summary')`)
  }
  const stats = async () => await fetch(urls.stats).then(response => response.json()) as any
  const request = async (contents: Electron.WebContents, suffix: string) => await contents.executeJavaScript(`fetch(${JSON.stringify(urls.page)}+'?case='+${JSON.stringify(suffix)}).then(r=>({status:r.status})).catch(e=>({failed:true}))`)
  if(previous) {
    const current = await list(), proxies = await cli(['browser','profile','proxy','ls'])
    assert.equal(sourceId,previous.sourceId)
    assert.deepEqual(proxies.proxies,previous.proxies)
    assert.deepEqual(current.profiles.find((profile:any)=>profile.id===sourceId).proxyBinding,previous.binding)
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'),'keep original')
    assert.ok((await page.session.cookies.get({url:urls.page})).some(value=>value.name==='source-sign-in'&&value.value==='original'))
    assert.equal((await request(page,'restart-same-profile')).status,200)
    await openLibrary(); await choose('Saved proxy asset',previous.proxyId)
    await until(()=>evaluate(`document.querySelector('textarea[aria-label="Proxy asset notes"]').value==='Retain this unsubmitted asset draft'`),'original Desktop draft leaf restored without fixture injection')
    receipt.cases.push('real-process-restart-original-core-workface-profile-binding-asset-version-cookie-localStorage-and-unsaved-asset-draft')
  } else {
    await page.executeJavaScript(`document.getElementById('draft').value='Keep this original page draft';document.cookie='source-sign-in=original; Max-Age=3600; Path=/';localStorage.setItem('source-only','keep original')`)
    await page.session.cookies.flushStore();page.session.flushStorageData()
    const other=(await cli(['browser','profile','create','--label','Independent Profile'])).profile
    await evaluate(`proxyLibraryProof.openOther(${JSON.stringify(other.id)},${JSON.stringify(urls.page)})`)
    const neighbor=await loaded('proxy-neighbor'), neighborId=neighbor.id
    await neighbor.executeJavaScript(`document.getElementById('draft').value='Keep independent native input'`)
    await selectSource();await openLibrary()
    await input(`document.querySelector('input[aria-label="Proxy asset name"]')`,'Workspace gateway')
    await input(`document.querySelector('input[aria-label="Proxy asset server"]')`,urls.proxyA)
    await input(`document.querySelector('input[aria-label="Proxy asset bypass"]')`,'<-loopback>')
    await click(textButton('Save proxy'))
    await until(()=>profiles.listProxies().length===1,'original GUI asset commit and unwrapped receipt')
    const proxy=profiles.listProxies()[0]!
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Saved proxy asset"]').value`),proxy.id)
    const source=profiles.listProfiles().find(value=>value.id===sourceId)!
    const assigned=await cli(['browser','profile','proxy','assign','--proxy',proxy.id,'--expected-revision',proxy.revision,'--items',JSON.stringify([{profileId:sourceId,expectedRevision:source.revision}])])
    assert.equal(assigned.results[0].outcome,'updated')
    await evaluate(`proxyLibraryProof.signIn(${JSON.stringify(sourceId)},'fixture-a','local-a-proof-secret')`)
    assert.equal((await request(page,'bound-a')).status,200)
    assert.ok((await stats()).a.authorized>0)
    const beforeNeighbor=await stats();assert.equal((await request(neighbor,'independent-direct')).status,200)
    const afterNeighbor=await stats();assert.equal(afterNeighbor.a.requests,beforeNeighbor.a.requests)
    receipt.cases.push('actual-gui-asset-creation-and-compiled-cli-original-session-application-authenticated-http-traffic-with-independent-profile-direct')
    const changed=(await cli(['browser','profile','proxy','update','--proxy',proxy.id,'--expected-revision',proxy.revision,'--edit',JSON.stringify({label:proxy.label,server:urls.proxyB,bypass:['<-loopback>']})])).proxy
    assert.equal((await request(page,'old-binding-after-asset-edit')).status,200)
    const afterEdit=await stats();assert.equal(afterEdit.b.requests,0)
    assert.equal(profiles.listProfiles().find(value=>value.id===sourceId)!.proxyBinding!.revision,proxy.revision)
    receipt.cases.push('editing-asset-keeps-exact-prior-profile-route-and-version-until-explicit-assignment')
    await click(`document.querySelector('.browser-proxy-library > summary')`)
    await click(textButton('Select Profiles'));await click(textButton('Select displayed'))
    const later=(await cli(['browser','profile','create','--label','Later matching Profile'])).profile
    const originalAssign=profiles.assignProxy.bind(profiles)
    profiles.assignProxy=async (proxyId,revision,items)=>{receipt.frozenSelection=structuredClone(items);const current=profiles.listProfiles().find(value=>value.id===other.id)!;await profiles.updateProfile(other.id,{notes:'Independent newer edit'},current.revision);return originalAssign(proxyId,revision,items)}
    await click(`[...document.querySelectorAll('section[aria-label="Selected Profiles"] summary')].find(e=>e.textContent==='Assign a proxy')`)
    await choose('Proxy for selected Profiles',proxy.id);await click(textButton('Assign to 2 selected'))
    await until(()=>evaluate(`document.querySelector('section[aria-label="Bulk Profile results"]')?.textContent.includes('1 updated · 1 failed')`),'original exact GUI assignment partial results')
    profiles.assignProxy=originalAssign
    assert.deepEqual(receipt.frozenSelection.map((item:any)=>item.profileId),[sourceId,other.id])
    assert.equal(profiles.listProfiles().find(value=>value.id===later.id)!.proxyBinding,undefined)
    assert.equal(profiles.listProfiles().find(value=>value.id===sourceId)!.proxyBinding!.revision,changed.revision)
    await click(`document.querySelector('section[aria-label="Bulk Profile results"] summary')`)
    await capture('proxy-assignment-wide-dark',1100,900,'dark')
    await capture('proxy-assignment-narrow-light',560,920,'light')
    const refused=await request(page,'new-proxy-never-acquires-old-credential');assert.notEqual(refused.status,200)
    const wrongEndpoint=await stats();assert.equal(wrongEndpoint.b.authorized,0)
    await evaluate(`proxyLibraryProof.signIn(${JSON.stringify(sourceId)},'fixture-b','local-b-proof-secret')`)
    assert.equal((await request(page,'explicit-new-sign-in')).status,200)
    assert.ok((await stats()).b.authorized>0)
    assert.equal(page.id,sourceContentsId);assert.equal(neighbor.id,neighborId)
    assert.equal(await page.executeJavaScript('document.getElementById("draft").value'),'Keep this original page draft')
    assert.equal(await neighbor.executeJavaScript('document.getElementById("draft").value'),'Keep independent native input')
    assert.equal((await evaluate('proxyLibraryProof.facts()')).sibling,'Keep this sibling draft')
    receipt.cases.push('real-gui-frozen-exact-assignment-partial-conflict-no-later-member-native-credential-endpoint-isolation-original-page-input-and-neighbor-retained')
    await openLibrary();await choose('Saved proxy asset',proxy.id)
    await input(`document.querySelector('textarea[aria-label="Proxy asset notes"]')`,'Retain this unsubmitted asset draft')
    await until(()=>evaluate(`localStorage.getItem('agentmux.browser-proxy-library-drafts.v1')===null`),'shipping Desktop does not store proxy draft in localStorage')
    await until(async()=>{const bytes=await workbenchUserState.read().catch(()=>null);if(!bytes)return false;const original=JSON.parse(bytes),raw=original.desktopFragments?.browserProxyLibraryDrafts;if(!raw)return false;return JSON.parse(raw).assets?.[proxy.id]?.active?.notes==='Retain this unsubmitted asset draft'},'actual original user-state file contains confirmed proxy draft')
    await capture('proxy-library-wide-light',1100,900,'light')
    await capture('proxy-library-narrow-dark',560,920,'dark')
    const metadata=await readFile(join(app.getPath('userData'),'browser-profiles.json'),'utf8')
    assert.ok(!metadata.includes('local-a-proof-secret')&&!metadata.includes('local-b-proof-secret'))
    assert.ok(receipt.calls.some((call:any)=>call.channel==='browser:saveProxy'&&call.completed&&call.exactSender&&call.exactFrame))
    assert.ok(receipt.calls.some((call:any)=>call.channel==='browser:assignProxy'&&call.completed&&call.exactSender&&call.exactFrame))
    await evaluate('proxyLibraryProof.persist()')
    receipt.identity={sourceId,proxyId:proxy.id,proxies:profiles.listProxies(),binding:profiles.listProfiles().find(value=>value.id===sourceId)!.proxyBinding,workface:await evaluate('proxyLibraryProof.savedWorkface()')}
    await writeFile(join(home,'proxy-library-identities.json'),JSON.stringify(receipt.identity))
  }
  assert.equal(receipt.runtimeConnections, 0)
  receipt.passed = true

}).catch(async error => {
  console.error('Proxy library proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets()
  try { receipt.renderer = await evaluate('proxyLibraryProof.facts()'); await capture('failure-observation') } catch { /* diagnostic only; never substitutes a business result */ }
}).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', () => win && !win.isDestroyed() ? evaluate('globalThis.proxyLibraryProof?.dispose()') : undefined],
    ['foreign-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()],
    ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()], ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }] ] as const) {
    stage('cleanup ' + owner)
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
