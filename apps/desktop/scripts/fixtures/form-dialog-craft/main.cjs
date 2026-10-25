const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto')
const { app, BrowserWindow } = require('electron')
const [html, evidence, round] = process.argv.slice(2)
const folderPath = require('../../../../../test/fixture-values.mjs').fixturePath('research/original-folder')
app.setName('AgentMux private form proof'); app.setPath('userData', path.join(evidence, 'profile')); app.setPath('sessionData', path.join(evidence, 'session'))
const result = { schema: 'agentmux.form-dialog-native.v1', passed: false, round, cases: [], screenshots: [], userRuntimeTouched: false, nativeFocusChanged: false, harnessSHA256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
async function read(source) { return win.webContents.executeJavaScript(source) }
async function until(source) { for (let i = 0; i < 150; i++) { if (await read(source)) return; await delay(20) } throw new Error('Original form condition not reached: ' + source) }
async function screenshot(label) { const image = await win.webContents.capturePage(), bytes = image.toPNG(); assert.ok(!image.isEmpty()); const file = label + '.png'; fs.writeFileSync(path.join(evidence, file), bytes); result.screenshots.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), width: image.getSize().width, height: image.getSize().height }) }
async function click(selector) { const point = await read('formProof.point(' + JSON.stringify(selector) + ')'); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); await delay(120) }
async function key(key) { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0, ...(type === 'keyDown' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await delay(120) }
app.whenReady().then(async () => {
 try {
  win = new BrowserWindow({ width: 1280, height: 800, show: false, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { const text = event.message; (result.consoleMessages ??= []).push(text); console.error('form-renderer: ' + text) });
  win.on('focus', () => { result.nativeFocusChanged = true }); win.showInactive(); await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('window.formProof?.ready && document.querySelector(".form-proof-workface button")')
  const desired = { group: 480, folder: 480, category: 560, mote: 400, viewport: 360 }
  for (const [size, width, height] of [['wide', 1280, 800], ['narrow', 420, 700]]) for (const theme of ['dark', 'light']) {
   win.setContentSize(width, height); await delay(60)
   for (const kind of ['group', 'folder', 'category', 'mote', 'viewport']) {
    const facts = await read('formProof.open(' + JSON.stringify(kind) + ',' + JSON.stringify(theme) + ')')
    assert.ok(facts.dialog); assert.ok(Math.abs(facts.dialog.width - Math.min(desired[kind], width - 32)) < 1, 'Declared dialog width survives the real CSS cascade: ' + kind)
    assert.equal(facts.dialog.overflow, false, 'Form has no horizontal overflow: ' + kind)
    assert.equal(facts.focusInside, true, 'Keyboard focus enters the actual form: ' + kind)
    if (kind !== 'viewport') { assert.equal(facts.dialog.primaryCount, 1); assert.ok(facts.dialog.close); assert.ok(Math.abs(facts.dialog.x + facts.dialog.width - facts.dialog.padding - (facts.dialog.close.x + facts.dialog.close.width)) < 2, 'Close action aligns to the heading edge') }
    if (kind === 'folder') assert.equal(facts.headingIconColor, facts.neutralColor, 'Ordinary folder identity uses neutral ink')
    if (kind === 'mote') assert.deepEqual(await read('(()=>{const n=document.querySelector(".mote-rename input");return [n.selectionStart,n.selectionEnd,n.value.length]})()'), [0, facts.value.length, facts.value.length])
    result.cases.push({ kind, theme, size, facts }); await screenshot([kind, size, theme].join('-'))
    await click('.confirmation-dialog__cancel' + (kind === 'viewport' ? ', .confirmation-dialog footer .small-button' : ''))
    await until('!document.querySelector(".confirmation-dialog")')
    assert.equal(await read('document.activeElement?.textContent'), 'Organize projects', 'Closing returns focus to its opening control: ' + kind)
   }
  }
  if (round === 'candidate') {
   win.setContentSize(1280, 800); await read('formProof.open("group","dark")'); await read('formProof.mode("unconfirmed")'); await read('formProof.setInput("Interface quality")'); await delay(50); await key('Enter')
   await until('!!document.querySelector(".project-group-dialog__unconfirmed")'); await screenshot('group-unconfirmed-dark')
   await read('formProof.mode("failure")'); await click('.project-group-dialog .primary-button'); await until('!!document.querySelector(".project-group-dialog .surface-inline-error")'); await screenshot('group-retry-failure-dark')
   let state = await read('formProof.facts()'); assert.equal(state.value, 'Interface quality'); assert.equal(new Set(state.saveRequests.map(request => request.groupId)).size, 1); assert.equal(state.saveRequests.length, 2)
   await read('formProof.mode("confirmed")'); await click('.project-group-dialog .primary-button'); await until('!document.querySelector(".confirmation-dialog")'); state = await read('formProof.facts()'); assert.equal(state.saveRequests.length, 3); assert.equal(new Set(state.saveRequests.map(request => request.groupId)).size, 1)
   await read('formProof.open("folder","light")'); await read('formProof.setInput(' + JSON.stringify(folderPath) + ')'); await delay(50); await key('Enter'); await until('!!document.querySelector(".host-folder-dialog .surface-inline-error")'); state = await read('formProof.facts()'); assert.equal(state.value, folderPath); assert.deepEqual(state.folderRequests, [{ hostId: 'original-host', path: folderPath }]); await screenshot('folder-save-failure-light')
   for (const kind of ['group', 'category']) for (const marker of ['composing', 'legacy']) {
    await read('formProof.open(' + JSON.stringify(kind) + ',"dark")')
    const prevented = await read('(()=>{const e=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true,' + (marker === 'composing' ? 'isComposing:true' : 'keyCode:229') + '});document.querySelector(".confirmation-dialog input").dispatchEvent(e);return e.defaultPrevented})()')
    assert.equal(prevented, true, 'Actual form keeps IME Enter ownership: ' + kind + '/' + marker)
   }
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await read('formProof.open("group","dark")'); assert.equal((await read('formProof.facts()')).scrimAnimation, 'none')
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); await read('document.querySelector(".dialog-scrim").dataset.nativeOverlayMotion="static"'); assert.equal((await read('formProof.facts()')).scrimAnimation, 'none')
  }
  assert.deepEqual((await read('formProof.facts()')).errors, []); assert.equal(result.nativeFocusChanged, false); result.passed = true
 } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; try { result.facts = await read('formProof.facts()'); await screenshot('failure') } catch {} }
 finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); if (win && !win.isDestroyed()) { win.webContents.debugger.detach(); win.destroy() } app.exit(result.passed ? 0 : 1) }
})
