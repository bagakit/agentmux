const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win
const receipt = { schema: 'agentmux.notification-center-render.v1', passed: false, frames: [], scenarios: [],
  captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false }
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const panel = `document.querySelector('.global-system-notices__details')`
const trigger = `document.querySelector('.global-system-notices__trigger')`
const row = `document.querySelector('.notification-item')`
async function waitFor(expression) {
  for (let i = 0; i < 240; i++) { try { if (await evaluate(expression)) return } catch {} await delay(25) }
  assert.fail('Expected actual Renderer fact: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(100) }
async function click(expression) {
  const point = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Original input target absent');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await painted()
}
async function escape() {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await painted()
}
const unread = () => evaluate(`Number(${trigger}.getAttribute('aria-label').match(/(\\d+) unread/)[1])`)
const button = text => `Array.from(${panel}.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(text)})`
const section = value => `document.querySelector('[role="tab"][data-section="${value}"]')`
const category = value => `document.querySelector('button[data-category="${value}"]')`
async function frame(name) {
  await painted()
  const file = name + '.png', png = (await win.webContents.capturePage()).toPNG()
  assert.ok(png.length > 0)
  await fs.writeFile(path.join(evidence, file), png)
  receipt.frames.push({ file, sha256: crypto.createHash('sha256').update(png).digest('hex'), bytes: png.length,
    viewport: await evaluate('({width:innerWidth,height:innerHeight})') })
}
async function resize(width, height) {
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await painted()
}
async function open() { await click(trigger); await waitFor(`${panel}.matches(':popover-open')`); await painted() }
async function close() { await escape(); await waitFor(`!${panel}.matches(':popover-open')`) }
async function bounded() {
  const bounds = await evaluate(`(()=>{const r=${panel}.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,scrollWidth:${panel}.scrollWidth,clientWidth:${panel}.clientWidth}})()`)
  assert.ok(bounds.width > 250 && bounds.height > 120 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= bounds.vw + 1 && bounds.y + bounds.height <= bounds.vh + 1,
    'The complete original panel remains usable inside the native viewport')
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, 'Narrow notification panel has no horizontal content loss')
  return bounds
}
async function surface() { return evaluate('notificationScene.surface()') }
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false, sandbox: false } })
    receipt.consoleErrors = []
    win.webContents.on('console-message', details => { if (details.level === 'error') receipt.consoleErrors.push(details.message) })
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await win.loadFile(html)
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('window.notificationScene?.initialized()')
    await evaluate('notificationScene.seed()'); await waitFor(`document.querySelector('[data-workbench-region-id="notification-primary"] .xterm-helper-textarea')`)
    await evaluate(`notificationScene.theme('dark')`); await painted()
    const terminal = `document.querySelector('[data-workbench-region-id="notification-primary"] .xterm-helper-textarea')`
    await click(terminal)
    const before = await surface(), geometry = await evaluate(`(()=>{const r=document.querySelector('[data-workbench-region-id="notification-primary"]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    await evaluate('notificationScene.activateNoise()'); await painted()
    assert.equal(await evaluate(`document.activeElement===${terminal}`), true, 'Passive 98-notice arrival preserves original terminal input focus')
    assert.deepEqual(await surface(), before, 'Passive observations retain original Tab, layout, drafts and exact Session identities')
    assert.equal(await unread(), 98, 'The original 98 facts remain present independently of object grouping')
    assert.equal(await evaluate(`${panel}.matches(':popover-open')`), false, 'Passive observations never open the center')
    await frame('dark-wide-status')
    await open()
    assert.equal(await unread(), 98, 'Opening the center never marks unseen facts read')
    const wide = await bounded(); await frame('dark-wide-current-98')
    await click(category('agents'))
    assert.equal(await evaluate(`document.querySelectorAll('.notification-group[data-group-id]').length`), 32)
    await click(`document.querySelector('.notification-group__more')`)
    assert.equal(await evaluate(`document.querySelector('.notification-group__more').getAttribute('aria-expanded')`), 'true')
    await click(`${row}.querySelector('.notification-item__details summary')`)
    await waitFor(`${row}.querySelector('.notification-item__original')`)
    assert.equal(await unread(), 97, 'Reading exact original details marks one fact only')
    await frame('dark-wide-agent-details')
    await click(button('Mark shown read'))
    assert.equal(await unread(), 2, 'Agent-filter bulk action includes folded Agent facts, not hidden system facts')
    assert.deepEqual(await surface(), before)
    await click(category('all')); await click(button('Mark shown read'))
    assert.equal(await unread(), 0)
    await frame('dark-wide-all-read')
    await evaluate('notificationScene.resolveAndRecur()'); await painted()
    assert.equal(await unread(), 1, 'Explicit original source resolution followed by recurrence is unread')
    await evaluate('notificationScene.events()'); await painted()
    const withEvents = await unread()
    assert.ok(withEvents >= 6, 'Independent Activity records and recurrent current source remain discoverable')
    assert.equal(await evaluate(`${section('current')}.getAttribute('aria-selected')`), 'true', 'New Activity never switches the Current view')
    await click(section('history'))
    const repeatedRow = `Array.from(document.querySelectorAll('.notification-item')).find(row=>row.textContent.includes('2 observations'))`
    await waitFor(repeatedRow)
    assert.ok(await evaluate(`${repeatedRow}.querySelector('time')?.textContent.includes('Received')`), 'Client receipt time is explicitly identified as Received')
    await click(`${repeatedRow}.querySelector('.notification-item__details summary')`)
    assert.ok(await evaluate(`${repeatedRow}.querySelector('.notification-item__original').textContent.includes('desktop-notifications')`), 'Original typed event source is readable in its exact Details')
    assert.ok(await evaluate(`${repeatedRow}.querySelector('.notification-item__original').textContent.includes('desktop')`), 'Original application object identity is retained')
    await click(`${repeatedRow}.querySelector('.notification-item__details summary')`)
    await evaluate(`${panel}.querySelector('.global-system-notices__content').scrollTop=0`)
    await frame('dark-wide-activity')
    const longRow = `Array.from(document.querySelectorAll('.notification-item')).find(row=>row.textContent.includes('original history request'))`
    await click(`${longRow}.querySelector('.notification-item__details summary')`)
    await waitFor(`${longRow}.querySelector('.notification-item__original')`)
    assert.ok(await evaluate(`${longRow}.querySelector('.notification-item__original').textContent.includes('FINAL ORIGINAL RECEIPT')`), 'Complete original diagnostic tail is retained')
    await resize(720, 780); const narrow = await bounded()
    const originalDetail = `${longRow}.querySelector('.notification-item__original')`
    await evaluate(`${originalDetail}.scrollIntoView({block:'start'})`); await painted()
    const detailViewport = await evaluate(`(()=>{const e=${originalDetail},r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+Math.min(40,r.height/2),height:r.height,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}})()`)
    assert.ok(detailViewport.height > 0, 'The original long diagnostic is actually visible for review')
    await frame('dark-narrow-long-details')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: detailViewport.x, y: detailViewport.y,
      deltaY: detailViewport.scrollHeight, deltaX: 0 })
    await painted(); await frame('dark-narrow-long-details-tail')
    const selected = await evaluate(`${section('history')}.getAttribute('aria-selected')`)
    const expandedId = await evaluate(`${longRow}.getAttribute('data-event-id')`)
    const scroll = await evaluate(`(()=>{const p=${panel};const s=[p,...p.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+30 && ['auto','scroll'].includes(getComputedStyle(e).overflowY));if(!s)return null;s.scrollTop=Math.min(80,s.scrollHeight-s.clientHeight);return{className:s.className,top:s.scrollTop}})()`)
    await evaluate('notificationScene.newEvent()'); await painted()
    assert.equal(await evaluate(`${section('history')}.getAttribute('aria-selected')`), selected)
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.notification-item')).find(row=>row.getAttribute('data-event-id')===${JSON.stringify(expandedId)}).querySelector('details').open`), true,
      'New event preserves original expanded details')
    if (scroll?.top > 0) assert.ok(await evaluate(`Array.from(${panel}.querySelectorAll('*')).find(e=>e.className===${JSON.stringify(scroll.className)})?.scrollTop>0`), 'New event does not return the original reader to the top')
    await close(); assert.deepEqual(await surface(), before, 'Reading the center retains the original workface')
    await evaluate(`notificationScene.theme('light')`); await resize(1280, 900); await open(); await click(section('current')); await click(category('all'))
    await frame('light-wide-current')
    await resize(720, 780); await bounded(); await frame('light-narrow-current')
    await click(category('agents'))
    await click(`${row}.querySelector('.notification-item__details summary')`)
    await frame('light-narrow-agent-details')
    await close()
    const afterGeometry = await evaluate(`(()=>{const r=document.querySelector('[data-workbench-region-id="notification-primary"]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    assert.deepEqual(await surface(), before)
    const facts = await evaluate('notificationScene.facts()')
    assert.equal(facts.writes.length, 0, 'Notification reading never submits or pastes Agent input')
    assert.ok(facts.trustedEvents.some(event => event.trusted && event.type === 'click'), 'Actual native pointer input reaches production controls')
    receipt.scenarios.push({ wide, narrow, originalGeometry: geometry, finalGeometry: afterGeometry, originalSurface: before, finalFacts: facts, scroll })
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    try { await frame('failure'); receipt.failureFacts = await evaluate('notificationScene.facts()'); receipt.failureDOM = await evaluate(`document.querySelector('.global-system-notices')?.outerHTML`) } catch {}
  } finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(receipt, null, 2) + '\n')
    win?.destroy(); app.exit(receipt.passed ? 0 : 1)
  }
})
