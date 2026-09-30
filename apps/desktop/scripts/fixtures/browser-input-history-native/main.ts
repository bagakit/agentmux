import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain } from 'electron'
import { BrowserInputHistoryStore } from '../../../src/main/browser-input-history'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import { senderTrust, assertSenderTrusted } from '../../../src/main/ipc-sender-trust'
import { NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL } from '../../../src/shared/contracts'

const privateRoot = process.env.AGENTMUX_HISTORY_PRIVATE_ROOT!, output = process.env.AGENTMUX_HISTORY_NATIVE_OUT!
const phase = process.env.AGENTMUX_HISTORY_NATIVE_PHASE!, compiledRoot = process.env.AGENTMUX_HISTORY_COMPILED_ROOT!
assert.ok(privateRoot.includes('agentmux-history-native-') && ['first', 'second'].includes(phase))
app.setPath('userData', join(privateRoot, 'userdata'))
app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('disk-cache-size', '1048576')
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
const receipt: any = { schema: 'agentmux.browser-input-history-component-native-process.v1', phase, pid: process.pid, versions: process.versions,
  scope: 'actual-shared-component-store-preload-native-overlay-only', taskComplete: false, passed: false, behaviorPassed: false,
  composedPageVisibility: 'pending-independent-review', fullNativeAcceptance: false,
  productCallerNativeMounted: false, fullDesktopRestore: false, osNativeImeCommit: 'not-tested', userAppRuntimeControl: [], systemClipboard: [],
  calls: [], actions: [], cases: [], images: [], assertions: [], warnings: [], actualNativeInput: [], producerAuthor: '/root/browser_input_history_main' }
