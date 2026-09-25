const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win
const result = { schema: 'agentmux.status-prompt-render.v1', passed: false, frames: [], scenes: [], userRunTouched: false }
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`
const rail = `${surface}.querySelector('.agent-status-prompts')`
const buttons = `${rail}.querySelectorAll('button')`
async function waitFor(expression) {
  for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25) }
  assert.fail('Expected actual renderer fact: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(40) }
async function click(expression) {
  const point = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Target absent');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function key(key, code, virtual, text) {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type, key, code, windowsVirtualKeyCode: virtual, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {})
  })
}
async function geometry() {
  return evaluate(`(()=>{const s=${surface},rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{
    body:rect(s.querySelector('.agent-body')),terminal:rect(s.querySelector('.terminal-view__xterm')),composer:rect(s.querySelector('.composer')),
    editor:rect(s.querySelector('.composer [role="textbox"]')),rail:rect(s.querySelector('.agent-status-prompts')),
    editorText:s.querySelector('.composer [role="textbox"]')?.textContent,
    xterm:resultReady.terminal(),terminalFocused:document.activeElement===s.querySelector('.xterm-helper-textarea'),
    composerFocused:document.activeElement===s.querySelector('.composer [role="textbox"]'),facts:statusPromptActions.facts()}})()`)
}
async function settledGeometry() {
  const key = value => JSON.stringify([value.body,value.terminal,value.composer,value.editor,value.rail,value.xterm.cols,value.xterm.rows,value.facts.resizes.length])
  let before = await geometry()
  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(160); const after = await geometry()
    if (key(before) === key(after)) return after
    before = after
  }
  assert.fail('The existing recovery/request layout and original xterm must settle before observing Prompt-only transitions')
}
function stable(before, after) {
  for (const name of ['body','terminal','composer','editor','rail','editorText']) assert.deepEqual(after[name], before[name], 'State changes preserve the fixed Prompt rail and Terminal geometry · ' + name)
  for (const name of ['id','cols','rows','baseY','viewportY','cursorX','cursorY','cursorLine','visibleLines'])
    assert.deepEqual(after.xterm[name], before.xterm[name], 'State changes preserve the original xterm · ' + name)
  assert.equal(after.terminalFocused, before.terminalFocused, 'State changes retain terminal focus')
  assert.equal(after.composerFocused, before.composerFocused, 'State changes retain composer focus')
  for (const name of ['drafts','tab','layout','resizes','sessions']) assert.deepEqual(after.facts[name], before.facts[name], 'State changes retain the original ' + name)
}
async function frame(width, name) {
  await painted()
  const file = `${width}-${name}.png`, bytes = (await win.webContents.capturePage()).toPNG()
  assert.ok(bytes.length > 0); await fs.writeFile(path.join(evidence, file), bytes); result.frames.push({ width, name, file })
}
async function typed(letter) {
  const count = await evaluate('statusPromptActions.facts().writes.length')
  await key(letter, 'Key' + letter.toUpperCase(), letter.toUpperCase().charCodeAt(0), letter)
  await waitFor(`statusPromptActions.facts().writes.length>${count}`); await painted()
  const writes = await evaluate(`statusPromptActions.facts().writes.slice(${count})`)
  assert.equal(writes.map(write => write.data).join(''), letter, 'Native keys reach the original Terminal write path')
  assert.equal(writes[0].control.agentSessionId, await evaluate('statusPromptActions.sessionId'))
  assert.equal(writes[0].source, 'user'); assert.ok(await evaluate(`resultReady.terminal().cursorLine.endsWith(${JSON.stringify(letter)})`))
  assert.ok(await evaluate('statusPromptActions.facts().inputs.some(event=>event.type==="keydown"&&event.terminal&&event.trusted)'))
}
async function scene(width) {
  result.stage = { width }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width * 2 + 1, height: 740, deviceScaleFactor: 1, mobile: false })
  await evaluate('statusPromptActions.seed(false)'); await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea')) && !${surface}.querySelector('.terminal-view__xterm--hydrating')`); await painted()
  const unconfigured = await geometry(); assert.equal(unconfigured.rail, null, 'Unconfigured status actions occupy no row')
  await frame(width, 'unconfigured')
  await evaluate('statusPromptActions.seed(true)'); await waitFor(`Boolean(${rail}) && !${surface}.querySelector('.terminal-view__xterm--hydrating')`); await painted()
  await click(`${surface}.querySelector('.terminal-view__xterm')`); await typed('a')
  const before = await settledGeometry(); assert.equal(before.rail.height, 24, 'The configured rail is one existing density row')
  assert.equal(before.editorText, before.facts.drafts[await evaluate('statusPromptActions.sessionId')], 'The production editor actually renders the retained draft')
  const states = await evaluate('statusPromptActions.states')
  // Disconnection has its own existing recovery panel. Isolate that flow's geometry from the Prompt rail.
  for (const state of states.filter(state => state !== 'disconnected')) {
    result.stage = { width, state }
    await evaluate(`statusPromptActions.state(${JSON.stringify(state)})`); await painted()
    const current = await geometry(); stable(before, current)
    const actual = await evaluate(`Array.from(${buttons}).map(button=>button.getAttribute('aria-label'))`)
    const expected = await evaluate(`statusPromptActions.prompts.filter(prompt=>prompt.states.includes(${JSON.stringify(state)})).map(prompt=>'Send '+prompt.label)`)
    assert.ok(actual.length > 0, 'Actual configured actions are nonempty'); assert.deepEqual(actual, expected)
  }
  await evaluate('statusPromptActions.state("disconnected")'); await painted()
  const disconnected = await geometry()
  for (const field of ['composer','editor','rail']) assert.deepEqual(disconnected[field], before[field], 'Disconnection preserves the same Prompt rail and draft surface · ' + field)
  assert.equal(disconnected.terminalFocused, true); assert.deepEqual(disconnected.facts.drafts, before.facts.drafts)
  assert.deepEqual(await evaluate(`Array.from(${buttons}).map(button=>button.getAttribute('aria-label'))`), ['Send Explain disconnected'])
  assert.equal(disconnected.xterm.id, before.xterm.id, 'Existing recovery disclosure keeps the original xterm')
  result.disconnected = [...(result.disconnected ?? []), { width, geometry: disconnected, boundary: 'Existing recovery panel may resize Terminal; the Prompt rail remains fixed. Mounted test proves typed restoration.' }]
  await evaluate('statusPromptActions.state("working")'); await painted(); await settledGeometry()
  await evaluate('statusPromptActions.state("done")'); await painted(); await typed('b')
  await frame(width, 'done-actions')
  const beforeKeyboard = await geometry()
  // The fixed row scrolls rather than wrapping. Native Tab traverses every configured action.
  await evaluate(`${buttons}[0].focus()`)
  const labels = []
  const length = await evaluate(`${buttons}.length`); assert.ok(length > 1)
  for (let index = 0; index < length; index++) {
    const focused = await evaluate(`({label:document.activeElement.getAttribute('aria-label'),within:${rail}.contains(document.activeElement),scroll:${rail}.scrollLeft})`)
    assert.equal(focused.within, true, 'Every Prompt action is keyboard reachable'); labels.push(focused.label)
    if (index + 1 < length) { await key('Tab', 'Tab', 9); await painted() }
  }
  assert.deepEqual(labels, await evaluate(`Array.from(${buttons}).map(button=>button.getAttribute('aria-label'))`))
  result.keyboardScroll = await evaluate(`({width:${rail}.clientWidth,scrollWidth:${rail}.scrollWidth,scrollLeft:${rail}.scrollLeft,focused:document.activeElement.getBoundingClientRect().toJSON()})`)
  assert.ok(result.keyboardScroll.scrollWidth>result.keyboardScroll.width && result.keyboardScroll.scrollLeft>0, 'All actions remain reachable through horizontal scroll')
  const focusPaint = await evaluate(`(()=>{const style=getComputedStyle(document.activeElement);return{visible:document.activeElement.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth),outlineOffset:parseFloat(style.outlineOffset),scrollbarWidth:getComputedStyle(${rail}).scrollbarWidth}})()`)
  assert.equal(focusPaint.visible, true, 'The actual keyboard action has a visible focus affordance')
  assert.equal(focusPaint.outlineStyle, 'solid'); assert.ok(focusPaint.outlineWidth > 0)
  assert.ok(focusPaint.outlineOffset + focusPaint.outlineWidth <= 0, 'The complete focus outline stays inside the fixed action row')
  assert.equal(focusPaint.scrollbarWidth, 'none', 'Native scrolling does not paint a thumb across the action focus')
  result.keyboardFocus = [...(result.keyboardFocus ?? []), { width, ...focusPaint }]
  const keyboardGeometry = await geometry()
  for (const field of ['body','terminal','composer','editor','rail']) assert.deepEqual(keyboardGeometry[field], beforeKeyboard[field], 'Keyboard scrolling does not move the original work surface · ' + field)
  for (const field of ['id','cols','rows']) assert.equal(keyboardGeometry.xterm[field], beforeKeyboard.xterm[field], 'Keyboard scrolling retains original xterm ' + field)
  await frame(width, 'keyboard-actions')
  const longLabel = await evaluate(`${buttons}[${length - 1}].getAttribute('aria-label')`)
  assert.ok(longLabel.includes('接下来工作的价值和重点'), 'Truncated labels keep their complete accessible text')
  const beforeClick = await evaluate('statusPromptActions.facts()')
  await key('Enter', 'Enter', 13, '\r'); await evaluate('statusPromptActions.drain()')
  const afterClick = await evaluate('statusPromptActions.facts()')
  assert.equal(afterClick.submissions.length, beforeClick.submissions.length + 1, 'One native action produces one typed submission')
  assert.equal(afterClick.submissions.at(-1).text, 'User next step 7'); assert.equal(afterClick.submissions.at(-1).control.agentSessionId, await evaluate('statusPromptActions.sessionId'))
  assert.deepEqual(afterClick.drafts, beforeClick.drafts, 'Configured Prompt submission preserves the independent draft')
  for (const kind of ['permission','question']) {
    await evaluate(`statusPromptActions.state('running'); statusPromptActions.pending(${JSON.stringify(kind)})`); await painted()
    const beforeQueue = await evaluate('statusPromptActions.facts()')
    assert.equal(await evaluate(`${buttons}[0].getAttribute('aria-label')`), 'Queue Explain running')
    assert.ok(await evaluate(`${buttons}[0].textContent.startsWith('Queue ·')`), 'Pending requests clearly name Queue')
    await click(`${buttons}[0]`); await evaluate('statusPromptActions.drain()')
    const queued = await evaluate('statusPromptActions.facts()')
    assert.equal(queued.submissions.length, beforeQueue.submissions.length, 'A queued action never submits into a pending request')
    assert.equal(queued.responses.length, beforeQueue.responses.length, 'A queued action never impersonates an interaction response')
    assert.deepEqual(queued.pending, beforeQueue.pending); assert.deepEqual(queued.drafts, beforeQueue.drafts)
    assert.deepEqual(queued.queues[await evaluate('statusPromptActions.sessionId')].map(item => item.text), ['Configured running prompt\n  exact spacing'])
    await frame(width, 'queue-' + kind)
    await evaluate(`statusPromptActions.answer(${JSON.stringify(kind)})`); await evaluate('statusPromptActions.drain()')
    const answered = await evaluate('statusPromptActions.facts()')
    assert.equal(answered.responses.length, beforeQueue.responses.length + 1)
    assert.equal(answered.submissions.length, beforeQueue.submissions.length + 1)
    assert.equal(answered.submissions.at(-1).text, 'Configured running prompt\n  exact spacing'); assert.deepEqual(answered.drafts, beforeQueue.drafts)
  }
  await click(`${surface}.querySelector('.composer [role="textbox"]')`)
  const composerFocused = await settledGeometry()
  for (const state of ['working','done','waiting']) { await evaluate(`statusPromptActions.state(${JSON.stringify(state)})`); await painted(); stable(composerFocused, await geometry()) }
  result.scenes.push({ width, unconfigured, configured: before, final: await geometry(), keyboardLabels: labels })
}
async function settings() {
  result.stage = { settings: true }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1000, height: 850, deviceScaleFactor: 1, mobile: false })
  await evaluate('statusPromptActions.seed(false); statusPromptActions.settings()'); await waitFor('Boolean(document.querySelector(".settings-pane-toolbar button"))')
  await click('document.querySelector(".settings-pane-toolbar button")')
  const card = 'document.querySelector(".prompt-settings-card")'
  await click(`${card}.querySelector('summary')`); await painted()
  async function fill(field, value) {
    const target = `Array.from(${card}.querySelectorAll('label')).find(label=>label.querySelector('span')?.textContent===${JSON.stringify(field)}).querySelector('input,textarea,[role="textbox"]')`
    await click(target)
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value })
  }
  await fill('Keyword', 'plainwords'); await fill('Name', '大白话说说做了什么'); await fill('Prompt', '大白话说清楚\n1. 目标与现状\n2. 完成的内容、质量和品位\n3. 接下来的价值和重点\n然后继续')
  const states = await evaluate('statusPromptActions.states'); assert.equal(states.length, 9)
  for (const state of states) await click(`${card}.querySelector('input[value=${JSON.stringify(state)}]')`)
  await frame(1000, 'settings-all-states')
  await click('document.querySelector(".settings-pane-actions button")'); await waitFor('statusPromptActions.facts().saved.length>0')
  const saved = await evaluate('statusPromptActions.facts().config.composerShortcuts')
  assert.equal(saved.length, 1); assert.deepEqual(saved[0].states, states); assert.equal(saved[0].label, '大白话说说做了什么')
  assert.ok(saved[0].body.includes('3. 接下来的价值和重点'))
  await click('document.querySelector(".settings-content__close")'); await waitFor('!document.querySelector(".settings-page")')
  await evaluate('statusPromptActions.state("done")'); await painted()
  assert.equal(await evaluate(`${buttons}.length`), 1, 'Native Settings changes immediately reach the product rail')
  const before = await evaluate('statusPromptActions.facts()'); await click(`${buttons}[0]`); await evaluate('statusPromptActions.drain()')
  const after = await evaluate('statusPromptActions.facts()')
  assert.equal(after.submissions.at(-1).text, saved[0].body); assert.deepEqual(after.drafts, before.drafts)
  result.settings = { saved, facts: after }
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1281, height: 850, webPreferences: { backgroundThrottling: false, sandbox: false } })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.statusPromptActions)')
    for (const width of [640,320]) await scene(width)
    await settings(); assert.equal(result.scenes.length, 2); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage }
    try { result.failureFacts = await geometry() } catch (diagnostic) { result.diagnosticError = diagnostic.message }
  } finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
