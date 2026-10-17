import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, type WebContents } from 'electron'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store.js'
import { ConfigOwner } from '../../../src/main/config-owner.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store.js'
import { resolveBrowserAgentControl } from '../../../src/shared/browser-agent-control.js'
import { avatarAndFrames } from './native-actions.js'
import { captureOperatorWindows } from './os-capture.js'

const privateRoot = process.env.AGENTMUX_PRESENCE_PRIVATE!, output = process.env.AGENTMUX_PRESENCE_OUTPUT!
const receiptFile = process.env.AGENTMUX_PRESENCE_RECEIPT!, label = process.env.AGENTMUX_PRESENCE_LABEL!
app.on('window-all-closed', () => {})
const receipt: any = { schema: 'agentmux.browser-operator-presence.native.v1', passed: false, pid: process.pid,
  versions: process.versions, cases: [], captures: [], cleanup: [], cleanupComplete: false,
  boundary: 'Actual Main owners and native page compositor only. No OS whole-window capture, foreground input, Renderer-generated artwork or Desktop restart qualification.' }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(read: () => Promise<T>, message: string, budget = 6000): Promise<NonNullable<T>> {
  const end = Date.now() + budget
  while (Date.now() < end) { const value = await read(); if (value) return value as NonNullable<T>; await pause(20) }
  throw new Error('Original native consumer did not observe ' + message)
}
const worldState = `(()=>{const s=globalThis.__agentMuxBrowserControlFeedback,a=globalThis.__agentMuxBrowserOperationFeedback;
 const host=s?.host,glow=s?.shadow?.querySelector('.amux-browser-agent-glow'),style=host&&getComputedStyle(host),rect=host?.getBoundingClientRect();
 return{control:s?{revision:s.revision,operationId:s.operationId,navigationId:s.navigationId,connected:!!host?.isConnected,
 blend:style?.mixBlendMode,pointerEvents:style?.pointerEvents,background:style?.backgroundColor,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,
 glow:glow?{display:getComputedStyle(glow).display,boxShadow:getComputedStyle(glow).boxShadow}:null}:null,
 action:a?{phase:a.phase,connected:!!a.host?.isConnected}:null,viewport:{width:innerWidth,height:innerHeight},hidden:document.hidden}})()`
