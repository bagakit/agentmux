import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, ipcMain, desktopCapturer, nativeImage, type WebContentsView } from 'electron'
import { connectLocalAgentMux, AgentMuxFileAgentSessionStore, connectAgentMuxRpc, connectHostedAgentMux } from '@agentmux/core'
import { composeAgentPrompt } from '../../../../../packages/core/src/agent-outbound-message'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server'
import { AgentMuxHostedRuntimeService } from '../../../../../packages/core/src/hosted-runtime-service'
import { createDesktopInputContextCaptureReader } from '../../../../host/src/input-context-capture-reader'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { desktopBusinessSocketPath } from '../../../src/main/desktop-host'
import { BrowserNativeInputShield } from '../../../src/main/browser-native-input-shield'
import { fitImageView } from '../../../src/renderer/src/components/image-annotation/view'

const directory = process.env.AGENTMUX_CONTEXTUAL_ROOT!, source = process.env.AGENTMUX_CONTEXTUAL_SOURCE!
const captureOnly = process.env.AGENTMUX_CONTEXTUAL_CAPTURE_ONLY === '1'
const presenceOnly = process.env.AGENTMUX_CONTEXTUAL_PRESENCE_ONLY === '1'
const selectionOnly = process.env.AGENTMUX_CONTEXTUAL_SELECTION_ONLY === '1'
const narrowCapture = process.env.AGENTMUX_CONTEXTUAL_CAPTURE_CASE === 'narrow'
app.on('window-all-closed', () => {})
const receipt: any = { schema: 'agentmux.browser-contextual-composer.native.v1', passed: false, cases: [], ipc: [],
  mode: selectionOnly ? 'selection-only' : presenceOnly ? 'operator-presence' : captureOnly ? 'capture-only' : 'opinion-and-trace',
  boundary: presenceOnly ? 'Actual BrowserPane artwork export through Chromium canvas, production sandbox preload and trusted Main avatar setter to the original native target cue. The controlled Agent supplies its real identity; this mode submits no opinion and does not qualify Provider admission, OS composition or aesthetics.' : captureOnly ? 'Capture-only uses the original BrowserPane/WindowOverlay/NativeOverlay/Store and production sandbox preload/full Main. It exercises real Browser programs and viewport invariants without sending an opinion or qualifying Host/Provider admission. No user Browser, Agent, clipboard or upstream model is used.' : 'Private actual BrowserPane/WindowOverlay/NativeOverlay/Store → production sandbox preload/registerIpc/RuntimeController → Hosted SDK/Host capture reader/Core → shipped CodexProvider/real ctxmux PTY/repository controlled CLI. Renderer CDP interaction does not attest physical OS input or foreground focus. No user Browser, Agent, clipboard or upstream model is used.',
  physicalInputQualified: false, independentVisualReview: 'not-performed' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(read: () => T | Promise<T>, label: string, attempts = 500): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) { const value = await read(); if (value) return value; await delay(25) }
  throw new Error('Private contextual proof did not observe ' + label)
}
let window: BrowserWindow | undefined, core: any, sdk: any, rpc: any, hosted: any, hostServer: any, runtime: RuntimeController | undefined,
  releaseIpc: (() => Promise<void>) | undefined, windows: WorkbenchWindows | undefined, access: any, session: any,
  server: ReturnType<typeof createServer> | undefined
