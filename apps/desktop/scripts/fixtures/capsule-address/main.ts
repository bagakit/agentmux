import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { NodeCapsuleOwner } from '../../../../../packages/capsule/src/node'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import { readBookmark } from '../../../src/main/bookmark-file'
import { bookmarkKindForPath } from '../../../src/shared/bookmark-file'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserInputHistoryStore } from '../../../src/main/browser-input-history'
import { DesktopControlIpcBridge } from '../../../src/main/control-ipc-bridge'
import { NativeOverlayWindows } from '../../../src/main/native-overlay-windows'
import { CONTROL_REQUEST_CHANNEL, CONTROL_RESPONSE_CHANNEL, CONTROL_CANCEL_CHANNEL, WORKSPACE_FILE_INVALIDATED_CHANNEL } from '../../../src/shared/contracts'
import { SpatialLinkIngress } from '../../../src/main/spatial-link-ingress'
import { capsulePresentation, createCapsuleBrowserDocument, resolveCapsuleColdDocument } from '../../../src/main/capsule-presentation'
import { browserColdDescriptor } from '../../../src/main/browser-cold-descriptor'
import { sessionInputOperationResult } from '../../../src/shared/session-input-result'
import { mintObjectId, runProcess } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '../../../../../packages/core/src/spatial-state'

const [html, profile, evidence, phase, workspacePath, externalUrl, attemptId] = process.argv.slice(2) as string[]
const report: any = { schema: 'agentmux.capsule-address-native-process.v1', attemptId, phase, pid: process.pid, passed: false,
  frames: [], opens: [], controls: [], creates: [], navigations: [], writes: [], restore: [], handoffs: [], external: [], userRunTouched: false, console: [] }
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {},
  workspaces: [{ id: 'capsule-address-private', name: 'Capsule desk', hostId: 'local', path: workspacePath, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: false, screenshot: false, devTools: false, viewport: false, saveBookmark: true, more: true } } }
const workspace = (id: string) => { assert.equal(id, config.workspaces[0]!.id); return config.workspaces[0]! }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let win: BrowserWindow, owner: NodeCapsuleOwner, files: WorkspaceFiles, profiles: BrowserProfileManager,
  browsers: BrowserViewManager, chrome: NativeOverlayWindows
