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
import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { ContinuousProgressLoopStore } from '../../../../host/src/continuous-progress-loop-store'
import { ContinuousProgressLoopManager } from '../../../../host/src/continuous-progress-loop-manager'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { registerIpc } from '../../../src/main/ipc'
import { topFrameNavigationGuard, topFrameOrigin } from '../../../src/main/top-frame-navigation'

const out = process.env.AGENTMUX_ACTIVITY_OUT!, assets = process.env.AGENTMUX_ACTIVITY_ASSETS!, home = process.env.AGENTMUX_ACTIVITY_HOME!
const urls = JSON.parse(process.env.AGENTMUX_ACTIVITY_URLS!) as { page: string }, phase = process.env.AGENTMUX_ACTIVITY_PHASE!
const receipt: any = { passed: false, phase, cases: [], images: [], calls: [], cleanup: [], runtimeConnections: 0, versions: process.versions }
const stage = (value: string) => console.log('Profile activity proof: ' + value)
let win: BrowserWindow | undefined, outsider: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, manager: BrowserViewManager | undefined
let rendererReady = false
const evaluate = (code: string) => win!.webContents.executeJavaScript(code)
const pause = () => new Promise(done => setTimeout(done, 60))
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 25)) }
  throw new Error('Private Profile activity observation expired: ' + label)
}
const nativePage = (id = 'original') => (manager as any).entries.get(id)?.view.webContents as Electron.WebContents
async function key(key: string, code: string, windowsVirtualKeyCode: number) {
  for (const type of ['keyDown', 'keyUp']) await win!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
  await pause()
}
async function loaded(id: string) { const page = nativePage(id); await until(() => page && !page.isLoading() && page.getURL().startsWith('http:'), 'loaded exact native page ' + id); return page }
async function cli(args: string[]) {
  const result = await promisify(execFile)(process.env.AGENTMUX_ACTIVITY_NODE!, [process.env.AGENTMUX_ACTIVITY_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY'].includes(key))) })
  return JSON.parse(result.stdout).result
}
async function click(selector: string) {
  const point = await until(async () => evaluate(`(()=>{const e=${selector};if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`), 'trusted actual App control')
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
  if (process.env.AGENTMUX_ACTIVITY_CAPTURE !== '1') return
  win!.setContentSize(width, height); await evaluate(`activityProof.theme(${JSON.stringify(theme)})`); await pause()
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
    const call = ['browser:createProfileFolder', 'browser:renameProfileFolder', 'browser:deleteProfileFolder', 'browser:updateProfile'].includes(channel) ? { channel, args, completed: false,
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
  config.workspaces = [{ id: 'activity-workspace', name: 'Private Profile activity', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
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
    scratchTopics, applicationAccess: access, progressLoops: progress, workbenchUserState: new WorkbenchUserStateStore(join(home, 'workbench-user-state.json')) })
  stage('production IPC ready')
  await win.loadFile(html); await until(() => evaluate('Boolean(globalThis.activityProof)'), 'production Renderer entry')
  rendererReady = true
  stage('actual Renderer ready')

  const previous = ['crash', 'restart', 'recovery-restart'].includes(phase) ? JSON.parse(await readFile(join(home, 'activity-identities.json'), 'utf8')) : null
  if (previous) {
    const beforeOpen = await evaluate('activityProof.profiles()')
    const saved = beforeOpen.profiles.find((value: any) => value.id === previous.sourceId)
    assert.equal(saved.revision, previous.sourceRevision, 'Opening a new App does not invent a configuration edit')
    if (phase === 'restart' || phase === 'recovery-restart') {
      assert.equal(saved.activity.state, 'unknown', 'A killed native observer is unknown before any new native page opens')
      assert.equal(saved.activity.observedRunMs, previous.crashObservedRunMs, 'Restart does not fill the unobserved suffix through now')
      assert.equal(saved.activity.lastUsedAt, previous.crashLastUsedAt)
      receipt.cases.push('crash-original-confirmed-history-and-unknown-suffix-before-native-reopen')
    }
  }
  const original = await evaluate(`activityProof.setup(${JSON.stringify(config)},${JSON.stringify(urls.page)},${JSON.stringify(previous?.sourceId)},${phase === 'recovery-restart'})`)
  if (phase === 'recovery-restart') {
    win.webContents.debugger.attach('1.3')
    assert.equal(original.restoredFromCore, true)
    const restored = await evaluate('activityProof.savedWorkface()')
    assert.deepEqual(restored.currentLayouts, previous.workface.currentLayouts)
    assert.deepEqual(restored.savedTabLayouts, previous.workface.savedTabLayouts)
    assert.deepEqual(restored.surfaces, previous.workface.surfaces)
    await until(() => evaluate(`activityProof.activity()?.includes('interrupted')`), 'actual Core-restored workface with unknown native activity before reopening')
    await evaluate(`document.querySelector('.settings-resource-editor').scrollTop=0`)
    await capture('activity-core-restart-unknown-wide-light')
    await capture('activity-core-restart-unknown-narrow-dark', 520, 820, 'dark')
    win.setContentSize(1100, 780); await pause()
    await evaluate('activityProof.resumeOriginal()')
    receipt.cases.push('actual-core-spatial-hydration-keeps-original-split-layout-and-browser-regions-before-native-acquisition')
  }
  const sourceId = original.profileId, page = await loaded('original'), sourceContentsId = page.id
  const profiles = (manager as any).profiles as import('../../../src/main/browser-profile-manager').BrowserProfileManager
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  const inspect = async (id: string) => (await cli(['browser', 'profile', 'inspect', '--profile', id])).profile
  const update = async (id: string, flags: string[]) => cli(['browser', 'profile', 'update', '--profile', id, '--expected-revision', (await inspect(id)).revision, ...flags])
  if (phase === 'visual') {
    // This phase only recreates the shared unknown presentation with current copy.
    // The separate receipts own timing, process recovery, mutation and Core topology claims.
    await new Promise(done => setTimeout(done, 1100)); await manager!.flushProfileActivity()
    const gone = new Promise(done => page.once('render-process-gone', done))
    page.forcefullyCrashRenderer(); await gone; await manager!.flushProfileActivity()
    await until(() => evaluate(`activityProof.activity()?.includes('interrupted')`), 'current unknown activity copy in the actual Settings consumer')
    await evaluate(`document.querySelector('.settings-resource-editor').scrollTop=0`)
    await capture('activity-unknown-copy-wide-light')
    await capture('activity-unknown-copy-narrow-dark', 520, 820, 'dark')
    receipt.cases.push('visual-only-current-settings-copy-in-actual-unknown-native-observation')
    receipt.passed = true
    return
  }
  if (phase === 'recovery-seed') {
    await page.executeJavaScript(`document.cookie='source-sign-in=original; Max-Age=3600; Path=/';localStorage.setItem('source-only','keep original')`)
    await page.session.cookies.flushStore(); page.session.flushStorageData()
    await evaluate('activityProof.persist()')
    const opened = await cli(['browser', 'open', '--url', urls.page + '?split=retained', '--profile', sourceId, '--right-of', 'original'])
    await loaded(opened.region.browserId)
    await evaluate('activityProof.persist()'); await manager!.flushProfileActivity()
    const source = await inspect(sourceId), workface = await evaluate('activityProof.savedWorkface()')
    assert.equal(workface.surfaces.length, 2)
    receipt.identity = { sourceId, sourceRevision: source.revision, crashObservedRunMs: source.activity.observedRunMs,
      crashLastUsedAt: source.activity.lastUsedAt, workface, surfaces: (await evaluate('activityProof.facts()')).surfaces }
    await writeFile(join(home, 'activity-identities.json'), JSON.stringify(receipt.identity))
    receipt.crashPrepared = true; receipt.cleanupComplete = false; receipt.passed = true
    receipt.cases.push('actual-public-split-and-original-core-workface-saved-before-private-process-kill')
    await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
    process.kill(process.pid, 'SIGKILL'); return
  }
  if (phase === 'crash') {
    await manager!.flushProfileActivity()
    const current = await inspect(sourceId)
    assert.equal(current.revision, previous.sourceRevision)
    await writeFile(join(home, 'activity-identities.json'), JSON.stringify({ ...previous,
      crashObservedRunMs: current.activity.observedRunMs, crashLastUsedAt: current.activity.lastUsedAt }))
    receipt.crashPrepared = true; receipt.cleanupComplete = false; receipt.passed = true
    receipt.cases.push('persisted-actual-open-native-checkpoint-before-private-process-kill')
    await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
    process.kill(process.pid, 'SIGKILL')
    return
  }
  if (phase === 'restart' || phase === 'recovery-restart') {
    await manager!.flushProfileActivity()
    const current = await inspect(sourceId)
    assert.equal(current.revision, previous.sourceRevision)
    assert.ok(current.activity.interruptions >= 1)
    assert.ok(current.activity.observedRunMs >= previous.crashObservedRunMs)
    assert.ok((await page.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in' && value.value === 'original'))
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'), 'keep original')
    const surfaces = (await evaluate('activityProof.facts()')).surfaces
    assert.deepEqual(surfaces, previous.surfaces, 'Original durable Browser region and Profile identity remain visible and recoverable')
    receipt.cases.push('actual-process-restart-original-native-profile-cookie-and-workface-with-confirmed-history-gap')
  } else {
    await evaluate(`activityProof.update(${JSON.stringify(sourceId)},{label:'Original settings',notes:'Saved purpose',network:{mode:'direct'}})`)
    await page.executeJavaScript(`document.getElementById('draft').value='Keep this original page draft';document.cookie='source-sign-in=original; Max-Age=3600; Path=/';localStorage.setItem('source-only','keep original')`)
    await page.session.cookies.flushStore(); page.session.flushStorageData()
    await manager!.create('overlapping', urls.page, 'activity-workspace', sourceId)
    await loaded('overlapping'); await manager!.flushProfileActivity()
    const beforeTime = performance.now(); manager!.checkpointProfileActivity(); await manager!.flushProfileActivity()
    const before = await inspect(sourceId)
    await new Promise(done => setTimeout(done, 550))
    const afterTime = performance.now(); manager!.checkpointProfileActivity(); await manager!.flushProfileActivity()
    const after = await inspect(sourceId), delta = after.activity.observedRunMs - before.activity.observedRunMs, elapsed = afterTime - beforeTime
    assert.ok(Math.abs(delta - elapsed) < 100, 'Concurrent native pages count once by observed interval union, not by page sum')
    assert.equal(after.revision, before.revision)
    receipt.union = { elapsed, delta, simultaneousNativePages: 2 }
    receipt.cases.push('two-actual-native-pages-use-union-and-activity-does-not-edit-configuration')

    const other = (await cli(['browser', 'profile', 'create', '--label', 'Other Profile'])).profile
    const folderRevision = (await cli(['browser', 'profile', 'ls'])).revision
    await manager!.flushProfileActivity()
    await cli(['browser', 'profile', 'folder', 'create', '--label', 'Activity does not conflict', '--expected-revision', String(folderRevision)])
    await until(() => evaluate(`activityProof.facts().editor==='Original settings'`), 'actual original Profile editor')
    await click(`document.querySelector('.browser-profile-editor__name')`)
    await input(`document.querySelector('input[aria-label="Profile name"]')`, 'Original edited after activity')
    await update(other.id, ['--notes', 'Independent public configuration'])
    await manager!.flushProfileActivity()
    await key('Enter', 'Enter', 13)
    await until(() => profiles.listProfiles().find(value => value.id === sourceId)?.label === 'Original edited after activity', 'GUI name draft uses exact Profile token across other edits and checkpoints')
    receipt.cases.push('actual-public-folder-cas-and-gui-profile-edit-survive-activity-and-unrelated-profile-configuration')

    await click(`document.querySelector('.browser-profile-editor__note')`)
    await input(`document.querySelector('textarea[aria-label="Notes"]')`, 'Keep this stale note until explicit reload')
    await update(sourceId, ['--pin'])
    await key('Tab', 'Tab', 9)
    await until(() => evaluate(`Boolean(document.querySelector('.browser-profile-editor__error'))`), 'same Profile stale edit is refused')
    assert.equal((await evaluate('activityProof.facts()')).notesDraft, 'Keep this stale note until explicit reload')
    assert.equal((await inspect(sourceId)).notes, 'Saved purpose')
    receipt.reloadBefore = { facts: await evaluate('activityProof.facts()'), current: await inspect(sourceId) }
    await evaluate(`globalThis.activityRecoveryEvents=[];for(const type of ['mousedown','focusout','click'])document.addEventListener(type,event=>{if(event.target?.closest?.('.browser-profile-editor'))activityRecoveryEvents.push({type,target:event.target.getAttribute('aria-label')||event.target.textContent,related:event.relatedTarget?.textContent,prevented:event.defaultPrevented})})`)
    await click(textButton('Reload'))
    receipt.reloadAfter = { facts: await evaluate('activityProof.facts()'), events: await evaluate('activityRecoveryEvents') }
    await click(`document.querySelector('textarea[aria-label="Notes"]')`)
    await click(`document.querySelector('[aria-label="Observed activity"] h4')`)
    await until(() => profiles.listProfiles().find(value => value.id === sourceId)?.notes === 'Keep this stale note until explicit reload', 'explicit reload adopts current exact token while retaining the person’s note')
    await click(`[...document.querySelectorAll('[role="radio"]')].find(e=>e.textContent.trim()==='Proxy')`)
    await input(`document.querySelector('input[aria-label="Proxy server"]')`, 'unsubmitted-gateway.example:8080')
    await manager!.flushProfileActivity(); await update(other.id, ['--notes', 'Still independent'])
    assert.equal((await evaluate('activityProof.facts()')).proxyDraft, 'unsubmitted-gateway.example:8080')
    assert.deepEqual((await inspect(sourceId)).network, { mode: 'direct' })
    await capture('activity-confirmed-wide-light')
    await capture('activity-confirmed-narrow-dark', 520, 820, 'dark')
    win.setContentSize(1100, 780); await pause()
    receipt.cases.push('same-profile-stale-gui-note-kept-and-explicitly-rebased-network-draft-and-sibling-kept')

    await update(other.id, ['--environment', '{"userAgent":"ActivityCandidateFailure/1.0"}'])
    await manager!.create('switch-page', urls.page, 'activity-workspace', sourceId); await loaded('switch-page')
    await assert.rejects(manager!.switchProfile('switch-page', other.id))
    assert.equal((await inspect(other.id)).activity, undefined, 'A failed loading candidate is not a committed Profile use')
    assert.equal(nativePage('switch-page').session, page.session)
    await update(other.id, ['--environment', 'null'])
    const retired = nativePage('switch-page')
    await retired.executeJavaScript(`window.onbeforeunload=()=>false;document.getElementById('draft').focus()`, true)
    await manager!.switchProfile('switch-page', other.id); const replacement = await loaded('switch-page')
    assert.notEqual(replacement, retired)
    await manager!.flushProfileActivity()
    const used = await inspect(other.id)
    assert.equal(used.activity.state, 'running')
    if (!retired.isDestroyed()) {
      await retired.executeJavaScript('window.onbeforeunload=null'); retired.close()
      await until(() => retired.isDestroyed(), 'original retired native owner eventually destroys')
      receipt.cases.push('real-native-beforeunload-retains-old-owner-until-exact-late-destruction')
    } else receipt.cases.push('native-switch-retirement-confirmed-synchronously-no-late-destruction-claim')
    assert.equal(replacement.isDestroyed(), false)
    assert.equal((await inspect(other.id)).activity.state, 'running')
    receipt.cases.push('failed-and-successful-profile-switches-use-exact-native-commit-not-candidate-or-old-destroy')

    const crashProfile = (await cli(['browser', 'profile', 'create', '--label', 'Interrupted observation'])).profile
    await manager!.create('renderer-crash', urls.page, 'activity-workspace', crashProfile.id)
    const crashing = await loaded('renderer-crash'); await manager!.flushProfileActivity()
    const confirmed = await inspect(crashProfile.id)
    let lastRunningConfirmed = confirmed.activity.observedRunMs
    const stopCrashObservations = profiles.onChange(snapshot => {
      const observed = snapshot.profiles.find(value => value.id === crashProfile.id)?.activity
      if (observed?.state === 'running') lastRunningConfirmed = observed.observedRunMs
    })
    const gone = new Promise(done => crashing.once('render-process-gone', done))
    crashing.forcefullyCrashRenderer(); await gone; await manager!.flushProfileActivity()
    const interrupted = await inspect(crashProfile.id)
    stopCrashObservations()
    assert.equal(interrupted.activity.state, 'unknown'); assert.equal(interrupted.activity.observedRunMs, lastRunningConfirmed)
    receipt.rendererCrash = { previousCliRead: confirmed.activity, lastRunningConfirmed, interrupted: interrupted.activity }
    await click(`document.querySelector('[data-resource-row="${crashProfile.id}"]')`)
    await until(() => evaluate(`activityProof.activity()?.includes('interrupted')`), 'actual Profile activity unknown surface')
    await capture('activity-interrupted-wide-dark', 1100, 780, 'dark')
    await capture('activity-interrupted-narrow-light', 520, 820, 'light')
    win.setContentSize(1100, 780); await pause()
    await crashing.loadURL(urls.page); await manager!.flushProfileActivity()
    assert.equal(crashing.isCrashed(), false)
    assert.equal((await inspect(crashProfile.id)).activity.state, 'running', 'Actual new native renderer dom-ready resumes the same WebContents observation')
    receipt.cases.push('real-renderer-crash-unknown-suffix-and-original-native-dom-ready-recovery')
    assert.equal(page.id, sourceContentsId)
    assert.equal(await page.executeJavaScript('document.getElementById("draft").value'), 'Keep this original page draft')
    assert.equal((await evaluate('activityProof.facts()')).sibling, 'Keep this sibling draft')
    await manager!.flushProfileActivity()
    const source = await inspect(sourceId)
    receipt.identity = { sourceId, sourceRevision: source.revision, surfaces: (await evaluate('activityProof.facts()')).surfaces }
    await writeFile(join(home, 'activity-identities.json'), JSON.stringify(receipt.identity))
    await evaluate('activityProof.persist()')
    receipt.cases.push('native-observation-bookkeeping-preserves-original-page-cookie-draft-and-workface')
  }
  assert.equal(receipt.runtimeConnections, 0)
  receipt.passed = true

}).catch(async error => {
  console.error('Profile activity proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets()
  if (rendererReady) {
    try { receipt.renderer = await evaluate('activityProof.facts()'); receipt.recoveryEvents = await evaluate('globalThis.activityRecoveryEvents'); await capture('failure-observation') } catch { /* diagnostic only; never substitutes a business result */ }
  }
}).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', () => rendererReady && win && !win.isDestroyed() ? evaluate('globalThis.activityProof?.dispose()') : undefined],
    ['foreign-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()],
    ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()], ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }] ] as const) {
    stage('cleanup ' + owner)
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