let restoreShieldObserver: (() => void) | undefined
const output: string[] = []
async function run() {
  await app.whenReady()
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  core = await connectLocalAgentMux({ store })
  core.onEvent((event: any) => { if (event.type === 'terminal-output') output.push(event.data) })
  session = await core.createAgent({ agentSessionId: 'contextual-recipient', createOperationId: 'contextual-create', providerId: 'codex',
    executorId: 'contextual-codex', workspacePath: directory, commandOverride: join(source, 'packages/core/test/fixtures/fake-codex-cli.mjs'), injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(directory, 'native-records') } })
  const attachment = await core.reattachAgent(session.agentSessionId, 0)
  for (const event of attachment.attachment.replay) output.push(event.data)
  await until(() => core.agentSession(session.agentSessionId).terminalPromptReadiness?.readyThroughByte !== undefined, 'real CodexProvider prompt readiness')
  const initialAcceptedInputBytes = (await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes
  const captureReader = createDesktopInputContextCaptureReader({ desktopSocketPath: desktopBusinessSocketPath(), captureHostId: 'local', executionHostId: 'local' })
  const identity = { runtimeId: randomUUID(), ownerInstanceId: randomUUID(), protocolVersion: 2, processId: process.pid, availability: 'connected' as const }
  hosted = new AgentMuxHostedRuntimeService(core, join(directory, 'sessions.json'), () => ({ ...identity, ctxmux: core.runtimeIdentity() }), undefined, undefined, captureReader)
  const socket = join(directory, 'semantic.sock')
  hostServer = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [{ hostId: 'local', client: core }], hostedRuntime: () => hosted })
  await hostServer.start()
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  sdk = await connectHostedAgentMux({ rpc })
  runtime = new RuntimeController(store, async () => sdk)
  const configStore = new ConfigStore(join(directory, 'config.json'))
  const config = await configStore.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private collaboration' }],
    workspaces: [{ id: 'contextual-workspace', name: 'Private collaboration', kind: 'folder', hostId: 'local', path: directory }],
    executors: { 'contextual-codex': { providerId: 'codex', label: 'Browser collaborator', command: join(source, 'packages/core/test/fixtures/fake-codex-cli.mjs'), args: [], env: {}, injectAgentMuxGuide: false,
      ...(presenceOnly ? { avatar: { badge: 'shield' as const, tint: '#469b78' } } : {}) } },
    browser: { ...DEFAULT_CONFIG.browser, agentAutomation: true, agentControl: { ...DEFAULT_CONFIG.browser.agentControl, showDiscussion: false } } })
  window = new BrowserWindow({ width: 1120, height: 760, show: false, title: 'Browser collaboration · private proof',
    webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const contents = window.webContents
  if (presenceOnly) {
    const dispose = BrowserNativeInputShield.prototype.dispose
    const observed = new WeakSet<BrowserNativeInputShield>()
    BrowserNativeInputShield.prototype.dispose = function () {
      const facts: any = { contentsId: this.contents.id, destroyedBefore: this.contents.isDestroyed() }
      ;(receipt.inputSurfaceDisposals ??= []).push(facts)
      if (!observed.has(this)) {
        observed.add(this)
        this.contents.once('destroyed', () => { facts.destroyedEvent = true })
      }
      try { dispose.call(this); facts.returned = true }
      catch (error) {
        facts.failure = { name: (error as Error).name, message: (error as Error).message,
          errors: error instanceof AggregateError ? error.errors.map(item => ({ name: item.name, message: item.message })) : [] }
        throw error
      } finally { facts.destroyedAfter = this.contents.isDestroyed() }
    }
    restoreShieldObserver = () => { BrowserNativeInputShield.prototype.dispose = dispose }
  }
  const originalNativeSend = contents.sendInputEvent.bind(contents)
  contents.sendInputEvent = input => {
    ;(receipt.nativeOverlayForwarded ??= []).push({ input, receiverId: contents.id, windowId: window!.id })
    originalNativeSend(input)
  }
  contents.on('console-message', (event: any) => { if (event.level === 'error') console.error('Renderer:', event.message) })
  windows = new WorkbenchWindows(window, new WorkbenchWindowStore(join(directory, 'windows.json')), () => [{ x: 0, y: 0, width: 1600, height: 1000 }])
  access = createDesktopApplicationAccessOwner(runtime, join(directory, 'application-access.sqlite'))
  const register = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) => register(channel, (event, ...args) => {
    const fact: any = { channel, exactSender: event.sender === contents, exactFrame: event.senderFrame === contents.mainFrame, args }
    if (channel.startsWith('browser:') || channel === 'sessions:submitPrompt' || channel === 'ui:publishNativeOverlays') receipt.ipc.push(fact)
    return Promise.resolve(handler(event, ...args)).then(value => { fact.result = value; return value })
  })
  releaseIpc = await registerIpc({ window, workbenchWindows: windows, initialConfig: config, configStore, runtime, applicationAccess: access,
    scratchTopics: new ScratchTopics(), progressLoops: { subscribe: () => () => {}, pauseTarget: async () => {} } as never })
  server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Original collaboration page</title><style>body{font:16px system-ui;margin:24px;min-height:1800px;background:#f5f7f6;color:#19342c}button{padding:12px}input{padding:10px;margin:12px}</style><h1>Original live page</h1><p>This Browser keeps working while its trace and opinion are read.</p><button id="action">Page action</button><input id="text" aria-label="Page draft"><script>globalThis.pageProof={events:[],clicks:0};document.querySelector('#action').onclick=()=>pageProof.clicks++;for(const type of ['pointerdown','pointerup','wheel','keydown','input'])addEventListener(type,e=>pageProof.events.push(type));</script>`) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}/original`
  await window.loadFile(join(directory, 'renderer/index.html'))
  window.showInactive()
  if (process.env.AGENTMUX_CONTEXTUAL_FOREGROUND === '1') {
    window.show(); app.focus({ steal: true }); window.focus()
    if (process.env.AGENTMUX_CONTEXTUAL_CAPTURE_HANDOFF !== '1') await until(() => window!.isFocused(), 'authorized private native foreground window')
  }
  const evaluate = (expression: string) => contents.executeJavaScript(expression)
  await until(() => evaluate('Boolean(window.contextualProof)'), 'actual Renderer entry')
  const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }
  const snapshot = await runtime.refresh(control, config)
  receipt.setup = await evaluate(`contextualProof.setup(${JSON.stringify(config)},${JSON.stringify(snapshot)},${JSON.stringify(url)})`)
  await until(() => evaluate('contextualProof.facts().stage?.width > 0'), 'original mounted BrowserPane stage')
  const page = await until(() => window!.contentView.children.find(view => (view as WebContentsView).webContents?.getURL() === url) as WebContentsView | undefined, 'same actual native page')
  await until(() => page.webContents.executeJavaScript('Boolean(globalThis.pageProof)'), 'original native document')
  if (process.env.AGENTMUX_CONTEXTUAL_CAPTURE_HANDOFF === '1') {
    const sourceId = window.getMediaSourceId(), match = /^window:(\d+):\d+$/u.exec(sourceId)!
    const native = JSON.parse(execFileSync(join(directory, 'native-window'), [match[1]!, String(process.pid)], { encoding: 'utf8' }))
    await writeFile(join(directory, 'window-ready.json'), JSON.stringify({ native, sourceId, pid: process.pid, appPath: process.execPath.split('/Contents/MacOS/')[0], focused: window.isFocused() }))
    console.log('native-window-ready')
    const observed = await until(async () => { try { return JSON.parse(await readFile(join(directory, 'window-ready-response.json'), 'utf8')) } catch { return null } }, 'the exact CUA private window observation', 3600)
    assert.equal(observed.pid, process.pid); assert.equal(observed.windowId, native.windowId)
    receipt.nativeWindowObservation = observed
    if (process.env.AGENTMUX_CONTEXTUAL_NATIVE_OPINION === '1') assert.equal(observed.ready, true, 'Actual native opinion requires the observed original private window')
    if (observed.ready !== true) receipt.nativeCaptureAvailability = { status: 'unknown', sourceId, failure: observed.failure,
      next: 'The exact private window capture remains unconfirmed. Preserve Renderer and native document evidence separately.' }
  }
  if (!captureOnly && !presenceOnly) {
    void evaluate(`window.agentmux.browser.runScript('contextual-browser', 'await waitForElement("Continue collaboration", ${selectionOnly ? 120000 : 25000}); return "finished"', ${JSON.stringify({ id: session.agentSessionId, name: snapshot.label })}, 'contextual-browser-program')`).then(report => { receipt.browserProgram = report })
    await until(() => evaluate('contextualProof.facts().browser?.activity?.operation?.steps?.length > 0'), 'actual running Browser step')
  }
  const before = await page.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,events:pageProof.events.slice()})')
  contents.debugger.attach('1.3')
  const click = async (selector: string) => {
    const point = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing original GUI control');const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,width:r.width,height:r.height,hit:element===hit||element.contains(hit),target:hit?.outerHTML.slice(0,300)}})()`)
    assert.ok(point.width > 0 && point.height > 0)
    assert.equal(point.hit, true, 'The actual GUI action point must hit its original control: ' + selector + '\n' + point.target)
    ;(receipt.clicks ??= []).push({ selector, point })
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    for (const type of ['mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const pageFacts = async () => ({ nativeBounds: page.getBounds(), document: await page.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,visual:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale},events:pageProof.events.slice()})'),
    stage: (await evaluate('contextualProof.facts()')).stage, url: page.webContents.getURL() })
  function capturedImage(bytes: Buffer) {
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    assert.ok(png || jpeg, 'The native capture must retain its actual PNG or JPEG encoding')
    const decoded = nativeImage.createFromBuffer(bytes)
    assert.equal(decoded.isEmpty(), false, 'The original native capture must actually decode')
    const pixels = decoded.getSize()
    assert.ok(pixels.width > 0 && pixels.height > 0)
    return { mimeType: png ? 'image/png' : 'image/jpeg', extension: png ? '.png' : '.jpg', pixels,
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  async function capture(name: string) {
    const frames = presenceOnly ? [['renderer', await contents.capturePage()], ['window', await window!.capturePage()]] as const
      : [['renderer', await contents.capturePage()], ['window', await window!.capturePage()], ['page', await page.webContents.capturePage()]] as const
    for (const [surface, picture] of frames) {
      const file = name + '-' + surface + '.png'
      await writeFile(join(directory, file), picture.toPNG())
      ;(receipt.frames ??= []).push({ file, surface, pixels: picture.getSize(), actualWindow: window!.getBounds(),
        boundary: surface === 'page' ? 'Original native Browser document only' : surface === 'renderer' ? 'Whole Renderer document; excludes the native Browser view' : 'Native BrowserWindow.capturePage API; composed native child inclusion needs independent pixel confirmation, not OS input proof' })
    }
    if (process.env.AGENTMUX_CONTEXTUAL_FOREGROUND === '1' || process.env.AGENTMUX_CONTEXTUAL_CAPTURE_HANDOFF === '1') {
      if (process.env.AGENTMUX_CONTEXTUAL_CAPTURE_HANDOFF === '1' && name.includes('-fixed-')) return
      if (receipt.nativeCaptureAvailability?.status === 'unknown') return
      const foreground = process.env.AGENTMUX_CONTEXTUAL_FOREGROUND === '1'
      // The initial handoff establishes this window. Capturing must not refocus its parent
      // while the actual native Chrome overlay owns a menu or an editor.
      const focus = { parentFocused: window!.isFocused(), focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null }
      const sourceId = window!.getMediaSourceId(), match = /^window:(\d+):\d+$/u.exec(sourceId)
      assert.ok(match, 'Electron must return its exact native window media source identity')
      const native = JSON.parse(execFileSync(join(directory, 'native-window'), [match[1]!, String(process.pid)], { encoding: 'utf8' }))
      if (foreground) {
        assert.notEqual(native.screenLocked, true, 'A locked desktop cannot qualify the foreground native window')
        assert.equal(native.onScreen, true)
      }
      assert.equal(native.layer, 0)
      const fileStem = name + '-os-window', file = fileStem + '.png'
      ;(receipt.nativeCaptureAttempts ??= []).push({ native, sourceId, fileStem, focus })
      if (process.env.AGENTMUX_CONTEXTUAL_CAPTURE_HANDOFF === '1') {
        // Retry the exact native route in this unlocked window; a prior locked failure
        // cannot establish that its OS capture is permanently unavailable.
        if (foreground && receipt.nativePngAvailability?.status !== 'unknown') {
          try {
            execFileSync('/usr/sbin/screencapture', ['-x', '-l', match[1]!, join(directory, file)], { timeout: 5000, stdio: 'pipe' })
            const image = capturedImage(await readFile(join(directory, file)))
            assert.equal(image.mimeType, 'image/png', 'The native screencapture PNG output must keep its actual encoding')
            receipt.nativePngAvailability = { status: 'captured', sourceId }
            receipt.frames.push({ file, surface: 'os-native-window', native, sourceId, ...image,
              boundary: 'Original screencapture bytes from this exact private foreground PID/CGWindowID; no composition, crop or re-encoding, separate from physical input proof' })
            return
          } catch (error) {
            receipt.nativePngAvailability = { status: 'unknown', sourceId, failure: String(error),
              next: 'Use the original CUA screenshot encoding for this exact window.' }
          }
        }
        const request = { captureId: name, native, sourceId, fileStem, pid: process.pid, foreground, encodings: ['image/png', 'image/jpeg'] }
        await writeFile(join(directory, 'capture-request.json'), JSON.stringify(request))
        console.log('native-capture-ready:' + name)
        const captured = await until(async () => {
          try { const response = JSON.parse(await readFile(join(directory, 'capture-response.json'), 'utf8')); return response.captureId === name ? response : null }
          catch { return null }
        }, 'actual CUA image for the original native capture request', 2400)
        assert.equal(captured.windowId, native.windowId); assert.equal(captured.pid, process.pid)
        if (captured.status === 'unknown') {
          receipt.nativeCaptureAvailability = { status: 'unknown', sourceId, failure: captured.failure,
            next: 'The exact private window capture remains unconfirmed. Renderer images do not replace the native window.' }
          return
        }
        assert.ok(captured.file === fileStem + '.png' || captured.file === fileStem + '.jpg', 'The original capture stays at this exact requested image stem')
        const image = capturedImage(await readFile(join(directory, captured.file)))
        assert.equal(captured.mimeType, image.mimeType)
        assert.equal(captured.file, fileStem + image.extension, 'The original image encoding determines its real extension')
        assert.deepEqual(captured.pixels, image.pixels)
        receipt.frames.push({ file: captured.file, surface: 'os-native-window', native, sourceId, captured, ...image,
          boundary: 'Actual CUA screenshot of this exact private window; complete original image bytes, no composition, separate from foreground or physical input proof' })
        return
      }
      if (receipt.nativeCaptureAvailability?.status === 'unknown') return
      try {
        const size = window!.getBounds()
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: size.width * 2, height: size.height * 2 }, fetchWindowIcons: false })
        const source = sources.find(item => item.id === sourceId)
        assert.ok(source && !source.thumbnail.isEmpty(), 'The exact private OS native window must produce a real captured image')
        await writeFile(join(directory, file), source.thumbnail.toPNG())
        receipt.frames.push({ file, surface: 'os-native-window', native, sourceId, pixels: source.thumbnail.getSize(), boundary: 'Actual Electron desktopCapturer OS capture of the exact foreground private PID/CGWindowID, including native Browser page and Chrome overlays; no image composition and no physical input claim' })
        receipt.nativeCaptureAvailability = { status: 'captured', sourceId }
      } catch (error) {
        receipt.nativeCaptureAvailability = { status: 'unknown', sourceId, failure: String(error),
          next: 'Capture this same private native window through the existing desktop tool; Renderer images do not replace the composed window.' }
      }
    }
  }
  if (presenceOnly) {
    const operationId = 'original-presence-program'
    const operator = { id: session.agentSessionId, name: snapshot.label }
    const program = evaluate(`window.agentmux.browser.runScript('contextual-browser', 'await waitForElement("Presence ready",20000);const page=await snapshot();await hover(page.nodes.find(node=>node.role==="button"&&node.name==="Page action").ref);return "finished"', ${JSON.stringify(operator)}, ${JSON.stringify(operationId)})`)
    await until(() => receipt.ipc.some((call: any) => call.channel === 'browser:setOperatorAvatar' && call.args[0]?.operationId === operationId && call.result === true),
      'BrowserPane cold export through the original trusted Main avatar setter')
    const accepted = receipt.ipc.find((call: any) => call.channel === 'browser:setOperatorAvatar' && call.result === true)
    assert.equal(accepted.exactSender, true); assert.equal(accepted.exactFrame, true)
    assert.equal(accepted.args[0].operatorId, operator.id); assert.equal(accepted.args[0].browserId, 'contextual-browser')
    const artwork = nativeImage.createFromDataURL(accepted.args[0].png)
    assert.equal(artwork.isEmpty(), false); assert.deepEqual(artwork.getSize(), { width: 64, height: 64 })
    const originalPng = Buffer.from(accepted.args[0].png.slice('data:image/png;base64,'.length), 'base64')
    await writeFile(join(directory, 'operator-original-avatar.png'), originalPng)
    const presentations: Array<{ image: Electron.NativeImage; observedAt: number }> = []
    page.webContents.beginFrameSubscription(false, image => {
      presentations.push({ image, observedAt: Date.now() })
      if (presentations.length > 4) presentations.shift()
    })
    await page.webContents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<button>Presence ready</button>")')
    const report = await program
    assert.equal(report.report.outcome.kind, 'completed')
    page.webContents.debugger.attach('1.3')
    let cue: any
    try {
      const tree = await page.webContents.debugger.sendCommand('Page.getFrameTree')
      const world = await page.webContents.debugger.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'agentmux-browser-operation-feedback' })
      const expression = `(()=>{const s=globalThis.__agentMuxBrowserOperationFeedback,label=s?.shadow?.querySelector('.label'),image=label?.querySelector('img'),pointer=s?.shadow?.querySelector('.pointer');if(!s?.host||!image?.complete||image.naturalWidth!==64||!pointer)return null;return{operationId:s.operationId,navigationId:s.navigationId,token:s.token,phase:s.phase,point:s.point,expiresAt:s.expiresAt,now:Date.now(),label:label.textContent,pointerEvents:getComputedStyle(s.host).pointerEvents,avatar:image.src,avatarWidth:image.naturalWidth,avatarHeight:image.naturalHeight,avatarRect:image.getBoundingClientRect().toJSON()}})()`
      cue = await until(async () => {
        const observed = await page.webContents.debugger.sendCommand('Runtime.evaluate', { contextId: world.executionContextId, returnByValue: true,
          expression })
        return observed.result?.value
      }, 'the original native target cue with its actual Renderer-generated face', 30)
      assert.equal(cue.operationId, operationId); assert.equal(cue.phase, 'completed')
      assert.equal(cue.avatar, accepted.args[0].png); assert.equal(cue.pointerEvents, 'none')
      assert.ok(cue.expiresAt > cue.now, 'The original completion cue is still within its normal lifetime')
      // Observe original compositor frames within the ordinary cue lifetime.
      // capturePage itself can return after that lifetime on an occluded desktop.
      const viewport = await page.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')
      const hoverStarted = report.report.runOperation.steps.find((step: any) => step.method === 'hover').startedAt
      const hasArrowPaint = (frame: typeof presentations[number]) => {
        if (frame.observedAt < cue.now || frame.observedAt < hoverStarted || frame.observedAt >= cue.expiresAt) return false
        const size = frame.image.getSize(), pixels = frame.image.toBitmap()
        if (pixels.length !== size.width * size.height * 4) return false
        const sx = size.width / viewport.width, sy = size.height / viewport.height
        let green = 0
        for (let y = Math.max(0, Math.floor(cue.point.y * sy)); y < Math.min(size.height, Math.ceil((cue.point.y + 21) * sy)); y++) {
          for (let x = Math.max(0, Math.floor(cue.point.x * sx)); x < Math.min(size.width, Math.ceil((cue.point.x + 17) * sx)); x++) {
            const index = (y * size.width + x) * 4, b = pixels[index]!, g = pixels[index + 1]!, r = pixels[index + 2]!
            if (g - r > 50 && g - b > 30) green++
          }
        }
        let avatarGreen = 0
        for (let y = Math.max(0, Math.floor(cue.avatarRect.y * sy)); y < Math.min(size.height, Math.ceil(cue.avatarRect.bottom * sy)); y++) {
          for (let x = Math.max(0, Math.floor(cue.avatarRect.x * sx)); x < Math.min(size.width, Math.ceil(cue.avatarRect.right * sx)); x++) {
            const index = (y * size.width + x) * 4, b = pixels[index]!, g = pixels[index + 1]!, r = pixels[index + 2]!
            if (g - r > 25 && g - b > 10) avatarGreen++
          }
        }
        return green >= 8 && avatarGreen >= 4
      }
      const presented = await until(() => presentations.findLast(hasArrowPaint) ?? (Date.now() >= cue.expiresAt ? { expired: true as const } : null),
        'the actual pointer paint during its original normal lifetime', 40)
      receipt.presencePaintObservation = { cue, hoverStarted, viewport,
        frames: presentations.map(frame => ({ observedAt: frame.observedAt, size: frame.image.getSize(), arrowPaint: hasArrowPaint(frame) })) }
      if (!presented || !('image' in presented)) for (const [index, frame] of presentations.entries()) {
        await writeFile(join(directory, `operator-unqualified-frame-${index}.png`), frame.image.toPNG())
      }
      assert.ok(presented && 'image' in presented, 'The original native cue must actually paint before its normal expiry; DOM presence is insufficient')
      const picture = presented.image
      const after = (await page.webContents.debugger.sendCommand('Runtime.evaluate', { contextId: world.executionContextId, returnByValue: true, expression })).result?.value
      const file = 'operator-completed-pointer-page.png'
      await writeFile(join(directory, file), picture.toPNG())
      ;(receipt.frames ??= []).push({ file, surface: 'page', pixels: picture.getSize(), before: cue, after, observedAt: presented.observedAt,
        boundary: 'Original native page beginFrameSubscription image with actual pointer paint inside its original cue lifetime. No hold, composition or re-encoding beyond its original native PNG encoding; identity/label appearance requires independent review.' })
      await capture('operator-completed-pointer')
    } finally { page.webContents.endFrameSubscription(); page.webContents.debugger.detach() }
    const raster = await evaluate('contextualProof.rasterPresenceAsset()')
    assert.equal(raster.status, 'ready', 'The existing bundled PNG provider artwork must render through Chromium too')
    const rasterBytes = Buffer.from(raster.avatar.dataUrl.slice('data:image/png;base64,'.length), 'base64')
    assert.ok(rasterBytes.length <= 64 * 1024)
    assert.deepEqual(nativeImage.createFromBuffer(rasterBytes).getSize(), { width: 64, height: 64 })
    await writeFile(join(directory, 'operator-bundled-raster-avatar.png'), rasterBytes)
    const facts = await until(async () => {
      const current = await evaluate('contextualProof.facts()')
      return current.browser?.control?.inputIsolation === 'inactive' ? current : undefined
    }, 'confirmed cleanup of the original native input surface', 30)
    assert.deepEqual(facts.errors, [], 'The actual presence consumer must not report a hidden export or bridge failure')
    assert.ok(receipt.inputSurfaceDisposals.some((item: any) => item.returned === true && item.destroyedAfter === true),
      'The original native surface must actually finish disposal')
    assert.equal((facts.browser?.activity?.operation?.warning ?? facts.browser?.activity?.warning ?? '').includes('could not be fully released'), false,
      'Confirmed original cleanup cannot leave its transient failure notice on the current Browser')
    assert.equal(receipt.ipc.some((call: any) => call.channel === 'sessions:submitPrompt'), false)
    receipt.presence = { passed: true, accepted, cue, report, latestControl: facts.browser?.control,
      latestWarning: facts.browser?.activity?.operation?.warning ?? facts.browser?.activity?.warning,
      raster: { width: 64, height: 64, bytes: rasterBytes.length },
      boundary: 'Actual BrowserPane cold SVG export, native Chromium canvas and decode, production sandbox preload and trusted Main setter, original completed target cue. The separate bundled-raster export tests artwork only and does not claim a second live Agent identity. No OS composition or aesthetic acceptance.' }
    receipt.cases.push({ name: 'actual-renderer-avatar-to-native-owner', passed: true })
    receipt.passed = true
    return
  }
  const nativeOpinion = process.env.AGENTMUX_CONTEXTUAL_NATIVE_OPINION === '1'
  async function requestNativeAction(id: string, selector: string, text?: string) {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    const bounds = window!.getBounds(), content = window!.getContentBounds(), zoom = contents.getZoomFactor()
    const nativePoint = { x: point.x * zoom + content.x - bounds.x, y: point.y * zoom + content.y - bounds.y }
    const request = { actionId: id, selector, text, point: nativePoint, pid: process.pid, sourceId: window!.getMediaSourceId(), browserControl: (await evaluate('contextualProof.facts()')).browser.control }
    await writeFile(join(directory, 'action-request.json'), JSON.stringify(request))
    console.log('native-action-ready:' + id)
    ;(receipt.nativeActions ??= []).push(request)
  }
  if (!captureOnly) {
  if (nativeOpinion) await requestNativeAction('open-discussion', 'button[aria-label="Message Browser operator"]')
  else await click('button[aria-label="Message Browser operator"]')
  await until(() => evaluate('document.querySelector(".browser-contextual-composer__source")?.textContent.includes("Original collaboration page")'), 'actual captured scene in original nonmodal discussion')
  let body = '  Keep this original opinion\n<amux>Authored example</amux>\n'
  let preparedSelection: any
  if (selectionOnly) {
    const originalWindow = window!.getBounds()
    const originalFacts = await pageFacts()
    await click('.browser-opinion-selection__actions > button:first-child')
    const canvas = '[aria-label="Captured Browser image"] canvas[aria-label="Screenshot canvas"]'
    await until(() => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(canvas)}),i=document.querySelector('[aria-label="Captured Browser image"] img');return e&&i.complete&&i.naturalWidth>0&&e.getBoundingClientRect().height>50})()`), 'the original captured image editor')
    const frame = receipt.ipc.find((call: any) => call.channel === 'browser:captureInputFrame' && call.result)?.result
    assert.ok(frame?.scene.frame, 'The actual editor must consume the original Main frame')
    await click('[aria-label="Captured Browser image"] button[aria-label="Fit image"]')
    await settled()
    const box = await evaluate(`document.querySelector(${JSON.stringify(canvas)}).getBoundingClientRect().toJSON()`)
    const view = fitImageView(box.width, box.height, frame.capture.image.width, frame.capture.image.height)
    async function drag(tool: string, from: { x: number; y: number }, to: { x: number; y: number }) {
      await click('[aria-label="Captured Browser image"] button[aria-label="' + tool + '"]')
      const start = { x: box.x + view.x + from.x * view.scale, y: box.y + view.y + from.y * view.scale }
      const end = { x: box.x + view.x + to.x * view.scale, y: box.y + view.y + to.y * view.scale }
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start })
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 })
      for (let n = 1; n <= 6; n++) await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * n / 6, y: start.y + (end.y - start.y) * n / 6, button: 'left', buttons: 1 })
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 })
      await settled()
    }
    const width = frame.capture.image.width, height = frame.capture.image.height
    await drag('Crop', { x: width * .1, y: height * .1 }, { x: width * .8, y: height * .8 })
    await drag('Cover', { x: width * .3, y: height * .3 }, { x: width * .5, y: height * .5 })
    assert.deepEqual(await pageFacts(), originalFacts, 'Editing the frozen frame must not affect the original page or viewport')
    assert.equal(page.getVisible(), true, 'The live native page remains available behind the frozen editor')
    await capture('selection-editor-normal')
    window!.setSize(433, 780); await settled()
    await until(() => evaluate('document.querySelector("[aria-label=\\"Captured Browser image\\"]").getBoundingClientRect().width<440'), 'the same frozen editor in the narrow window')
    assert.equal(page.getVisible(), true)
    await capture('selection-editor-narrow')
    window!.setBounds(originalWindow); await settled()
    await until(async () => (await pageFacts()).document.width === originalFacts.document.width, 'the original explicit window size after the two selection images')
    await until(() => evaluate(`(()=>{const b=[...document.querySelectorAll('[aria-label="Captured Browser image"] button')].find(e=>e.textContent==='Attach processed image');if(!b||b.disabled)return false;b.setAttribute('data-selection-attach','');return true})()`), 'explicit processed-image confirmation')
    await click('[data-selection-attach]')
    preparedSelection = await until(() => receipt.ipc.find((call: any) => call.channel === 'browser:prepareInputSelection' && call.result)?.result, 'the original actual processed-image writer result')
    const image = preparedSelection.scene.inputContext.selection.attachment
    const artifactBytes = await readFile(image.path), decoded = nativeImage.createFromBuffer(artifactBytes)
    assert.equal(decoded.isEmpty(), false)
    assert.equal(createHash('sha256').update(artifactBytes).digest('hex'), image.sha256)
    assert.deepEqual(decoded.getSize(), { width: image.width, height: image.height })
    assert.ok(image.width < width && image.height < height, 'Actual editor cropping must change the saved pixel dimensions')
    const center = decoded.crop({ x: Math.floor(image.width * .42), y: Math.floor(image.height * .42), width: 1, height: 1 }).toBitmap()
    assert.ok(center[0]! < 64 && center[1]! < 64 && center[2]! < 64 && center[3] === 255, 'Actual cover markup must survive in the saved processed PNG')
    assert.equal(preparedSelection.artifact.diskDurability, 'confirmed')
    assert.equal(preparedSelection.scene.inputContext.selection.frameId, frame.scene.reference.captureId)
    assert.equal(preparedSelection.scene.inputContext.selection.source.association, 'observed-during')
    receipt.selection = { passed: true, frame: frame.scene.reference, prepared: preparedSelection, frames: receipt.frames,
      boundary: 'Actual editor events and native PNG output; Renderer/page captures are separate, and only explicitly OS-labelled frames qualify whole-window composition.' }
  }
  if (nativeOpinion) {
    await requestNativeAction('write-opinion', 'textarea[aria-label="Opinion for Browser operator"]', body)
    await until(() => evaluate(`document.querySelector(${JSON.stringify('textarea[aria-label="Opinion for Browser operator"]')}).value === ${JSON.stringify(body)}`), 'original opinion text through the actual native overlay')
    await requestNativeAction('send-opinion', '.browser-contextual-composer .primary-button')
  } else {
    await evaluate(`document.querySelector(${JSON.stringify('textarea[aria-label="Opinion for Browser operator"]')}).focus()`)
    await contents.debugger.sendCommand('Input.insertText', { text: body })
    if (selectionOnly) body = await evaluate('document.querySelector(\'textarea[aria-label="Opinion for Browser operator"]\').value')
    await click('.browser-contextual-composer .primary-button')
  }
  const freeze = await until(() => receipt.ipc.find((call: any) => call.channel === 'browser:freezeInputContext' && call.result), 'actual GUI frozen operation ID')
  const operationId = freeze.args[0].operationId
  assert.equal(freeze.args[0].prompt, body, 'GUI must keep original authored bytes')
  await evaluate(`contextualProof.flush(${JSON.stringify(session.agentSessionId)})`)
  const key = { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: operationId }
  const original = await until(async () => { const record = await core.inspectAgentPromptSubmission(key); return record?.admission ? record : null }, 'actual original Core admission from normal Renderer queue')
  const message = original.admission.intent.message, context = freeze.result.record.inputContext
  assert.deepEqual(message.inputContext, context, 'GUI queue reference must reach the original Host capture reader')
  if (selectionOnly) {
    assert.deepEqual(context.selection, preparedSelection.scene.inputContext.selection, 'The sent input must retain the exact prepared frame and resource')
    const inspected = await captureReader.read(freeze.result.reference)
    assert.deepEqual(inspected.reference, freeze.result.reference)
    assert.deepEqual(inspected.record?.inputContext, context, 'The original public Browser input read retains the same frozen selection')
    assert.equal(inspected.record?.binding.agentSessionId, session.agentSessionId)
    assert.equal(inspected.record?.binding.originRun.runId, session.run.runId)
    assert.equal(Object.hasOwn(inspected.record!, 'prompt'), false, 'Public capture inspection cannot disclose the authored body')
    receipt.selection.publicInspect = { passed: true, reference: inspected.reference, record: inspected.record,
      boundary: 'Original Host adapter makes the readonly browser.input.inspect RPC to the actual Main capture owner; no capture, image write or input dispatch is introduced.' }
  }
  assert.equal(message.inputContextSource, 'host-capture')
  assert.equal(message.authorHuman, true, 'The real trusted user GUI remains human-authored')
  assert.equal(message.authorAgentSessionId, undefined, 'User opinion must not become Agent-to-Agent input')
  assert.equal(message.userContent, body)
  assert.equal(context.page.url, url)
  assert.equal(context.activity.operationId, 'contextual-browser-program')
  assert.equal(context.activity.stepSequence, 1)
  const wire = composeAgentPrompt(body, message.systemContext, context).text
  if (selectionOnly) assert.ok(wire.includes(context.selection.attachment.path) && wire.includes(context.selection.attachment.sha256), 'The Provider must receive the same pure-data image reference separately from the authored body')
  assert.equal(original.admission.intent.prompt, wire)
  await until(() => output.join('').replace(/\r\n/gu, '\n').includes('codex-submit:' + wire.replace(/\r\n/gu, '\n') + ':accepted'), 'real repository CLI accepted the actual Provider wire')
  const submit = receipt.ipc.find((call: any) => call.channel === 'sessions:submitPrompt' && call.args[2] === operationId)
  assert.ok(submit?.exactSender && submit.exactFrame, 'Original production preload reaches the trusted Main submit handler')
  assert.deepEqual(submit.args.at(-1), freeze.result.reference, 'Only the original typed capture reference crosses submit IPC')
  if (nativeOpinion) {
    assert.ok(receipt.nativeOverlayForwarded?.filter((item: any) => item.input.type === 'mouseDown').length >= 2,
      'Native overlay pointer events must actually forward through the original Main native projection into its Renderer')
    receipt.nativeOpinion = { passed: true, key, submit, forwarded: receipt.nativeOverlayForwarded.slice() }
  }
  assert.equal(receipt.browserProgram, undefined, 'The original Browser program must still be running during live viewport checks')
  assert.deepEqual(await page.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,events:pageProof.events.slice()})'), before, 'Discussion must not change original live viewport, scroll or page input')
  const history = await core.readAgentSessionHistory({ hostId: 'local', agentSessionId: session.agentSessionId, source: 'captured', kind: 'user-message', query: body, limit: 10 })
  const received = history.userMessages.find((message: any) => message.source.submissionId === 'prompt:' + operationId)
  assert.ok(received, 'The original Core user-message reader returns the actual submitted input')
  assert.deepEqual(received.author, { kind: 'human' })
  assert.deepEqual(received.inputContext, context)
  const timelineItem = (await core.sessionTimeline(session.agentSessionId)).items.find((item: any) => item.id === received.rawId)
  assert.ok(timelineItem)
  await evaluate(`contextualProof.reader(${JSON.stringify(received)},${JSON.stringify(timelineItem)})`)
  await until(() => evaluate('document.querySelector(".contextual-fixture__reader")?.textContent.includes("Keep this original opinion")'), 'shared shipped conversation reader consumes the actual received wire')
  assert.equal(await evaluate('document.querySelectorAll(".contextual-fixture__reader .conversation-browser-context").length'), 1,
    'The shared Reader folds the generated Browser context separately from the original opinion')
  assert.equal(await evaluate('document.querySelector(".contextual-fixture__reader .conversation-browser-context").open'), false)
  assert.equal(await evaluate('document.querySelector(".contextual-fixture__reader .conversation-browser-context").dataset.browserContextSource'), 'host-capture')
  if (selectionOnly) {
    await click('.contextual-fixture__reader .conversation-browser-context > summary')
    await evaluate('document.querySelector(".contextual-fixture__reader .conversation-browser-context__selection").scrollIntoView({block:"center"})')
    await until(() => evaluate('(()=>{const i=document.querySelector(\'.contextual-fixture__reader img[alt="Captured selection"]\');return i?.complete&&i.naturalWidth>0})()'), 'the original shared image port and Chromium decoder')
    const preview = receipt.ipc.filter((call: any) => call.channel === 'browser:readSelectionImage' && call.result).at(-1)
    assert.deepEqual(preview?.args[0], context.selection.attachment, 'The actual common image reader must request the complete original reference')
    const previewBytes = Buffer.from(preview.result.dataUrl.split(',')[1], 'base64')
    assert.equal(createHash('sha256').update(previewBytes).digest('hex'), context.selection.attachment.sha256)
    assert.equal(await evaluate('document.querySelector(".contextual-fixture__reader .conversation-browser-context__data pre").textContent.includes(' + JSON.stringify(context.selection.attachment.sha256) + ')'), true)
    receipt.selection.preview = { reference: preview.args[0], actualPixels: nativeImage.createFromBuffer(previewBytes).getSize(), exactSender: preview.exactSender, exactFrame: preview.exactFrame }
    await evaluate('document.querySelector(\'.contextual-fixture__reader button[aria-label="Copy message"]\').scrollIntoView({block:"nearest"})')
  }
  await click('button[aria-label="Copy message"]')
  await until(() => evaluate('contextualProof.facts().copies.length'), 'shared whole-message Copy consumer')
  assert.equal((await evaluate('contextualProof.facts()')).copies[0], body, 'Captured whole-message Copy keeps the exact original human opinion')
  await evaluate(`contextualProof.wire(${JSON.stringify(original.admission.intent.prompt)},${JSON.stringify(received)})`); await settled()
  if (selectionOnly) {
    // A long human wire is intentionally disclosed before parsing/rendering its full body.
    await until(() => evaluate('(()=>{const e=document.querySelector(".contextual-fixture__reader .message-disclosure > summary");if(!e)return false;e.setAttribute("data-selection-full-message","");e.scrollIntoView({block:"nearest"});return true})()'), 'the actual full-message disclosure for the longer wire')
    await click('[data-selection-full-message]')
    await until(() => evaluate('document.querySelectorAll(".contextual-fixture__reader .conversation-browser-context").length===1'), 'the full original wire Browser declaration')
  }
  assert.equal(await evaluate('document.querySelectorAll(".contextual-fixture__reader .conversation-browser-context").length'), 1, 'The shared wire Reader presents the actually received Browser context once')
  assert.equal(await evaluate('document.querySelector(".contextual-fixture__reader .conversation-browser-context").dataset.browserContextSource'), 'caller-declared', 'Native wire cannot borrow the Main capture source')
  await click('button[aria-label="Copy message"]')
  await until(() => evaluate('contextualProof.facts().copies.length === 2'), 'native whole-message Copy consumer')
  assert.equal((await evaluate('contextualProof.facts()')).copies[1], wire, 'Native whole-message Copy keeps the actual received wire')
  receipt.input = { key, originalMessage: message, originalWire: original.admission.intent.prompt, reference: freeze.result.reference,
    acceptedInputBytes: (await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes }
  receipt.received = received
  receipt.receivedWire = { source: 'original-Core-admission-and-real-CLI-consumer', text: original.admission.intent.prompt }
  receipt.renderer = await evaluate('contextualProof.facts()')
  receipt.cases.push({ name: 'actual-browser-opinion-through-original-queue-main-host-core-provider', passed: true })
  console.log('Actual GUI opinion, Provider wire and shared Reader consumers: GREEN')
  await writeFile(join(directory, 'baseline-renderer.png'), (await contents.capturePage()).toPNG())
  if (selectionOnly) { receipt.passed = true; return }
  await page.webContents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<button>Continue collaboration</button>")')
  await until(() => receipt.browserProgram, 'original Browser completion')
  assert.equal(receipt.browserProgram.report.outcome.kind, 'completed')
  await click('button[aria-label="Close discussion"]')
  }
  const operator = JSON.stringify({ id: session.agentSessionId, name: snapshot.label })
  async function startProgram(id: string) {
    await page.webContents.executeJavaScript('document.querySelector("#continue-proof")?.remove()')
    let report: any
    const completion = evaluate(`window.agentmux.browser.runScript('contextual-browser', 'await waitForElement("Trace continuation", 25000); return "finished"', ${operator}, ${JSON.stringify(id)})`).then(value => { report = value; return value })
    await until(async () => { const browser = (await evaluate('contextualProof.facts()')).browser; return browser.activity.operation?.id === id && browser.activity.operation?.steps.length > 0 && browser.retention.reasons.includes('operation') }, 'actual Main operation retention for ' + id)
    await settled()
    return async () => {
      assert.equal(report, undefined, 'The original Browser program must still own its trace viewport')
      await page.webContents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<button id=continue-proof>Trace continuation</button>")')
      const result = await completion
      assert.equal(result.report.outcome.kind, 'completed')
      await settled()
    }
  }
  async function openTrace() {
    const observations: any[] = []
    ;(receipt.traceOpening ??= []).push(observations)
    observations.push({ phase: 'before-menu', facts: await evaluate('contextualProof.facts()') })
    await click('.browser-operation-status__trigger')
    await until(() => evaluate('Boolean(document.querySelector("[aria-label=\\"Open browser activity timeline\\"]"))'), 'real activity disclosure')
    observations.push({ phase: 'open-menu', facts: await evaluate('contextualProof.facts()') })
    if (captureOnly && !narrowCapture && !receipt.menuCaptured) {
      await evaluate('contextualProof.appearance("dark")'); await settled()
      await capture('menu-normal-responsive-dark')
      receipt.menuCaptured = true
    }
    await click('[aria-label="Open browser activity timeline"]')
    await until(() => evaluate('Boolean(document.querySelector("aside[aria-label=\\"Browser activity trace\\"]"))'), 'original trace reader')
    await settled()
    observations.push({ phase: 'open-trace', facts: await evaluate('contextualProof.facts()') })
  }
  const traceReceipts: any[] = []
  receipt.trace = traceReceipts
  async function settleNativeGeometry() {
    await until(async () => {
      const stage = await evaluate('contextualProof.facts().stage')
      const zoom = contents.getZoomFactor(), bounds = page.getBounds()
      return page.getVisible() && stage && ['x', 'y', 'width', 'height'].every(key => Math.abs(bounds[key as keyof typeof bounds] - Math.round(stage[key] * zoom)) <= 1)
    }, 'the original native Browser bounds to match its current rendered stage')
  }
  async function requireReadablePage(selector: string, shape: { name: string }, viewport: unknown) {
    if (shape.name !== 'narrow' || viewport !== 'responsive') return
    const panel = await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`)
    const pageContent = await page.webContents.executeJavaScript('({height:innerHeight,heading:document.querySelector("h1").getBoundingClientRect().toJSON(),action:document.querySelector("#action").getBoundingClientRect().toJSON()})')
    const nativeBounds = page.getBounds()
    const contentBottom = nativeBounds.y + Math.max(pageContent.heading.bottom, pageContent.action.bottom) * nativeBounds.height / pageContent.height
    assert.ok(panel.top >= contentBottom, 'The narrow reader must leave the original page heading and action visible')
    ;(receipt.narrowReadability ??= []).push({ selector, panel, pageContent, nativeBounds, contentBottom })
  }
  for (const shape of [{ name: 'normal', width: 1120, height: 760 }, { name: 'narrow', width: 360, height: 760 }, { name: 'short', width: 760, height: 420 }]) {
    if (narrowCapture && shape.name !== 'narrow') continue
    window.setSize(shape.width, shape.height)
    await settled(); await settleNativeGeometry()
    for (const viewport of ['responsive', { width: 640, height: 480, screenPosition: 'desktop' }]) {
      receipt.currentCase = { shape, viewport, mode: 'live-floating' }
      await evaluate(`window.agentmux.browser.setViewport('contextual-browser', ${JSON.stringify(viewport)})`)
      await settled(); await delay(100)
      const finish = await startProgram('trace-floating-' + shape.name + '-' + (typeof viewport === 'string' ? 'responsive' : 'fixed'))
      const original = await pageFacts()
      await openTrace()
      const trace = await evaluate('(()=>{const e=document.querySelector("aside[aria-label=\\"Browser activity trace\\"]");return{floating:e.classList.contains("browser-trace-rail--floating"),sameDocument:e.ownerDocument===document,modal:e.getAttribute("aria-modal"),visibility:getComputedStyle(e).visibility,positioned:Boolean(e.style.left&&e.style.top),box:e.getBoundingClientRect().toJSON()}})()')
      assert.equal(trace.floating, true, 'Opening a live trace must float without taking page flow space')
      assert.equal(trace.sameDocument, true)
      assert.equal(trace.modal, 'false')
      assert.equal(trace.visibility, 'visible', 'The live trace must actually be painted after its original parent ref commits')
      assert.equal(trace.positioned, true)
      const currentStepVisible = await evaluate(`(()=>{const panel=document.querySelector('aside[aria-label="Browser activity trace"]'),step=panel?.querySelector('.browser-rsi-timeline__step--running,.browser-rsi-timeline__step--waiting');if(!panel||!step)return false;const p=panel.getBoundingClientRect(),s=step.getBoundingClientRect();return s.top>=p.top&&s.bottom<=p.bottom})()`)
      assert.equal(currentStepVisible, true, 'Opening the live trace must show the current step before scrolling through older operations')
      await requireReadablePage('aside[aria-label="Browser activity trace"]', shape, viewport)
      assert.deepEqual(await pageFacts(), original, 'Opening live trace must preserve original page viewport, geometry, scroll and input')
      for (const appearance of ['dark', 'light']) {
        await evaluate(`contextualProof.appearance(${JSON.stringify(appearance)})`); await settled()
        await capture('trace-' + shape.name + '-' + (typeof viewport === 'string' ? 'responsive' : 'fixed') + '-' + appearance)
      }
      await click('button[aria-label="Close browser activity timeline"]'); await settled()
      assert.deepEqual(await pageFacts(), original, 'Closing live trace must preserve original page viewport, geometry, scroll and input')
      await click('button[aria-label="Message Browser operator"]'); await settled()
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".browser-contextual-composer")).visibility'), 'visible', 'The opinion entry and actual discussion remain usable at this window size')
      await requireReadablePage('.browser-contextual-composer', shape, viewport)
      assert.deepEqual(await pageFacts(), original, 'Reading the original opinion must preserve the running Browser viewport')
      for (const appearance of ['dark', 'light']) {
        await evaluate(`contextualProof.appearance(${JSON.stringify(appearance)})`); await settled()
        await capture('discussion-' + shape.name + '-' + (typeof viewport === 'string' ? 'responsive' : 'fixed') + '-' + appearance)
      }
      await click('button[aria-label="Close discussion"]'); await settled()
      assert.deepEqual(await pageFacts(), original, 'Closing the original opinion must preserve the running Browser viewport')
      if (shape.name === 'narrow' && viewport === 'responsive') {
        await openTrace()
        await click('.browser-rsi-timeline__step--running > button,.browser-rsi-timeline__step--waiting > button')
        const commentSelector = '[data-original-step-comment]'
        await until(() => evaluate(`(()=>{const button=[...document.querySelectorAll('aside[aria-label="Browser activity trace"] button')].find(item=>item.textContent.startsWith('Comment on step'));if(!button)return false;button.setAttribute('data-original-step-comment','');button.scrollIntoView({block:'nearest'});return true})()`), 'the actual Portal historical-step opinion entry')
        await settled(); await click(commentSelector); await settled()
        const historical = await evaluate(`(()=>{const panel=document.querySelector('.browser-contextual-composer');return{compact:panel.dataset.compactReader,height:panel.getBoundingClientRect().height,editor:panel.querySelector('textarea')?.getBoundingClientRect().height}})()`)
        assert.equal(historical.compact, 'true')
        assert.ok(historical.height > 120 && historical.editor >= 56, 'A Portal historical-step opinion must use the exact original Pane, not its small button')
        await requireReadablePage('.browser-contextual-composer', shape, viewport)
        await click('button[aria-label="Close discussion"]'); await settled()
        await click('button[aria-label="Close browser activity timeline"]'); await settled()
        assert.deepEqual(await pageFacts(), original, 'A historical opinion must preserve the original live page')
        receipt.historicalOpinionLayout = historical
      }
      traceReceipts.push({ shape, viewport, original, trace })
      await finish()
      console.log('Actual live trace viewport: ' + shape.name + ' ' + (typeof viewport === 'string' ? 'responsive' : 'fixed') + ' GREEN')
    }
    await evaluate("window.agentmux.browser.setViewport('contextual-browser', 'responsive')"); await settled(); await delay(100)
    await openTrace()
    receipt.currentCase = { shape, mode: 'idle-dock-then-live-close' }
    assert.equal(await evaluate('document.querySelector("aside[aria-label=\\"Browser activity trace\\"]").classList.contains("browser-trace-rail--floating")'), false, 'An idle trace may dock')
    const finish = await startProgram('trace-held-' + shape.name)
    const original = await pageFacts()
    await click('button[aria-label="Close browser activity timeline"]'); await settled()
    assert.deepEqual(await pageFacts(), original, 'Closing a previously docked trace must preserve the live page footprint, including narrow column layout')
    assert.equal(await evaluate('Boolean(document.querySelector(".browser-trace-held"))'), true, 'A previously docked trace retains its original footprint during execution')
    await click('.browser-trace-held button'); await settled()
    assert.deepEqual(await pageFacts(), original, 'Reopening the held trace must reuse its original dock footprint')
    await click('button[aria-label="Close browser activity timeline"]'); await settled()
    await finish()
    await until(() => evaluate('!document.querySelector("aside[aria-label=\\"Browser activity trace\\"]")'), 'original dock reservation released after Main operation completion')
    traceReceipts.push({ shape, heldDock: true, original })
  }
  receipt.trace = traceReceipts
  receipt.cases.push({ name: 'native-live-trace-viewport-and-original-dock-footprint', passed: true })
  if (captureOnly) {
    assert.equal(receipt.ipc.some((call: any) => call.channel === 'sessions:submitPrompt'), false, 'Capture-only cannot submit or replay an opinion')
    receipt.captureOnly = { submittedOpinions: 0, nativeOpinionQualified: false,
      transportBytes: { before: initialAcceptedInputBytes, after: (await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes } }
    assert.equal(receipt.frames.filter((frame: any) => frame.surface === 'os-native-window').length, narrowCapture ? 4 : 13,
      'Capture-only must retain every actual native window, including the original menu')
    receipt.captureQualified = true
  }
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'ThrownValue', message: String(error) }; console.error(error)
  if (window && !window.isDestroyed()) {
    try {
      receipt.failureRenderer = await window.webContents.executeJavaScript('({facts:window.contextualProof?.facts(),menus:[...document.querySelectorAll("[role=menu]")].map(e=>e.outerHTML),buttons:[...document.querySelectorAll(".browser-toolbar button")].map(e=>({label:e.getAttribute("aria-label"),state:e.getAttribute("data-state"),box:e.getBoundingClientRect().toJSON()}))})')
      await writeFile(join(directory, 'failure-renderer.png'), (await window.webContents.capturePage()).toPNG())
    } catch (diagnostic) { receipt.failureDiagnostic = String(diagnostic) }
  }
}).finally(async () => {
  const cleanup: string[] = []
  for (const release of [async () => { if (session && core) await core.stopAgent(session.agentSessionId, core.agentSession(session.agentSessionId).run) },
    () => releaseIpc?.(), () => runtime?.dispose(), () => access?.dispose(), () => windows?.dispose(), () => sdk?.dispose(), () => rpc?.dispose(), () => hostServer?.stop(), () => hosted?.dispose(), () => core?.dispose(),
    () => { if (window && !window.isDestroyed()) window.destroy() }, () => { if (!server) return; server.closeAllConnections(); return new Promise<void>(resolve => server!.close(() => resolve())) },
    () => restoreShieldObserver?.()]) {
    try { await release() } catch (error) { cleanup.push(String(error)) }
  }
  receipt.cleanupFailures = cleanup
  await writeFile(join(directory, 'native-receipt.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed && !cleanup.length ? 0 : 1)
})
