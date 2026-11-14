import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { AppCaptureSource } from '../../../src/main/app-capture'

const [directory, phase, evidence] = process.argv.slice(2) as [string, string, string]
app.setPath('userData', join(directory, 'data')); app.setPath('sessionData', join(directory, 'session'))
app.on('window-all-closed', () => {})
const wait = async (name: string, read: () => any) => {
  const until = Date.now() + 15000
  do { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 25)) } while (Date.now() < until)
  throw new Error('Native condition did not settle: ' + name)
}
const page = (kind: string) => `<!doctype html><html><meta charset="UTF-8"><style>body{margin:24px;background:${kind === 'HTTP' ? '#d6efe8' : '#eee0c9'};color:#24382f;font:18px system-ui}input,textarea{font:inherit;width:90%;padding:10px;margin:10px 0}button{padding:10px}</style><h1>${kind} original form</h1><p>One original page, one exact native window.</p><form onsubmit="event.preventDefault();globalThis.submits++"><label>Unsubmitted title<input id="title" value="Original ${kind} title"></label><label>Draft<textarea id="draft">Original ${kind} draft</textarea></label><button>Submit</button></form><script>globalThis.documentToken=Math.random();globalThis.submits=0</script></html>`
const receipt: any = { passed: false, phase, pid: process.pid, ipc: [], coldWakeRequests: [], assertions: [], frames: [], boundary: 'Real WorkspaceWorkbench/BrowserPane and WorkbenchWindows/BrowserViewManager/AppCaptureSource. Private HTTP and file pages, no user App, Agent, Runtime or remote website. Forms are preserved only within one process; restart proves durable Browser/window identity and accurate native host.' }
let manager: BrowserViewManager, owner: WorkbenchWindows, profiles: BrowserProfileManager, main: BrowserWindow
let server: ReturnType<typeof createServer>
const ids = ['native-http-form', 'native-file-form']
const original = new Map<string, { contents: number; navigation: string; token: number }>()
const views = new Map<string, WebContentsView>()
async function finish(result: any) {
  Object.assign(receipt, result)
  if (receipt.coldWakeRequests.length) { receipt.passed = false; receipt.unrelatedColdViolation = true }
  try { await owner?.prepareQuit() } catch (error) { receipt.cleanupFailure = String(error); receipt.passed = false }
  try { manager?.dispose(); owner?.dispose(); await profiles?.dispose() } catch (error) { receipt.cleanupFailure = String(error); receipt.passed = false }
  server?.closeAllConnections(); server?.close()
  await writeFile(join(evidence, phase + '.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed ? 0 : 1)
}
app.whenReady().then(async () => {
  try {
    let port = 0
    if (phase === 'restore') port = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8')).port
    server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(page('HTTP')) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    port = (server.address() as { port: number }).port
    await writeFile(join(directory, 'server.json'), JSON.stringify({ port }))
    await writeFile(join(directory, 'source.html'), page('FILE'))
    main = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    main.webContents.on('console-message', (_event, ...args) => console.log('Renderer:', ...args))
    profiles = new BrowserProfileManager(new BrowserProfileStore(join(directory, 'profiles.json')))
    await profiles.initialize()
    manager = new BrowserViewManager(main, profiles, new BrowserRefLedgerStore(join(directory, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} })
    owner = new WorkbenchWindows(main, new WorkbenchWindowStore(join(directory, 'windows.json')), () => [{ x: 0, y: 0, width: 1600, height: 1200 }])
    manager.setPresentationWindowOwner((document, occurrence) => 'kind' in occurrence ? owner.windowForDocument(document) : owner.presentationWindow(document, occurrence))
    owner.setNativeOwner({ beforeClosing: window => manager.returnWindow(window) })
    main.webContents.setWindowOpenHandler(details => owner.windowOpen(details, () => { throw new Error('No external navigation') }))
    main.webContents.on('did-create-window', (window, details) => owner.createdWindow(window, details))
    const urls = ['http://127.0.0.1:' + port + '/', pathToFileURL(join(directory, 'source.html')).href]
    for (let index = 0; index < ids.length; index++) {
      const before = new Set(main.contentView.children)
      await manager.create(ids[index]!, urls[index]!, 'native-resource')
      const added = main.contentView.children.filter(view => !before.has(view) && 'webContents' in view) as WebContentsView[]
      assert.equal(added.length, 1, 'Native creation contributes exactly its original page view')
      views.set(ids[index]!, added[0]!)
    }
    for (const id of ids) {
      const contents = views.get(id)!.webContents
      await wait(id + ' original page', async () => { try { return !contents.isLoading() && await contents.executeJavaScript('Boolean(document.querySelector("#draft")&&globalThis.documentToken)') } catch { return false } })
      original.set(id, { contents: contents.id, navigation: (await manager.restore(id)).navigationId!, token: await contents.executeJavaScript('documentToken') })
    }
    const browserCall = async (event: Electron.IpcMainInvokeEvent, method: string, args: any[]) => {
      const fact: any = { method, args }; receipt.ipc.push(fact)
      if (method === 'registerPresentation' && args[0]?.browserId === 'unrelated-cold-page' || method === 'restore' && args[0] === 'unrelated-cold-page') {
        receipt.coldWakeRequests.push(fact)
        throw new Error('An unrelated hidden cold Browser must not be awakened by another window')
      }
      const frame = event.senderFrame
      if (method === 'registerPresentation') { const input = args[0]; await manager.prepareForConsumption(input.browserId); return manager.registerPresentation(event.sender, frame, input, frame ? { processId: frame.processId, frameToken: frame.frameToken } : null) }
      if (method === 'updatePresentation') return manager.updatePresentation(event.sender, frame, args[0], args[1])
      if (method === 'removePresentation') return manager.removePresentation(event.sender, frame, args[0])
      if (method === 'activatePresentation') { const result = await manager.activatePresentation(event.sender, frame, args[0], args[1]); fact.result = result; return result }
      if (method === 'armPresentationCapture') return manager.armPresentationCapture(event.sender, frame, args[0])
      if (method === 'ackPresentationCapture') return manager.ackPresentationCapture(event.sender, frame, args[0], args[1])
      if (method === 'setBounds') return manager.setBounds(args[0], args[1])
      if (method === 'restore') return manager.restore(args[0])
      if (method === 'cancelElementSelection') return manager.cancelElementSelection(args[0])
      if (method === 'setAnnotationMarkers') return manager.setAnnotationMarkers(args[0], args[1], args[2])
      if (method === 'recoveryPreview') return { status: 'unavailable' }
      throw new Error('Unregistered critical Browser operation: ' + method)
    }
    ipcMain.handle('native-window:browser', browserCall)
    ipcMain.handle('native-window:data', async () => ({ pages: await Promise.all(ids.map(id => manager.restore(id))), phase }))
    ipcMain.handle('native-window:call', (_event, method, input) => owner.call(method, input, { actor: { kind: 'user', id: 'private-native-proof' } }))
    ipcMain.handle('native-window:ready', event => owner.rendererReady(event))
    ipcMain.on('native-window:response', (event, response) => owner.accept(event, response))
    ipcMain.handle('native-window:inspect', async (_event, label, expectation, input) => {
      let info = await owner.call('app.window.ls', {}, { actor: { kind: 'user', id: 'private-native-proof' } })
      if (expectation === 'child') await wait(label + ' native owner', () => ids.filter(id => input.ids.includes(id)).every(id => {
        const view = views.get(id)!, target = owner.windowForDocument(input.window)
        return manager.windowForView(view) === target && target.contentView.children.includes(view) && !main.contentView.children.includes(view) && view.getVisible()
      }))
      if (expectation === 'hidden') await wait(label + ' hidden original', () => input.ids.every((id: string) => !views.get(id)!.getVisible()))
      if (expectation === 'main') await wait(label + ' Main native owner', () => input.ids.every((id: string) => manager.windowForView(views.get(id)!) === main && views.get(id)!.getVisible()))
      const state = await Promise.all(ids.map(async id => {
        const view = views.get(id)!, contents = view.webContents, before = original.get(id)!
        const form = await contents.executeJavaScript('({title:document.querySelector("#title").value,draft:document.querySelector("#draft").value,token:documentToken,submits})')
        assert.equal(contents.id, before.contents, 'Original WebContents remains unchanged')
        assert.equal((await manager.restore(id)).navigationId, before.navigation, 'Window moves never navigate')
        assert.equal(form.token, before.token, 'Window moves retain the same page DOM')
        assert.equal(form.submits, 0, 'No form is submitted')
        return { id, contents: contents.id, navigation: before.navigation, form, visible: view.getVisible(), host: manager.windowForView(view) === main ? 'main' : 'child', bounds: view.getBounds() }
      }))
      assert.equal(receipt.coldWakeRequests.length, 0, 'Unrelated hidden cold Browser has zero prepare/register/restore requests')
      receipt.assertions.push({ label, expectation, state, unrelatedColdWakeRequests: receipt.coldWakeRequests.length })
      // The original lease can settle before the asynchronous shell open receipt.
      // Read the current descriptor after the native condition, not a pending pre-wait projection.
      await wait(label + ' visible window receipt', async () => {
        info = await owner.call('app.window.ls', {}, { actor: { kind: 'user', id: 'private-native-proof' } })
        return expectation !== 'child' || info.windows.some(window => window.windowId === input.window.windowId && window.presentation === 'visible')
      })
      const pixel = new AppCaptureSource(owner, manager)
      for (const window of info.windows) {
        if (window.presentation !== 'visible') continue
        const frame = await wait(label + ' stable native pixels', async () => {
          try { return await pixel.capture({ windowId: window.windowId, documentGeneration: window.documentGeneration! }) }
          catch (error: any) { if (error.code === 'APP_CAPTURE_FRAME_CHANGED') return null; throw error }
        })
        if (!window.target && expectation === 'child') assert.ok(!frame.layers.some((layer: any) => input.ids.includes(layer.browserId)), 'Main contains no detached Browser native layer')
        const file = label + '-' + (window.target ? 'child' : 'main') + '.png'
        await writeFile(join(evidence, file), Buffer.from(frame.image.data, 'base64'))
        receipt.frames.push({ file, label, target: frame.target, layers: frame.layers, bounds: frame.bounds })
      }
      return state
    })
    ipcMain.handle('native-window:fill', async () => {
      for (const id of ids) await views.get(id)!.webContents.executeJavaScript(`document.querySelector('#title').value=${JSON.stringify('Unsent title ' + id)};document.querySelector('#draft').value=${JSON.stringify('Unsubmitted draft ' + id)}`)
    })
    ipcMain.handle('native-window:done', (_event, result) => finish(result))
    await main.loadFile(join(directory, 'renderer/index.html'), { query: { phase } }); main.showInactive()
  } catch (error: any) { await finish({ passed: false, failure: { message: error.message, stack: error.stack } }) }
})