let objects: any, savedGraph: any = null
let controlBridge: DesktopControlIpcBridge
let spatial: AgentMuxSpatialStateStore, disposeSpatial: (() => void) | undefined
const observers = new Map<string, () => void | Promise<void>>()
const ingress = new SpatialLinkIngress()
app.on('window-all-closed', () => {})
const progress = async (stage: string) => { report.stage = stage; console.error('CAPSULE_ADDRESS ' + phase + ' ' + stage); await writeFile(join(evidence, phase + '-progress.json'), JSON.stringify(report, null, 2)) }
const evaluate = async (expression: string): Promise<any> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const response = await Promise.race([win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }),
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The private Renderer observation did not settle at ' + report.stage + ': ' + expression.slice(0, 160))), 10000) })]).finally(() => clearTimeout(timer))
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}
async function until(expression: string, message = expression) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await pause(40) }
  report.timeout = { message, body: await evaluate('document.body.innerText'), facts: await evaluate('window.capsuleAddressProbe?.facts()') }
  assert.fail(message)
}
const paint = async () => { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await pause(70) }
async function click(expression: string, contents = win.webContents) {
  const command = async (expression: string) => {
    const response = await contents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  if (!contents.debugger.isAttached()) await contents.debugger.attach('1.3')
  await command(`${expression}.scrollIntoView({block:'nearest'})`)
  const point = await command(`(()=>{const element=${expression};if(!element||element.disabled)throw Error('Original control unavailable');const box=element.getBoundingClientRect();if(!box.width||!box.height)throw Error('Original control hidden');return{x:box.x+box.width/2,y:box.y+box.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await pause(80)
}
async function type(contents: Electron.WebContents, text: string, enter = false) {
  const modifier = process.platform === 'darwin' ? 4 : 2
  for (const type of ['keyDown', 'keyUp']) await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: modifier, ...(type === 'keyDown' ? { commands: ['selectAll'] } : {}) })
  await contents.debugger.sendCommand('Input.insertText', { text })
  const input = await contents.debugger.sendCommand('Runtime.evaluate', { expression: 'document.activeElement?.value', returnByValue: true })
  assert.equal(input.result.value, text, 'Chromium must contain the exact newly typed bytes before submission')
  if (enter) for (const type of ['keyDown', 'keyUp']) await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', ...(type === 'keyDown' ? { text: '\r' } : {}) })
  await pause(80)
}
const active = `(()=>{const state=capsuleAddressProbe.facts(),layout=state.layouts[capsuleAddressProbe.workspaceId],group=layout.groups.find(group=>group.id===layout.activeGroupId),tab=state.liveTabs[group.activeTabId];return tab&&Object.values(tab.regions).find(region=>region.kind==='browser')})()`
const control = (label: string) => `(()=>{const page=${active};return document.querySelector('[data-workbench-region-id="'+page.regionId+'"] button[aria-label=${JSON.stringify(label)}]')})()`
const address = `(()=>{const page=${active};return document.querySelector('[data-workbench-region-id="'+page.regionId+'"] input[aria-label="Browser address"]')})()`
async function submit(value: string, enter = true) {
  const before = report.opens.length, navigationBefore = report.navigations.length
  await click(address); await type(win.webContents, value, enter)
  if (enter && value.startsWith('amux:')) {
    const deadline = Date.now() + 20000
    const result = () => report.opens.length > before ? report.opens.at(-1) : report.navigations.length > navigationBefore ? report.navigations.at(-1) : null
    while (Date.now() < deadline && !result()?.settled) await pause(30)
    assert.ok(result()?.settled, 'The exact object ingress or current Browser owner must return its original result')
    assert.equal(result().issue ?? result().error ?? null, null, 'The original owner must confirm the exact page and Browser')
  }
}
async function nativePage(url: string) {
  await until(`${active}?.url===${JSON.stringify(url)}`, 'The actual Browser snapshot must retain the exact network URL')
  const id = await evaluate(`${active}.browserId`)
  let page = browsers.nativeOwner(id)
  for (let tries = 0; tries < 250 && (!page || page.view.webContents.isLoading()); tries++) { await pause(40); page = browsers.nativeOwner(id) }
  assert.ok(page, 'The original BrowserViewManager owns the current native document')
  assert.equal(page.view.webContents.getURL(), url)
  return page.view.webContents
}
async function focusBrowser(browserId: string) {
  const deadline = Date.now() + 20000
  let locations: any[] = []
  do { locations = (await spatial.readForLayout())?.graph.regions.filter(region => region.browserId === browserId) ?? []
    if (locations.length === 1) break
    await pause(30)
  } while (Date.now() < deadline)
  assert.equal(locations.length, 1, 'The original Browser must have one exact retained Region')
  const { tabId, regionId } = locations[0]
  const result = await controlBridge.execute({ schemaVersion: 5, requestId: mintObjectId(), operation: 'focus', target: { kind: 'space', tabId, regionId }, inputPolicy: 'preserve' })
  assert.equal(result.operation, 'focus')
  if (result.operation === 'focus') assert.ok(['applied', 'unchanged'].includes(result.navigation.state))
  ;(report.exactFocus ??= []).push(result)
}
async function facts(contents: Electron.WebContents) {
  return contents.executeJavaScript(`({href:location.href,title:document.title,thought:document.querySelector('#thought')?.value,count:document.querySelector('#count')?.textContent,node:typeof require,app:typeof window.agentmux,storage:localStorage.getItem('original-thought')})`)
}
async function frame(name: string) {
  await progress('frame:' + name); await paint(); await chrome.refresh(); await paint()
  const image = await win.webContents.capturePage(), size = image.getSize(), scale = size.width / win.getContentBounds().width
  const root = name + '-root.png'; await writeFile(join(evidence, root), image.toPNG())
  const bitmap = Buffer.from(image.toBitmap()), layers: any[] = []
  assert.equal(bitmap.length, size.width * size.height * 4)
  for (const view of win.contentView.children) {
    if (view.webContents === win.webContents || !view.getVisible() || view.webContents.isDestroyed()) continue
    const bounds = view.getBounds(); if (!bounds.width || !bounds.height) continue
    const page = browsers.targets().map(target => browsers.nativeOwner(target.id)).find(page => page?.view === view)
    const original = await view.webContents.capturePage(), file = name + '-native-' + layers.length + '.png'
    await writeFile(join(evidence, file), original.toPNG())
    const width = Math.round(bounds.width * scale), height = Math.round(bounds.height * scale), pixels = original.resize({ width, height }).toBitmap()
    const x = Math.round(bounds.x * scale), y = Math.round(bounds.y * scale)
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
      if (x + col < 0 || y + row < 0 || x + col >= size.width || y + row >= size.height) continue
      const from = (row * width + col) * 4, to = ((y + row) * size.width + x + col) * 4, alpha = pixels[from + 3]! / 255
      for (let channel = 0; channel < 3; channel++) bitmap[to + channel] = Math.min(255, Math.round(pixels[from + channel]! + bitmap[to + channel]! * (1 - alpha)))
      bitmap[to + 3] = 255
    }
    layers.push({ file, bounds, browserId: page?.browserId ?? null, kind: page ? 'browser' : 'native-chrome', url: view.webContents.getURL(), pixelSize: original.getSize() })
  }
  const file = name + '.png'; await writeFile(join(evidence, file), nativeImage.createFromBitmap(bitmap, size).toPNG())
  const layout = await evaluate(`(()=>{const field=${address},rect=element=>{const box=element.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height}};return{address:field.value,rect:rect(field),controlRect:rect(field.closest('label')),appearance:document.documentElement.dataset.appearance,viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth}})()`)
  report.frames.push({ name, file, root: { file: root, pixelSize: size }, layers, layout,
    method: 'Composed workface from the actual Renderer root and actual visible native child captures in contentView order/bounds, including production native Chrome. Not an OS screenshot.' })
  assert.ok(layout.rect.width > 80 && layout.rect.height > 0 && layout.controlRect.height >= 24, 'The stable address text and its original label control must remain readable and reachable')
  assert.equal(layout.overflow, false)
}
async function capture() {
  await progress('keyboard-object-open')
  await evaluate('capsuleAddressProbe.create()')
  await until(`Boolean(${address})`, 'The actual production Browser address field must mount')
  await submit(objects.primary.uri)
  let page = await nativePage(objects.primary.endpoint)
  await until(`${address}.value===${JSON.stringify(objects.primary.uri)}`)
  const original = await evaluate(active), originalOwner = browsers.nativeOwner(original.browserId)!
  const opened = report.capsuleOpens.at(-1)
  assert.equal(opened.rendering.browserId, original.browserId); assert.equal(opened.rendering.regionId, original.regionId)
  assert.equal(original.objectLink, objects.primary.uri); assert.equal(original.capsuleId, objects.primary.id)
  assert.equal(original.profileId, null)
  await click(`document.querySelector('#thought')`, page); await type(page, 'An original thought retained across navigation and restart')
  await click(`document.querySelector('#increment')`, page)
  const before = await facts(page); assert.equal(before.count, '1'); assert.equal(before.node, 'undefined'); assert.equal(before.app, 'undefined')
  await progress('draft-survives-route-and-object-reopen')
  await submit('amux://capsule/UNSENT_ADDRESS_DRAFT', false)
  await click(`document.querySelector('#route')`, page)
  page = await nativePage(objects.primary.endpoint + 'chapter?section=2#detail')
  assert.equal(await evaluate(`${address}.value`), 'amux://capsule/UNSENT_ADDRESS_DRAFT')
  const route = await evaluate(active), routeFacts = await facts(page)
  report.routeNavigation = { route, routeFacts }
  assert.equal(route.browserId, original.browserId); assert.equal(routeFacts.thought, before.thought); assert.equal(routeFacts.count, '1')
  await submit(objects.primary.uri)
  await until(`${address}.value===${JSON.stringify(objects.primary.uri)}`)
  assert.equal((await evaluate(active)).navigationId, route.navigationId, 'Opening the same object keeps the existing route and native document')
  assert.equal(page, browsers.nativeOwner(original.browserId)!.view.webContents)
  report.original = { original, route, before, routeFacts, partitionIsIndependentOfProfile: true }
  await click(control('Open in external browser'))
  assert.deepEqual(report.external, [route.url], 'An explicit external-browser request keeps the actual HTTP route separate from the stable object reference')
  await progress('production-bookmark-write-and-open')
  await click(control('Save this page as a bookmark'))
  await until(`document.querySelector('[data-tree-path="Reading desk.webloc"]')`, 'The real Store and WorkspaceFiles writer must publish the bookmark')
  const bookmark = await readFile(join(workspacePath, 'Reading desk.webloc'), 'utf8')
  assert.ok(bookmark.includes(objects.primary.uri)); assert.ok(!bookmark.includes(objects.primary.endpoint))
  const creates = report.creates.length
  await click(`document.querySelector('[data-tree-path="Reading desk.webloc"]')`)
  await until(`capsuleAddressProbe.facts().surfaces.some(region=>region.kind==='browser'&&region.bookmarkOrigin?.path==='Reading desk.webloc')`, 'The original bookmark File action must create its exact Browser resource')
  const fileSelection = await evaluate('capsuleAddressProbe.facts().layouts')
  const bookmarkCreation = report.creates.slice(creates).find((create: any) => create.capsuleId === objects.primary.id && create.result)
  assert.ok(bookmarkCreation, 'The original native acquisition must return the bookmark Browser receipt')
  await focusBrowser(bookmarkCreation.id)
  const bookmarkedPage = await nativePage(objects.primary.endpoint), bookmarked = await evaluate(active)
  assert.notEqual(bookmarked.browserId, original.browserId, 'The original File bookmark action owns its new Browser destination')
  assert.notEqual(bookmarked.regionId, original.regionId)
  assert.equal(bookmarked.capsuleId, objects.primary.id); assert.equal(bookmarked.objectLink, objects.primary.uri)
  assert.ok(report.creates.slice(creates).some((create: any) => create.id === bookmarked.browserId && create.url === objects.primary.uri && create.capsuleId === objects.primary.id), 'The bookmark passes its exact canonical object and Capsule identity to the original native acquisition owner')
  assert.equal(bookmarkedPage.session, originalOwner.view.webContents.session, 'The same Capsule keeps its original persistent partition across displays')
  assert.equal(browsers.target(original.browserId)!.url, route.url, 'A new bookmark display does not replace the original subroute')
  report.bookmark = { text: bookmark, sha256: sha(bookmark), originalBrowser: original.browserId, bookmarked, fileSelectionBeforeExplicitFocus: fileSelection, creates: report.creates.slice(creates), writes: [...report.writes] }
  await focusBrowser(original.browserId)
  await nativePage(route.url)
  const duplicateGraph = (await spatial.readForLayout())!.graph
  const sameCapsuleDisplays = [...new Set(duplicateGraph.regions.filter(region => region.kind === 'browser' && region.browserId &&
    browserColdDescriptor(duplicateGraph, region.browserId).capsuleId === objects.primary.id).map(region => region.browserId))]
  assert.ok(sameCapsuleDisplays.length >= 2 && sameCapsuleDisplays.includes(original.browserId) && sameCapsuleDisplays.includes(bookmarked.browserId), 'The exact same Capsule must have two retained Browser identities for the contextual address proof')
  const multiBefore = await evaluate(active), opensBefore = report.opens.length, navigationsBefore = report.navigations.length
  await submit(objects.primary.uri)
  const multiAfter = await evaluate(active), selfNavigation = report.navigations[navigationsBefore]
  assert.equal(report.opens.length, opensBefore, 'Submitting this Browser own stable URI must keep its exact owner when another display exists')
  assert.equal(selfNavigation?.id, original.browserId); assert.equal(selfNavigation?.url, objects.primary.uri)
  assert.equal(multiAfter.navigationId, multiBefore.navigationId); assert.equal(multiAfter.url, route.url)
  assert.equal((await facts(page)).thought, before.thought)
  report.multipleDisplaysSelfAddress = { before: multiBefore, after: multiAfter, selfNavigation, sameCapsuleDisplays }
  await progress('different-capsule-keeps-original-partition')
  await submit(objects.secondary.uri)
  const secondary = await nativePage(objects.secondary.endpoint), second = await evaluate(active)
  assert.notEqual(second.browserId, original.browserId); assert.equal(second.capsuleId, objects.secondary.id)
  assert.notEqual(secondary.session, originalOwner.view.webContents.session, 'Another Capsule never occupies the original partition')
  await focusBrowser(original.browserId)
  page = await nativePage(route.url)
  assert.equal((await evaluate(active)).browserId, original.browserId)
  await progress('external-and-back')
  await submit(externalUrl)
  await nativePage(externalUrl); await until(`${address}.value===${JSON.stringify(externalUrl)}`)
  assert.equal((await evaluate(active)).objectLink, undefined)
  await click(control('Back'))
  page = await nativePage(route.url); await until(`${address}.value===${JSON.stringify(objects.primary.uri)}`)
  assert.equal((await facts(page)).thought, before.thought)
  assert.equal((await facts(page)).count, '1')
  report.externalBack = { externalUrl, browserId: original.browserId, returned: await facts(page) }
  await click(control('Reload'))
  page = await nativePage(route.url); await until(`${address}.value===${JSON.stringify(objects.primary.uri)}`)
  assert.equal((await facts(page)).thought, before.thought)
  for (const [name, width, theme] of [['normal-dark', 1180, 'dark'], ['normal-light', 1180, 'light'], ['narrow-dark', 700, 'dark'], ['narrow-light', 700, 'light']] as const) {
    win.setContentSize(width, 820); await evaluate(`capsuleAddressProbe.theme(${JSON.stringify(theme)})`); await pause(100); await frame(name)
  }
  win.setContentSize(1180, 820); await evaluate(`capsuleAddressProbe.theme('dark')`)
  await paint(); await evaluate('capsuleAddressProbe.flush()')
  const savedState = await spatial.readForLayout(); assert.ok(savedState); savedGraph = savedState.graph
  const expected = { durable: await evaluate('capsuleAddressProbe.durable()'), graph: savedGraph, page: await facts(page),
    spatialRevision: savedState.revision, active: await evaluate(active), primary: objects.primary, secondary: objects.secondary, bookmarkSha256: sha(bookmark) }
  await writeFile(join(profile, 'spatial-graph.json'), JSON.stringify(savedGraph, null, 2))
  await writeFile(join(evidence, 'expected-durable.json'), JSON.stringify(expected, null, 2))
  report.expected = expected
}
async function restart() {
  await progress('original-records-before-scene-setup')
  const expected = JSON.parse(await readFile(join(evidence, 'expected-durable.json'), 'utf8'))
  const stored = await evaluate('capsuleAddressProbe.spatialBeforeInitialize'), actual = await evaluate('capsuleAddressProbe.beforeFixture')
  const topology = (value: any) => { const result = structuredClone({ tabs: value.tabs, layouts: value.layouts, activeWorkspaceId: value.activeWorkspaceId });
    for (const tab of Object.values(result.tabs) as any[]) for (const region of Object.values(tab.regions) as any[]) if (region.kind === 'browser') delete region.title
    return result }
  assert.equal(stored.revision, expected.spatialRevision)
  assert.deepEqual(stored.graph, expected.graph, 'The second process must read the original Core spatial record before initialization')
  assert.deepEqual(topology(actual), topology(expected.durable), 'Initialization keeps the original Tab/Region/capsule/route/layout identities')
  assert.deepEqual(savedGraph, expected.graph, 'The original evidence snapshot agrees with the persisted Core record')
  const page = await nativePage(expected.active.url)
  await until(`${address}.value===${JSON.stringify(objects.primary.uri)}`)
  const restored = await evaluate(active), restoredFacts = await facts(page)
  assert.equal(restored.browserId, expected.active.browserId); assert.equal(restored.regionId, expected.active.regionId)
  assert.equal(restored.capsuleId, expected.active.capsuleId); assert.equal(restored.objectLink, objects.primary.uri)
  assert.equal(restoredFacts.thought, expected.page.thought); assert.equal(restoredFacts.count, expected.page.count)
  assert.equal(sha(await readFile(join(workspacePath, 'Reading desk.webloc'))), expected.bookmarkSha256)
  const creates = report.creates.length
  await click(`document.querySelector('[data-tree-path="Reading desk.webloc"]')`)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !report.creates.slice(creates).some((create: any) => create.capsuleId === objects.primary.id && create.result)) await pause(30)
  const creation = report.creates.slice(creates).find((create: any) => create.capsuleId === objects.primary.id && create.result)
  assert.ok(creation, 'The restarted File action must return a new accurate Capsule Browser receipt')
  await focusBrowser(creation.id)
  await nativePage(objects.primary.endpoint)
  const bookmarked = await evaluate(active)
  assert.notEqual(bookmarked.browserId, restored.browserId); assert.equal(bookmarked.capsuleId, objects.primary.id)
  assert.ok(report.creates.slice(creates).some((create: any) => create.id === bookmarked.browserId && create.capsuleId === objects.primary.id && create.url === objects.primary.uri))
  assert.equal(browsers.target(restored.browserId)!.url, expected.active.url)
  await focusBrowser(restored.browserId)
  await nativePage(expected.active.url)
  await click(`document.querySelector('#increment')`, page)
  assert.equal((await facts(page)).count, String(Number(expected.page.count) + 1))
  report.durable = { passed: true, expected: expected.active, restored, restoredFacts,
    originalCapsuleRecordReused: true, originalBrowserAndRegionReused: true, reSeeded: false }
  await frame('restored-dark')
}

try {
  await progress('private-paths-before-owner-load')
  report.loaded = { mainSha256: sha(await readFile(fileURLToPath(import.meta.url))), rendererHtmlSha256: sha(await readFile(html)),
    preloadSha256: sha(await readFile(join(profile, '..', 'preload.cjs'))) }
  report.executionEnvironment = { node: process.version, electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch }
  report.paths = Object.fromEntries(['home', 'appData', 'userData', 'sessionData'].map(name => [name, app.getPath(name as any)]))
  for (const path of Object.values(report.paths) as string[]) assert.ok(path.startsWith(profile + '/'))
  await mkdir(workspacePath, { recursive: true })
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(profile, 'capsules') })
  if (phase === 'capture') {
    const source = join(profile, 'source'); await mkdir(source)
    await writeFile(join(source, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Reading desk</title><style>*{box-sizing:border-box}body{margin:0;padding:clamp(20px,5vw,56px);background:#eef4ef;color:#203b2d;font:16px/1.55 system-ui}main{max-width:680px;margin:auto}small{color:#557563;font-weight:600;letter-spacing:.1em}h1{font-size:clamp(26px,4vw,40px);line-height:1.15;margin:14px 0}p{color:#52705e}input{display:block;width:100%;font:inherit;background:white;border:1px solid #b6caba;border-radius:6px;padding:12px;margin:20px 0}button,a{font:inherit}button{background:#285b40;color:white;border:0;border-radius:6px;padding:10px 16px;margin-right:12px}a{color:#285b40}output{font-variant-numeric:tabular-nums;font-weight:600}</style><main><small>CAPSULE · ORIGINAL PAGE</small><h1>A result worth returning to.</h1><p>The same page, its saved thought and its reading position stay together.</p><input id="thought" aria-label="Page thought" placeholder="Keep a thought for later"><button id="increment">Keep count</button><output id="count">0</output><p><a id="route" href="/chapter?section=2#detail">Continue to the next chapter →</a></p><p id="detail">A stable Capsule reference identifies this page. Its internal HTTP route remains a separate navigation fact.</p></main><script>const thought=document.querySelector('#thought'),count=document.querySelector('#count');thought.value=localStorage.getItem('original-thought')||'';count.textContent=localStorage.getItem('original-count')||'0';thought.oninput=()=>localStorage.setItem('original-thought',thought.value);document.querySelector('#increment').onclick=()=>{count.textContent=String(Number(count.textContent)+1);localStorage.setItem('original-count',count.textContent)};</script>`)
    const primary = await owner.call('capsule.create', { operationId: 'private-create-reading-desk', sourcePath: source, title: 'Reading desk', mode: 'isolated', routing: 'spa' })
    const secondary = await owner.call('capsule.create', { operationId: 'private-create-other-desk', sourcePath: source, title: 'Other desk', mode: 'isolated', routing: 'spa' })
    assert.equal(primary.endpoint.status, 'available'); assert.equal(secondary.endpoint.status, 'available')
    objects = { primary: { id: primary.record.capsuleId, uri: 'amux://capsule/' + primary.record.capsuleId, endpoint: (primary.endpoint as any).url },
      secondary: { id: secondary.record.capsuleId, uri: 'amux://capsule/' + secondary.record.capsuleId, endpoint: (secondary.endpoint as any).url } }
    await writeFile(join(profile, 'fixture-identities.json'), JSON.stringify(objects))
    await writeFile(join(workspacePath, 'notes.md'), '# Original workface\n\nThe Capsule reference keeps its original page and Browser.\n')
    report.createdCapsules = 2
  } else {
    objects = JSON.parse(await readFile(join(profile, 'fixture-identities.json'), 'utf8'))
    savedGraph = JSON.parse(await readFile(join(profile, 'spatial-graph.json'), 'utf8'))
    for (const page of Object.values(objects) as any[]) {
      const inspection = await owner.call('capsule.inspect', { capsuleId: page.id })
      assert.equal(inspection.endpoint.status, 'available'); assert.equal((inspection.endpoint as any).url, page.endpoint)
    }
    report.createdCapsules = 0
  }
  files = new WorkspaceFiles(() => ({ kind: 'local' }))
  spatial = new AgentMuxSpatialStateStore(join(profile, 'spatial-state.json'))
  const spatialBeforeInitialize = await spatial.readForLayout()
  ipcMain.on('fixture:boot', event => { event.returnValue = { phase, config, objects, spatialBeforeInitialize } })
  ipcMain.handle('sessions:endpointWarnings', () => [])
  ipcMain.handle('spatial:read', () => spatial.readForLayout())
  ipcMain.handle('spatial:commit', (_event, input) => spatial.commit(input))
  ipcMain.handle('spatial:retainLabels', (_event, values) => spatial.retainDisplayLabels(values))
  ipcMain.handle('notesStorage:inspect', () => ({ directory: join(profile, 'notes'), catalogPath: join(profile, 'notes', '.notebooks.json'), resourceChanges: [], directoryChanges: [], operation: null }))
  ipcMain.on('ui:themeBootstrap', event => { event.returnValue = { status: 'unavailable', message: 'The private Renderer mounts the actual theme runtime explicitly.' } })
  ipcMain.handle('git:status', () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath }))
  for (const [channel, method] of [['files:readDirectory', 'readDirectory'], ['files:read', 'read'], ['files:readPreview', 'readPreview'], ['files:write', 'write']] as const)
    ipcMain.handle(channel, async (_event, id, input, options) => { const result = await (files[method] as any)(workspace(id), input, options); if (method === 'write') report.writes.push({ path: input.path, status: result.status }); return result })
  ipcMain.handle('files:readBookmark', async (_event, id, path) => { const kind = bookmarkKindForPath(path); if (!kind) return null; const bytes = await files.readBookmarkBytes(workspace(id), path); return bytes ? await readBookmark(kind, bytes, runProcess) : { url: null, binary: false } })
  ipcMain.handle('files:observe', async (event, id, path) => { const key = id + '\0' + path; if (!observers.has(key)) observers.set(key, await files.observe(workspace(id), path, () => event.sender.send(WORKSPACE_FILE_INVALIDATED_CHANNEL, { workspaceId: id, path }))) })
  ipcMain.handle('files:unobserve', async (_event, id, path) => { const key = id + '\0' + path; await observers.get(key)?.(); observers.delete(key) })
  ipcMain.handle('ui:requestStorageFlush', event => event.sender.session.flushStorageData())
  win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1180, height: 820,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, preload: join(profile, '..', 'preload.cjs') } })
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(profile, 'profiles.json'))); await profiles.initialize()
  browsers = new BrowserViewManager(win, profiles, new BrowserRefLedgerStore(join(profile, 'ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => { throw new Error('No OS scheme preference changes are permitted') },
      openExternal: async url => { report.handoffs.push(url); throw new Error('No OS handoff is permitted in this proof') } })
  disposeSpatial = spatial.subscribe(state => { if (!win.isDestroyed()) win.webContents.send('spatial:changed', state) })
  controlBridge = new DesktopControlIpcBridge({ isAvailable: () => !win.isDestroyed() && !win.webContents.isDestroyed(),
    sendRequest: request => win.webContents.send(CONTROL_REQUEST_CHANNEL, request), sendCancellation: request => win.webContents.send(CONTROL_CANCEL_CHANNEL, request) })
  ipcMain.on(CONTROL_RESPONSE_CHANNEL, (event, response) => { if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) controlBridge.accept(response) })
  chrome = new NativeOverlayWindows(win, browsers, { windowForDocument: document => {
    assert.equal(document, undefined, 'The private proof owns only its original main-window document')
    return win
  } })
  browsers.onNativeVisibilityChange = (_visibility, window) => chrome.visibilityChanged(window)
  browsers.onNativeInput = (page, input) => chrome.forwardBrowserInput(page, input)
  const graph = async () => (await spatial.readForLayout())?.graph ?? null
  const ensure = async (id: string, input?: any) => browsers.ensure(id, async () => {
    const original = browserColdDescriptor(await graph(), id)
    const resolved = original.capsuleId ? resolveCapsuleColdDocument(original, await owner.call('capsule.inspect', { capsuleId: original.capsuleId })) : original
    report.restore.push({ browserId: id, original, resolvedUrl: resolved.url, capsuleId: resolved.capsuleId }); return resolved
  }, input)
  const execute = async (request: any, signal?: AbortSignal) => { signal?.throwIfAborted(); report.controls.push(structuredClone(request)); const result = await controlBridge.execute(request, signal); (report.controlResults ??= []).push({ requestId: request.requestId, result }); return result }
  const presentation = capsulePresentation({ inspect: id => owner.call('capsule.inspect', { capsuleId: id }), graph,
    current: id => browsers.target(id), ensure, recordOpen: (id, capsuleId, operationId) => browsers.recordCapsuleOpen(id, capsuleId, operationId), execute,
    observe: async () => { const result = await controlBridge.execute({ schemaVersion: 5, requestId: mintObjectId(), operation: 'inspect.client' }); assert.equal(result.operation, 'inspect.client'); return (result as any).observation }, original: async () => { throw new Error('The private transport never substitutes another Core owner') } })
  ingress.ready(execute, message => { report.ingressIssue = message; win.webContents.send('ui:spatialLinkIssue', message) },
    async (capsuleId, operationId, signal) => { const result = await presentation.call('capsule.open', { capsuleId, operationId }, { signal }); (report.capsuleOpens ??= []).push(result); return result as any })
  ipcMain.handle('ui:openObjectLink', async (_event, raw: string) => { const opening = { raw, issue: null as string | null, settled: false }; report.opens.push(opening); opening.issue = await ingress.receive(raw); opening.settled = true; if (opening.issue) throw new Error(opening.issue) })
  ipcMain.handle('ui:spatialLinksReady', () => {})
  ipcMain.handle('ui:openExternal', (_event, url) => { report.external.push(url) })
  ipcMain.handle('capsules:call', (_event, method, params) => sessionInputOperationResult(() => method === 'capsule.open' ? presentation.call(method, params) : owner.call(method, params)))
  ipcMain.handle('ui:publishNativeOverlays', (_event, regions) => chrome.update(regions))
  ipcMain.handle('ui:nativeBrowserVisibility', (_event, scope) => chrome.visibility(scope))
  for (const method of ['registerPresentation', 'updatePresentation', 'removePresentation', 'armPresentationCapture', 'ackPresentationCapture', 'activatePresentation'] as const)
    ipcMain.handle('browser:' + method, (event, ...args) => (browsers[method] as any)(event.sender, event.senderFrame, ...args))
  ipcMain.handle('browser:create', async (_event, id, url, workspaceId, rememberedProfileId, mode, viewport, capsuleId, operationId) => {
    const receipt: any = { id, url, capsuleId, operationId }; report.creates.push(receipt)
    const result = capsuleId ? await createCapsuleBrowserDocument({ browsers, inspect: capsuleId => owner.call('capsule.inspect', { capsuleId }) }, { id, url, workspaceId, rememberedProfileId, mode, viewport, capsuleId, operationId })
      : await browsers.create(id, url, workspaceId, rememberedProfileId, mode, viewport)
    receipt.result = result; return result
  })
  ipcMain.handle('browser:restore', (_event, id, input) => ensure(id, input))
  for (const method of ['navigate', 'back', 'forward'] as const) ipcMain.handle('browser:' + method, async (_event, id, ...args) => {
    const receipt: any = method === 'navigate' ? { id, url: args[0], settled: false } : null
    if (receipt) report.navigations.push(receipt)
    try { await ensure(id); const result = await (browsers[method] as any)(id, ...args); if (receipt) receipt.result = result; return result }
    catch (error) { if (receipt) receipt.error = String(error); throw error }
    finally { if (receipt) receipt.settled = true }
  })
  ipcMain.handle('browser:reload', async (_event, id) => { await ensure(id); const capsuleId = browsers.capsuleId(id); return capsuleId ? await browsers.reloadCapsule(id, await owner.call('capsule.inspect', { capsuleId })) : await browsers.reload(id) })
  for (const method of ['setBounds', 'release', 'close', 'cancelElementSelection', 'setAnnotationMarkers'] as const) ipcMain.handle('browser:' + method, (_event, ...args) => (browsers[method] as any)(...args))
  ipcMain.handle('browser:listProfiles', () => profiles.listProfiles())
  const inputHistory = new BrowserInputHistoryStore(join(profile, 'input-history'))
  const historyScope = (target: any) => { const scope = browsers.inputHistoryScope(target.browserId, target.profileId); assert.ok(scope); return scope }
  ipcMain.handle('browser:listInputHistory', (_event, target) => { const scope = historyScope(target); return scope.profileId === null ? { scope, entries: [] } : inputHistory.list(scope) })
  ipcMain.handle('browser:recordInputHistory', (_event, target, text) => { const scope = historyScope(target); return scope.profileId === null ? { scope, entries: [], outcome: 'private' } : inputHistory.record(scope, text) })
  ipcMain.handle('browser:getRecoveryPreview', () => ({ status: 'unavailable', warning: 'No recovery screenshot is seeded by this private proof' }))
  win.webContents.on('console-message', (_event, _level, message) => { report.console.push(message); console.error('RENDERER ' + message) })
  await win.webContents.debugger.attach('1.3')
  void win.loadFile(html).catch(error => { report.navigationFailure = String(error) })
  await win.webContents.debugger.sendCommand('Runtime.enable')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('Boolean(window.capsuleAddressProbe)', 'The production Workbench and Store must initialize')
  report.initialFocus = { focused: win.isFocused(), visible: win.isVisible() }
  if (phase === 'capture') await capture(); else await restart()
  assert.deepEqual(report.handoffs, [], 'A stable object address never enters the generic OS scheme handoff')
  report.passed = true
} catch (error) {
  report.failure = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }
  await writeFile(join(evidence, phase + '-native.json'), JSON.stringify(report, null, 2))
  if (win! && !win.isDestroyed()) { report.bodyAtFailure = await evaluate('document.body.innerText').catch(String); await frame(phase + '-failure').catch(() => {}) }
} finally {
  const cleanup: string[] = []
  for (const stop of observers.values()) try { await stop() } catch (error) { cleanup.push(String(error)) }
  for (const page of browsers?.targets() ?? []) try { browsers.nativeOwner(page.id)?.view.webContents.session.flushStorageData() } catch (error) { cleanup.push('session:' + page.id + ': ' + String(error)) }
  const steps: [string, () => unknown][] = [['ingress', () => ingress.unavailable()], ['spatial-observation', () => disposeSpatial?.()],
    ['control', () => controlBridge?.dispose()], ['native-chrome', () => chrome?.dispose()], ['browsers', () => browsers?.dispose()],
    ['profiles', () => profiles?.dispose()], ['files', () => files?.dispose()], ['capsule-owner', () => owner?.close()],
    ['window', () => { if (win! && !win.isDestroyed()) win.destroy() }]]
  for (const [name, action] of steps) try { await action() } catch (error) { cleanup.push(name + ': ' + String(error)) }
  report.cleanup = cleanup; report.remainingWindows = BrowserWindow.getAllWindows().length
  const nativeRequire = createRequire(import.meta.url)
  // Electron's require cache also contains virtual builtins such as electron/common.
  // Their identity is the exact executable/version; only real resolved modules are files.
  const cachedModules = Object.keys(nativeRequire.cache)
  report.externalVirtualModules = cachedModules.filter(path => !isAbsolute(path))
  // Parent Node has no Electron ASAR fs patch. Bind the exact original archive,
  // retaining the loaded member mapping, so ordinary Node can recheck it later.
  report.externalModuleFiles = Object.fromEntries(cachedModules.filter(isAbsolute).map(path => {
    const archive = path.indexOf('.asar/')
    return [path, archive < 0 ? path : path.slice(0, archive + '.asar'.length)]
  }))
  const rawReadFile: typeof readFile = nativeRequire('original-fs').promises.readFile
  try { report.externalInputs = Object.fromEntries(await Promise.all([...new Set(Object.values(report.externalModuleFiles) as string[])].map(async path => [path, sha(await rawReadFile(path))]))) }
  catch (error) { cleanup.push('external-input-binding: ' + String(error)) }
  if (cleanup.length) report.passed = false
  await writeFile(join(evidence, phase + '-native.json'), JSON.stringify(report, null, 2))
  setImmediate(() => app.exit(report.passed ? 0 : 1))
}
