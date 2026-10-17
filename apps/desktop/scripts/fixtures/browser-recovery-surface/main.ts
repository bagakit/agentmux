import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { ContinuousProgressLoopStore } from '../../../src/main/continuous-progress-loop-store'
import { ContinuousProgressLoopManager } from '../../../src/main/continuous-progress-loop-manager'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { registerIpc } from '../../../src/main/ipc'
import { topFrameNavigationGuard, topFrameOrigin } from '../../../src/main/top-frame-navigation'

const out = process.env.AGENTMUX_RECOVERY_OUT!, assets = process.env.AGENTMUX_RECOVERY_ASSETS!, home = process.env.AGENTMUX_RECOVERY_HOME!
const receipt: any = { schema: 'agentmux.browser-recovery-surface.native.v1', passed: false, pid: process.pid,
  calls: [], cases: [], images: [], cleanup: [], runtimeConnections: 0, clipboardWrites: 0,
  boundary: 'Actual BrowserPane/Store/CSS, production sandbox preload, complete registerIpc and real BVM. Private HTTP failure and explicit same-identity recovery. Renderer capturePage PNGs only; no OS composition, physical input, installed app, ordinary restart, screenshot cache or clipboard-write qualification.' }
let win: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, pageServer: Server | undefined, siblingServer: Server | undefined
let manager: BrowserViewManager | undefined
const views = new Map<string, WebContentsView>()
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
async function until<T>(read: () => Promise<T | false> | T | false, name: string): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { const value = await read(); if (value !== false) return value; await delay(20) }
  throw new Error('Private recovery observation did not complete: ' + name)
}
const evaluate = (expression: string) => win!.webContents.executeJavaScript(expression)
const facts = () => evaluate('recoveryProof.facts()')
const settle = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
async function click(label: string, selector = 'button') {
  const point = await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>(e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)})&&e.getBoundingClientRect().width>0);if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
  assert.ok(point, 'The actual recovery control exists: ' + label)
  assert.equal(point.hit, true, 'The actual recovery control owns its Renderer hit: ' + label)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
    { type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
  await settle()
}
async function listen(server: Server, port = 0) {
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); done() }) })
  return (server.address() as { port: number }).port
}
async function close(server: Server | undefined) {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
}
const page = () => createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Field notes — original page</title><h1>Original research page</h1><p>The same Browser can reload after this local service returns.</p><input value="Original page draft">')
})

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  assert.equal(process.env.HOME, app.getPath('home'), 'Node and Electron share the private home')
  app.setActivationPolicy?.('accessory')
  await mkdir(join(home, 'workspace'), { recursive: true })
  pageServer = page(); const port = await listen(pageServer), url = `http://127.0.0.1:${port}/original`
  siblingServer = createServer((_request, response) => response.end('<!doctype html><title>Sibling page</title><h1>Unaffected page</h1><input value="Keep this native sibling draft">'))
  const siblingUrl = `http://127.0.0.1:${await listen(siblingServer)}/sibling`
  win = new BrowserWindow({ width: 1100, height: 740, show: false, webPreferences: {
    preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const html = join(assets, 'renderer/index.html')
  const guard = topFrameNavigationGuard(topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: html }))
  win.webContents.on('will-navigate', guard); win.webContents.on('will-redirect', guard)
  receipt.preloadErrors = []
  win.webContents.on('preload-error', (_event, path, error) => receipt.preloadErrors.push({ path, message: error.message }))
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => originalHandle(channel, (event, ...args) => {
    const row: any = { channel, args, exactSender: event.sender === win!.webContents, exactFrame: event.senderFrame === event.sender.mainFrame }
    if (channel.startsWith('browser:')) receipt.calls.push(row)
    if (channel === 'ui:writeClipboardText') receipt.clipboardWrites++
    try { return Promise.resolve(listener(event, ...args)).then(result => { row.result = result; row.finished = true; return result }, error => {
      row.error = String(error); row.finished = true; throw error
    }) } catch (error) { row.error = String(error); row.finished = true; throw error }
  })
  const originalCreate = BrowserViewManager.prototype.create
  BrowserViewManager.prototype.create = async function(...args) {
    manager = this
    const result = await originalCreate.apply(this, args)
    const view = (this as any).entries.get(args[0])?.view
    if (view) views.set(args[0], view)
    return result
  }
  const scratchTopics = new ScratchTopics()
  runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => {
    receipt.runtimeConnections++; throw new Error('Recovery presentation must not connect a Runtime')
  }, scratchTopics)
  runtime.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config = structuredClone(DEFAULT_CONFIG)
  config.workspaces = [{ id: 'recovery-workspace', name: 'Private recovery', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
  const configStore = new ConfigStore(join(home, 'config.json'))
  windows = new WorkbenchWindows(win, new WorkbenchWindowStore(join(home, 'windows.json')), () => [])
  access = createDesktopApplicationAccessOwner(runtime, join(home, 'applications.sqlite'))
  progress = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(home, 'progress.json')),
    async () => { throw new Error('No progress input is allowed') }, undefined, async () => { throw new Error('No Agent observation is allowed') })
  dispose = await registerIpc({ window: win, workbenchWindows: windows, runtime, configStore, initialConfig: config,
    scratchTopics, applicationAccess: access, progressLoops: progress })
  await win.loadFile(html)
  await until(() => evaluate('Boolean(globalThis.recoveryProof)') as Promise<boolean>, 'actual Renderer entry')
  const setup = await evaluate(`recoveryProof.setup(${JSON.stringify(config)},${JSON.stringify(url)},${JSON.stringify(siblingUrl)})`)
  const original = views.get('recovery-original')!, sibling = views.get('recovery-sibling')!
  assert.ok(original && sibling, 'Both original native owners exist')
  await until(() => original.webContents.getTitle() === 'Field notes — original page' && !original.webContents.isLoading() || false, 'original successful local page')
  await until(() => sibling.webContents.getTitle() === 'Sibling page' && !sibling.webContents.isLoading() || false, 'healthy sibling')
  const initial = { id: original.webContents.id, profileId: setup.original.profileId, siblingId: sibling.webContents.id,
    siblingNavigation: manager!.targets().find(target => target.id === 'recovery-sibling')!.navigationId, url }
  receipt.initial = initial
  await close(pageServer)
  await evaluate('recoveryProof.reload()')
  await until(async () => (await facts()).recovery || false, 'actual failed HTTP recovery surface')
  receipt.cases.push({ name: 'actual-http-failure', facts: await facts() })
  await evaluate(`recoveryProof.firstFailure(${JSON.stringify(url + '/first-load')})`)
  await until(async () => (await facts()).recovery && (await facts()).browsers.some((browser: any) => browser.id === 'recovery-first-failure' && browser.error) || false, 'first-load error without earlier artwork')
  assert.notEqual((await facts()).identity, 'Field notes — original page', 'First failure cannot borrow another Browser title')
  receipt.cases.push({ name: 'first-failure-without-cache', facts: await facts() })
  await evaluate('recoveryProof.original()'); await settle()
  if (process.env.AGENTMUX_RECOVERY_IMAGES === '1') {
    for (const shape of [
      { name: 'normal-light', width: 1100, height: 740, theme: 'light' },
      { name: 'narrow-dark', width: 430, height: 760, theme: 'dark' },
      { name: 'short-light', width: 900, height: 420, theme: 'light' },
      { name: 'normal-dark', width: 1100, height: 740, theme: 'dark' }
    ]) {
      win.setContentSize(shape.width, shape.height)
      await evaluate(`recoveryProof.theme(${JSON.stringify(shape.theme)})`); await settle()
      await until(() => !original.getVisible() || false, 'failed original native page yields to its Renderer recovery surface')
      const image = await win.webContents.capturePage(), bytes = image.toPNG(), file = shape.name + '-renderer.png'
      await writeFile(join(out, file), bytes)
      receipt.images.push({ ...shape, file, sha256: hash(bytes), size: image.getSize(), surface: 'BrowserWindow Renderer WebContents capturePage; not OS or native child composition' })
    }
    await writeFile(join(out, 'early-images.json'), JSON.stringify({ candidateStage: 'actual local HTTP failure before address/Retry actions', images: receipt.images }, null, 2) + '\n')
  }
  const draft = 'Keep this edited address draft'
  await evaluate(`(()=>{const e=document.querySelector('input[aria-label="Browser address"]');e.focus();e.select()})()`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Input.insertText', { text: draft })
  await settle()
  assert.equal((await facts()).address, draft, 'The actual original input owns its edited draft')
  const beforeEdit = receipt.calls.filter((row: any) => ['browser:navigate', 'browser:reload', 'browser:create'].includes(row.channel)).length
  await click('Browser workface', 'strong')
  await click('Edit address')
  const edited = await facts()
  assert.equal(edited.focused, true, 'Edit address focuses the existing real address input')
  assert.equal(edited.address, draft, 'Edit address preserves the human draft')
  assert.deepEqual(edited.selection, [0, draft.length], 'Edit address selects the existing draft without replacing it')
  assert.equal(receipt.calls.filter((row: any) => ['browser:navigate', 'browser:reload', 'browser:create'].includes(row.channel)).length, beforeEdit, 'Edit address never navigates or retries')
  await click('Technical details', 'summary')
  assert.equal((await facts()).detailsOpen, true, 'Actual diagnosis disclosure opens')
  assert.equal(await evaluate(`Boolean(document.querySelector('button[aria-label="Copy page address"]'))`), true, 'Original Copy action is present')
  receipt.cases.push({ name: 'edit-and-diagnosis', facts: edited, clipboard: 'Not invoked here; production helper success/failure belongs to mounted behavior tests.' })
  pageServer = page(); await listen(pageServer, port)
  const callStart = receipt.calls.length
  await click('Retry')
  await until(() => receipt.calls.slice(callStart).some((row: any) => row.channel === 'browser:create' && row.args[0] === 'recovery-original' && row.finished) || false, 'actual Retry create-same-ID reply')
  await settle()
  const retryCalls = receipt.calls.slice(callStart)
  assert.equal(retryCalls.filter((row: any) => row.channel === 'browser:reload' && row.args[0] === 'recovery-original').length, 1,
    'Actual recovery Retry reaches the original BVM reload exactly once')
  await until(() => original.webContents.getTitle() === 'Field notes — original page' && !original.webContents.isLoading() || false, 'same original local page recovered')
  await until(async () => !(await facts()).recovery || false, 'actual successful update removes the error surface')
  assert.equal(views.get('recovery-original'), original, 'Retry keeps the original physical page owner')
  assert.equal(original.webContents.id, initial.id)
  assert.equal(manager!.targets().find(target => target.id === 'recovery-original')!.url, url)
  assert.equal((await evaluate(`globalThis.agentmux.browser.create('recovery-original',${JSON.stringify(url)},'recovery-workspace')`)).profileId, initial.profileId)
  assert.equal(sibling.webContents.id, initial.siblingId)
  assert.equal(manager!.targets().find(target => target.id === 'recovery-sibling')!.navigationId, initial.siblingNavigation)
  assert.equal(await sibling.webContents.executeJavaScript('document.querySelector("input").value'), 'Keep this native sibling draft')
  assert.equal((await facts()).sibling, 'Keep this sibling draft')
  assert.equal((await facts()).address, draft, 'Successful recovery does not overwrite the address draft')
  assert.ok(retryCalls.length > 0 && retryCalls.every((row: any) => row.exactSender && row.exactFrame), 'Nonempty actual Retry calls come from production trusted preload')
  assert.equal(receipt.clipboardWrites, 0); assert.equal(receipt.runtimeConnections, 0)
  assert.deepEqual(receipt.preloadErrors, [])
  receipt.cases.push({ name: 'same-identity-retry', calls: retryCalls, facts: await facts() })
  receipt.passed = true
}).catch(error => {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  receipt.nativeAtFailure = [...views].map(([id, view]) => ({ id, destroyed: view.webContents.isDestroyed(),
    ...(!view.webContents.isDestroyed() ? { url: view.webContents.getURL(), title: view.webContents.getTitle(), loading: view.webContents.isLoading(), error: (manager as any)?.entries.get(id)?.error } : {}) }))
}).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', async () => { if (win && !win.isDestroyed()) await evaluate('globalThis.recoveryProof?.dispose()') }],
    ['debugger', () => { if (win && !win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach() }],
    ['ipc', () => dispose?.()], ['progress', () => progress?.stop()], ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()],
    ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }],
    ['original-http', () => close(pageServer)], ['sibling-http', () => close(siblingServer)] ] as const) {
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error) }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
