const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, evidence, mode] = process.argv.slice(2)
app.setName('AgentMux private performance proof')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { schema: 'agentmux.performance-healthcheck-native.v1', passed: false, mode, versions: process.versions,
  userAppOrRunTouched: false, physicalInputOrOsImeTested: false, cases: [], screenshots: [],
  boundary: 'Current shared Editor/Hover adapter, installed patched Radix/real xterm in one private non-activating native window. No user Run or original App recovery is simulated here.' }
let win, attached = false
const read = expression => win.webContents.executeJavaScript(expression)
const send = (method, params = {}) => win.webContents.debugger.sendCommand(method, params)
const facts = () => read('proof.facts()')
async function until(expression) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await read(expression)) return
    await delay(20)
  }
  throw Error('Private native condition not reached: ' + expression)
}
async function settled() {
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await delay(40)
}
async function screenshot(label) {
  const image = await win.webContents.capturePage(), bytes = image.toPNG()
  assert.ok(!image.isEmpty())
  fs.writeFileSync(path.join(evidence, label + '.png'), bytes)
  result.screenshots.push({ file: label + '.png', sha256: createHash('sha256').update(bytes).digest('hex'), size: image.getSize() })
}
async function key(key, code = key, text) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(text ? { text, unmodifiedText: text } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
}
async function metric() {
  const value = await send('Performance.getMetrics')
  const result = value.metrics.find(item => item.name === 'TaskDuration')?.value
  assert.ok(Number.isFinite(result), 'Native Renderer TaskDuration is available')
  return result
}
async function sample(scale) {
  await read('proof.scale(' + scale + ')')
  await until('proof.facts().retained===' + scale)
  await settled()
  await read('proof.focusComposer()')
  await settled()
  const before = await facts(), start = await metric()
  await read('proof.resetCosts()')
  for (let i = 0; i < 34; i++) await key('a', 'KeyA', 'a')
  await delay(400)
  const taskSeconds = (await metric()) - start, after = await facts()
  assert.ok(Number.isFinite(taskSeconds) && taskSeconds > 0)
  assert.equal(after.draft, before.draft + 'a'.repeat(34), 'All actual Chromium keys reach the original shared editor')
  assert.equal(after.sameNode, true)
  assert.equal(after.sameEditor, true)
  assert.equal(after.inputFocused, true)
  assert.ok(after.terminal.completedOutput > before.terminal.completedOutput, 'Real terminal output remains active during input sampling')
  assert.deepEqual(after.errors, [])
  result.cases.push({ scale, keys: 34, before, after, taskDurationSeconds: taskSeconds,
    costs: { keyCallbacks: after.keyCallbacks, pointerRegistrations: after.pointerRegistrations,
      keydownOwners: after.keydownOwners, selectionOwners: after.selectionOwners, editors: after.editors, unseenEditors: after.unseenEditors } })
}
async function menuBehavior() {
  await read('proof.focusComposer()')
  const initial = await facts(), trigger = initial.trigger
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 })
  await until('proof.facts().menuCount===1')
  assert.equal((await facts()).inputFocused, true, 'Actual hover preserves the existing editor caret')
  const item = await read('proof.itemRect()'), x = item.x + item.width / 2, y = item.y + item.height / 2
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await until('proof.facts().selected===1&&proof.facts().menuCount===0')
  // Finish the previous FocusScope's queued return-to-trigger before starting a
  // distinct keyboard opening; DOM removal alone is not its focus completion.
  await settled()
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await settled()
  await read('proof.focusMenu()')
  await key('ArrowDown')
  await until('proof.facts().menuItemFocused==="Visible action"')
  await read('proof.focusSubmenu()')
  await key('ArrowRight')
  await until('proof.facts().menuItemFocused==="Nested action"')
  await key('Escape')
  await until('proof.facts().menuCount===0')
  await until('proof.facts().menuFocused==="visible"')
  assert.equal((await facts()).menuFocused, 'visible', 'Escape restores the original trigger')
  await read('proof.focusTerminal()')
  const target = (await facts()).terminal.rect
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x + 100, y: target.y + 100, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x + 100, y: target.y + 100, button: 'right', clickCount: 1 })
  await until('proof.facts().menuCount===1')
  await key('Escape')
  await until('proof.facts().menuCount===0')
  await settled()
  return await facts()
}
async function inputAndReading() {
  await read('proof.focusComposer()')
  await until('proof.facts().inputFocused')
  await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await send('Input.insertText', { text: '中文' })
  await until('proof.facts().draft.endsWith("中文")')
  const composer = await facts()
  assert.ok(composer.terminal.compositions.some(item => item.target === 'composer' && item.name === 'compositionend' && item.data === '中文'))
  await read('proof.selectRange();proof.showComposer(false)')
  await settled()
  const hidden = await facts()
  assert.equal(hidden.sameNode, true)
  assert.equal(hidden.sameEditor, true)
  assert.deepEqual(hidden.selection, { from: 2, to: 7 })
  await read('proof.showComposer(true)')
  await settled()
  const restored = await facts()
  assert.equal(restored.draft, composer.draft)
  assert.deepEqual(restored.selection, hidden.selection)
  assert.equal(restored.sameEditor, true)
  assert.equal(await read('proof.undo()'), true, 'The retained editor keeps its real undo history')
  await read('proof.focusTerminal();proof.scrollTo(900)')
  await until('proof.facts().terminal.focused')
  await settled()
  const before = await facts(), rect = before.terminal.rect, samples = []
  for (let step = 0; step < 4; step++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      deltaX: 0, deltaY: -180 })
    await delay(80)
    samples.push((await facts()).terminal)
  }
  let previous = before.terminal.viewportY
  for (const sample of samples) {
    assert.ok(sample.viewportY < previous, 'Continuous upward reading progresses in the same live terminal')
    assert.ok(sample.top.startsWith('retained-terminal-line-'), 'Original retained lines remain readable')
    previous = sample.viewportY
  }
  assert.ok(samples.at(-1).completedOutput > before.terminal.completedOutput)
  await send('Input.insertText', { text: 'input-proof-' })
  await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await send('Input.insertText', { text: '中文' })
  await until('proof.facts().terminal.inputs.join("").includes("input-proof-中文")')
  const after = await facts()
  assert.equal(after.terminal.focused, true)
  assert.ok(after.terminal.compositions.some(item => item.target === 'terminal' && item.name === 'compositionend' && item.data === '中文'))
  return { composer, hidden, restored, before: before.terminal, upward: samples, after: after.terminal }
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 840, show: false, focusable: false, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.showInactive()
    await win.loadFile(html)
    assert.equal(win.webContents.getURL(), pathToFileURL(html).href, 'Only this exact private page is controlled')
    win.webContents.debugger.attach('1.3'); attached = true
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await send('Performance.enable')
    await until('window.proof?.ready')
    result.native = { mainPid: process.pid, rendererPid: win.webContents.getOSProcessId(), url: win.webContents.getURL(),
      windowFocused: win.isFocused(), visible: win.isVisible(), offscreen: win.webContents.isOffscreen(),
      backgroundThrottling: win.webContents.getBackgroundThrottling(), gpu: app.getGPUFeatureStatus() }
    assert.equal(result.native.windowFocused, false, 'Private proof never takes OS focus')
    assert.equal(result.native.visible, true)
    assert.equal(result.native.offscreen, false)
    await read('proof.start()')
    for (const scale of [1, 100, 500]) await sample(scale)
    const small = result.cases[0], large = result.cases.at(-1)
    assert.ok(small.costs.selectionOwners > 0, 'Actual document selection observation is nonempty')
    result.budget = { taskDurationSeconds: small.taskDurationSeconds * 3 + 0.25,
      keyCallbacks: 34, pointerRegistrations: 68, editors: 1, unseenEditors: 0, keydownOwners: 1, selectionOwners: small.costs.selectionOwners }
    assert.ok(result.cases.every(row => row.costs.keyCallbacks === 34 && row.costs.pointerRegistrations === 68 && row.costs.keydownOwners === 1 &&
      row.costs.editors === 1 && row.costs.unseenEditors === 0 && row.costs.selectionOwners === small.costs.selectionOwners),
      'Retained input cost grew with unrelated consumers')
    assert.ok(large.taskDurationSeconds <= result.budget.taskDurationSeconds, 'Fixed relevant input exceeds its native TaskDuration budget')
    result.behavior = { menus: await menuBehavior(), reading: await inputAndReading() }
    await screenshot('original-editor-live-terminal')
    assert.equal(win.isFocused(), false)
    result.passed = true
  } catch (error) {
    result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }
    try { result.failureFacts = await facts(); await screenshot('failure') } catch {}
  } finally {
    try { await read('window.proof?.stop()') } catch {}
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) {
      if (attached) { try { win.webContents.debugger.detach() } catch {} }
      win.destroy()
    }
    app.exit(result.passed ? 0 : 1)
  }
})
