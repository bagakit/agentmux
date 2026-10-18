const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { schema: 'agentmux.message-slot-layout.v1', passed: false, frames: [], scenarios: [], captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false, consoleErrors: [] }
let win
const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), read = code => win.webContents.executeJavaScript(code)
async function until(code) { for (let i = 0; i < 240; i++) { if (await read(code)) return; await pause(25) } assert.fail('Actual original consumer did not become ready: ' + code) }
async function painted() { await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
async function click(selector) {
  await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await painted()
  const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(hit!==n&&!n.contains(hit))throw Error('Original message action is covered');return {x,y}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
const original = '[data-layout-nested] [data-a2a-original-message-id] > .log-turn'
async function scenario(variant, width) {
  win.setContentSize(width, 980)
  await read(`messageLayout.select(${JSON.stringify(variant)})`)
  if (variant === 'system') await click('[data-layout-nested] .log-turn__system-toggle')
  await until(`!!document.querySelector(${JSON.stringify(original)})`); await painted()
  const measured = await read(`(()=>{
    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},style=n=>{if(!n)return null;const s=getComputedStyle(n);return {column:s.gridColumn,row:s.gridRow,fontSize:s.fontSize,color:s.color,padding:s.padding,background:s.backgroundColor,border:s.borderInlineStartWidth,opacity:s.opacity,gap:s.columnGap}};
    const card=n=>{const head=n.querySelector(':scope > .log-turn__head'),body=n.querySelector(':scope > .log-turn__body, :scope > .message-disclosure > .message-disclosure__body > .log-turn__body, :scope > .log-turn__system-body > .log-turn__body, :scope > .log-turn__collaboration-content > .log-turn__body'),avatar=n.querySelector(':scope > .log-turn__node');return {box:rect(n),style:style(n),head:{box:rect(head),style:style(head)},body:{box:rect(body),style:style(body),text:body.textContent},avatar:{box:rect(avatar),style:style(avatar)},nameStyle:style(head.querySelector('.log-turn__who')),timeStyle:style(head.querySelector('.log-turn__time')),copy:!!head.querySelector('[aria-label="Copy message"]'),details:!!head.querySelector('[aria-label="Message details"]')}};
    return {outer:card(document.querySelector('[data-layout-nested] > .log-turn')),nested:card(document.querySelector(${JSON.stringify(original)})),standalone:card(document.querySelector('[data-layout-standalone] > .log-turn')),plain:card(document.querySelector('[data-layout-plain] > .log-turn')),calls:structuredClone(messageLayout.calls),source:{body:messageLayout.body,plain:messageLayout.plain,hostId:messageLayout.hostId,recipientSessionId:messageLayout.recipientSessionId,senderSessionId:messageLayout.senderSessionId,messageId:messageLayout.messageId}};
  })()`)
  receipt.current = { variant, width, measured }
  const { outer, nested, standalone, plain, source } = measured
  assert.deepEqual(measured.calls, [{ reference: { hostId: source.hostId, agentSessionId: source.recipientSessionId }, id: source.messageId }])
  assert.equal(nested.body.style.column, '2', 'Nested compact body keeps its original content lane')
  assert.equal(nested.head.style.column, '2', 'Nested compact heading keeps its original content lane')
  assert.equal(nested.avatar.style.column, '1', 'Nested compact avatar keeps its original identity lane')
  assert.equal(nested.avatar.style.row, standalone.avatar.style.row, 'An ancestor does not span the original compact avatar over its text rows')
  for (const property of ['fontSize', 'color', 'padding', 'background', 'border']) assert.equal(nested.body.style[property], standalone.body.style[property], 'The original body owns ' + property)
  for (const property of ['fontSize', 'color']) { assert.equal(nested.nameStyle[property], standalone.nameStyle[property]); assert.equal(nested.timeStyle[property], standalone.timeStyle[property]) }
  assert.equal(nested.avatar.style.opacity, standalone.avatar.style.opacity)
  assert.ok(nested.body.box.left >= nested.avatar.box.right && nested.body.box.width >= nested.box.width - nested.avatar.box.width - Number.parseFloat(nested.style.gap) - 1, 'The original body occupies the remaining content track, rather than an avatar-width strip')
  assert.ok(Math.abs(nested.head.box.left - nested.body.box.left) <= 1)
  assert.ok(nested.body.box.right <= nested.box.right + 1)
  assert.ok(nested.body.text.includes('LongReferenceToken') && nested.body.text.endsWith('完整消息尾部均须保留。'))
  if (variant === 'progress') {
    assert.ok(Number.parseFloat(outer.body.style.padding) > 0, 'Public progress keeps its own quiet body padding')
    assert.notEqual(outer.body.style.background, standalone.body.style.background, 'Public progress keeps its quiet body fill without tinting the original')
  }
  if (variant === 'system') assert.equal(outer.body.style.border, '1px', 'Opened system context keeps its own quiet reading border')
  assert.ok(nested.copy && nested.details)
  assert.equal(plain.body.style.column, '1'); assert.equal(plain.avatar.style.column, '2')
  assert.equal(plain.body.text, source.plain); assert.ok(plain.body.box.width > plain.avatar.box.width)
  await click(original + ' [aria-label="Copy message"]')
  await until('messageLayout.copies.length===1')
  assert.equal(await read('messageLayout.copies[0]'), source.body, 'Whole-body Copy retains the original wire body')
  receipt.scenarios.push({ variant, width, ...measured, originalCopy: true })
  if (['human', 'other-agent', 'compact', 'progress', 'system'].includes(variant)) {
    await read(`document.querySelector('[data-layout-nested]').scrollIntoView({block:'start'})`); await painted()
    const file = variant + '-' + width + '.png', png = (await win.webContents.capturePage()).toPNG()
    await fs.writeFile(path.join(evidence, file), png); receipt.frames.push({ file, sha256: crypto.createHash('sha256').update(png).digest('hex'), bytes: png.length })
  }
  if (variant === 'human' && width === 332) {
    await read(`document.querySelector(${JSON.stringify(original + ' > .log-turn__head > .log-turn__actions > .log-turn__action')}).focus({preventScroll:true})`)
    await click(original + ' > .log-turn__head > .conversation-input-details > .conversation-input-details__toggle')
    await until(`document.querySelector(${JSON.stringify(original + ' .conversation-input-details__toggle')}).getAttribute('aria-expanded')==='true'`)
    const controls = await read(`(()=>{const card=document.querySelector(${JSON.stringify(original)}),items=[...card.querySelectorAll(':scope > .log-turn__head > .log-turn__actions > button, :scope > .log-turn__head > .conversation-input-details > .conversation-input-details__toggle')];return items.map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:n.getAttribute('aria-label'),focused:n===document.activeElement,left:r.left,right:r.right,top:r.top,bottom:r.bottom,hit:hit===n||n.contains(hit)}})})()`)
    assert.equal(controls.length, 2); assert.ok(controls.every(control => control.hit))
    assert.ok(controls.some(control => control.focused && control.label === 'Message details'))
    assert.ok(controls[0].right <= controls[1].left || controls[1].right <= controls[0].left || controls[0].bottom <= controls[1].top || controls[1].bottom <= controls[0].top, 'Original Copy and Info controls do not overlap')
    receipt.scenarios.at(-1).openedDetails = controls
    await painted()
    const file = 'human-332-details.png', png = (await win.webContents.capturePage()).toPNG()
    await fs.writeFile(path.join(evidence, file), png); receipt.frames.push({ file, sha256: crypto.createHash('sha256').update(png).digest('hex'), bytes: png.length })
  }
}
app.whenReady().then(async () => { try {
  await fs.mkdir(evidence, { recursive: true })
  win = new BrowserWindow({ show: false, width: 1280, height: 980, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') receipt.consoleErrors.push(event.message) })
  await win.loadFile(html)
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('!!window.messageLayout && !!document.querySelector("[data-layout-case]")')
  for (const width of [1280, 332]) for (const variant of await read('messageLayout.variants')) await scenario(variant, width)
  assert.equal(receipt.scenarios.length, 10); assert.equal(receipt.frames.length, 11); assert.deepEqual(receipt.consoleErrors, [])
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(receipt, null, 2)); win?.destroy(); app.exit(receipt.passed ? 0 : 1) } })