const state = (contents: WebContents) => contents.executeJavaScriptInIsolatedWorld(1209, [{ code: worldState }])
let window: BrowserWindow | undefined, manager: BrowserViewManager | undefined, unsubscribe: (() => void) | undefined
let server: ReturnType<typeof createServer> | undefined
async function capture(contents: WebContents, name: string) {
  const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  assert.equal(image.isEmpty(), false, 'The actual native page must produce compositor pixels')
  const bytes = image.toPNG(), pixels = image.toBitmap(), size = image.getSize()
  assert.equal(pixels.length, size.width * size.height * 4, 'The original native bitmap dimensions must be unambiguous')
  const file = label + '-' + name + '.png'
  await writeFile(join(output, file), bytes)
  const row = { file, size, sha256: createHash('sha256').update(bytes).digest('hex'),
    boundary: 'Original WebContents.capturePage PNG; native page only, not a composed OS window' }
  receipt.captures.push(row)
  return { row, pixels, size }
}
function edges(frame: Awaited<ReturnType<typeof capture>>) {
  const { pixels, size } = frame, { width, height } = size
  const sample = (x: number, y: number) => { const index = (y * width + x) * 4; return [pixels[index + 2], pixels[index + 1], pixels[index]] }
  return { top: sample(Math.floor(width / 2), 2), bottom: sample(Math.floor(width / 2), height - 3),
    left: sample(2, Math.floor(height / 2)), right: sample(width - 3, Math.floor(height / 2)), center: sample(Math.floor(width / 2), Math.floor(height / 2)) }
}
async function run() {
  const store = new ConfigStore(join(privateRoot, 'config.json'))
  let config = await store.save({ ...structuredClone(DEFAULT_CONFIG), browser: { ...DEFAULT_CONFIG.browser,
    agentControl: { ...resolveBrowserAgentControl(), glowColor: '#22cc66', glowAnimation: 'none', glowBlend: 'normal', glowOpacity: 0.9, glowWidth: 30 } } })
  const configOwner = new ConfigOwner({ read: () => config, save: value => store.save(value), publish: value => { config = value } })
  window = new BrowserWindow({ width: 800, height: 620, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await window.loadURL('data:text/html,<!doctype html><title>Private operator presence proof</title>')
  window.showInactive()
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    if (request.url?.startsWith('/frame')) {
      const kind = new URL(request.url, 'http://localhost').searchParams.get('kind')!
      assert.ok(['local', 'separate'].includes(kind))
      response.end(`<!doctype html><title>Private ${kind} document</title><style>html,body{margin:0;background:#eee;font:16px system-ui}button{position:absolute;top:35px;padding:12px}button:first-of-type{left:40px}button:last-of-type{left:320px}</style><output data-presence-click-count>0</output><button>${kind} left</button><button onclick="const o=document.querySelector('output');o.textContent=String(Number(o.textContent)+1)">${kind} right</button>`)
      return
    }
    response.end('<!doctype html><title>Original operator page</title><style>html,body{margin:0;min-height:100%;background:#eeeeee;font:16px system-ui}main{padding:80px}button{padding:16px}div:empty::before,div:empty::after{content:"page-pseudo-element";position:fixed;inset:0;display:block;background:white;pointer-events:auto;z-index:2147483647}</style><main><button>Original action</button><p>Original page remains available.</p></main>')
  })
  await new Promise<void>(resolve => server!.listen(0, resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}/original`
  manager = new BrowserViewManager(window, { defaultProfileId: () => 'private', resolvePartition: () => 'operator-presence-' + process.pid },
    new BrowserRefLedgerStore(join(privateRoot, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => { throw new Error('External navigation is outside this private proof') } },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => resolveBrowserAgentControl(configOwner.current.browser.agentControl))
  unsubscribe = configOwner.subscribe((saved, previous) => {
    if (JSON.stringify(saved.browser.agentControl) !== JSON.stringify(previous.browser.agentControl)) manager!.refreshAgentFeedback()
  })
  await manager.create('original', url)
  manager.setBounds('original', { x: 0, y: 0, width: 800, height: 588 })
  const owner = manager.nativeOwner('original')!, contents = owner.view.webContents
  contents.setBackgroundThrottling(false)
  await until(() => contents.executeJavaScript('document.querySelector("button")?.textContent === "Original action"'), 'the original loaded document')
  const before = await contents.executeJavaScript('({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})')
  const operationId = 'waiting-original-owner', operator = { id: 'original-agent', name: 'Original Agent' }
  const waitingCase: any = { name: 'actual-waiting-owner-glow', passed: false }
  receipt.cases.push(waitingCase)
  const task = manager.runScript('original', 'await waitForElement("Finish private presence",20000);return "complete"', operator, undefined, operationId)
  await until(async () => manager!.inputContext('original', 'local')?.activity?.phase === 'waiting', 'the original program waiting phase')
  const active = await state(contents)
  assert.equal(manager.target('original')?.control?.inputIsolation, 'isolated', 'The real native input shield is prepared')
  assert.equal(active.control?.connected, true, 'Waiting retains the actual current owner glow')
  assert.equal(active.control.operationId, operationId)
  assert.equal(active.control.pointerEvents, 'none')
  assert.ok(Math.abs(active.control.rect.width - active.viewport.width) < 1, 'The inset host covers the fractional CSS viewport width')
  assert.ok(Math.abs(active.control.rect.height - active.viewport.height) < 1, 'The inset host covers the fractional CSS viewport height')
  assert.equal(active.action.connected, false, 'Waiting clears an action cue while its ownership glow remains active')
  assert.equal(await contents.executeJavaScript('(()=>{const e=document.querySelector("button"),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e})()'), true,
    'Page-authored empty-div pseudo-elements cannot turn the decoration into a painted or hit-testing surface')
  Object.assign(waitingCase, { passed: true, observed: active })
  for (const background of ['#eeeeee', '#151515']) {
    const textColor = background === '#eeeeee' ? 'rgb(20, 20, 20)' : 'rgb(238, 238, 238)'
    await contents.executeJavaScript(`document.documentElement.style.background=${JSON.stringify(background)};document.body.style.background=${JSON.stringify(background)};document.body.style.color=${JSON.stringify(textColor)}`)
    assert.equal(await contents.executeJavaScript('getComputedStyle(document.querySelector("p")).color'), textColor, 'The actual light and dark page body keeps readable text')
    for (const blend of ['normal', 'screen', 'multiply', 'overlay'] as const) {
      await configOwner.update(current => ({ ...current, browser: { ...current.browser,
        agentControl: { ...resolveBrowserAgentControl(current.browser.agentControl), glowBlend: blend } } }))
      await until(async () => (await state(contents)).control?.blend === blend, 'the actual committed preference callback for ' + blend)
      assert.equal((await store.get()).browser.agentControl?.glowBlend, blend)
      const frame = await capture(contents, background.slice(1) + '-' + blend), samples = edges(frame)
      assert.ok(frame.size.width > 0 && frame.size.height > 0)
      const backgroundChannel = background === '#eeeeee' ? 238 : 21
      assert.ok(samples.center.every(value => Math.abs(value! - backgroundChannel) <= 4), 'The original compositor must show this current background, not an old or white empty frame')
      if (blend === 'screen') assert.ok(samples.top.every(value => value! >= backgroundChannel - 4), 'Actual screen-blended glow cannot darken its page backdrop')
      if (blend === 'multiply') assert.ok(samples.top.every(value => value! <= backgroundChannel + 4), 'Actual multiply-blended glow cannot lighten its page backdrop')
      if (blend === 'normal') for (const [edge, rgb] of Object.entries(samples)) if (edge !== 'center') {
        assert.ok(rgb[1]! - rgb[0]! > 15 && rgb[1]! - rgb[2]! > 15, 'All four actual page edges must contain the saved green glow: ' + edge)
      }
      receipt.cases.push({ name: 'saved-preferences-native-pixels', passed: true, background, blend, samples, capture: frame.row.file })
    }
  }
  assert.deepEqual(await contents.executeJavaScript('({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})'), before, 'Preference decoration must preserve the actual Browser viewport and scroll')
  await contents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<button>Finish private presence</button>")')
  const report = await task
  assert.equal(report.outcome.kind, 'completed')
  assert.equal((await state(contents)).control.connected, false, 'Normal program completion releases ownership glow')
  assert.equal(manager.target('original')?.control?.owner, 'human')
  assert.equal(manager.nativeOwner('original')?.inputShield, undefined)
  receipt.cases.push({ name: 'actual-completion-releases-control', passed: true, report })
  const stoppedId = 'explicit-takeover-owner'
  const stopped = manager.runScript('original', 'await waitForElement("Never dispatched private target",20000)', operator, undefined, stoppedId)
  await until(async () => manager!.inputContext('original', 'local')?.activity?.phase === 'waiting', 'the original waiting owner before explicit takeover')
  assert.equal((await state(contents)).control?.connected, true)
  await manager.stopOperationById(stoppedId)
  assert.equal((await stopped).outcome.kind, 'stopped')
  assert.equal((await state(contents)).control?.connected, false, 'Explicit takeover clears the actual original owner glow')
  assert.equal(manager.target('original')?.control?.owner, 'human')
  manager.returnControl('original')
  receipt.cases.push({ name: 'explicit-takeover-releases-control', passed: true })
  await configOwner.update(current => ({ ...current, browser: { ...current.browser,
    agentControl: { ...resolveBrowserAgentControl(current.browser.agentControl), pointerTween: true, pointerDurationMs: 1000, clickDurationMs: 1500 } } }))
  await avatarAndFrames(manager, contents, url, receipt)
  receipt.passed = true
}
void (process.env.AGENTMUX_PRESENCE_OS === '1' ? captureOperatorWindows(receipt) : run()).catch(error => {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  console.error(error)
}).finally(async () => {
  // Preserve original consumer results even if native teardown or input binding
  // fails. Only the final cleanupComplete receipt can qualify this invocation.
  await writeFile(receiptFile, JSON.stringify(receipt, null, 2))
  receipt.loadedExternalInputs = {}
  try {
    for (const path of Object.keys(createRequire(import.meta.url).cache)) if (path.includes('/node_modules/') && !path.includes('.asar/')) {
      const bytes = await readFile(path)
      receipt.loadedExternalInputs[path] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    }
  } catch (error) { receipt.cleanup.push('Actual native source binding: ' + String(error)) }
  for (const release of [() => unsubscribe?.(), () => manager?.dispose(), () => { if (window && !window.isDestroyed()) window.destroy() },
    async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) } }]) {
    try { await release() } catch (error) { receipt.cleanup.push(String(error)) }
  }
  if (receipt.cleanup.length) receipt.passed = false
  receipt.cleanupComplete = true
  await writeFile(receiptFile, JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
