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

const out = process.env.AGENTMUX_PERMISSION_OUT!, assets = process.env.AGENTMUX_PERMISSION_ASSETS!, home = process.env.AGENTMUX_PERMISSION_HOME!
const urls = JSON.parse(process.env.AGENTMUX_PERMISSION_URLS!) as { page: string; other: string; embed: string; control: string }
const phase = process.env.AGENTMUX_PERMISSION_PHASE!
const receipt: any = { passed: false, phase, cases: [], images: [], calls: [], native: [], cleanup: [], runtimeConnections: 0, versions: process.versions }
const stage = (value: string) => console.log('Permission proof: ' + value)
let win: BrowserWindow | undefined, outsider: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, manager: BrowserViewManager | undefined
const evaluate = (code: string) => win!.webContents.executeJavaScript(code)
const pending = (id = 'original') => manager!.target(id)?.sitePermissions?.requests[0]
const permissionFile = () => join(app.getPath('userData'), 'browser-site-permissions.json')
const settle = () => new Promise(done => setTimeout(done, 60))
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 25)) }
  throw new Error('Private permission observation expired: ' + label)
}
const nativePage = (id = 'original') => (manager as any).entries.get(id)?.view.webContents as Electron.WebContents
async function loaded(id = 'original') { const page = nativePage(id); await until(() => !page.isLoading() && page.getURL().startsWith('http:'), 'original loaded page'); return page }
async function ask(kind: 'camera' | 'notifications', id = 'original') {
  const page = await loaded(id)
  await page.executeJavaScript(`void window.ask${kind === 'camera' ? 'Camera' : 'Notifications'}();'native request started'`, true)
}
async function capture(name: string) {
  if (process.env.AGENTMUX_PERMISSION_CAPTURE !== '1') return
  const bytes = (await win!.webContents.capturePage()).toPNG(); await writeFile(join(out, name + '.png'), bytes)
  receipt.images.push({ name, file: name + '.png', sha256: createHash('sha256').update(bytes).digest('hex') })
}
async function click(code: string) {
  // ResizeObserver -> bounds IPC is asynchronous. Await its actual native receipt before input.
  const point = await until(async () => {
    const point = await evaluate(`(()=>{const e=${code};if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
    if (!point?.hit) return null
    const bounds = manager!.nativeOwner('original')?.bounds
    return bounds && point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height ? null : { ...point, nativeBounds: bounds }
  }, 'trusted permission control outside actual native page bounds')
  receipt.input ??= []; receipt.input.push(point)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y,
    ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
  await settle()
}
const button = (text: string) => `[...document.querySelectorAll('aside[aria-label="Site permissions"] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`
async function answerVisible(allow: boolean, remember = false) {
  await until(() => evaluate('permissionProof.facts().requests.length'), 'actual BrowserPane permission request')
  if (remember) await click(`document.querySelector('aside[aria-label="Site permissions"] input[type="checkbox"]')`)
  await click(button(allow ? remember ? 'Allow' : 'Allow once' : remember ? 'Block' : 'Block once'))
}
async function trustedAnswer(id: string, request: NonNullable<ReturnType<typeof pending>>, allow: boolean, remember = false) {
  return evaluate(`globalThis.agentmux.browser.answerSitePermission(${JSON.stringify(id)},${JSON.stringify({ requestId: request.requestId, navigationId: request.navigationId, allow, remember })})`)
}
async function navigate(url: string) { await evaluate(`permissionProof.navigate(${JSON.stringify(url)})`); await loaded() }
async function control(mode: string) { await fetch(urls.control + '?mode=' + mode) }
let releaseWrite: (() => void) | undefined, writing = false, armWrite = false
Object.assign(globalThis, { __permissionBeforeWrite: async () => {
  if (!armWrite) return
  armWrite = false; writing = true
  await new Promise<void>(done => { releaseWrite = done })
} })
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  stage('private App owners starting')
  app.setActivationPolicy?.('prohibited')
  await mkdir(join(home, 'workspace'), { recursive: true })
  stage('private workspace ready')
  const instrumented = new WeakSet<Electron.Session>(), originalPartition = session.fromPartition.bind(session)
  session.fromPartition = ((...args: Parameters<typeof session.fromPartition>) => {
    const target = originalPartition(...args)
    if (!instrumented.has(target)) {
      instrumented.add(target)
      const install = target.setPermissionRequestHandler.bind(target)
      target.setPermissionRequestHandler = handler => install(handler && ((contents, permission, callback, details) => {
        const row: any = { contentsId: contents.id, permission, details, answers: [], candidate: [...((manager as any)?.entries.values() ?? [])].some((entry: any) => entry.pendingSwitch?.contents === contents) }
        receipt.native.push(row)
        handler(contents, permission, allow => { row.answers.push(allow); callback(allow) }, details)
      }))
    }
    return target
  }) as typeof session.fromPartition
  win = new BrowserWindow({ width: 1100, height: 780, show: false, webPreferences: {
    preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const html = join(assets, 'renderer/index.html'), guard = topFrameNavigationGuard(topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: html }))
  win.webContents.on('will-navigate', guard); win.webContents.on('will-redirect', guard)
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => originalHandle(channel, (event, ...args) => {
    const call = channel.startsWith('browser:') && channel.includes('SitePermission') ? { channel, args, completed: false,
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
  config.workspaces = [{ id: 'permission-workspace', name: 'Private permissions', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
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
  await win.loadFile(html); await until(() => evaluate('Boolean(globalThis.permissionProof)'), 'production Renderer entry')
  stage('actual Renderer ready')
  const original = await evaluate(`permissionProof.setup(${JSON.stringify(config)},${JSON.stringify(urls.page)})`)
  await until(() => manager!.nativeOwner('original'), 'original native presentation'); const page = await loaded(), contentsId = page.id
  win.webContents.debugger.attach('1.3')
  if (phase === 'restart') {
    const previous = JSON.parse(await readFile(join(home, 'original.json'), 'utf8'))
    assert.equal(original.profileId, previous.profileId, 'Original durable Profile is reused after real process restart')
    await ask('notifications')
    await until(async () => await page.executeJavaScript('window.note') === 'granted', 'original remembered policy after process restart')
    assert.equal(pending(), undefined)
    assert.ok(manager!.target('original')!.sitePermissions?.decisions.some(value => value.permission === 'notifications' && value.scope === 'profile' && value.allow))
    receipt.cases.push('same-file-profile-policy-native-restart')
  } else {
    await ask('notifications'); const first = await until(() => pending(), 'original native notification request')
    await until(() => evaluate('permissionProof.facts().requests.length'), 'actual permission request Renderer')
    assert.equal(first.origin, new URL(urls.page).origin)
    for (const field of ['requestId', 'navigationId'] as const) await assert.rejects(manager!.answerSitePermission('original', { ...first, [field]: 'foreign', allow: true, remember: false }), /no longer belongs/)
    await assert.rejects(manager!.answerSitePermission('foreign-browser', { ...first, allow: true, remember: false }))
    await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='Allow once').click()`)
    await settle(); assert.equal(pending()?.requestId, first.requestId, 'Synthetic permission clicks cannot approve the native request')
    outsider = new BrowserWindow({ show: false, webPreferences: { preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true } })
    await outsider.loadURL('data:text/html,<title>Foreign permission sender</title>')
    await assert.rejects(outsider.webContents.executeJavaScript(`globalThis.agentmux.browser.answerSitePermission('original',${JSON.stringify({ ...first, allow: true, remember: false })})`), /Untrusted/)
    outsider.destroy(); outsider = undefined
    const cli = await promisify(execFile)(process.env.AGENTMUX_PERMISSION_NODE!, [process.env.AGENTMUX_PERMISSION_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), 'browser', 'targets'], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY'].includes(key))) })
    const publicTarget = JSON.parse(cli.stdout).result.targets.find((value: any) => value.id === 'original')
    assert.equal(publicTarget.sitePermissions.requests[0].requestId, first.requestId, 'Compiled public CLI retains read-only native permission facts')
    assert.equal(pending()?.requestId, first.requestId)
    if (process.env.AGENTMUX_PERMISSION_CAPTURE === '1') for (const shape of [
      { name: 'wide-light', width: 1100, height: 780, theme: 'light' }, { name: 'wide-dark', width: 1100, height: 780, theme: 'dark' },
      { name: 'narrow-light', width: 430, height: 820, theme: 'light' }, { name: 'narrow-dark', width: 430, height: 820, theme: 'dark' }
    ]) {
      win.setContentSize(shape.width, shape.height); await evaluate(`permissionProof.theme(${JSON.stringify(shape.theme)})`); await settle()
      const bytes = (await win.webContents.capturePage()).toPNG(); await writeFile(join(out, shape.name + '.png'), bytes)
      receipt.images.push({ ...shape, file: shape.name + '.png', sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    win.setContentSize(1100, 780); await evaluate('permissionProof.theme("light")'); await settle()
    await answerVisible(true); await until(async () => await page.executeJavaScript('window.note') === 'granted', 'trusted App Allow once reaches original native callback')
    assert.equal(page.id, contentsId); receipt.cases.push('notification-native-sender-nonce-public-gui')
    stage('original notification callback and trusted App UI confirmed')

    await ask('camera'); const cameraRequest = await until(() => { const value = pending(); return value?.permissions.includes('camera') ? value : undefined }, 'original native media request')
    armWrite = true
    await answerVisible(true, true); await until(() => writing, 'remember native write is held after enqueue')
    await until(async () => await page.executeJavaScript('window.camera') === 'allowed', 'native camera delivered before optional persistence')
    await click(`document.querySelector('aside[aria-label="Site permissions"] summary')`)
    await capture('decisions-before-forget')
    await click(`[...document.querySelectorAll('aside[aria-label="Site permissions"] details p')].find(e=>e.textContent.includes(' · camera ·')).querySelector('button')`)
    assert.equal(await page.executeJavaScript('window.stream.active'), true, 'Forget cannot withdraw delivered native media access')
    releaseWrite!(); releaseWrite = undefined
    await until(() => receipt.calls.some((row: any) => row.channel === 'browser:answerSitePermission' && row.args[1].requestId === cameraRequest.requestId && row.completed), 'earlier Remember write confirms through actual IPC')
    await until(() => receipt.calls.some((row: any) => row.channel === 'browser:forgetSitePermission' && row.args[1].permission === 'camera' && row.completed), 'later Forget confirms through actual IPC')
    assert.equal(JSON.parse(await readFile(permissionFile(), 'utf8')).policies.some((value: any) => value.permission === 'camera'), false, 'Later Forget must remove the earlier remembered policy')
    await until(async () => !(await evaluate('permissionProof.facts().description')).includes('camera · Allowed'), 'original permission UI forget receipt')
    assert.equal(await page.executeJavaScript('window.stream.active'), true)
    receipt.cases.push('media-native-and-remember-forget-write-order')
    stage('native media and late write/Forget confirmed')

    await navigate(urls.page)
    await ask('camera'); const heldOriginal = await until(() => pending(), 'original pending before failed Profile switch')
    const separate = await evaluate(`globalThis.agentmux.browser.createProfile('Independent permissions').then(r=>{if(!r.ok)throw new Error(r.error.message);return r.value})`)
    await control('fail-next')
    await assert.rejects(manager!.switchProfile('original', separate.id))
    assert.equal(nativePage(), page, 'Failed candidate keeps the original native page')
    assert.equal(pending()?.requestId, heldOriginal.requestId, 'Failed Profile switch preserves the original pending permission')
    await answerVisible(true); await until(async () => await page.executeJavaScript('window.camera') === 'allowed', 'retained original Allow once')
    await control('hold-next')
    const superseded = manager!.switchProfile('original', separate.id).catch(error => error as Error)
    await until(() => (manager as any).entries.get('original').pendingSwitch?.contents.getURL().startsWith('http:'), 'held candidate')
    const retiringCandidate = (manager as any).entries.get('original').pendingSwitch.contents as Electron.WebContents
    try { await manager!.switchProfile('original', original.profileId) }
    catch (error) {
      // Native close is asynchronous on some Chromium builds. Keep its original receipt,
      // prove the old page stays usable, then explicitly retry after real destruction.
      assert.match((error as Error).message, /candidate cleanup/)
      assert.equal(nativePage(), page)
      assert.ok(manager!.target('original')!.sitePermissions?.decisions.some(value => value.permission === 'camera' && value.scope === 'document' && value.allow))
      await until(() => retiringCandidate.isDestroyed(), 'superseded candidate native destruction')
      receipt.candidateCleanup = { message: (error as Error).message, nativeDestroyed: true }
      await manager!.switchProfile('original', original.profileId)
    }
    await superseded; await control('release')
    assert.ok(manager!.target('original')!.sitePermissions?.decisions.some(value => value.permission === 'camera' && value.scope === 'document' && value.allow), 'Superseded switch preserves original Allow once')
    receipt.cases.push('failed-and-superseded-switch-preserve-original')
    stage('failed and superseded Profile candidates confirmed')

    await control('candidate')
    const switching = manager!.switchProfile('original', separate.id)
    const candidate = await until(() => receipt.native.find((value: any) => value.candidate && value.permission === 'media'), 'real precommit candidate media request')
    assert.deepEqual(candidate.answers, [], 'A prepared Profile candidate must retain its native request instead of silently denying it')
    assert.equal(pending(), undefined, 'Candidate request is not exposed as the old document')
    await control('release'); await switching; const committed = await until(() => pending(), 'candidate permission is published at exact commit')
    assert.equal(committed.profileId, separate.id)
    assert.equal(committed.navigationId, manager!.target('original')!.navigationId)
    await answerVisible(true); await until(async () => await nativePage().executeJavaScript('window.camera') === 'allowed', 'committed candidate callback reaches its original fake native source')
    receipt.cases.push('precommit-candidate-callback-retained-and-committed')
    stage('precommit native candidate callback confirmed')

    await navigate(urls.embed)
    await nativePage().executeJavaScript(`document.querySelector('iframe').contentWindow.postMessage('camera','*');'asked'`)
    const embedded = await until(() => pending(), 'native embedded media request')
    assert.equal(embedded.origin, new URL(urls.other).origin, 'Native media securityOrigin owns the request origin')
    assert.equal(embedded.embeddingOrigin, new URL(urls.page).origin)
    await answerVisible(false); receipt.cases.push('embedded-native-security-origin')

    await navigate(urls.page)
    await nativePage().executeJavaScript(`const frame=document.createElement('iframe');document.body.appendChild(frame);void frame.contentWindow.navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{window.blankMedia='allowed';stream.getTracks().forEach(track=>track.stop())},error=>window.blankMedia=error.name);'requested from inherited native origin'`)
    const inherited = await until(() => pending(), 'native inherited-origin media request')
    assert.equal(inherited.origin, new URL(urls.page).origin, 'Native securityOrigin owns inherited-origin media, even when requestingUrl is opaque')
    const inheritedNative = receipt.native.filter((value: any) => value.permission === 'media').at(-1)
    receipt.inheritedMedia = { request: inherited, native: inheritedNative }
    await answerVisible(false); receipt.cases.push('inherited-native-media-origin')

    await navigate(urls.page); await ask('notifications'); const stale = await until(() => pending(), 'native request before document change')
    await navigate(urls.other)
    await assert.rejects(manager!.answerSitePermission('original', { ...stale, allow: true, remember: false }), /no longer belongs/)
    await ask('notifications'); const beforeHash = await until(() => pending(), 'native request before same-document navigation')
    await nativePage().executeJavaScript(`history.pushState({},'', '#same-document')`)
    const afterHash = await until(() => { const value = pending(); return value && value.navigationId !== beforeHash.navigationId ? value : null }, 'same-document native fence rebind')
    assert.equal(afterHash.requestId, beforeHash.requestId)
    await assert.rejects(manager!.answerSitePermission('original', { ...beforeHash, allow: true, remember: false }), /no longer belongs/)
    await answerVisible(false); receipt.cases.push('document-and-same-document-native-fences')

    await manager!.create('retired', urls.page, 'permission-workspace', separate.id); const retired = await loaded('retired')
    await ask('notifications', 'retired'); await until(() => pending('retired'), 'old incarnation native request')
    const owner = manager!.sitePermissions!, originalCancel = owner.cancel.bind(owner)
    let lateCancel: (() => void) | undefined
    owner.cancel = (id, source) => { if (source === retired) { lateCancel = () => originalCancel(id, source); return } originalCancel(id, source) }
    retired.close(); await until(() => retired.isDestroyed(), 'original native owner actually destroyed')
    await manager!.restore('retired'); await loaded('retired'); await ask('camera', 'retired')
    const fresh = await until(() => pending('retired'), 'new same-id native request')
    assert.ok(lateCancel, 'The original actual destroyed callback retains its native source')
    lateCancel(); owner.cancel = originalCancel
    assert.equal(pending('retired')?.requestId, fresh.requestId, 'Retired native owner cancellation preserves the new same-id request')
    await trustedAnswer('retired', fresh, true)
    await until(async () => await nativePage('retired').executeJavaScript('window.camera') === 'allowed', 'new native owner remains usable')
    receipt.cases.push('late-real-native-owner-destruction-fenced')

    await navigate(urls.page); await ask('notifications'); await until(() => pending(), 'native permission before storage failure')
    const originalBytes = 'original unknown site-permission bytes'; await writeFile(permissionFile(), originalBytes)
    await evaluate(`globalThis.agentmux.browser.retrySitePermissions('original')`)
    await answerVisible(true, true)
    await until(async () => await nativePage().executeJavaScript('window.note') === 'granted', 'storage failure keeps delivered native approval')
    assert.equal(await readFile(permissionFile(), 'utf8'), originalBytes)
    assert.ok(manager!.target('original')!.sitePermissions?.warning?.includes('unconfirmed'))
    await until(async () => (await evaluate('permissionProof.facts().description')).includes('Remembering the Profile decision is unconfirmed'), 'actual App storage service window')
    await capture('unknown-saved-permissions')
    receipt.cases.push('unreadable-original-bytes-current-native-approval-preserved')
    await writeFile(permissionFile(), JSON.stringify({ version: 1, policies: [] })); await evaluate(`globalThis.agentmux.browser.retrySitePermissions('original')`)
    await manager!.switchProfile('original', original.profileId); await loaded()
    await ask('notifications'); await until(() => pending(), 'original Profile final durable permission')
    await answerVisible(true, true); await until(async () => JSON.parse(await readFile(permissionFile(), 'utf8')).policies.some((value: any) => value.profileId === original.profileId && value.permission === 'notifications'), 'final Profile policy persisted')
    await writeFile(join(home, 'original.json'), JSON.stringify({ profileId: original.profileId }))
    receipt.descriptor = await evaluate('permissionProof.persistDescriptor()')
    assert.equal((await evaluate('permissionProof.facts()')).sibling, 'Keep this sibling draft')
    receipt.cases.push('original-durable-profile-policy-saved')
  }
  assert.equal(receipt.runtimeConnections, 0)
  receipt.passed = true
}).catch(error => { console.error('Permission proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets() }).finally(async () => {
  releaseWrite?.()
  for (const [owner, cleanup] of [ ['renderer', () => win && !win.isDestroyed() ? evaluate('globalThis.permissionProof?.dispose()') : undefined],
    ['foreign-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()],
    ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()], ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }] ] as const) {
    stage('cleanup ' + owner)
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
