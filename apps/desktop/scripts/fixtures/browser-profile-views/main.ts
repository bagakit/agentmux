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

const out = process.env.AGENTMUX_VIEWS_OUT!, assets = process.env.AGENTMUX_VIEWS_ASSETS!, home = process.env.AGENTMUX_VIEWS_HOME!
const urls = JSON.parse(process.env.AGENTMUX_VIEWS_URLS!) as { page: string }, phase = process.env.AGENTMUX_VIEWS_PHASE!
const receipt: any = { passed: false, phase, cases: [], images: [], calls: [], cleanup: [], runtimeConnections: 0, versions: process.versions }
const stage = (value: string) => console.log('Profile views proof: ' + value)
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
  const result = await promisify(execFile)(process.env.AGENTMUX_VIEWS_NODE!, [process.env.AGENTMUX_VIEWS_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], {
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
  if (process.env.AGENTMUX_VIEWS_CAPTURE !== '1') return
  win!.setContentSize(width, height); await evaluate(`viewsProof.theme(${JSON.stringify(theme)})`); await pause()
  await evaluate(`(()=>{for(const selector of ['.browser-profile-library','.settings-resource-editor','[data-settings-pane="browser-profiles"]']){const e=document.querySelector(selector);if(e)e.scrollTop=0}})()`); await pause()
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
    const call = ['browser:saveProfileView', 'browser:deleteProfileView', 'browser:bulkUpdateProfiles', 'browser:updateProfile'].includes(channel) ? { channel, args, completed: false,
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
  dispose = await registerIpc({ appDocumentSources: () => ({ current: { mode: 'prod', filePath: html }, loading: null }), window: win, workbenchWindows: windows, runtime, configStore, initialConfig: config,
    scratchTopics, applicationAccess: access, progressLoops: progress })
  stage('production IPC ready')
  await win.loadFile(html); await until(() => evaluate('Boolean(globalThis.viewsProof)'), 'production Renderer entry')
  stage('actual Renderer ready')

  const previous = phase === 'restart' ? JSON.parse(await readFile(join(home, 'views-identities.json'), 'utf8')) : null
  const original = await evaluate(`viewsProof.setup(${JSON.stringify(config)},${JSON.stringify(urls.page)},${JSON.stringify(previous?.sourceId)},${Boolean(previous)})`)
  const sourceId = original.profileId
  if (previous) {
    assert.equal(original.restoredFromCore, true)
    receipt.restoredBeforeNative = await evaluate('viewsProof.savedWorkface()')
    assert.deepEqual(receipt.restoredBeforeNative.currentLayouts, previous.workface.currentLayouts)
    assert.deepEqual(receipt.restoredBeforeNative.surfaces, previous.workface.surfaces)
    await evaluate('viewsProof.resumeOriginal()')
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
    assert.equal((await evaluate('viewsProof.facts()')).sibling, 'Keep this sibling draft')
  }
  if (previous) {
    const current = await list()
    assert.equal(sourceId, previous.sourceId)
    assert.deepEqual(current.views, previous.views)
    for (const saved of previous.profiles) {
      const actual = current.profiles.find((value: any) => value.id === saved.id)
      for (const field of ['label', 'tags', 'folderId', 'pinned', 'notes']) assert.deepEqual(actual[field], saved[field])
    }
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'), 'keep original')
    assert.ok((await page.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in'))
    const filtered = await cli(['browser', 'profile', 'ls', '--view', previous.viewId])
    assert.deepEqual(filtered.profiles.map((value: any) => value.id), previous.filteredIds)
    receipt.cases.push('real-process-restart-retains-saved-view-config-original-core-space-ids-and-native-login-state')
  } else if (phase === 'save-ack') {
    await page.executeJavaScript(`document.getElementById('draft').value='Keep save ACK page draft'`)
    const sourceContents = page.id, actualSave = profiles.saveView.bind(profiles)
    let deferNext = false, release!: () => void
    receipt.viewAcks = []
    profiles.saveView = async (...args) => {
      const saved = await actualSave(...args)
      receipt.viewAcks.push({ inputRevision: args[2], viewId: saved.view.id, revision: saved.revision })
      if (deferNext) {
        deferNext = false
        await profiles.createProfile('Independent write after this exact view commit')
        const waiting = new Promise<void>(done => { release = done })
        receipt.delayedViewAck = structuredClone(saved)
        await waiting
      }
      return saved
    }
    await click(`[...document.querySelectorAll('.browser-profile-library__views summary')].find(e=>e.textContent==='Save this view')`)
    await input(`document.querySelector('input[aria-label="Profile view name"]')`, 'Native immediate updates')
    await click(textButton('Save new'))
    await until(() => evaluate(`(()=>{const e=${textButton('Update view')};return e&&!e.disabled})()`), 'Save new immediately exposes Update on its confirmed revision')
    const first = profiles.listViews().find(view => view.label === 'Native immediate updates')!
    await click(`document.querySelector('.browser-profile-library__views details summary')`)
    await choose('Profile order', 'name')
    await click(textButton('Update view'))
    await until(() => profiles.listViews().find(view => view.id === first.id)?.query.sort === 'name', 'first immediate GUI Update without Reload')
    await until(() => evaluate(`!(${textButton('Update view')}).disabled`), 'Update ACK retains the next edit baseline')
    await choose('Profile observed status', 'unknown')
    await click(textButton('Update view'))
    await until(() => profiles.listViews().find(view => view.id === first.id)?.query.status === 'unknown', 'second immediate GUI Update without Reload')
    await until(() => evaluate(`!(${textButton('Update view')}).disabled`), 'second Update ACK complete')
    assert.equal(receipt.viewAcks.length, 3)
    assert.equal(receipt.viewAcks[1].inputRevision, receipt.viewAcks[0].revision)
    assert.equal(receipt.viewAcks[2].inputRevision, receipt.viewAcks[1].revision)
    receipt.cases.push('actual-gui-save-new-modify-update-modify-update-consumes-each-confirmed-write-revision-without-reload')

    const later = (await cli(['browser', 'profile', 'view', 'create', '--label', 'Later selected view', '--query', '{"route":"system"}', '--expected-revision', String(profiles.listRevision())])).view
    await until(() => evaluate(`Boolean(document.querySelector('select[aria-label="Saved Profile view"] option[value="${later.id}"]'))`), 'later view discovered from original catalog')
    await input(`document.querySelector('input[aria-label="Profile view name"]')`, 'Earlier pending save')
    deferNext = true
    await click(textButton('Save new'))
    await until(() => receipt.delayedViewAck, 'earlier view confirmed before delayed ACK')
    assert.ok(profiles.listRevision() > receipt.delayedViewAck.revision)
    await until(() => evaluate(`viewsProof.facts().catalogRevision===${profiles.listRevision()}`), 'later confirmed catalog reaches the original list before choosing its view')
    await choose('Saved Profile view', later.id)
    await choose('Profile order', 'recent')
    await input(`document.querySelector('input[aria-label="Filter profiles"]')`, 'Keep later query')
    await input(`document.querySelector('input[aria-label="Profile view name"]')`, 'Keep later name')
    const laterBaseline = profiles.listRevision()
    release()
    await until(() => evaluate(`!(${textButton('Save new')}).disabled`), 'earlier ACK delivered without taking current view')
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Saved Profile view"]').value`), later.id)
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Profile order"]').value`), 'recent')
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Filter profiles"]').value`), 'Keep later query')
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Profile view name"]').value`), 'Keep later name')
    await click(textButton('Update view'))
    await until(() => profiles.listViews().find(view => view.id === later.id)?.label === 'Keep later name', 'later selected view keeps its own original baseline')
    const updated = profiles.listViews().find(view => view.id === later.id)!
    assert.deepEqual(updated.query, { search: 'Keep later query', route: 'system', sort: 'recent' })
    assert.equal(receipt.viewAcks.at(-1).inputRevision, laterBaseline)
    assert.notEqual(receipt.viewAcks.at(-1).inputRevision, receipt.delayedViewAck.revision)
    assert.equal(profiles.listViews().find(view => view.id === receipt.delayedViewAck.view.id)!.label, 'Earlier pending save')
    assert.equal(page.id, sourceContents)
    assert.equal(await page.executeJavaScript('document.getElementById("draft").value'), 'Keep save ACK page draft')
    assert.equal((await evaluate('viewsProof.facts()')).sibling, 'Keep this sibling draft')
    profiles.saveView = actualSave
    receipt.cases.push('delayed-exact-view-ack-after-later-collection-write-preserves-new-view-query-name-baseline-and-original-page')
  } else {
    await evaluate(`viewsProof.update(${JSON.stringify(sourceId)},{label:'Original settings',notes:'Saved purpose',network:{mode:'direct'}})`)
    await page.executeJavaScript(`document.getElementById('draft').value='Keep this original page draft';document.cookie='source-sign-in=original; Max-Age=3600; Path=/';localStorage.setItem('source-only','keep original')`)
    await page.session.cookies.flushStore(); page.session.flushStorageData()
    const other = (await cli(['browser', 'profile', 'create', '--label', 'Original settings'])).profile
    await until(() => profiles.listProfiles().find(value => value.id === sourceId)?.activity?.state === 'running', 'original native activity projection')
    const observed = await cli(['browser', 'profile', 'ls', '--query', '{"status":"running","route":"direct","lastUsed":"day"}'])
    assert.deepEqual(observed.profiles.map((value: any) => value.id), [sourceId])
    const unknown = await cli(['browser', 'profile', 'ls', '--query', '{"status":"unknown"}'])
    assert.deepEqual(unknown.profiles.map((value: any) => value.id), [other.id])
    receipt.cases.push('actual-compiled-cli-query-consumes-original-native-status-route-and-last-observed-use')
    await click(`[...document.querySelectorAll('[role="radio"]')].find(e=>e.textContent.trim()==='Proxy')`)
    await input(`document.querySelector('input[aria-label="Proxy server"]')`, 'unsubmitted-gateway.example:8080')
    await click(textButton('Select Profiles')); await click(textButton('Select displayed'))
    const later = (await cli(['browser', 'profile', 'create', '--label', 'Later matching Profile'])).profile
    await until(() => evaluate(`viewsProof.facts().rowIds.includes(${JSON.stringify(later.id)})`), 'later matching Profile visible')
    assert.ok(await evaluate(`document.querySelector('section[aria-label="Selected Profiles"]').textContent.includes('2 selected')`))
    await click(`document.querySelector('.browser-profile-library__views details summary')`)
    await choose('Profile observed status', 'unknown'); await choose('Profile order', 'name')
    await click(`[...document.querySelectorAll('.browser-profile-library__views summary')].find(e=>e.textContent==='Save this view')`)
    await input(`document.querySelector('input[aria-label="Profile view name"]')`, 'Unknown profiles')
    await click(textButton('Save new'))
    await until(() => profiles.listViews().some(view => view.label === 'Unknown profiles'), 'actual GUI named view durable commit')
    const view = profiles.listViews().find(view => view.label === 'Unknown profiles')!
    assert.deepEqual(view.query, { status: 'unknown', sort: 'name' })
    await until(() => evaluate(`document.querySelector('select[aria-label="Saved Profile view"]').value===${JSON.stringify(view.id)}`), 'saved view receipt unwrapped to exact identity')
    assert.equal((await evaluate('viewsProof.facts()')).proxyDraft, 'unsubmitted-gateway.example:8080')
    assert.deepEqual(profiles.listProfiles().find(value => value.id === sourceId)!.network, { mode: 'direct' })
    await click(`[...document.querySelectorAll('.browser-profile-library__views summary')].find(e=>e.textContent==='Save this view')`)
    assert.equal(await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Apply to 2 selected');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===e||e.contains(hit)})()`), true, 'Expanded controls keep the exact Apply button reachable in its original library scroller')
    receipt.cases.push('expanded-filter-controls-exact-apply-hit-target-remains-reachable')
    await capture('views-filter-selection-wide-light', 1100, 900, 'light')
    win!.setContentSize(560, 920); await pause()
    await click(textButton('All Profiles'))
    await capture('views-filter-selection-narrow-dark', 560, 920, 'dark')
    // Interleave a real original-owner update after the UI freezes input, before the original batch begins.
    const originalBulk = profiles.bulkUpdate.bind(profiles)
    let armed = true
    profiles.bulkUpdate = async (items, action) => {
      if (armed) {
        armed = false; receipt.frozenSelection = structuredClone(items)
        const current = profiles.listProfiles().find(value => value.id === other.id)!
        await profiles.updateProfile(other.id, { notes: 'Independent newer configuration' }, current.revision)
      }
      return originalBulk(items, action)
    }
    await click(`document.querySelector('.browser-profile-library__views details summary')`)
    await choose('Bulk Profile action', 'add-tag')
    await input(`document.querySelector('input[aria-label="Bulk tag name"]')`, 'Review')
    await click(textButton('Apply to 2 selected'))
    await until(() => evaluate(`document.querySelector('section[aria-label="Bulk Profile results"]')?.textContent.includes('1 updated · 1 failed')`), 'exact actual batch partial receipt')
    profiles.bulkUpdate = originalBulk
    assert.deepEqual(receipt.frozenSelection.map((value: any) => value.profileId), [sourceId, other.id])
    assert.ok(profiles.listProfiles().find(value => value.id === sourceId)!.tags?.includes('Review'))
    assert.equal(profiles.listProfiles().find(value => value.id === other.id)!.tags, undefined)
    assert.equal(profiles.listProfiles().find(value => value.id === later.id)!.tags, undefined)
    assert.equal(profiles.listProfiles().find(value => value.id === other.id)!.notes, 'Independent newer configuration')
    assert.ok(receipt.calls.some((call: any) => call.channel === 'browser:bulkUpdateProfiles' && call.completed && call.exactSender && call.exactFrame))
    await click(`[...document.querySelectorAll('section[aria-label="Bulk Profile results"] summary')][0]`)
    await capture('views-partial-results-narrow-light', 560, 920, 'light')
    await capture('views-partial-results-wide-dark', 1100, 900, 'dark')
    assert.equal((await evaluate('viewsProof.facts()')).proxyDraft, 'unsubmitted-gateway.example:8080')
    await assertOriginal()
    receipt.cases.push('real-settings-saved-query-frozen-same-name-id-selection-later-match-excluded-partial-stale-token-drafts-preserved')
    const current = await list(), filtered = await cli(['browser', 'profile', 'ls', '--view', view.id])
    await evaluate('viewsProof.persist()')
    const workface = await evaluate('viewsProof.savedWorkface()')
    receipt.identity = { sourceId, viewId: view.id, views: current.views, profiles: current.profiles, filteredIds: filtered.profiles.map((value: any) => value.id), workface }
    await writeFile(join(home, 'views-identities.json'), JSON.stringify(receipt.identity))
  }
  assert.equal(receipt.runtimeConnections, 0)
  receipt.passed = true

}).catch(async error => {
  console.error('Profile views proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets()
  try { receipt.renderer = await evaluate('viewsProof.facts()'); await capture('failure-observation') } catch { /* diagnostic only; never substitutes a business result */ }
}).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', () => win && !win.isDestroyed() ? evaluate('globalThis.viewsProof?.dispose()') : undefined],
    ['foreign-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()],
    ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()], ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }] ] as const) {
    stage('cleanup ' + owner)
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
