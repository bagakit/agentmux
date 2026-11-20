import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, webContents } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'

const out = process.env.AGENTMUX_POINTER_OUTPUT!, privateRoot = process.env.AGENTMUX_POINTER_PRIVATE!
const mode = process.env.AGENTMUX_POINTER_MODE!
assert.ok(['dialog', 'popover'].includes(mode))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const page = `<!doctype html><meta charset="utf-8"><style>
body{margin:30px;background:#eee;color:#222;font:20px system-ui}button{padding:15px;margin:20px}
dialog,[popover]{padding:25px;background:white;border:2px solid #222}::backdrop{background:#0002}
</style><h1>Private Browser action feedback</h1><p>The original page keeps its own native ${mode}.</p>
<dialog id="scene"><h2>Native dialog</h2><button>Actual target</button></dialog>
<section id="panel" popover="manual"><h2>Native popover</h2><button>Actual target</button></section>`
const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(page) })
const readHud = `(()=>{const s=globalThis.__agentMuxBrowserOperationFeedback;if(!s)return null;const p=s.shadow?.querySelector('.pointer');const r=p?.getBoundingClientRect();return {operationId:s.operationId,navigationId:s.navigationId,token:s.token,phase:s.phase,kind:s.kind,hostConnected:!!s.host?.isConnected,popoverOpen:!!s.host?.matches(':popover-open'),point:s.point,viewport:{width:innerWidth,height:innerHeight},pointer:r?{x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(p).display}:null}})()`
const receipt: any = { schema: 'agentmux.browser-pointer-top-layer.native.v1', mode, passed: false,
  observation: 'Private actual BrowserViewManager and native compositor capture. Does not certify OS composition, physical input, installed Desktop or Core Run recovery.',
  targets: [], sourceFocus: {}, cleanup: [] }
