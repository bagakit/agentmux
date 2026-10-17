import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, nativeImage } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store.js'
import { resolveBrowserAgentControl } from '../../../src/shared/browser-agent-control.js'

/** Adds exact OS window observations to an already qualified native/Renderer proof. */
export async function captureOperatorWindows(receipt: any) {
  const handoff = process.env.AGENTMUX_PRESENCE_HANDOFF!, output = process.env.AGENTMUX_PRESENCE_OUTPUT!
  const privateRoot = process.env.AGENTMUX_PRESENCE_PRIVATE!
  const artwork = JSON.parse(await readFile(join(handoff, 'original-artwork.json'), 'utf8'))
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  async function until<T>(read: () => Promise<T>, label: string, budget = 6000): Promise<NonNullable<T>> {
    const end = Date.now() + budget
    while (Date.now() < end) { const value = await read(); if (value) return value as NonNullable<T>; await pause(10) }
    throw new Error('The original OS observation did not confirm ' + label)
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Private operator page</title><style>html,body{margin:0;min-height:100%;font:16px system-ui}main{padding:24px}button{padding:12px}</style><main><h1>Original live page</h1><p>This page stays available while the Agent works.</p><button>Page action</button></main>')
  })
  let window: BrowserWindow | undefined, manager: BrowserViewManager | undefined
  receipt.mode = 'os-window-join'; receipt.captureQualified = false
  receipt.boundary = 'Actual BVM native control surfaces in a private stock Electron OS window. Artwork bytes join the original qualified BrowserPane/Chromium/preload/Main proof. This small native host is not a second BrowserPane or a physical-input proof.'
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as any).port}/original`
    window = new BrowserWindow({ width: 960, height: 720, show: false, title: 'Private operator presence OS proof',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    await window.loadURL('data:text/html,<!doctype html><title>Private operator presence OS proof</title>')
    manager = new BrowserViewManager(window, { defaultProfileId: () => 'private', resolvePartition: () => 'presence-os-' + process.pid },
      new BrowserRefLedgerStore(join(privateRoot, 'refs.json')),
      { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => { throw new Error('External navigation is outside this private proof') } },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => resolveBrowserAgentControl())
    await manager.create('original', url)
    const sizePage = () => { const bounds = window!.getContentBounds(); manager!.setBounds('original', { x: 0, y: 0, width: bounds.width, height: bounds.height }) }
    sizePage()
    const contents = manager.nativeOwner('original')!.view.webContents
    contents.setBackgroundThrottling(false)
    await until(() => contents.executeJavaScript('Boolean(document.querySelector("button"))'), 'the original loaded page')
    window.show(); app.focus({ steal: true }); window.focus()
    await until(async () => window!.isFocused(), 'the exact private window native focus')
    const readNative = () => {
      const sourceId = window!.getMediaSourceId(), id = /^window:(\d+):\d+$/u.exec(sourceId)![1]!
      const native = JSON.parse(execFileSync(join(handoff, 'native-window'), [id, String(process.pid)], { encoding: 'utf8' }))
      assert.equal(native.pid, process.pid); assert.notEqual(native.screenLocked, true); assert.equal(native.onScreen, true)
      return { native, sourceId }
    }
    const ready = { ...readNative(), pid: process.pid, appPath: process.execPath.split('/Contents/MacOS/')[0], focused: window.isFocused(), mode: receipt.mode }
    await writeFile(join(handoff, 'window-ready.json'), JSON.stringify(ready)); console.log('operator-os-window-ready: ' + handoff)
    const observed = await until(async () => { try { return JSON.parse(await readFile(join(handoff, 'window-ready-response.json'), 'utf8')) } catch { return null } }, 'the exact private CUA window', 120_000)
    assert.equal(observed.ready, true); assert.equal(observed.pid, process.pid); assert.equal(observed.windowId, ready.native.windowId)
    receipt.nativeWindowObservation = observed
    const control = () => contents.executeJavaScriptInIsolatedWorld(1209, [{ code: '(()=>{const s=globalThis.__agentMuxBrowserControlFeedback;return{operationId:s?.operationId,connected:!!s?.host?.isConnected,viewport:{width:innerWidth,height:innerHeight},reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches}})()' }])
    // BVM owns attachment during the program. Observe its finished cue only
    // after that original session releases the debugger.
    let world: { executionContextId: number } | undefined
    const cue = async () => {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
      if (!world) {
        const tree = await contents.debugger.sendCommand('Page.getFrameTree')
        world = await contents.debugger.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'agentmux-browser-operation-feedback' })
      }
      return (await contents.debugger.sendCommand('Runtime.evaluate', { contextId: world!.executionContextId, returnByValue: true,
        expression: '(()=>{const s=globalThis.__agentMuxBrowserOperationFeedback,i=s?.shadow?.querySelector("img");return{operationId:s?.operationId,token:s?.token,phase:s?.phase,expiresAt:s?.expiresAt,now:Date.now(),connected:!!s?.host?.isConnected,avatar:i?{src:i.src,complete:i.complete,width:i.naturalWidth}:null}})()' })).result.value
    }
    async function capture(id: string, state: any, readAfter: () => Promise<any>, completed = false) {
      const identity = readNative()
      assert.equal(identity.native.windowId, ready.native.windowId)
      const request = { captureId: id, ...identity, pid: process.pid, fileStem: id + '-os-window', mode: receipt.mode, state, completed }
      await writeFile(join(handoff, 'capture-request.json'), JSON.stringify(request))
      const response = await until(async () => { try { const value = JSON.parse(await readFile(join(handoff, 'capture-response.json'), 'utf8')); return value.captureId === id && value } catch { return null } }, 'original native capture ' + id, 15_000)
      assert.equal(response.pid, process.pid); assert.equal(response.windowId, ready.native.windowId)
      assert.equal(response.file, basename(response.file))
      assert.ok(/\.(png|jpg)$/u.test(response.file))
      const bytes = await readFile(join(handoff, response.file)), sha256 = createHash('sha256').update(bytes).digest('hex')
      assert.equal(sha256, response.sha256)
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      assert.ok(png || jpeg); assert.equal(response.mimeType, png ? 'image/png' : 'image/jpeg')
      assert.equal(response.file.endsWith(png ? '.png' : '.jpg'), true)
      const image = nativeImage.createFromBuffer(bytes), pixels = image.getSize()
      assert.equal(image.isEmpty(), false); assert.deepEqual(pixels, response.pixels)
      assert.ok(Math.abs(pixels.width / identity.native.bounds.Width - pixels.height / identity.native.bounds.Height) < 0.01)
      const after = await readAfter()
      const qualified = !completed || state.connected && state.phase === 'completed' && state.avatar?.complete && state.avatar.width === 64
        && response.captureStarted >= state.now && response.captureCompleted < state.expiresAt && after.connected && after.token === state.token && after.now < state.expiresAt
      const file = response.file
      await writeFile(join(output, file), bytes)
      receipt.captures.push({ file, sha256, pixels, mimeType: response.mimeType, native: identity.native, before: state, after,
        captureStarted: response.captureStarted, captureCompleted: response.captureCompleted, qualified,
        boundary: 'Original CUA complete private-window image bytes. No crop, composition, re-encoding, cue hold or replay.' })
      return qualified
    }
    const shapes = [{ name: 'normal', width: 960, height: 720 }, { name: 'narrow', width: 360, height: 760 }, { name: 'short', width: 760, height: 420 }]
    const contexts = shapes.flatMap(shape => ['light', 'dark'].map(theme => ({ ...shape, theme, zoom: 1, reduced: false })))
    contexts.push({ ...shapes[0]!, name: 'reduced-motion', theme: 'dark', zoom: 1, reduced: true }, { ...shapes[0]!, name: 'zoom', theme: 'light', zoom: 1.25, reduced: false })
    let allQualified = true
    for (const [index, context] of contexts.entries()) {
      window.setSize(context.width, context.height); sizePage(); contents.setZoomFactor(context.zoom)
      await contents.executeJavaScript(`document.documentElement.style.background=${JSON.stringify(context.theme === 'dark' ? '#151b18' : '#f5f7f6')};document.body.style.background='inherit';document.body.style.color=${JSON.stringify(context.theme === 'dark' ? '#edf7f0' : '#19342c')}`)
      const id = context.name + '-' + context.theme, operationId = 'os-owner-' + index, finish = 'Private continuation ' + index
      const program = `await waitForElement(${JSON.stringify(finish)},20000);${index === 0 ? 'const s=await snapshot();const n=s.nodes.find(n=>n.name==="Page action");await hover(n.ref);return n' : 'return "finished"'}`
      const running = manager.runScript('original', program, artwork.operator, undefined, operationId, () => {
        assert.equal(manager!.setOperatorAvatar({ browserId: 'original', operationId, operatorId: artwork.operator.id, png: artwork.png }), true)
      })
      let programFailure: unknown
      void running.catch(error => { programFailure = error })
      await until(async () => { if (programFailure) throw programFailure; return manager!.inputContext('original', 'local')?.activity?.phase === 'waiting' }, 'the original waiting owner')
      await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: context.reduced ? 'reduce' : 'no-preference' }] })
      const before = await control()
      assert.equal(before.connected, true); assert.equal(before.operationId, operationId); assert.equal(before.reducedMotion, context.reduced)
      assert.equal(contents.getZoomFactor(), context.zoom); assert.equal(manager.target('original')?.control?.inputIsolation, 'isolated')
      await capture(id + '-waiting', before, control)
      await contents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify('<button>' + finish + '</button>')})`)
      const report = await running
      assert.equal(report.outcome.kind, 'completed')
      if (index === 0) {
        const beforeCue = await cue()
        assert.equal(beforeCue.operationId, operationId); assert.equal(beforeCue.avatar?.src, artwork.png)
        allQualified = await capture(id + '-completed', beforeCue, cue, true) && allQualified
        contents.debugger.detach()
      }
      assert.equal((await control()).connected, false, 'A completed program no longer claims control')
      receipt.cases.push({ name: 'actual-os-window-context', context, operationId, passed: true, report })
    }
    receipt.captureQualified = allQualified; receipt.passed = allQualified
    await writeFile(join(handoff, 'os-finished.json'), JSON.stringify({ passed: receipt.passed, pid: process.pid, captures: receipt.captures.length }))
  } finally {
    for (const release of [() => manager?.dispose(), () => { if (window && !window.isDestroyed()) window.destroy() }, async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }]) {
      try { await release() } catch (error) { receipt.cleanup.push(String(error)) }
    }
  }
}
