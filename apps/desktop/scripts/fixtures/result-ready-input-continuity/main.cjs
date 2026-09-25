const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, privateRoot, evidence, probe = 'complete'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win
const result = { schema: 'agentmux.result-ready-input-render.v1', passed: false, frames: [], scenarios: [], userRunTouched: false }
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const surface = `(document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface') ?? document.querySelector('.agent-surface'))`
const trigger = `${surface}.querySelector('.session-result-review__trigger')`
const popover = `${surface}.querySelector('.session-result-review__popover')`
const textarea = `${surface}.querySelector('.xterm-helper-textarea')`
async function waitFor(expression) {
  for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25) }
  assert.fail('Expected actual renderer fact: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(60) }
const visible = expression => `(()=>{const e=${expression};if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility==='visible'&&s.display!=='none'})()`
async function point(expression) {
  return evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Actual target absent');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
}
async function click(expression, button = 'left') {
  const p = await point(expression)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button, clickCount: 1 })
}
async function key(key, code, virtual, text) {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type, key, code, windowsVirtualKeyCode: virtual, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {})
  })
}
async function typed(text) {
  const before = await evaluate('resultReady.facts().writes.length')
  for (const letter of text) await key(letter, 'Key' + letter.toUpperCase(), letter.toUpperCase().charCodeAt(0), letter)
  await painted()
  const writes = await evaluate('resultReady.facts().writes.slice(' + before + ')')
  assert.ok(writes.length > 0, 'Trusted keyboard input reaches production sessions.write')
  assert.equal(writes.map(item => item.data).join(''), text, 'Actual keys retain their exact bytes')
  assert.equal(writes[0].control.agentSessionId, await evaluate('resultReady.sessionId'))
  assert.equal(writes[0].source, 'user')
  await waitFor(`resultReady.terminal().cursorLine?.endsWith(${JSON.stringify(text)})`)
}
async function geometry() {
  return evaluate(`(()=>{const s=${surface},rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    return{body:rect(s.querySelector('.agent-body')),terminal:rect(s.querySelector('.terminal-view__xterm')),composer:rect(s.querySelector('.composer')),
      review:rect(s.querySelector('.session-result-review__popover')),prompt:rect(s.querySelector('.xterm-helper-textarea')),
      editor:rect(s.querySelector('.composer [role="textbox"]')),terminalFacts:resultReady.terminal(),focusedTerminal:document.activeElement===s.querySelector('.xterm-helper-textarea'),
      focusedComposer:document.activeElement===s.querySelector('.composer [role="textbox"]'),notices:s.querySelectorAll('.terminal-service-window .service-window').length,
      expanded:${trigger}?.getAttribute('aria-expanded')??null,nativeOpen:${popover}?.matches(':popover-open')??false,
      nativeOverlays:resultReady.facts().nativeOverlays,resizes:resultReady.facts().resizes}})()`)
}
function stable(before, after, message) {
  for (const field of ['body', 'terminal', 'composer', 'editor', 'resizes']) assert.deepEqual(after[field], before[field], message + ' · ' + field)
  for (const field of ['id', 'cols', 'rows', 'baseY', 'viewportY', 'cursorX', 'cursorY', 'cursorLine', 'visibleLines'])
    assert.deepEqual(after.terminalFacts[field], before.terminalFacts[field], message + ' · actual xterm ' + field)
}
async function frame(width, state) {
  const file = `${width}-${state}.png`, png = (await win.webContents.capturePage()).toPNG()
  assert.ok(png.length > 0, 'Actual full capture is nonempty'); await fs.writeFile(path.join(evidence, file), png)
  result.frames.push({ width, state, file })
}
const action = label => `Array.from(${popover}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})`
async function openReview() {
  await click(trigger); await waitFor(`${popover}.matches(':popover-open') && ${trigger}.getAttribute('aria-expanded')==='true'`); await painted()
  assert.equal(await evaluate('resultReady.facts().nativeOverlays'), 1, 'A deliberate result disclosure owns one native overlay lease')
  assert.ok(await evaluate(`${popover}.querySelectorAll('.session-result-review__details-actions button').length`) > 0, 'Actual review targets are nonempty')
  const { review, body, prompt, editor } = await geometry()
  assert.ok(review.width > 0 && review.height > 0, 'The actual result details are visible')
  assert.ok(review.x >= body.x && review.x + review.width <= body.x + body.width,
    'Result details stay inside their owning Region')
  assert.ok(review.y + review.height <= body.y + body.height / 2,
    'Result details leave the original Terminal input area visible')
  assert.ok(review.y + review.height <= prompt.y, 'Result details do not cover the actual xterm caret row')
  if (editor) assert.ok(review.y + review.height <= editor.y, 'Result details do not cover the original composer draft')
}
async function folded(message = 'The native popover is folded and releases its lease') {
  try { await waitFor(`${trigger}.getAttribute('aria-expanded')==='false' && !${popover}.matches(':popover-open') && resultReady.facts().nativeOverlays===0`) }
  catch (error) { result.foldFailure = await geometry(); assert.fail(message + ': ' + error.message) }
  await painted()
}
async function scene(width, mode = 'healthy') {
  result.stage = { width, mode }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: mode === 'readonly' ? width : width * 2 + 1, height: 740, deviceScaleFactor: 1, mobile: false })
  await evaluate(`resultReady.seed(${JSON.stringify(mode)})`)
  await waitFor(visible(textarea)); await waitFor(`!${surface}.querySelector('.terminal-view__xterm--hydrating')`); await painted()
  if (mode !== 'readonly') { await click(`${surface}.querySelector('.terminal-view__xterm')`); await typed('a') }
  const before = await geometry(), identity = await evaluate('resultReady.facts()')
  if (mode === 'healthy') assert.equal(before.notices, 0, 'The primary scene is healthy through an actual basic-vt checkpoint, not CSS-hidden notices')
  if (mode === 'degraded') assert.ok(before.notices > 0, 'The degraded scene actually retains its service notices')
  assert.ok(before.terminalFacts.visibleLines.some(line => line.includes('half typed prompt')), 'The actual prompt is visible before completion')
  await frame(width, mode + '-working')
  await evaluate('resultReady.done()'); await waitFor(visible(trigger)); await painted()
  const automatic = await geometry(), afterIdentity = await evaluate('resultReady.facts()')
  stable(before, automatic, 'Automatic Result ready preserves the original terminal geometry and prompt')
  assert.equal(automatic.expanded, 'false'); assert.equal(automatic.nativeOpen, false); assert.equal(automatic.nativeOverlays, 0)
  assert.equal(automatic.focusedTerminal, before.focusedTerminal, 'Automatic Result ready never steals terminal focus')
  for (const field of ['sessions', 'tab', 'layout', 'drafts']) assert.deepEqual(afterIdentity[field], identity[field], 'Completion retains the original ' + field)
  if (mode !== 'readonly') {
    await typed('b')
    const prompt = await evaluate('resultReady.terminal().cursorLine')
    assert.ok(prompt.endsWith('half typed promptab'), 'The same prompt continues receiving actual terminal input')
    const inputEvents = await evaluate('resultReady.facts().inputs.filter(event=>event.type==="keydown"&&event.terminal)')
    assert.ok(inputEvents.length > 0); assert.equal(inputEvents.at(-1).trusted, true, 'Post-completion keyboard input is trusted')
  }
  await frame(width, mode + '-ready')
  if (probe === 'automatic' || mode === 'degraded') { result.scenarios.push({ width, mode, before, automatic, identity: afterIdentity }); return }
  const beforeReview = await geometry()
  await openReview(); const opened = await geometry(); stable(beforeReview, opened, 'Deliberate Review preserves the same xterm')
  await frame(width, mode + '-review')
  await key('Escape', 'Escape', 27); await folded()
  assert.equal(await evaluate(`document.activeElement===${trigger}`), true, 'Native Escape returns to the original Review control')
  await openReview(); const beforeCollapseEvents = await evaluate('resultReady.facts().inputs.length'); await click(action('Collapse'))
  assert.ok(await evaluate(`resultReady.facts().inputs.slice(${beforeCollapseEvents}).some(event=>event.type==="click"&&event.trusted&&event.label==="Collapse")`),
    'The trusted Collapse click reaches its actual result button')
  await folded('Collapse closes the actual native popover and releases its lease')
  assert.equal(await evaluate(`document.activeElement===${trigger}`), true, 'Collapse returns to the original Review control')
  await openReview(); await key('Tab', 'Tab', 9)
  assert.equal(await evaluate('document.activeElement?.textContent?.trim()'), 'Collapse', 'Keyboard navigation reaches the actual result controls')
  await key('Enter', 'Enter', 13, '\r'); await folded('Keyboard Collapse closes the actual native popover and releases its lease')
  assert.equal(await evaluate(`document.activeElement===${trigger}`), true, 'Keyboard Collapse returns to the original Review control')
  await openReview(); await click(`${surface}.querySelector('.terminal-view__xterm')`); await folded()
  if (mode !== 'readonly') {
    await openReview(); const retained = await evaluate('resultReady.terminal().id')
    await evaluate('resultReady.visible(false)'); await waitFor('resultReady.facts().nativeOverlays===0'); await waitFor(`!${popover}.matches(':popover-open')`)
    await evaluate('resultReady.visible(true)'); await waitFor(visible(trigger)); await painted()
    assert.equal(await evaluate('resultReady.terminal().id'), retained, 'Hide and restore keep the original xterm')
    await folded()
    // A trusted context-menu Paste reads a bounded fixture value through the real application seam.
    // It never reads or changes the user's operating-system clipboard.
    await click(`${surface}.querySelector('.terminal-view__xterm')`, 'right')
    const paste = `Array.from(document.querySelectorAll('.terminal-context-menu [role="menuitem"]')).find(item=>item.querySelector('span')?.textContent==='Paste')`
    await waitFor(visible(paste)); const pasteCount = await evaluate('resultReady.facts().pastes.length')
    await click(paste); await waitFor(`resultReady.facts().pastes.length===${pasteCount + 1}`); await painted()
    const receipt = await evaluate('resultReady.facts().pastes.at(-1)')
    assert.equal(receipt.text, ' bounded paste'); assert.equal(receipt.terminalData, ' bounded paste')
    assert.equal(receipt.control.agentSessionId, await evaluate('resultReady.sessionId'))
    assert.ok(await evaluate('resultReady.terminal().cursorLine.endsWith("half typed promptab bounded paste")'))
    await click(`${surface}.querySelector('.composer [role="textbox"]')`)
    const beforeDismiss = await geometry()
    await openReview(); await click(action('Close')); await waitFor(`!${trigger} && resultReady.facts().nativeOverlays===0`)
    assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.composer [role="textbox"]')`), true, 'Dismiss returns to the original composer caret')
    const dismissed = await geometry(); stable(beforeDismiss, dismissed, 'Dismiss preserves layout')
    await evaluate('resultReady.done()'); await painted()
    assert.equal(await evaluate(`Boolean(${trigger})`), false, 'The same done notification does not reopen a dismissed result')
    await evaluate('resultReady.working()'); await painted(); await evaluate('resultReady.done()')
    try { await waitFor(visible(trigger)) } catch { assert.fail('A new completed turn exposes its result control') }
    await painted()
    stable(dismissed, await geometry(), 'A new completion retains the original geometry and prompt')
    assert.equal(await evaluate(`${trigger}.getAttribute('aria-expanded')`), 'false', 'A new completion is discoverable without expanding itself')
  }
  result.scenarios.push({ width, mode, before, automatic, opened, final: await geometry(), identity: await evaluate('resultReady.facts()') })
}
async function routing() {
  await evaluate('resultReady.seed()'); await waitFor(visible(textarea)); await painted(); await evaluate('resultReady.done()'); await waitFor(visible(trigger))
  await openReview(); await click(action('result.txt'))
  await waitFor('resultReady.facts().routes.some(route=>route[0]==="diff") && resultReady.facts().gitCalls.some(call=>call[0]==="diff")')
  let facts = await evaluate('resultReady.facts()')
  const workspaceId = await evaluate('resultReady.workspaceId')
  assert.ok(Object.values(facts.tabs).some(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'result.txt' && region.workspaceId === workspaceId)),
    'The result action reaches the actual existing file-diff workbench route')
  assert.equal(facts.routes.find(route => route[0] === 'diff')[2], await evaluate('resultReady.workspaceId'))
  const original = facts.sessions
  await evaluate('resultReady.seed()'); await waitFor(visible(textarea)); await painted(); await evaluate('resultReady.done()'); await waitFor(visible(trigger))
  await openReview(); await click(action('Preview'))
  await waitFor('resultReady.facts().routes.some(route=>route[0]==="preview")')
  facts = await evaluate('resultReady.facts()')
  assert.ok(Object.values(facts.tabs).some(tab => Object.values(tab.regions).some(region => region.kind === 'browser' && region.url === 'https://preview.example.test/result')),
    'Preview reaches the existing browser workbench route')
  assert.deepEqual(facts.sessions, original, 'Opening result destinations does not replace the original Sessions or Runs')
  result.routing = { routes: facts.routes, gitCalls: facts.gitCalls, tabs: facts.tabs, originalSessions: original }
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1281, height: 740, webPreferences: { backgroundThrottling: false, sandbox: false } })
    result.consoleErrors = []; win.webContents.on('console-message', details => { if (details.level === 'error') result.consoleErrors.push(details.message) })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.resultReady)')
    for (const width of [640, 320]) await scene(width)
    if (probe === 'complete') { await scene(320, 'degraded'); await scene(320, 'readonly'); await routing() }
    assert.ok(result.scenarios.length > 0, 'Actual scenarios are nonempty'); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage }
    try { result.failureFacts = { geometry: await geometry(), facts: await evaluate('resultReady.facts()'),
      focus: await evaluate('({ tag: document.activeElement?.tagName, className: document.activeElement?.className, documentFocused: document.hasFocus() })') } }
    catch (diagnostic) { result.diagnosticError = diagnostic.message }
  }
  finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
