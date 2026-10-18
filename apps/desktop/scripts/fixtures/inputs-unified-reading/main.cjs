const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, evidence, mode] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'private-user-data'))
app.commandLine.appendSwitch('disable-background-timer-throttling')
const result = { schema: 'agentmux.inputs-unified-reading-native.v1', passed: false, captureOnly: true,
  aestheticReview: 'not-performed', userSessionTouched: false, electron: process.versions.electron,
  chromium: process.versions.chrome, mode: mode ?? 'capture', frames: [], scenes: [], console: [] }
let win
const panel = `document.querySelector('.composer-mailbox')`
const rows = `${panel}.querySelectorAll('.composer-mailbox__messages > li')`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = expression => win.webContents.executeJavaScript(expression, true)
async function waitFor(expression) {
  for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(expression)) return; await delay(25) }
  throw new Error('Native Renderer condition did not arrive: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(70) }
async function click(expression) {
  const point = await evaluate(`(()=>{const node=(${expression});if(!node)throw Error('Missing product control: '+${JSON.stringify(expression)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();if(!r.width||!r.height)throw Error('Product control is not visible');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await painted()
}
const button = (scope, name) => `[...(${scope}).querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(name)}||node.getAttribute('aria-label')===${JSON.stringify(name)})`
async function frame(scene, name) {
  if (mode === 'smoke') return
  await painted()
  const file = `${scene.width}-${scene.theme}-${name}.png`, bytes = (await win.webContents.capturePage()).toPNG()
  assert.ok(bytes.length > 0)
  await fs.writeFile(path.join(evidence, file), bytes)
  result.frames.push({ scene, name, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
}
async function facts() { return evaluate('inputsNativeFixture.facts()') }
async function originalContributionRange() {
  await evaluate('inputsNativeFixture.mountOriginalReadingProbe()')
  await waitFor("document.querySelectorAll('#original-reading-probe details').length===2")
  await click("document.querySelector('#original-reading-probe summary')")
  await waitFor("Boolean(document.querySelector('#original-reading-probe p'))")
  const before = await evaluate(`(() => {
    const body = document.querySelector('#original-reading-probe p'), range = document.createRange();
    range.selectNodeContents(body); getSelection().removeAllRanges(); getSelection().addRange(range);
    window.originalRangeProbe = { body, range };
    return { text: getSelection().toString(), id: body.dataset.readingProbeId };
  })()`)
  assert.ok(before.text.length > 0)
  await evaluate('withdrawFirstOriginal()')
  await painted()
  const after = await evaluate(`(() => {
    const { body, range } = originalRangeProbe;
    return { text: getSelection().toString(), connected: body.isConnected,
      sameDOM: document.querySelector('#original-reading-probe p') === body,
      sameRange: getSelection().rangeCount === 1 && getSelection().getRangeAt(0) === range };
  })()`)
  assert.equal(after.text, before.text, 'Removing a relation must preserve actual Chromium selected text')
  assert.equal(after.connected && after.sameDOM && after.sameRange, true)
  result.originalContributionRange = { passed: true, before, after }
  await evaluate('unmountOriginalReadingProbe(); getSelection().removeAllRanges()')
}
async function scene(scene) {
  result.stage = scene
  await win.setContentSize(scene.width, 760)
  await win.loadFile(html, { query: { theme: scene.theme } })
  await waitFor(`Boolean(document.querySelector('.composer__mailbox'))&&Boolean(window.inputsNativeFixture)`)
  const projected = await facts()
  assert.deepEqual(projected.groupCounts, [{ messages: 2, mailbox: 1 }, { messages: 1, mailbox: 0 }], 'Current Core groups three sources and preserves independent equal text')
  await click(`document.querySelector('.composer__mailbox')`)
  await waitFor(`${panel}.matches(':popover-open')`)
  const inputTab = `${panel}.querySelector('[id$="-user-tab"]')`
  await click(inputTab)
  await waitFor(`${rows}.length===2&&${panel}.querySelectorAll('.input-history__search').length===1`)
  await waitFor(`!${panel}.querySelector('[role="tabpanel"][id$="-user"]').getAttribute('aria-busy')||${panel}.querySelector('[role="tabpanel"][id$="-user"]').getAttribute('aria-busy')==='false'`)
  const initial = await evaluate(`({rows:${rows}.length,text:${panel}.textContent,queryCount:${panel}.querySelectorAll('input[type="search"]').length})`)
  assert.match(initial.text, /结果待核实|未确认|unknown/i, 'Unknown original receipt stays visible in list')
  assert.equal(initial.queryCount, 1)
  await frame(scene, 'inputs-list')
  await click(`${panel}.querySelector('[data-input-mailbox-key] .composer-mailbox__row')`)
  await waitFor(`${panel}.querySelectorAll('.input-history__original').length===2`)
  await frame(scene, 'original-details')
  const nativeOriginal = `[...${panel}.querySelectorAll('.input-history__original')].find(node=>node.querySelector('summary')?.textContent.includes('原生'))`
  await click(`${nativeOriginal}.querySelector('summary')`)
  await waitFor(`${nativeOriginal}.textContent.includes(inputsNativeFixture.nativeText)`)
  await frame(scene, 'native-contribution')
  await click(button(nativeOriginal, '复制正文'))
  await waitFor('inputsNativeFixture.copied.length===1')
  assert.equal((await facts()).copied[0], await evaluate('inputsNativeFixture.nativeText'))
  await click(button(nativeOriginal, '填入草稿'))
  await waitFor('inputsNativeFixture.facts().draft.includes(inputsNativeFixture.text)&&inputsNativeFixture.facts().draft.includes("原生系统上下文")')
  assert.equal((await facts()).dispatches.length, 0, 'Actual Copy and Fill dispatch nothing')
  await frame(scene, 'filled-draft')
  await click(`${panel}.querySelector('.composer-mailbox__back button')`)
  await waitFor(`Boolean(${panel}.querySelector('input[type="search"]'))`)
  await click(`${panel}.querySelector('input[type="search"]')`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '原生系统上下文' })
  await click(`${panel}.querySelector('.input-history__search button[type="submit"]')`)
  await waitFor(`${rows}.length===1`)
  assert.ok(await evaluate(`Boolean(${panel}.querySelector('[data-input-mailbox-key]'))`), 'Native-only search retains original journal primary')
  await frame(scene, 'native-search')
  const final = await facts()
  assert.equal(final.dispatches.length, 0)
  assert.deepEqual(final.queues, {}, 'Reading and Fill create no queued sending intent')
  assert.equal(final.receiptStatus, 'unknown')
  assert.ok(final.draft.includes('保留的未发送草稿。'), 'Fill preserves existing unsent draft')
  result.scenes.push({ scene, initial, final })
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 640, height: 760, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, ...args) => {
    const details = typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1], line: args[2], sourceId: args[3] }
    result.console.push({ level: details.level, message: details.message, line: details.line, sourceId: details.sourceId })
  })
  win.webContents.debugger.attach('1.3')
  try {
    for (const width of mode === 'smoke' ? [640] : [640, 320]) for (const theme of mode === 'smoke' ? ['dark'] : ['dark', 'light']) await scene({ width, theme })
    await originalContributionRange()
    result.passed = true
    await fs.writeFile(path.join(evidence, 'review.md'), '# Inputs Native Renderer captures\n\nCapture only; independent image review has not been performed. Synthetic private read pages, actual product components, Core projection, CSS, popover and Composer interactions. No Provider or user Session claim.\n\n' + result.frames.map(frame => `- [${frame.file}](${frame.file})`).join('\n') + '\n')
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    try { result.failureDom = await evaluate('document.body.innerText'); await frame(result.stage ?? { width: 640, theme: 'dark' }, 'failure') } catch {}
  } finally {
    await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
    win.destroy(); app.exit(result.passed ? 0 : 1)
  }
}).catch(async error => { result.error = { message: error.message, stack: error.stack }; await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(result, null, 2)); app.exit(1) })
