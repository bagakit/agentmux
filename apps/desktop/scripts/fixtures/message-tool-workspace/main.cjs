const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false,
  runtime: { electron: process.versions.electron, chromium: process.versions.chrome }, scenes: [], frames: [] }
let win
const surface = `document.querySelector('[data-workbench-region-id="region-actions-target"]')`
const panel = `${surface}.querySelector('.composer-mailbox')`
const editor = `${surface}.querySelector('.composer [role="textbox"]')`
const visiblePanel = `${panel}.querySelector('[role="tabpanel"]:not([hidden])')`
const query = `${visiblePanel}.querySelector('input[type="search"]')`
const buttons = (name, root = panel) => `([...${root}.querySelectorAll('button')].find(n=>!n.closest('[hidden]')&&(n.getAttribute('aria-label')===${JSON.stringify(name)}||n.textContent.trim()===${JSON.stringify(name)})))`
const tab = name => `([...${panel}.querySelectorAll('[role="tab"]')].find(n=>!n.closest('[hidden]')&&(n.querySelector('.composer-mailbox__folder-label')?.textContent??n.textContent).trim()===${JSON.stringify(name)}))`
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const visible = target => `(()=>{const n=${target};if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility==='visible'})()`
async function waitFor(expression) {
  for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25) }
  throw new Error('Timed out: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(100) }
async function click(target) {
  await waitFor(visible(target))
  await evaluate(`${target}.scrollIntoView({block:'nearest'})`)
  const point = await evaluate(`(()=>{const n=${target},r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(n!==hit&&!n.contains(hit))throw new Error('Original action is not hit: '+n.outerHTML);return{x,y}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await painted()
}
async function key(key, code, virtual) {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual,
    ...(type === 'keyDown' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await painted()
}
async function replace(target, value) {
  await click(target); win.webContents.selectAll(); await key('Backspace', 'Backspace', 8)
  await win.webContents.insertText(value); await painted()
}
async function choose(name) { await click(tab(name)); await waitFor(`${tab(name)}.getAttribute('aria-selected')==='true'`) }
async function frame(width, theme, state) {
  await painted()
  const file = `${theme}-${width}-${state}.png`, png = (await win.webContents.capturePage()).toPNG()
  assert.ok(png.length > 0); await fs.writeFile(path.join(evidence, file), png)
  result.frames.push({ width, theme, state, file, sha256: createHash('sha256').update(png).digest('hex') })
}
async function layout() {
  const actual = await evaluate(`(()=>{const p=${panel},r=p.getBoundingClientRect();return{width:p.clientWidth,scroll:p.scrollWidth,top:r.top,bottom:r.bottom,tabs:[...p.querySelectorAll('[role="tab"]')].filter(n=>!n.closest('[hidden]')).map(n=>{const l=n.querySelector('.composer-mailbox__folder-label')??n,b=n.getBoundingClientRect();return{label:l.textContent,complete:l.scrollWidth<=l.clientWidth+1,left:b.left,right:b.right,top:b.top,inside:b.left>=r.left-1&&b.right<=r.right+1}})}})()`)
  assert.ok(actual.scroll <= actual.width + 1, 'The actual mailbox has no horizontal overflow')
  assert.ok(actual.top >= 0 && actual.bottom <= await evaluate('innerHeight'), 'The original mailbox stays inside the viewport')
  assert.ok(actual.tabs.length >= 3 && actual.tabs.every(item => item.complete && item.inside), 'All visible navigation labels remain complete and contained')
  assert.deepEqual(actual.tabs.slice(0, 3).map(item => item.label), ['Inputs', 'Agent messages', 'Notices'])
  assert.equal(new Set(actual.tabs.slice(0, 3).map(item => Math.round(item.top))).size, 1, 'Primary navigation keeps one readable row')
  return actual
}
async function rowAffordances() {
  assert.equal(await evaluate("matchMedia('(hover: hover) and (pointer: fine)').matches"), true, 'The real desktop hover rules are active')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await painted()
  const send = await evaluate(`(()=>{const n=${visiblePanel}.querySelector('.composer-outbox__send'),row=n?.closest('.composer-mailbox__record'),footer=n?.closest('.composer-mailbox__record-footer');if(!n||!row||!footer)throw new Error('The original pending Send action is missing');const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),style=getComputedStyle(footer);return{hovered:row.matches(':hover'),focused:row.matches(':focus-within'),opacity:style.opacity,pointerEvents:style.pointerEvents,visible:getComputedStyle(n).visibility,enabled:!n.disabled,hit:n===hit||n.contains(hit)}})()`)
  assert.equal(send.hovered, false); assert.equal(send.focused, false)
  assert.equal(send.opacity, '1', 'The resting pending footer remains fully visible')
  assert.equal(send.pointerEvents, 'auto'); assert.equal(send.visible, 'visible')
  assert.equal(send.enabled, true); assert.equal(send.hit, true, 'Send remains hit-testable without hover or dispatch')
  const plain = `${visiblePanel}.querySelector('.composer-mailbox__record:not(:has(.composer-mailbox__record-actions, .composer-mailbox__record-status)):has(time)')`
  await waitFor(visible(plain))
  await evaluate(`${plain}.scrollIntoView({block:'nearest'})`)
  const point = await evaluate(`(()=>{const r=${plain}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await painted()
  const metadata = await evaluate(`(()=>{const row=${plain},n=row.querySelector('.composer-mailbox__metadata'),time=n.querySelector('time'),r=time.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{hovered:row.matches(':hover'),visibility:getComputedStyle(n).visibility,opacity:getComputedStyle(n).opacity,text:time.textContent,hit:time===hit||time.contains(hit)}})()`)
  assert.equal(metadata.hovered, true, 'The plain record receives a real pointer hover')
  assert.ok(metadata.text); assert.equal(metadata.visibility, 'visible'); assert.equal(metadata.opacity, '1')
  assert.equal(metadata.hit, true, 'A row without actions keeps its visible time while hovered')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await evaluate(`${panel}.querySelector('.composer-mailbox__content').scrollTop=0`)
  await painted()
  return { send, metadata }
}
async function scenario(width, theme, short = false) {
  result.stage = { width, theme, short, action: 'seed' }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width * 2 + 1, height: short ? 540 : 800, deviceScaleFactor: 1, mobile: false })
  const original = await evaluate(`messageWorkspace.seed(${JSON.stringify(theme)},${JSON.stringify(theme + '-' + width + (short ? '-short' : ''))})`)
  await waitFor(`${surface}?.querySelector('.xterm') && ${editor}?.textContent.includes('尚未发送')`)
  await painted()
  await evaluate(`window.workspaceEditor=${editor}`)
  const before = await evaluate('({terminal:messageWorkspace.terminal(),facts:messageWorkspace.facts()})')
  await click(`${surface}.querySelector('.composer__mailbox')`)
  await waitFor(`${panel}.matches(':popover-open')`)
  await choose('Inputs')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key]').length===5`)
  const geometry = await layout()
  const affordances = short ? undefined : await rowAffordances()
  await frame(width, theme, short ? 'inputs-short' : 'inputs')
  if (short) { await key('Escape', 'Escape', 27); return }
  if (width === 380 && theme === 'dark') {
    await click(buttons('编辑这条待发消息'))
    const queuedEditor = `${panel}.querySelector('textarea[aria-label="编辑待发消息"]')`
    await replace(queuedEditor, '保留在编辑器中的候选文本；取消不会改动原消息。')
    await frame(width, theme, 'queue-edit')
    await click(buttons('取消'))
    assert.deepEqual((await evaluate('messageWorkspace.facts()')).queues, before.facts.queues)
  }

  result.stage.action = 'search'
  await replace(query, 'Mercury'); await key('Enter', 'Enter', 13)
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key]').length===2`)
  assert.ok(await evaluate(`[...${visiblePanel}.querySelectorAll('button[data-record-key]')].every(n=>n.textContent.includes('Mercury'))`))
  const prior = await evaluate('messageWorkspace.facts().calls')
  await click(buttons('Refresh inputs'))
  await waitFor(`messageWorkspace.facts().calls.length>=${prior.length + 3}`)
  const reads = await evaluate(`messageWorkspace.facts().calls.slice(${prior.length})`)
  assert.equal(reads.filter(item => item.action === 'journal').length, 1)
  assert.deepEqual(reads.filter(item => item.action === 'history').map(item => item.query.query), ['Mercury', 'Mercury'])
  if (width === 380 && theme === 'dark') await frame(width, theme, 'search')

  result.stage.action = 'journal-detail'
  const journal = `([...${visiblePanel}.querySelectorAll('button[data-record-key]')].find(n=>n.textContent.includes('Mercury · 核对')))`
  const journalKey = await evaluate(`${journal}.dataset.recordKey`)
  await click(journal)
  await waitFor(`${visiblePanel}.querySelector('.log-turn__body')?.textContent.includes('原文末尾仍然可读')`)
  assert.equal(await evaluate(`${panel}.querySelectorAll('.log-turn__body').length`), 1)
  await click(buttons('Copy message'))
  await waitFor(`messageWorkspace.facts().clipboard.at(-1)===${JSON.stringify(original.journalWire)}`)
  const scroll = await evaluate(`(()=>{const n=${panel}.querySelector('.composer-mailbox__content');n.scrollTop=37;return n.scrollTop})()`)
  await click(buttons('Automation'))
  assert.equal(await evaluate(`document.activeElement===${buttons('Back to messages')}`), true, 'Automation entry transfers focus to its Back action')
  await click(buttons('Back to messages'))
  assert.equal(await evaluate(`${panel}.querySelector('.composer-mailbox__detail[data-record-key]')?.dataset.recordKey`), journalKey, 'Automation returns to the original journal detail')
  assert.equal(await evaluate(`${panel}.querySelector('.composer-mailbox__content').scrollTop`), scroll)
  assert.equal(await evaluate(`document.activeElement===${buttons('Automation')}`), true)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'journal-detail')
  await click(`${panel}.querySelector('.composer-mailbox__back button')`)
  assert.equal(await evaluate('document.activeElement.dataset.recordKey'), journalKey)
  assert.equal(await evaluate(`${query}.value`), 'Mercury')
  await replace(query, ''); await key('Enter', 'Enter', 13)
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key]').length===5`)

  result.stage.action = 'agent-messages'
  await choose('Agent messages'); await choose('Received')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===25`)
  await layout()
  if (width === 380 || width === 320) await frame(width, theme, 'received')
  assert.equal((await evaluate('identityMenu.mailboxLayoutFacts().calls')).filter(item => item.action === 'read').length, 0, 'A2A metadata does not read full bodies per row')
  const incoming = `([...${visiblePanel}.querySelectorAll('button[data-record-key]')].find(n=>n.dataset.recordKey===${JSON.stringify('a2a:' + original.incoming)}))`
  await click(incoming)
  await waitFor(`${visiblePanel}.querySelector('.log-turn__body')?.textContent.includes('原文唯一尾段')`)
  const originalReads = (await evaluate('identityMenu.mailboxLayoutFacts().calls')).filter(item => item.action === 'read')
  assert.equal(originalReads.length, 1); assert.equal(originalReads[0].messageId, original.incoming)
  assert.deepEqual(originalReads[0].reference, { hostId: original.hostId, agentSessionId: original.agentSessionId })
  if (width === 380 && theme === 'dark') await frame(width, theme, 'a2a-detail')
  await click(`${panel}.querySelector('.composer-mailbox__back button')`)
  await click(buttons('Read earlier messages'))
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===27`)
  await choose('Sent')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===3`)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'sent')
  await choose('Collaboration')
  await waitFor(`${visiblePanel}.querySelector('[data-source-message]')`)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'collaboration')
  await choose('Notices')
  await waitFor(`${visiblePanel}.querySelector('.composer-notice')`)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'notices')

  result.stage.action = 'automation'
  const automation = `([...${panel}.querySelectorAll('button')].find(n=>!n.closest('[hidden]')&&n.textContent.includes('Automation')))`
  await click(automation)
  await click(`${panel}.querySelector('[data-progress-details="interval"] > summary')`)
  const interval = `${panel}.querySelector('.continuous-progress-control input[type="number"]')`
  await waitFor(visible(interval)); await replace(interval, '23')
  await evaluate(`window.workspaceInterval=${interval}`)
  const subscriptions = await evaluate('messageWorkspace.facts().progress.subscribers')
  if (width === 380 || width === 320) await frame(width, theme, 'automation')
  await click(buttons('Back to messages'))
  await choose('Inputs'); await click(automation)
  assert.equal(await evaluate(`window.workspaceInterval===${interval}&&${interval}.value==='23'`), true, 'Automation keeps the original field and unsaved value')
  assert.equal(await evaluate('messageWorkspace.facts().progress.subscribers'), subscriptions, 'Navigation does not duplicate Automation observers')
  await click(buttons('Back to messages'))

  result.stage.action = 'keyboard-close'
  await evaluate(`${tab('Inputs')}.focus()`); await key('ArrowRight', 'ArrowRight', 39)
  assert.equal(await evaluate(`${tab('Agent messages')}.getAttribute('aria-selected')`), 'true')
  await key('Escape', 'Escape', 27)
  await waitFor(`!${panel}.matches(':popover-open')`)
  assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.composer__mailbox')`), true)
  const after = await evaluate('({terminal:messageWorkspace.terminal(),facts:messageWorkspace.facts(),sameEditor:window.workspaceEditor===' + editor + '})')
  assert.equal(after.sameEditor, true, 'Reading keeps the original composer editor')
  assert.equal(after.facts.drafts[original.agentSessionId], original.draft)
  assert.deepEqual(after.facts.queues, before.facts.queues, 'Reading never dispatches or reorders pending inputs')
  assert.deepEqual(after.terminal, before.terminal, 'The original terminal instance and geometry remain unchanged')
  assert.equal(after.facts.calls.filter(item => /dispatch|automation-/.test(item.action)).length, 0)
  result.scenes.push({ width, theme, geometry, affordances, queryAndRefresh: true, journalDetailAndCopy: true, retainedAutomation: true, originalSurfacePreserved: true })
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1281, height: 800, webPreferences: { backgroundThrottling: false, sandbox: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.messageWorkspace)')
    for (const theme of ['dark', 'light']) for (const width of [640, 380, 320]) await scenario(width, theme)
    await scenario(320, 'dark', true)
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) await frame(result.stage?.width ?? 0, result.stage?.theme ?? 'unknown', 'failure').catch(() => {})
  } finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
