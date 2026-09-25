const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, privateRoot, evidence, probe = 'complete'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win
const result = { schema: 'agentmux.service-notice-render.v1', passed: false, frames: [], scenarios: [], userRunTouched: false }
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`
const owner = `${surface}.querySelector('.agent-launch-notice .service-disclosure')`
const trigger = `${owner}.querySelector('.service-disclosure__trigger')`
const panel = `${owner}?.querySelector('.service-disclosure__details')`
const browser = `document.querySelector('[data-workbench-region-id="result-input-neighbor"] .browser-surface')`
async function waitFor(expression) {
  for (let i = 0; i < 180; i++) { try { if (await evaluate(expression)) return } catch {} await delay(25) }
  assert.fail('Expected actual renderer fact: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(70) }
async function click(expression) {
  const point = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Actual target absent');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function key(key, text) {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type, key, code: key === 'Escape' ? 'Escape' : `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0),
    ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) })
}
async function typed(text) {
  const before = await evaluate('serviceReady.facts().writes.length')
  for (const letter of text) await key(letter, letter)
  await painted()
  const writes = await evaluate(`serviceReady.facts().writes.slice(${before})`)
  assert.ok(writes.length > 0, 'Actual native keyboard invokes the production terminal write')
  assert.equal(writes.map(item=>item.data).join(''), text)
  await waitFor(`serviceReady.terminal().cursorLine.endsWith(${JSON.stringify(text)})`)
}
async function geometry() {
  return evaluate(`(()=>{const s=${surface},r=s.querySelector('.terminal-view__xterm').getBoundingClientRect();return{
    terminal:{x:r.x,y:r.y,width:r.width,height:r.height},xterm:serviceReady.terminal(),
    focused:document.activeElement===s.querySelector('.xterm-helper-textarea'),overlays:serviceReady.facts().nativeOverlays,
    unread:${owner}?.getAttribute('data-unread'),open:${panel}?.matches(':popover-open')??false}})()`)
}
async function frame(width, state) {
  const file = `${width}-${state}.png`, png = (await win.webContents.capturePage()).toPNG()
  assert.ok(png.length > 0); await fs.writeFile(path.join(evidence, file), png); result.frames.push({ width, state, file })
}
async function folded(target = owner) {
  await waitFor(`${target}.querySelector('.service-disclosure__trigger').getAttribute('aria-expanded')==='false' && !${target}.querySelector('.service-disclosure__details').matches(':popover-open') && serviceReady.facts().nativeOverlays===0`)
  await painted()
}
async function open(target = owner) {
  await click(`${target}.querySelector('.service-disclosure__trigger')`)
  await waitFor(`${target}.querySelector('.service-disclosure__details').matches(':popover-open') && serviceReady.facts().nativeOverlays===1`)
  await painted()
}
function preserved(before, after) {
  for (const field of ['sessions', 'tab', 'layout', 'drafts']) assert.deepEqual(after[field], before[field], 'Notice reading preserves original ' + field)
}
async function scene(width, mode) {
  result.stage = { width, mode }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width*2+1, height: 740, deviceScaleFactor: 1, mobile: false })
  await evaluate(`serviceReady.seed('healthy')`)
  await waitFor(`${surface}.querySelector('.xterm-helper-textarea') && !${surface}.querySelector('.terminal-view__xterm--hydrating')`)
  await painted(); await click(`${surface}.querySelector('.terminal-view__xterm')`); await typed('a')
  const identity = await evaluate('serviceReady.facts()'), before = await geometry()
  await evaluate(`serviceReady.activate(${JSON.stringify(mode)})`); await waitFor(owner); await painted()
  const automatic = await geometry()
  assert.equal(automatic.open, false, 'A passive service notice never opens details automatically')
  assert.equal(automatic.overlays, 0); assert.equal(automatic.focused, true, 'A passive notice never steals the original terminal input')
  assert.ok(automatic.terminal.height > 400 && automatic.terminal.width > 150, 'The actual prompt has a usable terminal rectangle')
  assert.equal(automatic.xterm.id, before.xterm.id, 'Automatic notices retain the original xterm instance')
  assert.ok(automatic.xterm.visibleLines.some(line=>line.includes('half typed prompt')), 'The actual latest input line remains visible')
  preserved(identity, await evaluate('serviceReady.facts()')); await typed('b')
  await frame(width, `${mode}-default`)
  await open()
  const final = mode === 'projection' ? 'FINAL PROJECTION CAUSE.' : 'FINAL LIFECYCLE CAUSE.'
  assert.ok(await evaluate(`${panel}.textContent.includes(${JSON.stringify(final)})`), 'The original diagnostic and final facts are reachable')
  assert.equal(await evaluate(`${panel}.querySelectorAll('.service-window__step,.service-window__mode,.service-window__restore').length`), 3, 'The disclosure exposes all three original facts')
  const bounds = await evaluate(`(()=>{const r=${panel}.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})()`)
  assert.ok(bounds.width > 150 && bounds.height > 50 && bounds.y >= 0 && bounds.y + bounds.height <= bounds.viewportHeight+1, 'The complete disclosure is bounded by the actual window')
  await frame(width, `${mode}-details`)
  await click(`${panel}.querySelector('.service-disclosure__close')`); await folded()
  assert.equal(await evaluate(`${owner}.getAttribute('data-unread')`), 'false', 'Explicit escape persists its read receipt')
  assert.equal((await geometry()).focused, true, 'Closing details restores the original input focus')
  preserved(identity, await evaluate('serviceReady.facts()')); await typed('c')
  await evaluate('serviceReady.repeat()'); await painted()
  assert.equal(await evaluate(`${owner}.getAttribute('data-unread')`), 'false', 'Diagnostic-only repeat cannot re-expand an acknowledged cause')
  await evaluate('serviceReady.remount()'); await waitFor(owner); await painted()
  assert.equal(await evaluate(`${owner}.getAttribute('data-unread')`), 'false', 'Remount retains the durable read identity')
  await open(); await key('Escape'); await folded()
  await open(); await evaluate('serviceReady.visible(false)'); await waitFor('serviceReady.facts().nativeOverlays===0')
  assert.equal(await evaluate(`${panel}.matches(':popover-open')`), false, 'Hidden work surfaces cannot leave an orphan top-layer panel')
  await evaluate('serviceReady.visible(true)'); await waitFor(owner); await painted()
  assert.equal(await evaluate(`${owner}.getAttribute('data-unread')`), 'false')
  if (probe === 'complete') {
    await evaluate('serviceReady.cause()'); await painted()
    assert.equal(await evaluate(`${owner}.getAttribute('data-unread')`), 'true', 'A genuinely different cause is discoverable')
    await click(`${owner}.querySelector('.service-disclosure__close')`); await folded()
    await evaluate(`serviceReady.activate(${JSON.stringify(mode)})`); await painted()
    await click(`${owner}.querySelector('.service-disclosure__close')`); await folded()
    await open()
    await evaluate('serviceReady.subject()'); await waitFor(owner); await painted()
    assert.equal(await evaluate(`${panel}.matches(':popover-open')`), false, 'A new Run cannot inherit the previous Run disclosure')
    await folded()
    assert.equal(await evaluate(`${owner}.getAttribute('data-unread')`), 'true', 'A new Run cannot inherit the previous Run acknowledgement')
    await click(`${owner}.querySelector('.service-disclosure__close')`); await folded()
    await evaluate('serviceReady.resolved()'); await waitFor(`!${owner}`)
    await evaluate(`serviceReady.activate(${JSON.stringify(mode)})`); await waitFor(owner); await painted()
    assert.equal(await evaluate(`${owner}.getAttribute('data-unread')`), 'true', 'Resolved then recurrent facts receive a new read opportunity')
  }
  result.scenarios.push({ width, mode, before, automatic, bounds, final: await geometry(), identity: await evaluate('serviceReady.facts()') })
}
async function browserAndWorkspace(width) {
  result.stage = { width, mode: 'browser-workspace' }
  await evaluate(`serviceReady.seed('healthy')`); await waitFor(`document.querySelector('[data-native-browser-stage="service-browser"]')`); await painted()
  const local = `document.querySelector('[data-workbench-region-id="result-input-neighbor"] .service-disclosure')`
  await waitFor(local)
  const before = await evaluate('serviceReady.facts()')
  await open(local)
  assert.ok(await evaluate(`${local}.querySelector('.service-disclosure__details').textContent.includes('FINAL ANNOTATION CAUSE.')`))
  assert.equal(await evaluate(`${local}.querySelectorAll('.service-disclosure').length`), 0, 'Full content cannot recursively create another disclosure')
  await frame(width, 'browser-annotation-details')
  await click(`${local}.querySelector('.service-disclosure__details .service-disclosure__close')`); await folded(local)
  await evaluate('serviceReady.annotationRepeat()'); await painted()
  assert.equal(await evaluate(`${local}.getAttribute('data-unread')`), 'false')
  await open(local); await evaluate('serviceReady.annotationSuccess()')
  const retry = `Array.from(${local}.querySelectorAll('button')).find(button=>button.textContent==='Retry annotations')`
  await click(retry); await waitFor(`!${local}`); await waitFor('serviceReady.facts().nativeOverlays===0')
  preserved(before, await evaluate('serviceReady.facts()'))
  await evaluate('serviceReady.focusMoved()'); await waitFor('document.querySelector("[data-workbench-moved-focus] .service-disclosure")'); await painted()
  const moved = `document.querySelector('[data-workbench-moved-focus] .service-disclosure')`
  await frame(width, 'workspace-focus-moved')
  await open(moved)
  assert.ok(await evaluate(`${moved}.textContent.includes('no replacement Agent is selected')`))
  await click(`${moved}.querySelector('.service-disclosure__details .service-disclosure__close')`); await folded(moved)
  assert.equal(await evaluate(`${moved}.getAttribute('data-unread')`), 'false')
  preserved(before, await evaluate('serviceReady.facts()'))
  await evaluate('serviceReady.focusMoved(false)'); await waitFor(`!${moved}`)
  result.scenarios.push({ width, mode: 'browser-workspace', identity: await evaluate('serviceReady.facts()') })
}
async function fullContentInboxes() {
  await evaluate(`serviceReady.seed('lifecycle')`); await waitFor(owner); await painted()
  const globalTrigger = `document.querySelector('.global-system-notices__trigger')`, globalPanel = `document.querySelector('.global-system-notices__details')`
  await click(globalTrigger); await waitFor(`${globalPanel}.matches(':popover-open')`)
  assert.ok(await evaluate(`${globalPanel}.querySelectorAll('.service-window').length > 0`))
  assert.equal(await evaluate(`${globalPanel}.querySelectorAll('.service-disclosure').length`), 0, 'Existing system inbox remains full content without nested auto popovers')
  await key('Escape'); await waitFor('serviceReady.facts().nativeOverlays===0')
  const mailbox = `${surface}.querySelector('.composer__mailbox')`, mailPanel = `${surface}.querySelector('.composer-mailbox')`
  await click(mailbox); await waitFor(`${mailPanel}.matches(':popover-open')`)
  const system = `Array.from(${mailPanel}.querySelectorAll('[role="tab"]')).find(button=>button.id.endsWith('-system-tab'))`
  await click(system)
  assert.ok(await evaluate(`${mailPanel}.querySelectorAll('.service-window').length > 0`))
  assert.equal(await evaluate(`${mailPanel}.querySelectorAll('.service-disclosure').length`), 0, 'Existing Session mailbox retains its own X/Escape and complete facts')
  await key('Escape'); await waitFor('serviceReady.facts().nativeOverlays===0')
  result.inboxes = { fullContent: true, identity: await evaluate('serviceReady.facts()') }
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1281, height: 740, webPreferences: { backgroundThrottling: false, sandbox: false } })
    result.consoleErrors = []; win.webContents.on('console-message', details=>{if(details.level==='error')result.consoleErrors.push(details.message)})
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.serviceReady)')
    for (const width of [640, 320]) { await scene(width, 'projection'); if (probe === 'complete') { await scene(width, 'lifecycle'); await browserAndWorkspace(width) } }
    if (probe === 'complete') await fullContentInboxes()
    assert.ok(result.scenarios.length > 0); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage }
    try { result.failureFacts = { geometry: await geometry(), facts: await evaluate('serviceReady.facts()') } } catch (diagnostic) { result.diagnosticError = diagnostic.message }
  } finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
