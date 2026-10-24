const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { schema: 'agentmux.a2a-primary-reading-render.v1', passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], scenarios: [], userRunTouched: false, consoleErrors: [] }
let win
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const notice = `document.querySelector('.conversation-a2a-notice[data-a2a-notification-id]')`
const original = `document.querySelector('[data-a2a-original-message-id]')`
const retry = `${notice}.querySelector('.conversation-a2a-originals__pending button')`
const details = `${notice}.querySelector(':scope > .conversation-a2a-notice__details')`
async function waitFor(expression) {
  for (let i = 0; i < 240; i++) { try { if (await evaluate(expression)) return } catch {} await delay(25) }
  assert.fail('Expected actual Renderer fact: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(40) }
async function click(expression) {
  const point = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing original input target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await painted()
}
async function frame(name) {
  await painted(); const file = name + '.png', bytes = (await win.webContents.capturePage()).toPNG()
  assert.ok(bytes.length > 0); await fs.writeFile(path.join(evidence, file), bytes)
  receipt.frames.push({ file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
}
async function scenario(surface, theme, width, generation) {
  receipt.stage = { surface, theme, width, action: 'seed' }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false })
  const source = await evaluate(`a2aPrimaryReading.seed(${JSON.stringify(surface)},${JSON.stringify(theme)},${generation})`)
  await waitFor('a2aPrimaryReading.facts().pending===2')
  const edge = theme === 'dark' && width === 360
  if (edge) {
    await click(`document.querySelector('[aria-label="Unsent draft"]')`)
    receipt.stage.action = 'failed-read'; await evaluate(`a2aPrimaryReading.settle('failure');a2aPrimaryReading.settle('original')`); await waitFor(retry)
    assert.equal(await evaluate(`document.querySelectorAll('[data-a2a-original-message-id]').length`), 1, 'Another sender remains readable during one failed read')
    assert.equal(await evaluate('a2aPrimaryReading.facts().draftFocused'), true, 'Read failure preserves existing draft focus')
    await frame(`${surface}-${theme}-${width}-failure`)
    await click(retry); await waitFor('a2aPrimaryReading.facts().pending===1')
    await click(`document.querySelector('[aria-label="Unsent draft"]')`)
  }
  receipt.stage.action = 'read-original'; await evaluate(`a2aPrimaryReading.settle('original')${edge ? '' : ";a2aPrimaryReading.settle('original')"}`)
  await waitFor(`document.querySelectorAll('[data-a2a-original-message-id]').length===2`); await painted()
  const facts = await evaluate('a2aPrimaryReading.facts()')
  assert.equal(facts.draft, source.draft); if (edge) assert.equal(facts.draftFocused, true, 'Successful read preserves existing draft focus')
  assert.deepEqual(facts.calls, [...source.messages.map(message => ({ reference: source.reference, messageId: message.messageId })), ...(edge ? [{ reference: source.reference, messageId: source.messageId }] : [])])
  const card = await evaluate(`(()=>{const n=${notice},o=${original},c=o.querySelector('.log-turn'),r=c.getBoundingClientRect();return{count:document.querySelectorAll('[data-a2a-original-message-id]').length,text:o.textContent,bubble:c.dataset.messageBubble,compact:c.dataset.compact,relation:c.dataset.speakerRelation,systemHead:!!n.querySelector(':scope > .log-turn__head'),left:r.left,right:r.right,width:r.width,scrollWidth:c.scrollWidth,clientWidth:c.clientWidth}})()`)
  assert.equal(card.count, 2); assert.equal(card.bubble, 'true'); assert.equal(card.compact, undefined); assert.equal(card.relation, 'other-agent'); assert.equal(card.systemHead, false)
  assert.ok(card.text.includes('原始协作消息')); assert.ok(card.left >= 0 && card.right <= width + 1 && card.width > 100)
  assert.ok(card.scrollWidth <= card.clientWidth + 1, 'Original card fits the actual consumer')
  await frame(`${surface}-${theme}-${width}-original`)
  if (edge) {
    for (const message of source.messages) {
      await click(`document.querySelector('[data-a2a-original-message-id="${message.messageId}"] [aria-label="Copy message"]')`)
      await waitFor(`a2aPrimaryReading.facts().copied.at(-1)===${JSON.stringify(message.body)}`)
    }
    receipt.stage.action = 'inspect-notification-sources'
    await evaluate(`${details}.querySelector('summary').focus()`)
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(`${details}.open`)
    await click(`${details}.querySelector('[aria-label="Copy notification protocol"]')`)
    await waitFor(`a2aPrimaryReading.facts().copied.at(-1)===${JSON.stringify(source.wire)}`)
    const summaries = await evaluate(`${details}.querySelectorAll('.conversation-original-record > summary').length`)
    assert.equal(summaries, 2)
    for (let i = 0; i < summaries; i++) await click(`${details}.querySelectorAll('.conversation-original-record > summary')[${i}]`)
    const evidence = await evaluate(`(()=>{const d=${details};return{copies:d.querySelectorAll('[aria-label="Copy notification protocol"]').length,pre:d.querySelectorAll('pre').length,cards:d.querySelectorAll('.log-turn,[data-a2a-original-message-id]').length,total:document.querySelectorAll('[data-a2a-original-message-id]').length}})()`)
    assert.deepEqual(evidence, { copies: 1, pre: 3, cards: 0, total: 2 })
    await frame(`${surface}-${theme}-${width}-sources`)
  }
  receipt.scenarios.push({ surface, theme, width, exactCalls: facts.calls, card, failureAndRetry: edge, sourceJsonWithoutMessageDuplication: edge })
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 960, height: 850, webPreferences: { backgroundThrottling: false, sandbox: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') receipt.consoleErrors.push(details.message) })
    win.webContents.debugger.attach('1.3'); await win.loadFile(html)
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('window.a2aPrimaryReading?.ready')
    let generation = 0
    for (const surface of ['desktop', 'mobile', 'focus']) for (const theme of ['dark', 'light']) for (const width of [960, 360]) await scenario(surface, theme, width, ++generation)
    assert.equal(receipt.frames.length, 18); assert.deepEqual(receipt.consoleErrors, []); receipt.passed = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; if (win) await frame('failure').catch(() => {}) }
  finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(receipt, null, 2) + '\n'); win?.destroy(); app.exit(receipt.passed ? 0 : 1) }
})
