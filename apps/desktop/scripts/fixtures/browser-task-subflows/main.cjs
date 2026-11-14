const { app, BrowserWindow } = require('electron')
const { mkdirSync } = require('node:fs')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const out = process.env.SUBFLOW_UI_OUT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(out, key), { recursive: true }); app.setPath(key, join(out, key)) }
const receipt = { captureOnly: true, aestheticReview: 'not-performed', captures: [], boundary: 'Actual production Editor and styles in isolated Electron; data are explicit nonempty private fixture props. Native input proves Editor callback values only. Runtime, business execution and restart are separately tested by their owners.' }
let win
const pause = ms => new Promise(done => setTimeout(done, ms))
app.whenReady().then(async () => {
  app.setActivationPolicy?.('prohibited')
  win = new BrowserWindow({ width: 620, height: 960, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.debugger.attach('1.3')
  const evaluate = async expression => { const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await win.loadFile(process.env.SUBFLOW_UI_HTML)
  for (let n = 0; !await evaluate(`Boolean(document.querySelector(${JSON.stringify('[aria-label="Collection item 2 Entry label"]')}))`); n++) { if (n > 100) throw new Error('Actual Editor did not mount'); await pause(100) }
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  }
  await click('[aria-label="Collection item 2 Entry label"]'); await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Second entry' })
  await click('[aria-label="Collection fresh Access token"]'); await win.webContents.debugger.sendCommand('Input.insertText', { text: 'private-fixture-token' })
  for (const appearance of ['dark', 'light']) for (const width of [620, 390]) {
    win.setContentSize(width, 960)
    await evaluate(`subflowProof.appearance(${JSON.stringify(appearance)});scrollTo(0,0);new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`)
    const overflow = await evaluate(`({page:document.documentElement.scrollWidth>innerWidth,controls:[...document.querySelectorAll('input,select,button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<0)}).map(e=>e.getAttribute('aria-label')||e.textContent)})`)
    assert.equal(overflow.page, false); assert.deepEqual(overflow.controls, [])
    const metrics = await win.webContents.debugger.sendCommand('Page.getLayoutMetrics'), size = metrics.cssContentSize
    const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(size.height), scale: 1 } })
    const file = `subflows-${appearance}-${width}.png`; await writeFile(join(out, file), Buffer.from(image.data, 'base64'))
    const surface = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim()')
    receipt.captures.push({ file, width, height: Math.ceil(size.height), appearance, surface, overflow })
  }
  assert.notEqual(receipt.captures.find(image => image.appearance === 'dark').surface, receipt.captures.find(image => image.appearance === 'light').surface, 'The actual theme owner renders distinct light and dark surfaces')
  await click('.browser-task-asset__version .browser-rsi-button--primary')
  const invoked = await evaluate('subflowProof.invoked')
  assert.equal(invoked.runId, 'original-root-run'); assert.deepEqual(invoked.calls.collection.items.map(item => item.id), ['first-entry', 'second-entry'])
  assert.equal(invoked.calls.collection.items[1].parameters.label, 'Second entry')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify('[aria-label="Collection fresh Access token"]')}).value`), '')
  receipt.nativeCallback = { originalRoot: invoked.runId, itemIds: invoked.calls.collection.items.map(item => item.id), valuesCleared: true }
  receipt.complete = true; receipt.pid = process.pid
}).catch(error => { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => { await writeFile(join(out, 'capture.json'), JSON.stringify(receipt, null, 2)); win?.destroy(); app.quit() })
