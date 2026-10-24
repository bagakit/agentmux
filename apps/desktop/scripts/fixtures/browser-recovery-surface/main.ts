import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeImage, type WebContentsView } from 'electron'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
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

const out = process.env.AGENTMUX_RECOVERY_OUT!, assets = process.env.AGENTMUX_RECOVERY_ASSETS!, home = process.env.AGENTMUX_RECOVERY_HOME!
const phase = process.env.AGENTMUX_RECOVERY_PHASE ?? 'recovery'
const handoffFile = process.env.AGENTMUX_RECOVERY_HANDOFF
const receipt: any = { schema: 'agentmux.browser-recovery-surface.native.v1', passed: false, pid: process.pid, phase,
  calls: [], cases: [], images: [], cleanup: [], runtimeConnections: 0, clipboardWrites: 0,
  boundary: 'Actual BrowserPane/Store/CSS, production sandbox preload, complete registerIpc and real BVM. Private HTTP failure and explicit same-identity recovery. Renderer capturePage PNGs only; no OS composition, physical input, installed app, ordinary full-App restart or clipboard-write qualification. The explicit preview phases prove normal historical JPEG persistence across two private test processes.' }
let rendererLoaded = false
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
async function captureRecoveryImages(previewDataUrl?: string) {
  for (const shape of [
    { name: 'normal-light', width: 1100, height: 740, theme: 'light' },
    { name: 'narrow-dark', width: 430, height: 760, theme: 'dark' },
    { name: 'short-light', width: 900, height: 420, theme: 'light' },
    { name: 'normal-dark', width: 1100, height: 740, theme: 'dark' }
  ]) {
    win!.setContentSize(shape.width, shape.height)
    await evaluate(`recoveryProof.theme(${JSON.stringify(shape.theme)})`); await settle()
    await until(() => !views.get('recovery-original')!.getVisible() || false, 'failed native page yields to its Renderer recovery surface')
    if (previewDataUrl) await until(async () => (await facts()).previewImages.some((image: any) => image.src === previewDataUrl && image.complete && image.width > 0) || false,
      'the original historical JPEG remains decoded at this actual shape')
    const image = await win!.webContents.capturePage(), bytes = image.toPNG(), file = shape.name + '-renderer.png'
    await writeFile(join(out, file), bytes)
    receipt.images.push({ ...shape, file, sha256: hash(bytes), size: image.getSize(), surface: 'BrowserWindow Renderer WebContents capturePage; not OS or native child composition' })
  }
  await writeFile(join(out, 'early-images.json'), JSON.stringify({ candidateStage: 'actual local HTTP failure before address/Retry actions', images: receipt.images }, null, 2) + '\n')
}
function checkedJpeg(preview: any) {
  assert.equal(preview.scope.mode, 'normal', 'The original native producer uses a persistent normal Profile')
  assert.ok(preview.image.dataUrl.startsWith('data:image/jpeg;base64,'))
  const bytes = Buffer.from(preview.image.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')
  assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024, 'Real native JPEG remains within its original bounded byte budget')
  const image = nativeImage.createFromBuffer(bytes)
  assert.equal(image.isEmpty(), false, 'The actual saved bytes decode as a native image')
  assert.deepEqual(image.getSize(), { width: preview.image.width, height: preview.image.height })
  assert.ok(preview.image.width <= 480 && preview.image.height <= 300)
  return { bytes, sha256: hash(bytes) }
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
  const handoff = phase === 'preview-read' ? JSON.parse(await readFile(handoffFile!, 'utf8')) : null
  let port = 0, url = handoff?.failedUrl ?? '', siblingUrl = ''
  if (phase !== 'preview-read') {
    pageServer = page(); port = await listen(pageServer); url = `http://127.0.0.1:${port}/original`
  }
  if (phase === 'recovery') {
    siblingServer = createServer((_request, response) => response.end('<!doctype html><title>Sibling page</title><h1>Unaffected page</h1><input value="Keep this native sibling draft">'))
    siblingUrl = `http://127.0.0.1:${await listen(siblingServer)}/sibling`
  }
  win = new BrowserWindow({ width: 1100, height: 740, show: false, webPreferences: {
    preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  receipt.nativeWindow = { pid: process.pid, mediaSourceId: win.getMediaSourceId() }
  await writeFile(join(out, 'native-startup.json'), JSON.stringify(receipt.nativeWindow, null, 2) + '\n')
  if (phase !== 'recovery') {
    receipt.focusEvents = []
    win.on('focus', () => receipt.focusEvents.push({ event: 'focus', focused: win!.isFocused() }))
    win.on('blur', () => receipt.focusEvents.push({ event: 'blur', focused: win!.isFocused() }))
    win.show()
    app.focus({ steal: true })
    win.focus()
    await until(() => win!.isFocused() || false, 'the original private test App foreground focus')
    receipt.display = { shown: win.isVisible(), focused: win.isFocused(), reason: 'The private test App activates once through the existing native fixture flow; focus is confirmed before creating a Browser.' }
  }
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
  const configStore = new ConfigStore(join(home, 'config.json'))
  const config = phase === 'preview-read' ? await configStore.get() : structuredClone(DEFAULT_CONFIG)
  if (phase !== 'preview-read') config.workspaces = [{ id: 'recovery-workspace', name: 'Private recovery', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
  if (phase === 'preview-capture') await configStore.save(config)
  windows = new WorkbenchWindows(win, new WorkbenchWindowStore(join(home, 'windows.json')), () => [])
  access = createDesktopApplicationAccessOwner(runtime, join(home, 'applications.sqlite'))
  progress = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(home, 'progress.json')),
    async () => { throw new Error('No progress input is allowed') }, undefined, async () => { throw new Error('No Agent observation is allowed') })
  dispose = await registerIpc({ window: win, workbenchWindows: windows, runtime, configStore, initialConfig: config,
    scratchTopics, applicationAccess: access, progressLoops: progress })
  await win.loadFile(html); rendererLoaded = true
  await until(() => evaluate('Boolean(globalThis.recoveryProof)') as Promise<boolean>, 'actual Renderer entry')
  if (phase === 'preview-capture') {
    const original = await evaluate(`recoveryProof.setupPreview(${JSON.stringify(config)},${JSON.stringify(url)})`)
    const view = views.get('recovery-original')!
    assert.ok(view, 'The original producer is an actual BVM page')
    await until(() => view.getVisible() && view.webContents.getTitle() === 'Field notes — original page' && !view.webContents.isLoading() || false, 'real successful visible preview source')
    const saved: any = await until(async () => {
      const result = await evaluate('recoveryProof.readPreview()')
      return result.status === 'available' ? result : false
    }, 'actual preload receives the automatic native preview')
    assert.equal(saved.preview.url, url)
    assert.equal(saved.preview.scope.browserId, 'recovery-original')
    assert.equal(saved.preview.scope.profileId, original.profileId)
    const jpeg = checkedJpeg(saved.preview)
    await writeFile(join(out, 'successful-preview.jpg'), jpeg.bytes)
    const spatial = await evaluate('recoveryProof.persistDescriptor()')
    assert.ok(spatial.graph.regions.length > 0, 'Original Desktop projection saved a nonempty Core descriptor')
    const value = { schema: 'agentmux.browser-recovery-surface.preview-handoff.v1', originalPid: process.pid,
      original, preview: saved.preview, jpegSha256: jpeg.sha256, failedUrl: url.replace('/original', '/different-target'), spatialRevision: spatial.revision }
    await writeFile(handoffFile!, JSON.stringify(value, null, 2) + '\n')
    receipt.preview = { original, preview: saved.preview, jpegSha256: jpeg.sha256, spatialRevision: spatial.revision }
    receipt.cases.push({ name: 'native-successful-jpeg-publication', scope: saved.preview.scope, jpegSha256: jpeg.sha256 },
      { name: 'original-desktop-descriptor-commit', revision: spatial.revision })
    assert.equal(receipt.runtimeConnections, 0); assert.equal(receipt.clipboardWrites, 0)
    assert.deepEqual(receipt.preloadErrors, [])
    receipt.passed = true
    return
  }
  if (phase === 'preview-read') {
    assert.notEqual(process.pid, handoff.originalPid, 'The preview reader is a genuinely new native process')
    assert.equal(views.size, 0)
    const cold = await evaluate('recoveryProof.readPreview()')
    assert.equal(cold.status, 'available', 'Cold actual preload reads the original saved Core descriptor without creating a native page')
    assert.equal(views.size, 0, 'Historical appearance observation does not acquire a native page')
    assert.deepEqual(cold.preview, handoff.preview)
    assert.equal(checkedJpeg(cold.preview).sha256, handoff.jpegSha256)
    receipt.cases.push({ name: 'cold-preload-read-without-native-acquisition', jpegSha256: handoff.jpegSha256 })
    const original = await evaluate(`recoveryProof.setupPreview(${JSON.stringify(config)},${JSON.stringify(url)},${JSON.stringify(handoff.original.profileId)})`)
    assert.equal(original.profileId, handoff.original.profileId)
    assert.equal(original.id, handoff.original.id)
    await until(async () => (await facts()).recovery || false, 'restarted original Browser fails at its new target')
    const current = await evaluate('recoveryProof.readPreview()')
    assert.equal(current.status, 'available')
    assert.deepEqual(current.preview, handoff.preview)
    const jpeg = checkedJpeg(current.preview)
    assert.equal(jpeg.sha256, handoff.jpegSha256)
    assert.notEqual(url, current.preview.url, 'Historical preview URL differs from the current failed target')
    assert.equal((await facts()).displayedUrl, url, 'The failed surface retains its current exact target')
    await until(async () => (await facts()).previewImages.some((image: any) => image.src === current.preview.image.dataUrl && image.complete && image.width > 0) || false,
      'actual recovery surface decodes the original historical JPEG')
    receipt.preview = { cold, current, jpegSha256: jpeg.sha256, failedUrl: url, original }
    receipt.cases.push({ name: 'normal-jpeg-survives-private-process-restart', jpegSha256: jpeg.sha256 })
    if (process.env.AGENTMUX_RECOVERY_IMAGES === '1') await captureRecoveryImages(current.preview.image.dataUrl)
    pageServer = page(); await listen(pageServer, Number(new URL(url).port))
    win.webContents.debugger.attach('1.3')
    const start = receipt.calls.length
    await click('Retry')
    await until(() => receipt.calls.slice(start).some((row: any) => row.channel === 'browser:reload' && row.finished) || false, 'actual current-target Retry completes')
    await until(async () => !(await facts()).recovery || false, 'current target becomes healthy')
    assert.equal(manager!.target('recovery-original')!.url, url, 'Historical artwork never becomes the Retry destination')
    assert.equal(views.get('recovery-original')!.webContents.getURL(), url)
    const calls = receipt.calls.slice(start).filter((row: any) => ['browser:create', 'browser:reload'].includes(row.channel))
    assert.ok(calls.length > 0 && calls.every((row: any) => row.exactSender && row.exactFrame))
    assert.equal(calls.find((row: any) => row.channel === 'browser:create')!.args[1], url)
    receipt.cases.push({ name: 'retry-retains-new-target-over-historical-appearance', target: url, calls })
    assert.equal(receipt.runtimeConnections, 0); assert.equal(receipt.clipboardWrites, 0)
    assert.deepEqual(receipt.preloadErrors, [])
    receipt.passed = true
    return
  }
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
  if (process.env.AGENTMUX_RECOVERY_IMAGES === '1') await captureRecoveryImages()
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
  if (win && !win.isDestroyed()) receipt.displayAtFailure = { shown: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() }
  receipt.nativeAtFailure = [...views].map(([id, view]) => ({ id, destroyed: view.webContents.isDestroyed(),
    ...(!view.webContents.isDestroyed() ? { url: view.webContents.getURL(), title: view.webContents.getTitle(), loading: view.webContents.isLoading(), error: (manager as any)?.entries.get(id)?.error } : {}) }))
}).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', async () => { if (rendererLoaded && win && !win.isDestroyed()) await evaluate('globalThis.recoveryProof?.dispose()') }],
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