let manager: BrowserViewManager | undefined, profiles: BrowserProfileManager | undefined, window: BrowserWindow | undefined
app.on('window-all-closed', () => {})
try {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  window = new BrowserWindow({ width: 1000, height: 800, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, focusOnNavigation: false } })
  await window.loadURL('data:text/html,<title>Private pointer proof</title>')
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(privateRoot, 'profiles.json')))
  await profiles.initialize()
  manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(privateRoot, 'refs.json')))
  await manager.create('pointer-page', url, 'pointer-workspace')
  manager.setBounds('pointer-page', { x: 20, y: 20, width: 930, height: 720 })
  window.showInactive()
  const contents = manager.nativeOwner('pointer-page')!.view.webContents
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!contents.isLoading() && await contents.executeJavaScript('document.querySelectorAll("button").length===2')) break
    await pause(20)
  }
  assert.equal(await contents.executeJavaScript('document.querySelectorAll("button").length'), 2)
  await contents.executeJavaScript(mode === 'dialog' ? 'document.querySelector("#scene").showModal()' : 'document.querySelector("#panel").showPopover()')
  receipt.scene = await contents.executeJavaScript('({dialog:document.querySelector("#scene").open,popover:document.querySelector("#panel").matches(":popover-open"),active:document.activeElement?.textContent})')
  receipt.sourceFocus.before = webContents.getFocusedWebContents()?.id ?? null
  const send = contents.debugger.sendCommand.bind(contents.debugger)
  const handles = new Map<string, number>(), reads: Promise<unknown>[] = []
  contents.debugger.sendCommand = ((method: string, params: any = {}, sessionId?: string) => {
    const work = send(method, params, sessionId)
    void work.then((result: any) => {
      if (method === 'DOM.resolveNode' && params.executionContextId && result.object?.objectId) handles.set(result.object.objectId, params.executionContextId)
      const payload = params.arguments?.[0]?.value
      if (method !== 'Runtime.callFunctionOn' || payload?.kind !== 'target' || payload.phase !== 'running') return
      const contextId = handles.get(params.objectId)
      assert.ok(contextId, 'The actual target has its original isolated context')
      const target: any = { operationId: payload.operationId, navigationId: payload.navigationId, token: payload.token, contextId }
      receipt.targets.push(target)
      // Observe the original result without awaiting a reader inside the page action.
      reads.push(send('Runtime.evaluate', { contextId, expression: readHud, returnByValue: true }, sessionId).then((read: any) => {
        assert.equal(read.exceptionDetails, undefined); target.hud = read.result?.value
      }))
    }).catch(() => {})
    return work
  }) as typeof contents.debugger.sendCommand
  receipt.operation = await manager.runScript('pointer-page', `const page=await snapshot();const node=page.nodes.find(node=>node.role==='button'&&node.name==='Actual target');if(!node)throw new Error('The original target is absent');await hover(node.ref);return {navigationId:page.navigationId}`, { id: 'pointer-agent', name: 'Page collaborator' }, undefined, 'pointer-operation')
  await Promise.all(reads)
  assert.equal(receipt.operation.outcome.kind, 'completed')
  assert.equal(receipt.targets.length, 1)
  const target = receipt.targets[0], hud = target.hud
  assert.equal(hud.operationId, receipt.operation.runOperation.id)
  assert.equal(hud.navigationId, target.navigationId); assert.equal(hud.token, target.token)
  // The pixel oracle keeps the original target's measured position even when a
  // display failure correctly clears its cue. It does not borrow mutant HUD data.
  const geometry = await contents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(mode === 'dialog' ? '#scene button' : '#panel button')}).getBoundingClientRect();return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,width:32,height:32,viewport:{width:innerWidth,height:innerHeight}}})()`)
  await pause(80) // Capture observation only; the real action never waits for this.
  const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  const size = image.getSize(), bitmap = image.toBitmap(), point = geometry
  assert.equal(bitmap.length, size.width * size.height * 4)
  const sx = size.width / geometry.viewport.width, sy = size.height / geometry.viewport.height
  let greenPixels = 0
  for (let y = Math.max(0, Math.floor((point.y - 2) * sy)); y < Math.min(size.height, Math.ceil((point.y + point.height + 2) * sy)); y++) {
    for (let x = Math.max(0, Math.floor(point.x * sx)); x < Math.min(size.width, Math.ceil((point.x + point.width) * sx)); x++) {
      const offset = (y * size.width + x) * 4, b = bitmap[offset]!, g = bitmap[offset + 1]!, r = bitmap[offset + 2]!
      if (g > r + 25 && g > b + 15 && g > 100) greenPixels++
    }
  }
  receipt.image = { path: join(out, mode + '.png'), size, greenPixels, source: 'original-page-capturePage-native-image', roi: point, scale: { x: sx, y: sy } }
  await writeFile(receipt.image.path, image.toPNG())
  receipt.sourceFocus.after = webContents.getFocusedWebContents()?.id ?? null
  receipt.sceneAfter = await contents.executeJavaScript('({dialog:document.querySelector("#scene").open,popover:document.querySelector("#panel").matches(":popover-open"),active:document.activeElement?.textContent})')
  assert.deepEqual(receipt.sceneAfter, receipt.scene, 'The display does not close the page layer or change its DOM focus')
  assert.equal(receipt.sourceFocus.after, receipt.sourceFocus.before, 'The feedback does not change native keyboard focus')
  assert.ok(greenPixels > 25, 'Actual pointer pixels remain visible above the native page layer')
  assert.equal(hud.hostConnected, true); assert.equal(hud.pointer.display, 'flex'); assert.equal(hud.popoverOpen, true)
  receipt.passed = true
} catch (error: any) {
  receipt.failure = { code: error.code, message: error.message, stack: error.stack }
} finally {
  for (const [name, dispose] of [['page', () => manager?.close('pointer-page')], ['profiles', () => profiles?.dispose()], ['window', () => window?.destroy()]] as const) {
    try { await dispose() } catch (error) { receipt.cleanup.push({ name, error: String(error) }) }
  }
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ mode, passed: receipt.passed, pixels: receipt.image?.greenPixels, failure: receipt.failure }))
  app.exit(receipt.passed && receipt.cleanup.length === 0 ? 0 : 1)
}
