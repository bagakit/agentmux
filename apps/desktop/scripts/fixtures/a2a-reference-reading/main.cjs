const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { schema: 'agentmux.a2a-reference-reading-render.v1', passed: false, captureOnly: true, aestheticReview: 'not-performed',
  frames: [], scenarios: [], operations: [], userRunTouched: false, consoleErrors: [] }
let win, generation = 0
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const notice = `document.querySelector('.conversation-a2a-notice[data-a2a-notification-id]')`
const originals = `document.querySelectorAll('[data-a2a-original-message-id]')`
const details = `${notice}.querySelector(':scope > .conversation-a2a-notice__details')`
async function waitFor(expression) {
  for (let i = 0; i < 240; i++) { try { if (await evaluate(expression)) return } catch {} await delay(25) }
  assert.fail('Expected actual Renderer fact: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(40) }
async function click(expression) {
  await evaluate(`(${expression}).scrollIntoView({block:'center',inline:'nearest'})`); await painted()
  const target = await evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect(),point={x:r.x+r.width/2,y:r.y+r.height/2},hit=document.elementFromPoint(point.x,point.y);return{point,unobstructed:hit===e||e.contains(hit)}})()`)
  assert.equal(target.unobstructed, true, 'Original input target is covered: ' + expression)
  receipt.operations.push({ kind: 'native-pointer-click', target: expression })
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...target.point, button: 'left', clickCount: 1 })
  await painted()
}
async function frame(name) {
  await painted(); const file = name + '.png', bytes = (await win.webContents.capturePage()).toPNG()
  assert.ok(bytes.length > 0); await fs.writeFile(path.join(evidence, file), bytes)
  receipt.frames.push({ file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
}
async function seed(surface, theme, width, sender = false) {
  receipt.stage = { surface, theme, width, sender }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false })
  const source = await evaluate(`a2aReferenceReading.seed(${JSON.stringify(surface)},${JSON.stringify(theme)},${++generation},${sender})`)
  await waitFor(`document.querySelector('[data-generation="${generation}"]')`); return source
}
async function copy(expression, text) {
  const before = await evaluate('a2aReferenceReading.facts().copied.length')
  await waitFor(expression)
  await click(expression); await waitFor(`a2aReferenceReading.facts().copied.length===${before + 1}`)
  assert.equal(await evaluate('a2aReferenceReading.facts().copied.at(-1)'), text)
  receipt.operations.push({ kind: 'private-clipboard-copy', text })
}
async function conversation(theme, width) {
  const source = await seed('conversation', theme, width)
  await waitFor('a2aReferenceReading.facts().pending===2')
  const edge = theme === 'dark' && width === 360
  await click(`document.querySelector('[aria-label="Unsent draft"]')`)
  if (edge) {
    await evaluate(`a2aReferenceReading.settle('failure');a2aReferenceReading.settle('original')`)
    const retry = `${notice}.querySelector('.conversation-a2a-originals__pending button')`
    await waitFor(retry); assert.equal(await evaluate(`${originals}.length`), 1)
    assert.equal(await evaluate('a2aReferenceReading.facts().draftFocused'), true)
    await click(retry); await waitFor('a2aReferenceReading.facts().pending===1')
    await click(`document.querySelector('[aria-label="Unsent draft"]')`)
  }
  await evaluate(`a2aReferenceReading.settle('original')${edge ? '' : ";a2aReferenceReading.settle('original')"}`)
  await waitFor(`${originals}.length===2`); await painted()
  assert.equal(await evaluate('a2aReferenceReading.facts().draftFocused'), true)
  assert.equal(await evaluate('a2aReferenceReading.facts().draft'), source.draft)
  const messageCalls = (await evaluate('a2aReferenceReading.facts().calls')).filter(call => call.kind === 'message')
  assert.deepEqual(messageCalls, [...source.messages.map(message => ({ kind: 'message', reference: source.reference, messageId: message.messageId, notificationId: source.notificationId })),
    ...(edge ? [{ kind: 'message', reference: source.reference, messageId: source.messageId, notificationId: source.notificationId }] : [])])
  assert.equal(await evaluate(`${details}.open`), false)
  assert.equal(await evaluate(`${notice}.querySelector(':scope > .log-turn__head,.log-turn__system-toggle')`), null)
  const cards = await evaluate(`Array.from(${originals}).map(o=>{const c=o.querySelector('.log-turn'),r=c.getBoundingClientRect(),rect=n=>{const b=n.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom}};return{role:c.dataset.speakerRole,relation:c.dataset.speakerRelation,bubble:c.dataset.messageBubble,left:r.left,right:r.right,scrollWidth:c.scrollWidth,clientWidth:c.clientWidth,text:c.textContent,sender:rect(c.querySelector('.log-turn__sender-id')),timing:rect(c.querySelector('.conversation-a2a-timing'))}})`)
  for (const card of cards) {
    assert.equal(card.role, 'agent'); assert.equal(card.relation, 'other-agent'); assert.equal(card.bubble, 'true'); assert.ok(card.left >= 0 && card.right <= width + 1); assert.ok(card.scrollWidth <= card.clientWidth + 1)
    assert.ok(card.sender.bottom <= card.timing.top + 1 || card.timing.bottom <= card.sender.top + 1 || card.sender.right <= card.timing.left + 1 || card.timing.right <= card.sender.left + 1,
      'The original sender identity and recorded notification timing must not overlap')
  }
  await frame(`reference-conversation-${theme}-${width}`)
  if (edge) {
    for (const message of source.messages) await copy(`document.querySelector('[data-a2a-original-message-id="${message.messageId}"] [aria-label="Copy message"]')`, message.body)
    await evaluate(`${details}.querySelector('summary').focus()`)
    for (const input of [{ type: 'keyDown', keyCode: 'Enter' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Enter' }]) win.webContents.sendInputEvent(input)
    await waitFor(`${details}.open`)
    await copy(`${details}.querySelector('[aria-label="Copy notification protocol"]')`, source.wire)
    const records = []
    for (let i = 0; i < source.originalRecords.length; i++) {
      const summary = `${details}.querySelectorAll('.conversation-original-record > summary')[${i}]`
      await click(summary)
      const reveal = `(${summary}).parentElement.querySelector('.conversation-progressive-body__placeholder button')`
      if (await evaluate(`Boolean(${reveal})`)) await click(reveal)
      await waitFor(`(${summary}).parentElement.querySelector('pre')`)
      records.push(await evaluate(`JSON.parse((${summary}).parentElement.querySelector('pre').textContent)`))
      await click(summary)
    }
    assert.deepEqual(records, source.originalRecords)
    assert.equal(await evaluate(`${details}.querySelectorAll('.log-turn,[data-a2a-original-message-id]').length`), 0)
    assert.equal(await evaluate(`${originals}.length`), 2)
  }
  receipt.scenarios.push({ surface: 'conversation', theme, width, messageCalls, cards, failureAndRetry: edge, sourceJsonWithoutMessageDuplication: edge, preservedDraftAndFocus: true })
}
async function mailbox(folder) {
  const source = await seed('mailbox', 'dark', 750, folder === 'outbox')
  await waitFor(`document.querySelector('.composer__mailbox')`)
  await click(`document.querySelector('.composer__mailbox')`)
  await waitFor(`document.querySelector('.composer-mailbox[data-state="open"]')`)
  if (folder === 'user') {
    await click(`document.querySelector('[role="tab"][id$="-user-tab"]')`)
    await waitFor(`document.querySelector('[role="tabpanel"][id$="-user"]').getAttribute('aria-busy')==='false'&&document.querySelector('[role="tabpanel"][id$="-user"]').textContent.includes(${JSON.stringify(source.humanText)})`)
    const text = await evaluate(`document.querySelector('[role="tabpanel"][id$="-user"]').textContent`)
    assert.ok(text.includes(source.unknownText)); assert.ok(!text.includes(source.messageId)); assert.ok(!text.includes(source.notificationId))
    assert.ok((await evaluate('a2aReferenceReading.facts().calls')).some(call => call.kind === 'inputs' && call.reference.agentSessionId === source.participant))
    await frame('reference-user-messages')
    receipt.scenarios.push({ surface: 'user-messages', retainedHumanAndUnknown: true, typedPlatformExcluded: true })
  } else {
    if (folder === 'outbox') {
      await click(`document.querySelector('[role="tab"][id$="-agents-tab"]')`)
      await click(`document.querySelector('[role="tab"][id$="-outbox-tab"]')`)
    }
    await waitFor(`document.querySelector('[role="tabpanel"][id$="-${folder}"] [data-record-key="a2a:${source.messageId}"]')`)
    await click(`document.querySelector('[role="tabpanel"][id$="-${folder}"] [data-record-key="a2a:${source.messageId}"]')`)
    await waitFor(`document.querySelector('.composer-mailbox__detail .log-turn__body')`)
    const body = await evaluate(`document.querySelector('.composer-mailbox__detail .log-turn__body').textContent`)
    assert.ok(body.includes('原始协作消息'))
    assert.equal(await evaluate(`document.querySelector('.composer-mailbox__detail').querySelectorAll('.log-turn__references').length`), 0)
    if (folder === 'inbox') await copy(`document.querySelector('.composer-mailbox__detail [aria-label="Copy message"]')`, source.messages[0].body)
    await click(`document.querySelector('.composer-mailbox__detail [aria-label="Message details"]')`)
    await waitFor(`document.querySelector('.composer-mailbox__record-facts')?.textContent.includes(${JSON.stringify(source.messageId)})`)
    const facts = await evaluate(`document.querySelector('.composer-mailbox__record-facts').textContent`)
    assert.ok(facts.includes('Notification submitted'))
    await click(`document.querySelector('.composer-mailbox__detail [aria-label="Message details"]')`)
    await frame(folder === 'inbox' ? 'reference-inbox-original' : 'reference-outbox')
    receipt.scenarios.push({ surface: folder, originalBodyReadable: true, independentNotificationSubmitted: true })
  }
  assert.equal(await evaluate('a2aReferenceReading.facts().draft'), source.draft)
  assert.deepEqual(await evaluate('a2aReferenceReading.facts().forbidden'), [])
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 960, height: 850, webPreferences: { backgroundThrottling: false, sandbox: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') receipt.consoleErrors.push(details.message) })
    win.webContents.debugger.attach('1.3'); await win.loadFile(html)
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('window.a2aReferenceReading?.ready')
    for (const theme of ['dark', 'light']) for (const width of [960, 360]) await conversation(theme, width)
    for (const folder of ['user', 'inbox', 'outbox']) await mailbox(folder)
    assert.equal(receipt.frames.length, 7); assert.deepEqual(receipt.consoleErrors, []); receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) {
      receipt.failure.controls = await evaluate(`Array.from(document.querySelectorAll('button,summary')).map(node=>({tag:node.tagName,label:node.getAttribute('aria-label'),text:node.textContent}))`).catch(() => [])
      await frame('failure').catch(() => {})
    }
  }
  finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(receipt, null, 2) + '\n'); win?.destroy(); app.exit(receipt.passed ? 0 : 1) }
})
