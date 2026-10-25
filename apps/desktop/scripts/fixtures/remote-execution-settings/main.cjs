const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), { mkdirSync } = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto')
const [html, privateRoot, directory, mode = 'complete'] = process.argv.slice(2)
for (const key of ['home', 'appData', 'userData', 'sessionData']) {
  mkdirSync(path.join(privateRoot, key), { recursive: true }); app.setPath(key, path.join(privateRoot, key))
}
const receipt = { schema: 'agentmux.remote-execution-settings.native-capture.v1', passed: false, captureOnly: true,
  independentVisualReview: 'not-performed', pid: process.pid, mode, frames: [], interactions: [],
  boundary: 'Real private Electron Renderer, production Settings/Workbench/Launcher, controlled typed Session and API facts. No Main/SSH/native-Agent or physical user-input qualification.' }
const pause = ms => new Promise(done => setTimeout(done, ms))
let win
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1180, height: 900, show: false, title: 'Remote execution · private Settings review',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, _level, message) => { if (message.includes('Error')) console.error(message.slice(0, 500)) })
  await win.loadFile(html)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const read = async code => { receipt.lastEvaluation = code; return win.webContents.executeJavaScript(code) }
  const until = async (code, label) => {
    const end = performance.now() + 15000
    while (performance.now() < end) { if (await read(code)) return; await pause(30) }
    throw new Error(label ?? 'Renderer did not reach: ' + code)
  }
  const paint = async () => { await read('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))'); await pause(160) }
  const viewport = async (width, height) => { win.setContentSize(width, height); await paint() }
  const click = async selector => {
    await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`); await paint()
    const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,visible:n.checkVisibility(),hit:n.contains(document.elementFromPoint(x,y))}})()`)
    assert(point?.visible && point.hit, 'Actual visible hit target: ' + selector)
    const before = await read('remoteExecutionVisual.trustedEvents.length')
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    await paint()
    const events = await read(`remoteExecutionVisual.trustedEvents.slice(${before})`)
    assert(events.some(event => event.type === 'click' && event.trusted), 'Native Electron click reaches the actual component')
    receipt.interactions.push({ kind: 'native-renderer-click', selector, events })
  }
  const key = async keyCode => {
    const before = await read('remoteExecutionVisual.trustedEvents.length')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await paint()
    const events = await read(`remoteExecutionVisual.trustedEvents.slice(${before})`)
    assert(events.some(event => event.type === 'keydown' && event.trusted), 'Native Electron key reaches the actual component')
    receipt.interactions.push({ kind: 'native-renderer-key', keyCode, events })
  }
  const frame = async (name, selector = '.remote-execution-settings') => {
    await paint()
    const facts = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n?.getBoundingClientRect();return{width:innerWidth,height:innerHeight,appearance:document.documentElement.dataset.appearance,bodyOverflow:document.documentElement.scrollWidth>innerWidth,component:r?.toJSON(),readers:remoteExecutionVisual.facts().readers}})()`)
    assert(facts.component?.width > 0 && !facts.bodyOverflow, 'Complete production view fits its viewport')
    const image = await win.webContents.capturePage(), bytes = image.toPNG(), file = (mode === 'first' ? 'first-' : '') + name + '.png'
    await fs.writeFile(path.join(directory, file), bytes)
    receipt.frames.push({ name, file, sha256: createHash('sha256').update(bytes).digest('hex'), pixels: image.getSize(),
      facts, surface: 'complete-renderer-viewport', webContentsId: win.webContents.id })
    console.log(JSON.stringify({ frame: path.join(directory, file), captureOnly: true }))
  }
  const top = async () => { await read('document.querySelector(".remote-execution-settings")?.scrollIntoView({block:"start"})'); await paint() }
  await until('Boolean(window.remoteExecutionVisual?.ready && document.querySelector("[data-remote-prepare]"))')
  receipt.original = await read('remoteExecutionVisual.facts()')
  assert.equal(receipt.original.sessions.length, 2)
  assert.deepEqual(receipt.original.readers, [], 'An unselected settings list does not open binding readers')
  await frame('remote-wide-dark')
  if (mode === 'first') { receipt.passed = true; return }
  await read('remoteExecutionVisual.theme("light")'); await frame('remote-wide-light')
  await read('remoteExecutionVisual.empty(true)'); await frame('remote-empty')
  await read('remoteExecutionVisual.empty(false);remoteExecutionVisual.show("mote")'); await until('Boolean(document.querySelector(".settings-mote"))')
  await frame('mote-comparison-light', '.settings-mote')
  await read('remoteExecutionVisual.theme("dark")'); await frame('mote-comparison-dark', '.settings-mote')
  await read('remoteExecutionVisual.show()'); await until('Boolean(document.querySelector("[data-remote-prepare]"))')
  const firstId = receipt.original.sessions[0].id, secondId = receipt.original.sessions[1].id
  await click('[data-resource-row="' + firstId + '"]')
  await until('remoteExecutionVisual.facts().readers.length === 1 && document.querySelector(".tool-execution-observation")?.textContent.includes("Connected")')
  await frame('remote-original-binding')
  await click('[data-remote-open]')
  await until('Boolean(document.querySelector("#remote-settings-workbench"))')
  const opened = await read('remoteExecutionVisual.facts()')
  assert.deepEqual(opened.sessions, receipt.original.sessions, 'Opening the workface preserves exact original Session/Run/binding facts')
  assert.deepEqual(opened.drafts, receipt.original.drafts, 'Original unsent drafts survive opening')
  assert.equal(opened.layouts['local-project'].groups.find(group => group.id === opened.layouts['local-project'].activeGroupId).activeTabId, 'original-work-1')
  receipt.interactions.push({ kind: 'opened-original-workface', originalSessionId: firstId, facts: opened })
  await read('remoteExecutionVisual.show()'); await until('Boolean(document.querySelector("[data-remote-prepare]"))')
  await click('[data-resource-row="' + firstId + '"]'); await key('Down'); await key('Enter')
  await until('document.querySelector("[data-remote-binding]")?.dataset.remoteBinding === "preview-binding-2"')
  assert.deepEqual(await read('remoteExecutionVisual.facts().readers'), ['preview-binding-2'], 'Selection owns only the exact new reader')
  await read('remoteExecutionVisual.longLabels()')
  await frame('remote-long-path-same-host-names')
  await click('[data-resource-row="' + firstId + '"]')
  await until('document.querySelector("[data-remote-binding]")?.dataset.remoteBinding === "preview-binding-1"')
  assert.equal(receipt.original.sessions[0].status.state, 'working', 'Unknown observation is exercised on the original Working Agent')
  await read('remoteExecutionVisual.unknown()'); await viewport(560, 850)
  await read('document.querySelector(".remote-execution-detail").scrollIntoView({block:"start"})')
  await frame('remote-narrow-observation-unknown')
  assert.equal(await read('document.querySelector("[data-remote-open]").disabled'), false, 'Unknown observation leaves original work available')
  assert.deepEqual((await read('remoteExecutionVisual.facts()')).sessions[0], receipt.original.sessions[0], 'Observation failure preserves original Working Session facts')
  await viewport(840, 430); await top(); await frame('remote-short')
  const prepareHit = await read(`(()=>{const n=document.querySelector('[data-remote-prepare]'),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{bounds:r.toJSON(),viewport:{width:innerWidth,height:innerHeight},visible:n.checkVisibility(),disabled:n.disabled,hit:n.contains(document.elementFromPoint(x,y))}})()`)
  receipt.interactions.push({ kind: 'short-viewport-prepare-reachable', ...prepareHit })
  assert(prepareHit.visible && !prepareHit.disabled && prepareHit.hit && prepareHit.bounds.top >= 0 && prepareHit.bounds.bottom <= prepareHit.viewport.height && prepareHit.bounds.left >= 0 && prepareHit.bounds.right <= prepareHit.viewport.width,
    'Prepare is fully visible and hit-testable in the initial short viewport without scrolling to the button')
  await viewport(1180, 900); await top()
  await click('[data-remote-prepare]')
  await until('Boolean(document.querySelector("#remote-settings-workbench .launch-surface"))')
  const prepared = await read('remoteExecutionVisual.facts()')
  const newTabs = Object.values(prepared.tabs).filter(tab => !receipt.original.tabs[tab.id])
  assert.equal(newTabs.length, 1, 'Prepare creates one original Launcher tab')
  const launcher = newTabs[0].regions[newTabs[0].layout.activeRegionId]
  assert.equal(launcher.kind, 'launcher'); assert.equal(launcher.workspaceId, 'local-project'); assert.equal(launcher.agentWorkspaceId, 'local-project')
  assert.deepEqual(prepared.sessions, receipt.original.sessions); assert.deepEqual(prepared.drafts['original-region-1'], receipt.original.drafts['original-region-1'])
  assert.deepEqual(prepared.forbiddenCalls, [], 'Preparing does not create, submit, resume or stop an Agent')
  assert.deepEqual(prepared.readers, [], 'Settings release only their observation reader when preparing')
  receipt.interactions.push({ kind: 'prepared-original-launcher', launcher, originalSessions: prepared.sessions })
  await frame('remote-prepared-launcher', '.launch-surface')
  receipt.final = prepared; receipt.passed = true
}).catch(error => { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy()
  receipt.cleanup = { windowDestroyed: !win || win.isDestroyed() }
  await fs.writeFile(path.join(directory, mode === 'first' ? 'first-capture.json' : 'capture.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
