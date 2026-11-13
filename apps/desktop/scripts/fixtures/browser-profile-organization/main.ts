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

const out = process.env.AGENTMUX_ORG_OUT!, assets = process.env.AGENTMUX_ORG_ASSETS!, home = process.env.AGENTMUX_ORG_HOME!
const urls = JSON.parse(process.env.AGENTMUX_ORG_URLS!) as { page: string }, phase = process.env.AGENTMUX_ORG_PHASE!
const receipt: any = { passed: false, phase, cases: [], images: [], calls: [], cleanup: [], runtimeConnections: 0, versions: process.versions }
const stage = (value: string) => console.log('Profile organization proof: ' + value)
let win: BrowserWindow | undefined, outsider: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, manager: BrowserViewManager | undefined
const evaluate = (code: string) => win!.webContents.executeJavaScript(code)
const pause = () => new Promise(done => setTimeout(done, 60))
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 25)) }
  throw new Error('Private Profile organization observation expired: ' + label)
}
const nativePage = (id = 'original') => (manager as any).entries.get(id)?.view.webContents as Electron.WebContents
async function key(key: string, code: string, windowsVirtualKeyCode: number) {
  for (const type of ['keyDown', 'keyUp']) await win!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
  await pause()
}
async function loaded(id: string) { const page = nativePage(id); await until(() => page && !page.isLoading() && page.getURL().startsWith('http:'), 'loaded exact native page ' + id); return page }
async function cli(args: string[]) {
  const result = await promisify(execFile)(process.env.AGENTMUX_ORG_NODE!, [process.env.AGENTMUX_ORG_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], {
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
  if (process.env.AGENTMUX_ORG_CAPTURE !== '1') return
  win!.setContentSize(width, height); await evaluate(`organizationProof.theme(${JSON.stringify(theme)})`); await pause()
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
  config.workspaces = [{ id: 'organization-workspace', name: 'Private Profile organization', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
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
  await win.loadFile(html); await until(() => evaluate('Boolean(globalThis.organizationProof)'), 'production Renderer entry')
  stage('actual Renderer ready')

  const previous = phase === 'restart' ? JSON.parse(await readFile(join(home, 'organization-identities.json'), 'utf8')) : null
  const original = await evaluate(`organizationProof.setup(${JSON.stringify(config)},${JSON.stringify(urls.page)},${JSON.stringify(previous?.sourceId)})`)
  const sourceId = original.profileId, page = await loaded('original'), sourceContentsId = page.id
  const profiles = (manager as any).profiles as import('../../../src/main/browser-profile-manager').BrowserProfileManager
  win.webContents.debugger.attach('1.3')
  if (previous) {
    const list = await cli(['browser', 'profile', 'ls'])
    assert.equal(sourceId, previous.sourceId)
    assert.deepEqual(list.folders, previous.folders, 'Empty directories and their exact IDs survive a real process restart')
    for (const saved of previous.profiles) {
      const current = list.profiles.find((value: any) => value.id === saved.id)
      for (const field of ['label', 'tags', 'folderId', 'pinned', 'notes']) assert.deepEqual(current[field], saved[field])
    }
    assert.ok((await page.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in' && value.value === 'original'))
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'), 'keep original')
    await manager!.create('restarted-copy', urls.page, 'organization-workspace', previous.copyId)
    const copied = await loaded('restarted-copy')
    assert.ok(!(await copied.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in'))
    receipt.cases.push('original-identities-catalog-empty-folder-tags-pins-and-native-storage-real-restart')
  } else {
    await evaluate(`organizationProof.update(${JSON.stringify(sourceId)},{label:'Original settings',notes:'Saved purpose',network:{mode:'direct'}})`)
    await page.executeJavaScript(`document.getElementById('draft').value='Keep this original page draft';document.cookie='source-sign-in=original; Max-Age=3600; Path=/';localStorage.setItem('source-only','keep original')`)
    await page.session.cookies.flushStore(); page.session.flushStorageData()
    const other = await cli(['browser', 'profile', 'create', '--label', 'Other Profile'])
    const list = () => cli(['browser', 'profile', 'ls'])
    const revision = async () => String((await list()).revision)
    const edit = async (id: string, flags: string[]) => cli(['browser', 'profile', 'update', '--profile', id, '--expected-revision', (await list()).profiles.find((value: any) => value.id === id).revision, ...flags])
    const folder = (await cli(['browser', 'profile', 'folder', 'create', '--label', 'CLI research', '--expected-revision', await revision()])).folder
    const empty = (await cli(['browser', 'profile', 'folder', 'create', '--label', 'Empty saved folder', '--expected-revision', await revision()])).folder
    await edit(sourceId, ['--tags', '[" Research ","Research","café"]', '--folder', folder.id, '--pin'])
    assert.deepEqual((await list()).profiles.find((value: any) => value.id === sourceId).tags, ['Research', 'café'])
    receipt.cases.push('actual-compiled-cli-folder-catalog-tags-assignment-pinning')
    await until(() => evaluate(`organizationProof.facts().folder===${JSON.stringify(folder.id)}`), 'original Settings organization projection')
    await click(`document.querySelector('button[aria-label="Manage folders"]')`)
    await click(textButton('New folder…'))
    await input(`document.querySelector('input[aria-label="New folder name"]')`, 'GUI folder')
    await capture('organization-new-folder-narrow-dark', 520, 820, 'dark')
    win.setContentSize(1100, 780); await pause()
    await click(textButton('Create folder'))
    const guiFolder = await until(() => profiles.listFolders().find(value => value.label === 'GUI folder'), 'actual GUI create stored in original catalog')
    assert.equal(profiles.listProfiles().find(value => value.id === sourceId)!.folderId, folder.id, 'Creating a directory never silently reassigns a Profile')
    // Focusing the DOM control avoids the OS popup, which is outside CDP's input surface.
    // macOS native selects use character search; CDP arrow keys only open an OS-owned popup.
    // The character dispatch generates a trusted native change and the original React/IPC consumer.
    await evaluate(`document.querySelector('select[aria-label="Profile folder"]').focus()`)
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'g' })
    await until(() => profiles.listProfiles().find(value => value.id === sourceId)?.folderId === guiFolder.id, 'actual GUI folder selection')
    await input(`document.querySelector('input[aria-label="New Profile tag"]')`, ' UI ')
    await click(textButton('Add tag'))
    await until(() => profiles.listProfiles().find(value => value.id === sourceId)?.tags?.includes('UI'), 'actual GUI canonical tag')
    await click(`document.querySelector('.browser-profile-organization__pin input')`)
    await until(() => !profiles.listProfiles().find(value => value.id === sourceId)?.pinned, 'actual GUI unpin')

    await click(`document.querySelector('button[aria-label="Manage folders"]')`)
    await click(textButton('GUI folder'))
    await capture('organization-folder-menu-wide-light')
    await click(textButton('Rename folder…'))
    await input(`document.querySelector('input[aria-label="Rename folder"]')`, 'Renamed GUI folder')
    await click(textButton('Rename'))
    await until(() => profiles.listFolders().find(value => value.id === guiFolder.id)?.label === 'Renamed GUI folder', 'GUI rename keeps exact folder ID')
    assert.equal(profiles.listProfiles().find(value => value.id === sourceId)!.folderId, guiFolder.id)
    receipt.cases.push('trusted-app-folder-create-assign-stable-rename-tags-and-unpin')

    await input(`document.querySelector('input[aria-label="Filter profiles"]')`, 'Original')
    await click(`document.querySelector('.browser-profile-editor__name')`)
    await input(`document.querySelector('input[aria-label="Profile name"]')`, 'Keep my unfinished name')
    await edit(other.profile.id, ['--pin'])
    await edit(sourceId, ['--tags', '["Research","café","UI","Background change"]'])
    let facts = await evaluate('organizationProof.facts()')
    assert.equal(facts.nameDraft, 'Keep my unfinished name'); assert.equal(facts.query, 'Original'); assert.equal(facts.editor, 'Original settings')
    await key('Escape', 'Escape', 27)
    await click(`document.querySelector('.browser-profile-editor__note')`)
    await input(`document.querySelector('textarea[aria-label="Notes"]')`, 'Keep my unfinished note')
    await cli(['browser', 'profile', 'folder', 'rename', '--folder', folder.id, '--label', 'CLI renamed', '--expected-revision', await revision()])
    assert.equal((await evaluate('organizationProof.facts()')).notesDraft, 'Keep my unfinished note')
    await key('Escape', 'Escape', 27)
    await input(`document.querySelector('input[aria-label="Filter profiles"]')`, '')
    await until(() => evaluate(`organizationProof.facts().rowIds[0]===${JSON.stringify(other.profile.id)}`), 'pinned list reorder')
    assert.equal((await evaluate('organizationProof.facts()')).editor, 'Original settings', 'Reordering retains the exact selected Profile')
    await click(`[...document.querySelectorAll('[role="radio"]')].find(e=>e.textContent.trim()==='Proxy')`)
    await input(`document.querySelector('input[aria-label="Proxy server"]')`, 'unsubmitted-gateway.example:8080')
    await edit(sourceId, ['--pin'])
    assert.equal((await evaluate('organizationProof.facts()')).proxyDraft, 'unsubmitted-gateway.example:8080')
    assert.deepEqual(profiles.listProfiles().find(value => value.id === sourceId)!.network, { mode: 'direct' })
    receipt.cases.push('background-organization-keeps-query-selected-id-name-notes-proxy-drafts-and-pinned-reordering')

    const copied = await cli(['browser', 'profile', 'copy', '--profile', sourceId, '--label', 'Organized copy', '--expected-revision', (await list()).profiles.find((value: any) => value.id === sourceId).revision])
    assert.deepEqual(copied.profile.tags, profiles.listProfiles().find(value => value.id === sourceId)!.tags)
    assert.equal(copied.profile.folderId, guiFolder.id); assert.equal(copied.profile.pinned, undefined)
    await manager!.create('organized-copy', urls.page, 'organization-workspace', copied.profile.id)
    const copiedPage = await loaded('organized-copy')
    assert.equal(await copiedPage.executeJavaScript('localStorage.getItem("source-only")'), null)
    assert.ok(!(await copiedPage.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in'))
    receipt.cases.push('configuration-copy-retains-organization-without-pin-or-native-website-state')

    const file = join(app.getPath('userData'), 'browser-profiles.json'), saved = await readFile(file, 'utf8'), unknown = '{"version":'
    await writeFile(file, unknown)
    await input(`document.querySelector('input[aria-label="New Profile tag"]')`, 'Recovered tag')
    await click(textButton('Add tag'))
    await until(() => evaluate(`Boolean(document.querySelector('.browser-profile-editor__error'))`), 'original metadata failure remains visible')
    assert.equal(await readFile(file, 'utf8'), unknown, 'Unknown saved bytes are never replaced with an empty directory')
    assert.equal(await evaluate(`document.querySelector('input[aria-label="New Profile tag"]').value`), 'Recovered tag')
    assert.equal(page.id, sourceContentsId)
    assert.equal(await page.executeJavaScript('document.getElementById("draft").value'), 'Keep this original page draft')
    await writeFile(file, saved)
    await click(textButton('Add tag'))
    await until(() => profiles.listProfiles().find(value => value.id === sourceId)?.tags?.includes('Recovered tag'), 'retry through original owner after original bytes restored')
    receipt.cases.push('unknown-metadata-preserves-original-bytes-native-page-and-unsubmitted-tag-retry')

    await click(`document.querySelector('button[aria-label="Manage folders"]')`)
    await click(textButton('Renamed GUI folder'))
    await click(textButton('Delete folder'))
    await until(() => !profiles.listFolders().some(value => value.id === guiFolder.id), 'GUI folder deletion committed')
    const after = await list()
    assert.equal(after.profiles.length, 3, 'Folder deletion retains every original and copied Profile')
    for (const id of [sourceId, copied.profile.id]) assert.equal(after.profiles.find((value: any) => value.id === id).folderId, undefined)
    assert.ok(after.folders.some((value: any) => value.id === empty.id), 'Empty folder remains explicitly listed')
    assert.ok(receipt.calls.some((value: any) => value.channel === 'browser:deleteProfileFolder' && value.completed && value.exactSender && value.exactFrame && value.args[0] === guiFolder.id))
    await capture('organization-delete-keeps-profiles-wide-dark', 1100, 780, 'dark')
    await capture('organization-delete-keeps-profiles-narrow-light', 520, 820, 'light')
    await edit(sourceId, ['--folder', folder.id])
    assert.equal(page.id, sourceContentsId)
    assert.equal(await page.executeJavaScript('localStorage.getItem("source-only")'), 'keep original')
    assert.ok((await page.session.cookies.get({ url: urls.page })).some(value => value.name === 'source-sign-in' && value.value === 'original'))
    assert.equal((await evaluate('organizationProof.facts()')).sibling, 'Keep this sibling draft')
    const final = await list()
    receipt.identity = { sourceId, copyId: copied.profile.id, folders: final.folders, profiles: final.profiles }
    await writeFile(join(home, 'organization-identities.json'), JSON.stringify(receipt.identity))
    await evaluate('organizationProof.persist()')
    receipt.cases.push('actual-folder-delete-only-unassigns-keeps-profiles-native-pages-and-sibling-work')
  }
  assert.equal(receipt.runtimeConnections, 0)
  receipt.passed = true

}).catch(async error => {
  console.error('Profile organization proof failed', error); receipt.failure = { message: error.message, stack: error.stack }; receipt.targets = manager?.targets()
  try { receipt.renderer = await evaluate('organizationProof.facts()'); await capture('failure-observation') } catch { /* diagnostic only; never substitutes a business result */ }
}).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', () => win && !win.isDestroyed() ? evaluate('globalThis.organizationProof?.dispose()') : undefined],
    ['foreign-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()],
    ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()], ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }] ] as const) {
    stage('cleanup ' + owner)
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
