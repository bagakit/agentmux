import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { desktopBusinessSocketPath } from '../../../src/main/desktop-host'
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
import { ContinuousProgressLoopStore } from '../../../../host/src/continuous-progress-loop-store'
import { ContinuousProgressLoopManager } from '../../../../host/src/continuous-progress-loop-manager'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { registerIpc } from '../../../src/main/ipc'
import { topFrameNavigationGuard, topFrameOrigin } from '../../../src/main/top-frame-navigation'

const out = process.env.AGENTMUX_CERT_OUT!, assets = process.env.AGENTMUX_CERT_ASSETS!, home = process.env.AGENTMUX_CERT_HOME!
const urls = JSON.parse(process.env.AGENTMUX_CERT_URLS!) as { first: string; second: string; h2: string; rotate: string }
const receipt: any = { passed: false, cases: [], images: [], calls: [], cleanup: [], runtimeConnections: 0, clipboardWrites: 0 }
let rendererLoaded = false
let outsider: BrowserWindow | undefined
let win: BrowserWindow | undefined, windows: WorkbenchWindows | undefined, runtime: RuntimeController | undefined
let progress: ContinuousProgressLoopManager | undefined, access: ReturnType<typeof createDesktopApplicationAccessOwner> | undefined
let dispose: (() => Promise<void>) | undefined, pageServer: Server | undefined, manager: BrowserViewManager | undefined
const views = new Map<string, WebContentsView>()
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
async function until<T>(read: () => Promise<T | false> | T | false, name: string): Promise<T> {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) { const value = await read(); if (value !== false) return value; await delay(20) }
  throw new Error('Certificate observation did not complete: ' + name)
}
const evaluate = (expression: string) => win!.webContents.executeJavaScript(expression)
const facts = () => evaluate('certificateProof.facts()')
const settle = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
const pending = (id = 'original') => (manager as any)?.entries.get(id)?.certificateDecision?.request as import('@agentmux/core').AgentMuxBrowserCertificateRequest | undefined
function deny(id: string) {
  const request = pending(id); assert.ok(request)
  manager!.answerCertificate(id, { ...request, allow: false })
}
async function click(label: string, selector = 'button') {
  const point = await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
  assert.ok(point); assert.equal(point.hit, true, 'Original Renderer owns its certificate control')
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
    { type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
  await settle()
}
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  app.setActivationPolicy?.('prohibited')
  await mkdir(join(home, 'workspace'), { recursive: true })
  pageServer = createServer((_request, response) => response.end('<!doctype html><title>Healthy sibling</title><input value="Preserve the original draft">'))
  await new Promise<void>(done => pageServer!.listen(0, '127.0.0.1', done))
  const healthyUrl = `http://127.0.0.1:${(pageServer.address() as any).port}/`
  win = new BrowserWindow({ width: 1100, height: 780, show: false, webPreferences: {
    preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const html = join(assets, 'renderer/index.html')
  const guard = topFrameNavigationGuard(topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: html }))
  win.webContents.on('will-navigate', guard); win.webContents.on('will-redirect', guard)
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => originalHandle(channel, (event, ...args) => {
    if (channel === 'browser:answerCertificate') receipt.calls.push({ channel, args, exactSender: event.sender === win!.webContents, exactFrame: event.senderFrame === event.sender.mainFrame })
    return listener(event, ...args)
  })
  const originalCreate = BrowserViewManager.prototype.create
  BrowserViewManager.prototype.create = async function(...args) { manager = this; const result = await originalCreate.apply(this, args); const view = (this as any).entries.get(args[0])?.view; if (view) views.set(args[0], view); return result }
  const scratchTopics = new ScratchTopics()
  runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => {
    receipt.runtimeConnections++; throw new Error('Recovery presentation must not connect a Runtime')
  }, scratchTopics)
  runtime.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const configStore = new ConfigStore(join(home, 'config.json'))
  const config = structuredClone(DEFAULT_CONFIG)
  config.workspaces = [{ id: 'certificate-workspace', name: 'Private recovery', kind: 'folder', hostId: 'local', path: join(home, 'workspace') }]
  windows = new WorkbenchWindows(win, new WorkbenchWindowStore(join(home, 'windows.json')), () => [])
  access = createDesktopApplicationAccessOwner(runtime, join(home, 'applications.sqlite'))
  progress = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(home, 'progress.json')),
    async () => { throw new Error('No progress input is allowed') }, undefined, async () => { throw new Error('No Agent observation is allowed') })
  dispose = await registerIpc({ window: win, workbenchWindows: windows, runtime, configStore, initialConfig: config,
    scratchTopics, applicationAccess: access, progressLoops: progress })
  await win.loadFile(html); rendererLoaded = true
  await until(() => evaluate('Boolean(globalThis.certificateProof)') as Promise<boolean>, 'actual Renderer entry')
  const cold = await evaluate('globalThis.agentmux.spatial.read()')
  if (cold) assert.ok(cold.graph.regions.some((region: any) => region.regionId === 'original'), 'Original Browser Region descriptor survives a native process restart')
  const original = await evaluate(`certificateProof.setup(${JSON.stringify(config)},${JSON.stringify(healthyUrl)})`)
  await until(() => manager!.nativeOwner('original') || false, 'original native view')
  const contents = views.get('original')!.webContents, contentsId = contents.id
  await until(() => contents.getTitle() === 'Healthy sibling' || false, 'healthy initial document')
  await manager!.create('sibling', healthyUrl, 'certificate-workspace', original.profileId)
  const sibling = views.get('sibling')!.webContents
  await until(() => sibling.getTitle() === 'Healthy sibling' || false, 'healthy sibling document')
  const siblingNavigation = manager!.target('sibling')!.navigationId
  await evaluate(`certificateProof.navigate(${JSON.stringify(urls.first)})`)
  const first = await until(() => pending() || false, 'original certificate callback')
  assert.equal(first.url, urls.first)
  assert.equal(first.scope, 'profile-connections')
  assert.match(first.fingerprint, /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/)
  await until(async () => (await facts()).pending || false, 'production BrowserPane shows the original request')
  assert.equal(contents.isLoading(), true, 'Native navigation waits for the human while the original Renderer stays usable')
  await until(() => !views.get('original')!.getVisible() || false, 'The native waiting view yields to the real certificate Renderer')
  for (const field of ['requestId', 'navigationId', 'fingerprint'] as const) {
    assert.throws(() => manager!.answerCertificate('original', { ...first, [field]: 'foreign', allow: true }), /no longer matches/,
      'A foreign certificate answer must be rejected')
    assert.equal(pending()?.requestId, first.requestId, 'Wrong answers preserve the original pending request')
  }
  assert.throws(() => manager!.answerCertificate('sibling', { ...first, allow: true }), /No certificate request/)
  outsider = new BrowserWindow({ show: false, webPreferences: { preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await outsider.loadURL('data:text/html,<!doctype html><title>Foreign test sender</title>')
  await assert.rejects(outsider.webContents.executeJavaScript(`globalThis.agentmux.browser.answerCertificate('original',${JSON.stringify({ ...first, allow: true })})`),
    /Untrusted/, 'A foreign App sender must be refused')
  assert.equal(pending()?.requestId, first.requestId)
  outsider.destroy(); outsider = undefined

  await manager!.create('concurrent', urls.second, 'certificate-workspace', original.profileId)
  const concurrent = await until(() => pending('concurrent') || false, 'concurrent same-Profile request')
  assert.notEqual(concurrent.requestId, first.requestId)
  deny('concurrent')
  assert.equal(pending()?.requestId, first.requestId, 'Refusing another page preserves the original pending callback')

  // Real public CLI -> original Desktop business endpoint -> same Main Browser owner.
  const cli = await promisify(execFile)(process.env.AGENTMUX_CERT_NODE!, [process.env.AGENTMUX_CERT_CLI!, '--endpoint',
    'unix:' + desktopBusinessSocketPath(), 'browser', 'targets'], { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY'].includes(key))) })
  const catalog = JSON.parse(cli.stdout)
  const publicTarget = catalog.result.targets.find((target: any) => target.id === 'original')
  assert.equal(publicTarget.certificateRequest?.requestId, first.requestId, 'Actual public CLI retains the original pending certificate facts')
  assert.equal(publicTarget.certificateRequest.fingerprint, first.fingerprint)
  receipt.cases.push('exact-native-request-and-public-cli')
  const run = manager!.runScript('original', 'await new Promise(() => {})')
  await until(() => manager!.target('original')!.control?.activeOperationId || false, 'original active operation')
  const taken = manager!.takeControl('original')
  assert.equal(taken.control.owner, 'human')
  assert.equal(pending()?.requestId, first.requestId, 'Taking control preserves the original certificate decision')
  await run

  // DOM-generated clicks cannot stand in for the person in the actual Renderer.
  await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='Continue to site').click()`)
  await settle(); assert.equal(pending()?.requestId, first.requestId); assert.equal(receipt.calls.filter((row: any) => row.exactSender).length, 0)
  win.webContents.debugger.attach('1.3')
  for (const shape of [{ name: 'normal-light', width: 1100, height: 780, theme: 'light' }, { name: 'narrow-dark', width: 430, height: 820, theme: 'dark' }]) {
    win.setContentSize(shape.width, shape.height)
    await evaluate(`certificateProof.theme(${JSON.stringify(shape.theme)})`); await settle()
    const bytes = (await win.webContents.capturePage()).toPNG(), file = shape.name + '.png'
    await writeFile(join(out, file), bytes); receipt.images.push({ ...shape, file, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  assert.ok((await facts()).description.includes('not limited to this page'))
  assert.ok((await facts()).buttons.every((button: any) => !button.disabled), 'Human controls stay usable during pending navigation')
  await click('Keep blocked')
  await until(() => !pending() && !contents.isLoading() || false, 'human refusal completes')
  assert.notEqual(contents.getTitle(), 'Private TLS page')
  assert.throws(() => manager!.answerCertificate('original', { ...first, allow: true }), /No certificate request/)
  receipt.cases.push('human-refusal-and-no-synthetic-acceptance')
  await evaluate(`certificateProof.navigate(${JSON.stringify(urls.first)})`)
  const allowed = await until(() => pending() || false, 'retry requests human review again')
  await until(async () => (await facts()).pending || false, 'retry certificate Renderer')
  await click('Continue to site')
  await until(() => contents.getTitle() === 'Private TLS page' && !contents.isLoading() || false, 'human acceptance resumes original native callback')
  assert.equal(contents.id, contentsId)
  assert.equal(manager!.target('original')!.certificateRequest, null)
  assert.equal(manager!.target('original')!.control?.owner, original.control.owner)
  assert.equal(receipt.calls.filter((row: any) => row.exactSender && row.exactFrame).length, 2)
  assert.equal(receipt.calls.filter((row: any) => !row.exactSender).length, 1)
  assert.throws(() => manager!.answerCertificate('original', { ...allowed, allow: true }), /No certificate request/)
  await manager!.navigate('sibling', urls.first)
  await until(() => sibling.getTitle() === 'Private TLS page' && !sibling.isLoading() || false, 'same-Profile accepted connection reuse')
  assert.equal(pending('sibling'), undefined, 'The disclosed same-Profile connection reuse really occurs')
  receipt.cases.push('trusted-ipc-accepts-original-and-discloses-profile-reuse')

  const separateProfile = await evaluate(`globalThis.agentmux.browser.createProfile('Independent certificate proof')`)
  await manager!.create('separate-profile', urls.first, 'certificate-workspace', separateProfile.id)
  await until(() => pending('separate-profile') || false, 'independent Profile keeps default TLS')
  deny('separate-profile')
  await fetch(urls.rotate)
  await evaluate(`certificateProof.navigate(${JSON.stringify(urls.first)})`)
  const rotated = await until(() => pending() || false, 'changed certificate on a new connection')
  assert.notEqual(rotated.fingerprint, first.fingerprint)
  assert.throws(() => manager!.answerCertificate('original', { ...allowed, allow: true }), /no longer matches/)
  deny('original')
  receipt.cases.push('certificate-rotation-and-independent-profile')

  // Independent origin and HTTP/2 both begin with default TLS refusal.
  await manager!.create('independent', urls.second, 'certificate-workspace', original.profileId)
  await until(() => pending('independent') || false, 'independent origin still requires a human')
  deny('independent')
  await manager!.create('h2', urls.h2, 'certificate-workspace', original.profileId)
  const h2 = await until(() => pending('h2') || false, 'HTTP/2 original certificate')
  assert.equal(h2.scope, first.scope); deny('h2')
  receipt.cases.push('independent-origin-and-http2-default-refusal')
  // Accept through the same real BrowserPane, then preserve its original native owner.
  await evaluate(`certificateProof.navigate(${JSON.stringify(urls.h2)})`)
  await until(() => pending() || false, 'HTTP/2 original Renderer request')
  await until(async () => (await facts()).pending || false, 'HTTP/2 review surface')
  await click('Continue to site')
  await until(() => contents.getTitle() === 'Private H2 page' && !contents.isLoading() || false, 'HTTP/2 original callback resumes')
  await manager!.navigate('h2', urls.h2)
  await until(() => views.get('h2')!.webContents.getTitle() === 'Private H2 page' || false, 'HTTP/2 same-Profile connection reuse')

  await manager!.create('cancel', urls.second, 'certificate-workspace', original.profileId)
  const cancel = await until(() => pending('cancel') || false, 'pending cancellation')
  await manager!.navigate('cancel', healthyUrl)
  await until(() => !pending('cancel') && views.get('cancel')!.webContents.getTitle() === 'Healthy sibling' || false, 'navigation cancels original callback')
  assert.throws(() => manager!.answerCertificate('cancel', { ...cancel, allow: true }), /No certificate request/)
  await manager!.navigate('cancel', urls.second)
  await until(() => pending('cancel') || false, 'pending close')
  await manager!.close('cancel'); assert.equal(manager!.target('cancel'), null)
  await manager!.create('switch', urls.second, 'certificate-workspace', original.profileId)
  const switching = await until(() => pending('switch') || false, 'Profile-switch pending request')
  await manager!.switchProfile('switch', separateProfile.id).catch(() => {})
  assert.equal(pending('switch'), undefined)
  assert.throws(() => manager!.answerCertificate('switch', { ...switching, allow: true }), /No certificate request/)

  assert.equal(sibling.id, views.get('sibling')!.webContents.id)
  assert.notEqual(siblingNavigation, manager!.target('sibling')!.navigationId)
  assert.equal((await facts()).sibling, 'Keep this sibling draft')
  assert.equal(receipt.runtimeConnections, 0)
  receipt.cases.push('navigation-close-and-healthy-work-preserved')
  const saved = await evaluate('certificateProof.persistDescriptor()')
  assert.ok(saved.graph.regions.some((region: any) => region.regionId === 'original'))
  receipt.descriptor = { revision: saved.revision, originalProfileId: original.profileId, previousRevision: cold?.revision ?? null }
  await manager!.create('shutdown-pending', urls.second, 'certificate-workspace', original.profileId)
  await until(() => pending('shutdown-pending') || false, 'shutdown owns an outstanding original callback')
  receipt.passed = true
}).catch(error => { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; receipt.owners = [...views].map(([id,view]) => ({ id, destroyed: view.webContents.isDestroyed(), ...(!view.webContents.isDestroyed() ? { url: view.webContents.getURL(), title: view.webContents.getTitle(), loading: view.webContents.isLoading(), target: manager?.target(id), pending: pending(id) } : {}) })) }).finally(async () => {
  for (const [owner, cleanup] of [ ['renderer', () => win && !win.isDestroyed() ? evaluate('globalThis.certificateProof?.dispose()') : undefined],
    ['foreign-sender-window', () => { if (outsider && !outsider.isDestroyed()) outsider.destroy() }], ['ipc', () => dispose?.()], ['progress', () => progress?.stop()], ['access', () => access?.dispose()], ['runtime', () => runtime?.dispose()],
    ['windows', () => windows?.dispose()], ['window', () => { if (win && !win.isDestroyed()) win.destroy() }],
    ['http', async () => { pageServer?.closeAllConnections(); if (pageServer?.listening) await new Promise<void>(done => pageServer!.close(() => done())) }] ] as const) {
    try { await cleanup() } catch (error) { receipt.cleanup.push({ owner, message: String(error), detail: error, errors: error instanceof AggregateError ? error.errors.map(e => ({message:String(e), cause: String(e.cause), errors: e instanceof AggregateError ? e.errors.map(String) : undefined, stack:e.stack})) : undefined }) }
  }
  receipt.cleanupComplete = !win || win.isDestroyed()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed && receipt.cleanupComplete && !receipt.cleanup.length ? 0 : 1)
})
