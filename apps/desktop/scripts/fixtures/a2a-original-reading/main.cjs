const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
const protocolCards = process.argv.includes('--protocol-cards')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win
const receipt = { schema: 'agentmux.a2a-original-reading-render.v1', passed: false, frames: [], scenarios: [],
  captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false, consoleErrors: [] }
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const notice = `document.querySelector('[data-a2a-notification-id="notice-original"]')`
const unqualified = `document.querySelector('[data-message-id="probe-unqualified-record"]')`
const draft = `document.querySelector('[aria-label="Unsent draft"]')`
const original = `document.querySelector('[data-a2a-original-message-id="probe-mid"]')`
const retry = `Array.from(${notice}.querySelectorAll('button')).find(button=>button.textContent==='Retry original message')`
async function waitFor(expression) {
  for (let i = 0; i < 240; i++) { try { if (await evaluate(expression)) return } catch {} await delay(25) }
  assert.fail('Expected actual Renderer fact: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(80) }
async function click(expression) {
  const point = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Original input target absent');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await painted()
}
async function frame(name) {
  await painted()
  const file = name + '.png', png = (await win.webContents.capturePage()).toPNG()
  assert.ok(png.length > 0)
  await fs.writeFile(path.join(evidence, file), png)
  receipt.frames.push({ file, sha256: crypto.createHash('sha256').update(png).digest('hex'), bytes: png.length,
    viewport: await evaluate('({width:innerWidth,height:innerHeight})') })
}
async function bounded(expression, label) {
  const bounds = await evaluate(`(()=>{const e=${expression},r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})()`)
  assert.ok(bounds.width > 100 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= bounds.vw + 1 && bounds.y + bounds.height <= bounds.vh + 1,
    label + ' is completely inside the native viewport')
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, label + ' has no horizontal content loss')
  return bounds
}
async function protocolScenario(width, theme, generation) {
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height:960, deviceScaleFactor:1, mobile:false })
  const source=await evaluate(`a2aOriginalReading.seed(${JSON.stringify(theme)},${generation},'declarations')`)
  await waitFor("document.querySelectorAll('[data-protocol-kind]').length===4")
  for(const [kind,wire] of Object.entries(source.declared)) {
    const card=`document.querySelector('[data-protocol-kind=${kind}]')`, raw=card+".querySelector('details.conversation-protocol__original')"
    assert.equal(await evaluate(`${card}.querySelectorAll('[data-protocol-kind]').length`),0)
    assert.equal(await evaluate(`${raw}.open`),false)
    assert.equal(await evaluate(`${raw}.querySelector('pre').textContent`),wire)
    assert.ok((await evaluate(`${card}.innerText`)).includes(source.bodies[kind]),'Default card exposes the original body')
    await bounded(card,'Protocol card '+kind)
  }
  await frame('protocol-cards-'+theme)
  const heart="document.querySelector('[data-protocol-kind=heartbeat] details')"
  await click(heart+".querySelector('summary')")
  assert.equal(await evaluate(heart+".open"),true)
  await frame('protocol-expanded-'+theme)
  await evaluate(`a2aOriginalReading.seed(${JSON.stringify(theme)},${generation+1},'original')`)
  await waitFor('a2aOriginalReading.facts().pending===1')
  await evaluate("a2aOriginalReading.settle('original')")
  await waitFor(original)
  const positions=await evaluate(`(()=>{const record=${notice},original=${original},details=record.querySelector('.conversation-a2a-notice__details');return {record:record.className,seen:original.innerText,below:!!details && original.getBoundingClientRect().bottom<=details.getBoundingClientRect().top+1,count:record.querySelectorAll('[data-a2a-original-message-id]').length,details:details?.className}})()`)
  assert.ok(positions.seen.includes('原始协作消息') && positions.count===1)
  assert.ok(positions.below,'Original body precedes the notification details: '+JSON.stringify(positions))
  const footer=await evaluate(`(()=>{const part=${original},body=part.querySelector('.log-turn__body').getBoundingClientRect(),timing=part.querySelector('.conversation-a2a-timing').getBoundingClientRect();return {body:body.toJSON(),timing:timing.toJSON()}})()`)
  assert.ok(footer.timing.width>=footer.body.width-2 && footer.timing.top>=footer.body.bottom-1,'Notification timing shares the original text column: '+JSON.stringify(footer))
  await frame('received-original-'+theme)
  await evaluate(`a2aOriginalReading.seed(${JSON.stringify(theme)},${generation+2},'captured')`)
  await waitFor("document.querySelectorAll('[data-protocol-kind]').length===3")
  for(const kind of ['heartbeat','calendar','automation']) {
    const card=`document.querySelector('[data-protocol-kind=${kind}]')`
    assert.ok((await evaluate(`${card}.innerText`)).includes(source.bodies[kind]))
    assert.equal(await evaluate(`${card}.closest('.log-turn').querySelector('.log-turn__who').textContent`),'自动触发')
    assert.equal(await evaluate(`${card}.querySelector('pre,details.conversation-protocol__original')`),null,'Public text carries no original wire')
    await bounded(card,'Captured public body '+kind)
  }
  await frame('captured-public-'+theme)
  receipt.scenarios.push({width,theme,bodies:source.bodies,positions})
}
async function scenario(width, theme, generation) {
  const height = width < 400 ? 1050 : 760
  receipt.stage = { width, theme, action: 'seed' }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  const source = await evaluate(`a2aOriginalReading.seed(${JSON.stringify(theme)},${generation})`)
  await waitFor(`document.querySelector('[data-generation="${generation}"]')`)
  await painted()
  await waitFor('a2aOriginalReading.facts().pending===1')
  receipt.stage.action = 'unqualified-wire'
  await click(`${unqualified}.querySelector('.log-turn__system-toggle')`)
  assert.equal(await evaluate('a2aOriginalReading.facts().calls.length'), 1, 'Only the qualified notice reads its exact original')
  assert.equal(await evaluate(`${unqualified}.querySelector('[data-a2a-original-message-id]')`), null)
  await click(`${unqualified}.querySelector('.log-turn__system-toggle')`)
  await click(draft)
  const focusedDraft = await evaluate('a2aOriginalReading.facts()')
  assert.equal(focusedDraft.draftFocused, true)
  receipt.stage.action = 'read-failure'
  await evaluate(`a2aOriginalReading.settle('failure')`)
  await waitFor(retry)
  assert.equal(await evaluate('a2aOriginalReading.facts().draftFocused'), true, 'Asynchronous read failure preserves the existing host input focus')
  assert.equal(await evaluate('a2aOriginalReading.facts().draft'), source.draft)
  const failedGeometry = await bounded(`document.querySelector('.conversation-a2a-originals')`, 'Failed original reference and Retry action')
  await bounded(retry, 'Retry original message button')
  await frame(`${theme}-${width}-failure`)
  receipt.stage.action = 'retry-original'
  await click(retry)
  await waitFor('a2aOriginalReading.facts().pending===1')
  await click(draft)
  await evaluate(`a2aOriginalReading.settle('original')`)
  await waitFor(original)
  await painted()
  const facts = await evaluate('a2aOriginalReading.facts()')
  assert.equal(facts.draft, source.draft, 'Original unsent text is retained after reading')
  assert.equal(facts.draftFocused, true, 'Successful original read never steals host draft focus')
  assert.deepEqual(facts.calls, [0, 1].map(() => ({ reference: { hostId: source.hostId, agentSessionId: source.recipientSessionId }, messageId: source.messageId })),
    'Read and explicit Retry use the same exact Host, receiving Session and MID')
  const reading = await evaluate(`(()=>{const e=${original};return{text:e.textContent,strong:e.querySelector('strong')?.textContent,list:e.querySelectorAll('li').length,quote:e.querySelector('blockquote')?.textContent,longCode:Array.from(e.querySelectorAll('code')).find(code=>code.textContent.startsWith('MID-original-body-'))?.textContent}})()`)
  assert.ok(reading.text.includes('原始协作消息'), 'The original heading remains readable in the product input Markdown mode')
  assert.equal(reading.strong, '消息原文与接收者')
  assert.equal(reading.list, 2, 'The actual original body renders its Markdown list')
  assert.ok(reading.quote?.includes('这里只读取原文'), 'The actual original body renders its Markdown quotation')
  assert.ok(reading.text.includes('原文结束：中文、Markdown 与长引用均保留。'), 'Original body tail is present')
  assert.ok(reading.longCode?.length > 100, 'The actual body retains the complete long MID-like token')
  const originalGeometry = await bounded(original, 'Complete original body')
  const textGeometry = await evaluate(`(()=>{const e=${original},walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),areas=[];let node;while(node=walker.nextNode()){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const r of range.getClientRects())if(r.width>0&&r.height>0)areas.push({x:r.x,y:r.y,right:r.right,bottom:r.bottom})}return areas})()`)
  assert.ok(textGeometry.length > 8, 'Visible original text has nonempty measured lines')
  assert.ok(textGeometry.every(area => area.x >= 0 && area.right <= width + 1 && area.y >= 0 && area.bottom <= height), 'Complete original text, including long reference and tail, is visible without clipping')
  await frame(`${theme}-${width}-original`)
  await click(`${notice}.querySelector('.conversation-a2a-notice__details > summary')`)
  assert.equal(await evaluate('a2aOriginalReading.facts().calls.length'), 2, 'Inspecting the notification source performs no additional read or input operation')
  receipt.scenarios.push({ width, theme, source, calls: facts.calls, failedGeometry, originalGeometry,
    ordinaryWireReadCount: 0, explicitRetryCount: 1, preservedDraftAndFocus: true, originalMarkdownVisible: true })
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 960, height: 1050, webPreferences: { backgroundThrottling: false, sandbox: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') receipt.consoleErrors.push(details.message) })
    win.webContents.debugger.attach('1.3')
    await win.loadFile(html,{query:protocolCards?{protocolCards:'1'}:{}})
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('window.a2aOriginalReading?.ready && document.querySelector("[data-generation]")')
    let generation = 0
    if(protocolCards) {
      await protocolScenario(960,'dark',1)
      await protocolScenario(360,'light',4)
    } else for (const theme of ['dark', 'light']) for (const width of [960, 332]) await scenario(width, theme, ++generation)
    assert.equal(receipt.frames.length, 8)
    assert.deepEqual(receipt.consoleErrors, [], 'Actual Renderer has no console errors')
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) await frame('failure').catch(() => {})
  } finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(receipt, null, 2) + '\n')
    win?.destroy(); app.exit(receipt.passed ? 0 : 1)
  }
})
