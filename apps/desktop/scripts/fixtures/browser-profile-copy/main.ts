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

const out = process.env.AGENTMUX_COPY_OUT!, assets = process.env.AGENTMUX_COPY_ASSETS!, home = process.env.AGENTMUX_COPY_HOME!
const urls = JSON.parse(process.env.AGENTMUX_COPY_URLS!) as { page: string }, phase = process.env.AGENTMUX_COPY_PHASE!
const receipt: any = { passed: false, phase, cases: [], images: [], calls: [], cleanup: [], runtimeConnections: 0, versions: process.versions }
const stage = (value: string) => console.log('Profile copy proof: ' + value)
let win: BrowserWindow | undefined, outsider: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, manager: BrowserViewManager | undefined
const evaluate = (code: string) => win!.webContents.executeJavaScript(code)
const pause = () => new Promise(done => setTimeout(done, 60))
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 25)) }
  throw new Error('Private Profile copy observation expired: ' + label)
}
const nativePage = (id = 'original') => (manager as any).entries.get(id)?.view.webContents as Electron.WebContents
async function loaded(id: string) { const page = nativePage(id); await until(() => page && !page.isLoading() && page.getURL().startsWith('http:'), 'loaded exact native page ' + id); return page }
async function cli(args: string[]) {
  const result = await promisify(execFile)(process.env.AGENTMUX_COPY_NODE!, [process.env.AGENTMUX_COPY_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], {
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
  if (process.env.AGENTMUX_COPY_CAPTURE !== '1') return
  win!.setContentSize(width, height); await evaluate(`copyProof.theme(${JSON.stringify(theme)})`); await pause()
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
    const call = ['browser:copyProfile', 'browser:updateProfile', 'browser:create'].includes(channel) ? { channel, args, completed: false,
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
  config.workspaces = [{ id: 'copy-workspace', name: 'Private Profile copy', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
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
  await win.loadFile(html); await until(() => evaluate('Boolean(globalThis.copyProof)'), 'production Renderer entry')
  stage('actual Renderer ready')

  const previous = phase === 'restart' ? JSON.parse(await readFile(join(home, 'copy-identities.json'), 'utf8')) : null
  const original = await evaluate(`copyProof.setup(${JSON.stringify(config)},${JSON.stringify(urls.page)},${JSON.stringify(previous?.sourceId)})`)
  const sourceId = original.profileId, page = await loaded('original'), sourceContentsId = page.id
  const profiles = (manager as any).profiles as import('../../../src/main/browser-profile-manager').BrowserProfileManager
  win.webContents.debugger.attach('1.3')
  if (previous) {
    assert.equal(sourceId, previous.sourceId)
    const list = await cli(['browser', 'profile', 'ls'])
    for (const id of [previous.sourceId, previous.cliId, previous.guiId]) assert.ok(list.profiles.some((value: any) => value.id === id), 'Original saved Profile identities survive a real process restart')
    assert.ok((await page.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in' && value.value === 'original'))
    await manager!.create(previous.cliBrowserId, urls.page, 'copy-workspace', previous.cliId)
    const copied = await loaded(previous.cliBrowserId)
    assert.equal(await copied.executeJavaScript('navigator.userAgent'), 'CopySource/1.0')
    assert.equal(await copied.executeJavaScript('localStorage.getItem("source-only")'), null)
    assert.ok((await copied.session.cookies.get({ url: urls.page })).some(value => value.name === 'copy-only'))
    assert.ok(!(await copied.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in'))
    receipt.cases.push('same-profile-configuration-and-independent-storage-native-restart')
  } else {
    await evaluate(`copyProof.update(${JSON.stringify(sourceId)},{label:'Original settings',hue:270,notes:'Saved purpose',network:{mode:'direct'},environment:{userAgent:'CopySource/1.0',acceptLanguages:['fr-FR']},agentAccess:false})`)
    await page.executeJavaScript(`document.getElementById('draft').value='Keep this original page draft';document.cookie='source-sign-in=original; Max-Age=3600; Path=/';localStorage.setItem('source-only','keep original')`)
    await page.session.cookies.flushStore(); page.session.flushStorageData()
    const sourceUa = await page.executeJavaScript('navigator.userAgent')
    const file = join(app.getPath('userData'), 'browser-profiles.json'), authFile = join(app.getPath('userData'), 'browser-profile-proxy-auth.json')
    const sourceRecord = JSON.parse(await readFile(file, 'utf8')).profiles.find((value: any) => value.id === sourceId)
    // The credential owner is separate from configuration. This opaque fixture envelope is never
    // decrypted or offered to a proxy; only its original username mapping is observed.
    const credentialBytes = JSON.stringify({ version: 1, profiles: { [sourceId]: { username: 'original-user', password: Buffer.from('opaque fixture envelope').toString('base64') } } })
    await writeFile(authFile, credentialBytes)
    receipt.credentialBoundary = 'Opaque external credential-file sentinel is byte-preserved; no native keychain or proxy-authentication claim.'
    const listed = await cli(['browser', 'profile', 'ls'])
    const copied = await cli(['browser', 'profile', 'copy', '--profile', sourceId, '--expected-revision', listed.profiles.find((value: any) => value.id === sourceId).revision, '--label', 'CLI configuration copy'])
    assert.equal(copied.sourceProfileId, sourceId); assert.notEqual(copied.profile.id, sourceId)
    const cliId = copied.profile.id
    assert.equal(copied.profile.agentAccess, false); assert.equal(copied.profile.source, null)
    assert.equal(copied.profile.environmentApplication, undefined, 'Copy result never inherits a native application receipt')
    assert.equal(await evaluate(`copyProof.username(${JSON.stringify(cliId)})`), null)
    assert.equal(await readFile(authFile, 'utf8'), credentialBytes)
    const pendingApplication = (await cli(['browser', 'profile', 'inspect', '--profile', cliId])).profile.environmentApplication
    if (pendingApplication) assert.equal(pendingApplication.status, 'not-applied')
    receipt.cases.push('compiled-public-cli-copy')
    await evaluate('copyProof.persist()')
    const opened = await cli(['browser', 'open', '--url', urls.page, '--profile', cliId, '--right-of', 'original'])
    const cliBrowserId = opened.region.browserId, copyPage = await loaded(cliBrowserId)
    assert.ok(await copyPage.executeJavaScript('navigator.userAgent') === 'CopySource/1.0', 'Copied native page applies the saved source UA')
    assert.ok(!(await copyPage.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in'))
    assert.equal(await copyPage.executeJavaScript('localStorage.getItem("source-only")'), null)
    await copyPage.executeJavaScript(`document.cookie='copy-only=independent; Max-Age=3600; Path=/'`)
    await copyPage.session.cookies.flushStore(); copyPage.session.flushStorageData()
    const revision = (await cli(['browser', 'profile', 'inspect', '--profile', cliId])).profile.revision
    await cli(['browser', 'profile', 'update', '--profile', cliId, '--expected-revision', String(revision), '--notes', 'Only this copy changed'])
    assert.equal(profiles.listProfiles().find(value => value.id === sourceId)!.notes, 'Saved purpose')
    receipt.cases.push('public-open-edit-and-native-empty-independent-partition')
    stage('public copy, exact open, independent native storage and editing confirmed')

    await until(() => evaluate(`copyProof.facts().editor==='Original settings'`), 'actual Settings original Profile editor')
    await click(`[...document.querySelectorAll('[role="radio"]')].find(e=>e.textContent.trim()==='Proxy')`)
    await input(`document.querySelector('input[aria-label="Proxy server"]')`, 'unsubmitted-gateway.example:8080')
    await click(`document.querySelector('button[aria-label="More for Original settings"]')`)
    await until(() => evaluate(`Boolean(${textButton('Copy settings')})`), 'actual Settings copy menu')
    await capture('copy-menu-wide-dark', 1100, 780, 'dark')
    await capture('copy-menu-narrow-light', 520, 820, 'light')
    win.setContentSize(1100, 780); await pause()
    await click(textButton('Copy settings'))
    await until(() => evaluate(`Boolean(copyProof.facts().notice?.includes('Copied saved settings'))`), 'actual copy IPC result unwrapped into Settings notice')
    assert.equal((await evaluate('copyProof.facts()')).editor, 'Original settings')
    assert.equal((await evaluate('copyProof.facts()')).proxyDraft, 'unsubmitted-gateway.example:8080', 'Copy preserves the mounted original editor draft')
    const guiCall = receipt.calls.find((value: any) => value.channel === 'browser:copyProfile' && value.completed)
    assert.ok(guiCall?.exactSender && guiCall.exactFrame)
    assert.equal(guiCall.args[0], sourceId)
    const guiId = profiles.listProfiles().find(value => value.label === 'Original settings copy')!.id
    assert.notEqual(guiId, sourceId); assert.notEqual(guiId, cliId)
    assert.deepEqual(profiles.listProfiles().find(value => value.id === guiId)!.network, { mode: 'direct' }, 'GUI copy uses saved route rather than the unsaved editor draft')
    await capture('copy-notice-wide-light')
    await capture('copy-notice-narrow-dark', 520, 820, 'dark')
    win.setContentSize(1100, 780); await pause()
    await click(textButton('Edit copy'))
    await until(() => evaluate(`Boolean(document.querySelector('input[aria-label="Profile name"]'))`), 'explicit Edit copy reaches original Profile editor')
    await input(`document.querySelector('input[aria-label="Profile name"]')`, 'GUI renamed copy')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await until(() => profiles.listProfiles().find(value => value.id === guiId)?.label === 'GUI renamed copy', 'actual Settings rename persists only copied identity')
    await capture('copied-profile-editor')
    const beforeOpen = new Set(manager!.targets().map(value => value.id))
    await click(textButton('Open Browser'))
    const guiTarget = await until(() => manager!.targets().find(value => !beforeOpen.has(value.id) && value.profile?.id === guiId), 'actual Settings Open Browser creates the copied Profile page')
    await evaluate(`globalThis.agentmux.browser.navigate(${JSON.stringify(guiTarget.id)},${JSON.stringify(urls.page)})`)
    const guiPage = await loaded(guiTarget.id)
    assert.equal(await guiPage.executeJavaScript('navigator.userAgent'), 'CopySource/1.0')
    assert.ok(!(await guiPage.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in'))
    receipt.cases.push('actual-settings-copy-draft-preservation-edit-open')
    assert.equal(page.id, sourceContentsId)
    assert.equal(await page.executeJavaScript('document.getElementById("draft").value'), 'Keep this original page draft')
    assert.equal(await page.executeJavaScript('navigator.userAgent'), sourceUa)
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'), 'keep original')
    assert.ok((await page.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in' && value.value === 'original'))
    const { activity: _beforeActivity, ...sourceConfiguration } = sourceRecord
    const { activity: _afterActivity, ...currentConfiguration } = JSON.parse(await readFile(file, 'utf8')).profiles.find((value: any) => value.id === sourceId)
    assert.deepEqual(currentConfiguration, sourceConfiguration)
    assert.equal(await readFile(authFile, 'utf8'), credentialBytes)
    assert.equal((await evaluate('copyProof.facts()')).sibling, 'Keep this sibling draft')
    receipt.identity = { sourceId, cliId, guiId, cliBrowserId }
    await writeFile(join(home, 'copy-identities.json'), JSON.stringify(receipt.identity))
    await evaluate('copyProof.persist()')
    receipt.cases.push('source-native-page-configuration-and-durable-credential-owner-kept')
  }
  assert.equal(receipt.runtimeConnections, 0)
  receipt.passed = true

}).catch(error => { console.error('Profile copy proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets() }).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', () => win && !win.isDestroyed() ? evaluate('globalThis.copyProof?.dispose()') : undefined],
    ['foreign-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()],
    ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()], ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }] ] as const) {
    stage('cleanup ' + owner)
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
