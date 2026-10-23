import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { BrowserWindow, type WebContentsView } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserCdpSession } from '../../../src/main/browser-cdp-session'
import { createBrowserPageDispatch } from '../../../src/main/browser-page-dispatch'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import type { NativeOverlayRegion } from '../../../src/shared/native-overlay'
import { proof, output, delay, wait, screenshot } from './common'

void proof(async receipt => {
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0;background:#e4e9ed}button{position:fixed;left:10px;top:10px;width:110px;height:80px}input{position:fixed;left:140px;top:20px}</style><button onclick="clicks++">Original action</button><input value="Original Browser draft"><script>window.clicks=0;window.keys=0;window.wheels=0;addEventListener("keydown",()=>keys++);addEventListener("wheel",()=>wheels++);</script>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } })
  await window.loadURL('data:text/html,<style>body{margin:0;background:#26313b}aside{position:fixed;left:300px;top:200px;width:240px;height:120px;background:#303943;color:white}</style><aside>Original pending confirmation</aside>')
  const manager = new BrowserViewManager(window, { defaultProfileId: () => 'isolated', resolvePartition: profileId => 'modal-boundary-' + profileId },
    new BrowserRefLedgerStore(join(output, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  let surfaces: NativeOverlaySurfaces | undefined
  try {
    const id = 'original-browser'
    await manager.create(id, `http://127.0.0.1:${port}/`, 'original-workspace', undefined, undefined, 'responsive', { agent: { hostId: 'original-host', agentSessionId: 'original-agent' } })
    manager.setBounds(id, { x: 0, y: 0, width: 800, height: 600 }); window.showInactive()
    const page = manager.nativeOwner(id)!.view, originalContents = page.webContents, originalId = originalContents.id
    page.webContents.debugger.attach('1.3')
    const read = (source: string) => page.webContents.executeJavaScript(source)
    await wait(() => read('typeof clicks === "number"'), 'Original local Browser page must load')
    const facts = async () => ({ clicks: await read('clicks'), keys: await read('keys'), wheels: await read('wheels'), draft: await read('document.querySelector("input").value') })
    const cdpFailures: string[] = []
    const cdp = async (label: string) => {
      const before = await facts(), commands = []
      for (const type of ['mousePressed', 'mouseReleased']) commands.push(await page.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 30, y: 30, button: 'left', clickCount: 1 }))
      await delay(40); const after = await facts(); receipt.cases.push({ label, route: 'original-page-CDP', before, after, commands })
      if (after.clicks !== before.clicks + 1) cdpFailures.push(label)
    }
    const human = async (label: string, blocked: boolean) => {
      const p = page.getBounds(), point = { x: p.x + 30, y: p.y + 30 }
      const hit = [...window.contentView.children].reverse().find(view => { const b = view.getBounds(); return view.getVisible() && point.x >= b.x && point.y >= b.y && point.x < b.x + b.width && point.y < b.y + b.height }) as WebContentsView
      assert.ok(hit, 'Actual native hit owner is required')
      if (blocked) assert.notEqual(hit, page, 'input human hit owner must be a sibling native barrier during ' + label)
      const before = await facts(), b = hit.getBounds()
      for (const type of ['mouseDown', 'mouseUp'] as const) hit.webContents.sendInputEvent({ type, x: point.x - b.x, y: point.y - b.y, button: 'left', clickCount: 1 })
      hit.webContents.focus()
      for (const type of ['keyDown', 'keyUp'] as const) hit.webContents.sendInputEvent({ type, keyCode: 'A' })
      hit.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x - b.x, y: point.y - b.y, deltaY: 20, deltaX: 0 })
      await delay(60); const after = await facts(); receipt.cases.push({ label, route: 'native-top-hit-synthetic-input', hit: hit.webContents.id, before, after })
      assert.equal(after.clicks, before.clicks + (blocked ? 0 : 1), 'input native click has the original modal isolation effect during ' + label)
      if (blocked) { assert.equal(after.keys, before.keys, 'input native keyboard stays outside the background Browser'); assert.equal(after.wheels, before.wheels, 'input native wheel stays outside the background Browser') }
    }
    const warnings: unknown[] = []
    surfaces = new NativeOverlaySurfaces(window, manager, (message, modalId) => warnings.push({ message, modalId }), () => {})
    const pair = (modal: string, offset = 0): NativeOverlayRegion[] => [
      { id: 'chrome-' + (1 + offset), bounds: { x: 0, y: 0, width: 800, height: 600 }, radius: 0, scrim: 'rgba(0,0,0,.5)', modal: { id: modal, part: 'scrim' } },
      { id: 'chrome-' + (2 + offset), bounds: { x: 300, y: 200, width: 240, height: 120 }, radius: 8, modal: { id: modal, part: 'content' } }
    ]
    await human('before-modal', false); await cdp('before-modal')
    const capture = window.webContents.capturePage.bind(window.webContents)
    let release!: () => void, held = false
    window.webContents.capturePage = (async (...args: any[]) => { if (args[0] && !held) { held = true; await new Promise<void>(resolve => { release = resolve }) } return capture(...args) }) as typeof window.webContents.capturePage
    const preparing = surfaces.update(pair('original-modal'))
    await wait(() => held, 'Original modal must reach held content capture after native barrier preparation')
    try { await cdp('preparing-modal'); await human('preparing-modal', true) } finally { release?.() }
    const prepared = await preparing; assert.equal(prepared.projected, 2, 'Original required pair must commit after preparation')
    window.webContents.capturePage = capture
    await cdp('visible-modal'); await human('visible-modal', true)
    page.webContents.debugger.detach()
    const pageSession = BrowserCdpSession.attach(page.webContents)
    try {
      const dispatch = createBrowserPageDispatch({ session: pageSession,
        pageInfo: () => ({ url: page.webContents.getURL(), title: page.webContents.getTitle(), navigationId: 'original-navigation' }),
        gotoUrl: async () => { throw new Error('This private action does not navigate') }, captureScreenshot: async () => page.webContents.capturePage(),
        readLedger: async () => null, writeLedger: async () => {}, note: () => {} })
      const snapshot = await dispatch('snapshot', []) as { nodes: Array<{ role: string; name: string; ref: string }> }
      const target = snapshot.nodes.find(node => node.role === 'button' && node.name === 'Original action')
      assert.ok(target?.ref, 'Original public Browser dispatcher must discover the actual action ref')
      const before = await facts(); await dispatch('click', [target.ref]); await delay(40); const after = await facts()
      receipt.cases.push({ label: 'public-browser-dispatch-through-modal', target, before, after })
      assert.equal(after.clicks, before.clicks + 1, 'input public Browser dispatcher still performs the original action through a visible modal')
      const protocolBefore = await facts(), commands = []
      for (const type of ['mousePressed', 'mouseReleased']) commands.push(await dispatch('cdp', ['Input.dispatchMouseEvent', { type, x: 30, y: 30, button: 'left', clickCount: 1 }]))
      await delay(40); const protocolAfter = await facts()
      receipt.cases.push({ label: 'public-browser-cdp-through-modal', protocolBefore, protocolAfter, commands })
      if (protocolAfter.clicks !== protocolBefore.clicks + 1) cdpFailures.push('public-browser-cdp-through-modal')
      assert.deepEqual(cdpFailures, [], 'input CDP must still perform the original Browser action through both original debugger and public dispatcher')
    } finally { assert.equal(pageSession.detach(), null, 'The exact private public-dispatch session releases its original debugger') }
    page.webContents.debugger.attach('1.3')
    const modalShield = manager.nativeOwner(id)!.inputShield
    manager.returnControl(id); await wait(() => manager.nativeOwner(id)?.inputShield === modalShield, 'Agent and modal reuse one original native input surface')
    await surfaces.update([]); assert.equal(manager.nativeOwner(id)!.inputShield, modalShield, 'Releasing modal retains the original Agent input barrier')
    await cdp('agent-only'); await human('agent-only', true)
    await surfaces.update(pair('retained-modal')); manager.takeControl(id)
    assert.equal(manager.nativeOwner(id)!.inputShield, modalShield, 'Returning Agent control to human retains the still-open modal barrier')
    await cdp('human-owner-modal'); await human('human-owner-modal', true)
    await surfaces.update([...pair('retained-modal'), ...pair('nested-modal', 2)]); await cdp('nested-modal'); await human('nested-modal', true)
    await surfaces.update(pair('retained-modal')); await human('nested-dismiss-retains-parent', true)
    await surfaces.update([]); await wait(() => !manager.nativeOwner(id)?.inputShield, 'Closing the last modal releases its exact native input surface')
    await human('after-modal', false); await cdp('after-modal')
    window.webContents.capturePage = (async (...args: any[]) => { if (args[0]) throw new Error('Private original content failure'); return capture(...args) }) as typeof window.webContents.capturePage
    const failed = await surfaces.update(pair('failed-modal')); receipt.cases.push({ label: 'failed-modal', failed, warnings })
    assert.equal(failed.failures?.length, 1); assert.equal(manager.nativeOwner(id)!.inputShield, undefined, 'Presentation failure releases only its original modal barrier')
    window.webContents.capturePage = capture
    await cdp('after-presentation-failure'); await human('after-presentation-failure', false)
    assert.deepEqual(cdpFailures, [], 'input CDP must still perform the original Browser action after modal lifecycle transitions')
    assert.equal(page.webContents.id, originalId, 'Every modal transition retains the original Browser owner')
    assert.equal((await facts()).draft, 'Original Browser draft', 'Original Browser unsent draft is preserved')
    await surfaces.update(pair('profile-change-modal'))
    const retiringShield = manager.nativeOwner(id)!.inputShield!, retiringContents = retiringShield.webContents
    await manager.switchProfile(id, 'replacement')
    await wait(() => originalContents.isDestroyed() && retiringContents.isDestroyed(), 'Replacing the original page retires its exact page and modal input surface')
    const replacement = manager.nativeOwner(id)!
    receipt.cases.push({ label: 'profile-change-retires-original-surface', originalPage: originalId, replacementPage: replacement.view.webContents.id,
      originalPageDestroyed: originalContents.isDestroyed(), originalShieldDestroyed: retiringContents.isDestroyed() })
    assert.notEqual(replacement.view.webContents.id, originalId, 'A profile change confirms a new native page incarnation')
    assert.equal(window.contentView.children.includes(retiringShield), false, 'No retired modal input surface remains attached to the healthy Browser window')
    await surfaces.update(pair('replacement-modal')); await surfaces.update([])
    receipt.screenshots.push(await screenshot(window, 'input-original-browser'))
  } finally { surfaces?.dispose(); manager.dispose(); server.close() }
})