let window: BrowserWindow, manager: BrowserViewManager, overlays: NativeOverlaySurfaces, profiles: BrowserProfileManager
let holdNextList = false, held: (() => void) | undefined
const history = new BrowserInputHistoryStore(join(privateRoot, 'browser-input-history'))
const browserId = 'private-history-original-page', workspaceId = 'private-history-resource'
async function read(): Promise<any> { return window.webContents.executeJavaScript('window.historyProbe.read()') }
async function until(label: string, fn: () => Promise<any>, ms = 5000): Promise<any> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const row = await fn(); if (row) return row; await wait(25) }
  throw new Error('Native observation timed out: ' + label)
}
async function command(method: string, params: any): Promise<any> {
  const row: any = { api: 'actual-renderer-CDP', method, params, webContentsId: window.webContents.id, startedAt: Date.now() }
  receipt.actions.push(row)
  try { return await window.webContents.debugger.sendCommand(method, params) }
  finally { row.returnedAt = Date.now() }
}
async function key(key: string, modifiers = 0): Promise<void> {
  const codes: Record<string, number> = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, a: 65 }
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: codes[key], modifiers,
    ...(key === 'a' && modifiers === 4 ? { commands: ['selectAll'] } : {}) })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: codes[key], modifiers })
}
async function click(selector: string): Promise<void> {
  const box = await window.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
  assert.ok(box, 'Actual mounted target exists: ' + selector)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 })
}
async function fill(text: string): Promise<void> {
  await click('input[role="combobox"]'); await key('a', 4)
  if (text) await command('Input.insertText', { text }); else await key('Backspace')
  await until('actual text ' + text, async () => (await read()).value === text)
}
async function snapshotFile(label: string, document: any): Promise<any> {
  const bytes = Buffer.from(JSON.stringify(document)), path = `${phase}-${label}.json`
  await writeFile(join(output, path), bytes); return { path, bytes: bytes.length, sha256: hash(bytes) }
}
async function screenshot(label: string): Promise<void> {
  const owner = manager.nativeOwner(browserId)!
  let composedCaptured = false
  for (const [kind, contents] of [['renderer-chrome', window.webContents], ['original-native-page', owner.view.webContents]] as const) {
    const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true }), bytes = image.toPNG()
    assert.ok(!image.isEmpty() && bytes.length > 8)
    const path = `${phase}-${label}-${kind}.png`; await writeFile(join(output, path), bytes)
    receipt.images.push({ phase, label, kind, path, bytes: bytes.length, sha256: hash(bytes), webContentsId: contents.id, size: image.getSize(), pid: process.pid })
  }
  try {
    const call = async (args: string[]) => {
      const { stdout } = await exec(process.env.AGENTMUX_HISTORY_ORCA ?? 'orca', ['computer', ...args, '--json'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
      const result = JSON.parse(stdout); assert.equal(result.ok, true); return result
    }
    const listed = await call(['list-windows', '--app', `pid:${process.pid}`])
    assert.equal(listed.result.app.pid, process.pid); assert.equal(listed.result.windows.length, 1)
    const id = listed.result.windows[0].id
    const captured = await call(['get-app-state', '--app', `pid:${process.pid}`, '--window-id', String(id)])
    assert.equal(captured.result.snapshot.app.pid, process.pid); assert.equal(captured.result.snapshot.window.id, id)
    assert.equal(captured.result.screenshotStatus.state, 'captured')
    const shot = captured.result.screenshot, bytes = shot.path ? await readFile(shot.path) : Buffer.from(shot.data, 'base64')
    const path = `${phase}-${label}-composed-window.png`; await writeFile(join(output, path), bytes)
    const metadata = await snapshotFile(label + '-os', { listed, captured: { ...captured, result: { ...captured.result, screenshot: { ...shot, data: undefined } } } })
    receipt.images.push({ phase, label, kind: 'actual-exact-pid-composed-window', path, bytes: bytes.length, sha256: hash(bytes), pid: process.pid, windowId: id, metadata })
    composedCaptured = true
  } catch (error: any) {
    const failure = await snapshotFile(label + '-os-failed', { message: error.message, stdout: error.stdout, stderr: error.stderr, code: error.code })
    receipt.warnings.push({ stage: 'OS-composed-window-capture', message: error.message, originalFailure: failure })
  }
  // A second actual OS window capture bypasses no permissions and does not ask AX to activate the window.
  // Its native window id comes from this live BrowserWindow, never another application's selection.
  try {
    const mediaSourceId = window.getMediaSourceId(), windowId = mediaSourceId.split(':')[1]
    assert.match(mediaSourceId, /^window:\d+:\d+$/)
    const path = `${phase}-${label}-native-window.png`, args = ['-x', '-l', windowId, join(output, path)], startedAt = Date.now()
    const actual = await exec('/usr/sbin/screencapture', args, { timeout: 15000 })
    const bytes = await readFile(join(output, path)); assert.ok(bytes.length > 8)
    const metadata = await snapshotFile(label + '-native-window', { api: '/usr/sbin/screencapture', args, startedAt, returnedAt: Date.now(),
      mediaSourceId, windowId: Number(windowId), pid: process.pid, browserWindowId: window.id, stdout: actual.stdout, stderr: actual.stderr,
      windowVisible: window.isVisible(), windowFocused: window.isFocused(), pageWebContentsId: owner.view.webContents.id,
      nativeBounds: owner.view.getBounds(), actualLayers: window.contentView.children.map(view => ({ bounds: view.getBounds(), visible: view.getVisible(), webContentsId: (view as any).webContents?.id })) })
    receipt.images.push({ phase, label, kind: 'actual-native-window-screencapture', path, bytes: bytes.length, sha256: hash(bytes), pid: process.pid, windowId: Number(windowId), metadata })
    composedCaptured = true
  } catch (error: any) {
    receipt.warnings.push({ stage: 'native-window-screencapture', message: error.message })
  }
  if (!composedCaptured) receipt.osCaptureMissing = true
}
async function keepPage(label: string): Promise<void> {
  const owner = manager.nativeOwner(browserId)!, contents = owner.view.webContents, bounds = owner.view.getBounds()
  assert.ok(owner.view.getVisible() && bounds.width > 0 && bounds.height > 0)
  const before = await contents.executeJavaScript('window.fixtureClicks'), x = Math.min(bounds.width - 10, 100), y = bounds.height - 18
  // This uses the actual current native owner at an uncovered bottom point, not a second DOM click.
  const covering = [...window.contentView.children].reverse().find(view => view.getVisible() && (() => { const b = view.getBounds(); return bounds.x + x >= b.x && bounds.x + x < b.x + b.width && bounds.y + y >= b.y && bounds.y + y < b.y + b.height })())
  assert.equal(covering, owner.view, 'Uncovered point belongs to the original native page')
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  const after = await until('one original page input', async () => { const result = await contents.executeJavaScript('({clicks:window.fixtureClicks,events:window.fixtureEvents})'); return result.clicks === before + 1 ? result : false })
  assert.equal(after.events.at(-1).trusted, true)
  receipt.cases.push({ label, original: { browserId, webContentsId: contents.id, scope: receipt.owner.scope, bounds, visible: owner.view.getVisible() }, beforeCounter: before, afterCounter: after.clicks, events: after.events })
}
async function run(): Promise<void> {
  await app.whenReady(); await mkdir(output, { recursive: true })
  app.setAccessibilitySupportEnabled(true)
  receipt.privateAccessibilitySupport = app.accessibilitySupportEnabled
  window = new BrowserWindow({ width: 620, height: 520, show: false, backgroundColor: '#111315', webPreferences: { preload: join(compiledRoot, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', (_event: any, level: any, message: any) => receipt.warnings.push({ stage: 'renderer-console', level, message }))
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(privateRoot, 'profiles.json'))); await profiles.initialize()
  manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(privateRoot, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('Private probe never opens system application') } })
  overlays = new NativeOverlaySurfaces(window, manager, message => { receipt.warnings.push({ stage: 'native-overlay', message }); window.webContents.send(NATIVE_OVERLAY_WARNING_CHANNEL, message) }, input => window.webContents.send(NATIVE_BROWSER_INPUT_CHANNEL, input))
  manager.onNativeInput = (owner, input) => overlays.forwardBrowserInput(owner, input)
  const created = await manager.create(browserId, process.env.AGENTMUX_HISTORY_PAGE_URL!, workspaceId)
  manager.setBounds(browserId, { x: 20, y: 98, width: 560, height: 382 })
  const target = { kind: 'browser', browserId, profileId: created.profileId }, scope = manager.inputHistoryScope(browserId, created.profileId)
  const original = manager.nativeOwner(browserId)!.view.webContents
  // Keep this private observation presenting beneath other owners' windows. This does not certify the product's default policy.
  receipt.observationCondition = { privateFixtureOnly: true, originalBackgroundThrottling: original.getBackgroundThrottling(), requestedBackgroundThrottling: false }
  original.setBackgroundThrottling(false)
  receipt.observationCondition.actualBackgroundThrottling = original.getBackgroundThrottling()
  await until('original page loaded in its actual owner', async () => !original.isLoading() && original.getURL() &&
    await original.executeJavaScript('document.readyState === "complete" && typeof window.fixtureClicks === "number"'))
  const loadedSnapshot = await manager.create(browserId, process.env.AGENTMUX_HISTORY_PAGE_URL!, workspaceId)
  receipt.owner = { browserId, scope, navigationId: loadedSnapshot.navigationId, pageWebContentsId: original.id, rendererWebContentsId: window.webContents.id,
    pageFrame: { processId: original.mainFrame.processId, routingId: original.mainFrame.routingId, url: original.mainFrame.url },
    rendererFrame: { processId: window.webContents.mainFrame.processId, routingId: window.webContents.mainFrame.routingId } }
  const scopeFor = (value: any) => { const s = value.kind === 'browser' ? manager.inputHistoryScope(value.browserId, value.profileId) : { workspaceId: value.workspaceId, profileId: profiles.defaultProfileId() }; assert.equal(s.workspaceId, workspaceId); profiles.resolvePartition(s.profileId); return s }
  for (const method of ['listInputHistory', 'recordInputHistory', 'removeInputHistory', 'clearInputHistory']) {
    ipcMain.handle('browser:' + method, async (event, value, ...args) => {
      assertSenderTrusted(senderTrust(('browser:' + method) as any, event.sender, window.webContents))
      const s = scopeFor(value), row: any = { method, senderWebContentsId: event.sender.id, target: value, scope: s, args, at: Date.now() }; receipt.calls.push(row)
      const result = method === 'listInputHistory' ? await history.list(s) : method === 'recordInputHistory' ? await history.record(s, args[0]) : (() => { assert.deepEqual(args[0], s); return method === 'removeInputHistory' ? history.remove(s, args[1]) : history.clear(s) })()
      row.result = await result
      if (method === 'listInputHistory' && holdNextList) { holdNextList = false; await new Promise<void>(resolve => { held = resolve }); row.heldUntil = Date.now() }
      row.returnedAt = Date.now(); return row.result
    })
  }
  ipcMain.handle('ui:publishNativeOverlays', async (event, regions) => {
    assertSenderTrusted(senderTrust('ui:publishNativeOverlays', event.sender, window.webContents))
    const result = await overlays.update(regions)
    receipt.actualNativeInput.push({ kind: 'overlay-publication', regions, result, at: Date.now(), pageOwner: manager.nativeOwner(browserId)?.bounds,
      actualLayers: window.contentView.children.map(view => ({ bounds: view.getBounds(), visible: view.getVisible(), webContentsId: (view as any).webContents?.id })) })
    return result
  })
  await window.loadFile(join(compiledRoot, 'index.html')); window.showInactive(); window.webContents.focus()
  window.webContents.debugger.attach('1.3')
  await until('actual mounted input', async () => window.webContents.executeJavaScript('!!window.historyProbe'))
  const configure = async (width: number, height: number) => {
    window.setContentSize(Math.ceil(width + 40), height)
    manager.setBounds(browserId, { x: 20, y: 98, width: Math.ceil(width), height: height - 118 })
    await window.webContents.executeJavaScript(`window.historyProbe.configure(${JSON.stringify(target)},${width})`)
    await wait(120)
  }
  await configure(560, 500)
  const path = join(privateRoot, 'browser-input-history', hash(Buffer.from(JSON.stringify([scope.workspaceId, scope.profileId]))) + '.json')
  if (phase === 'first') {
    await fill('first native history'); await key('Enter')
    await until('actual first record IPC finished', async () => receipt.calls.find((row: any) => row.method === 'recordInputHistory' && row.returnedAt))
    assert.equal((await history.list(scope)).entries[0]?.text, 'first native history', 'Actual native human submission is durably recorded')
    receipt.assertions.push({ label: 'actual-input-recorded', facts: await read() })
    await fill('https://example.invalid/path?q=keep%2Bcase#fragment'); await key('Enter')
    await until('second explicit submit', async () => (await history.list(scope)).entries.length === 2)
    await fill(''); await until('nonempty history panel', async () => (await read()).options.length === 2)
    await key('ArrowDown'); const selected = await read(); assert.equal(selected.options.filter((row: any) => row.selected === 'true').length, 1)
    await key('Escape'); const dismissed = await read(); assert.equal(dismissed.expanded, 'false')
    receipt.assertions.push({ label: 'keyboard-select-and-escape', selected, dismissed })
    // A real held Main list response arrives after new native edits; no synthetic DOM input.
    await click('button[aria-label="Submit address"]'); holdNextList = true
    await click('input[role="combobox"]'); await until('held actual Main list', async () => !!held)
    await command('Input.insertText', { text: 'new native draft' }); await key('ArrowLeft'); await key('ArrowLeft', 8)
    const before = await read(); held!(); held = undefined; await wait(100); const after = await read()
    assert.equal(after.value, before.value); assert.deepEqual(after.selection, before.selection); assert.equal(after.focused, before.focused)
    receipt.assertions.push({ label: 'late-main-list-keeps-draft-selection-focus', before, after })
    await fill(''); const submitBefore = (await read()).submissions.length
    await command('Input.imeSetComposition', { text: '输入', selectionStart: 2, selectionEnd: 2 })
    await key('Enter'); const during = await read(); assert.equal(during.submissions.length, submitBefore, 'Actual native composing Enter does not submit')
    await command('Input.insertText', { text: '输入' }); const committed = await read()
    const composition = committed.events.filter((e: any) => e.type.startsWith('composition'))
    assert.ok(composition.length > 0 && composition.some((e: any) => e.type === 'compositionstart' && e.trusted), 'Actual CDP composition start is trusted')
    receipt.assertions.push({ label: 'actual-CDP-composition-no-implicit-submit', during, committed, composition,
      trustedCommitObserved: composition.some((e: any) => e.type === 'compositionend' && e.trusted), osNativeImeCommit: 'not-tested' })
    for (const [kind, width, height] of [['normal', 560, 500], ['narrow', 234.5, 420], ['short', 560, 240]] as const) {
      const startAt = Date.now(), previousPublicationCount = receipt.actualNativeInput.length
      await configure(width, height); await fill(''); await key('ArrowDown')
      const publication = await until('this geometry actual native overlay is projected', async () => {
        const facts = await read(), panel = facts.panel
        return receipt.actualNativeInput.slice(previousPublicationCount).find((row: any) => row.at >= startAt && row.result.projected > 0 &&
          row.regions.some((region: any) => panel && Math.abs(region.bounds.x - panel.x) < 1 && Math.abs(region.bounds.y - panel.y) < 1 &&
            Math.abs(region.bounds.width - panel.width) < 1 && Math.abs(region.bounds.height - panel.height) < 1) &&
          row.pageOwner.width === Math.ceil(width) && row.pageOwner.height === height - 118)
      })
      await wait(180); const facts = await read(); assert.ok(facts.options.length > 0 && facts.panel && facts.panel.height > 0)
      assert.ok(facts.panel.x >= 0 && facts.panel.y >= 0 && facts.panel.x + facts.panel.width <= facts.viewport.width + .5 && facts.panel.y + facts.panel.height <= facts.viewport.height + .5)
      receipt.assertions.push({ label: 'actual-' + kind + '-history', geometry: { paneWidth: width, contentHeight: height }, publication, facts })
      await screenshot(kind); await keepPage(kind); await key('Escape')
    }
    receipt.durable = { saved: await history.list(scope), file: await snapshotFile('saved-history-original', JSON.parse(await readFile(path, 'utf8'))) }
  } else {
    const recovered = await history.list(scope); assert.ok(recovered.entries.length > 0)
    receipt.durable = { recovered, file: await snapshotFile('recovered-history-original', JSON.parse(await readFile(path, 'utf8'))) }
    await fill(''); await key('ArrowDown'); await until('original saved history recovered in real input', async () => (await read()).options.length === recovered.entries.length)
    await click('.browser-address-history__delete'); await until('actual remove changed durable history', async () => (await history.list(scope)).entries.length === recovered.entries.length - 1)
    await click('.browser-address-history > header button'); await until('actual clear persisted', async () => (await history.list(scope)).entries.length === 0)
    receipt.durable.afterDeletion = await history.list(scope); receipt.durable.afterDeletionFile = await snapshotFile('deleted-history-original', JSON.parse(await readFile(path, 'utf8')))
    receipt.assertions.push({ label: 'second-process-actual-remove-clear', facts: await read() }); await keepPage('second-after-delete')
  }
  await history.flush()
  receipt.loaded = []
  for (const name of ['main.mjs', 'preload.cjs', 'renderer.js', 'renderer.css']) { const bytes = await readFile(join(compiledRoot, name)); receipt.loaded.push({ name, bytes: bytes.length, sha256: hash(bytes) }) }
  receipt.behaviorPassed = true; receipt.phaseCompleted = true
}
run().catch(error => { receipt.failure = { message: error.message, stack: error.stack }; receipt.behaviorPassed = false }).finally(async () => {
  try { receipt.finalRendererFacts = window && !window.webContents.isDestroyed() ? await read() : null } catch {}
  await mkdir(output, { recursive: true }); await writeFile(join(output, phase + '-receipt.json'), JSON.stringify(receipt))
  overlays?.dispose(); manager?.dispose(); await profiles?.dispose(); window?.destroy(); app.exit(receipt.behaviorPassed ? 0 : 1)
})
