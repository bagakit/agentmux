const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto')
const [html, privateRoot, evidence, only] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.message-delivery-diagnostics.visual.v1', passed: false, frames: [], events: [], captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false, captureScope: only || 'all' }
let win
const evaluate = value => win.webContents.executeJavaScript(value)
const delay = value => new Promise(resolve => setTimeout(resolve, value))
const surface = `document.querySelector('[data-workbench-region-id="region-actions-target"]')`
const mailbox = `${surface}.querySelector('.composer-mailbox')`
const diagnostic = `${mailbox}.querySelector('.message-delivery-failure')`
async function waitFor(expression) { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(25) } throw Error('Timeout: ' + expression) }
async function key(key, code, value) { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: value,
  ...(type === 'keyDown' && (key === ' ' || key === 'Enter') ? { text: key === 'Enter' ? '\r' : ' ', unmodifiedText: key === 'Enter' ? '\r' : ' ' } : {}) }) }
async function click(expression) {
  await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing target: '+${JSON.stringify(expression)});e.scrollIntoView({block:'nearest'})})()`)
  await painted()
  const point = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function painted() { await evaluate('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()'); await delay(100) }
async function capture(width, state) {
  await painted()
  const file = `${width}-${state}.png`, png = (await win.webContents.capturePage()).toPNG()
  assert.ok(png.length > 0); await fs.writeFile(path.join(evidence, file), png)
  result.frames.push({ width, state, file, sha256: createHash('sha256').update(png).digest('hex') })
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1281, height: 820, webPreferences: { backgroundThrottling: false, sandbox: false } })
    result.consoleErrors = []
    win.webContents.on('console-message', details => { if (details.level === 'error') result.consoleErrors.push(details.message) })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.deliveryDiagnostics)')
    const kinds = ['preparation', 'unknown', 'legacy', 'compaction', 'first-wait', 'exhausted', 'observer']
    assert.ok(!only || kinds.includes(only), 'Only a named owning scene can be recaptured')
    for (const width of [640, 320]) for (const kind of only ? [only] : kinds) {
      result.stage = `${width}-${kind}`
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width * 2 + 1, height: 820, deviceScaleFactor: 1, mobile: false })
      const seeded = await evaluate(`deliveryDiagnostics.seed(${JSON.stringify(kind)},${JSON.stringify(width === 640 ? 'dark' : 'light')})`)
      await waitFor(`${surface} && Boolean(${surface}.querySelector('.composer__mailbox'))`)
      await painted()
      await evaluate(`${surface}.querySelector('.composer__mailbox').focus()`); await key(' ', 'Space', 32)
      await waitFor(`${mailbox}.matches(':popover-open')`)
      await painted()
      await click(`${mailbox}.querySelector('[role="tab"][id$="-outbox-tab"]')`)
      await waitFor(`${mailbox}.querySelector('[role="tab"][id$="-outbox-tab"]').getAttribute('aria-selected')==='true'`)
      await click(`${mailbox}.querySelector('[data-record-key="queue:${seeded.operationId}"]')`)
      if (kind === 'first-wait') {
        await waitFor(`${mailbox}.querySelector('.composer-outbox__inline')`)
        assert.equal(await evaluate(`${mailbox}.querySelectorAll('.composer-outbox__inline .composer-pending__retry').length`), 1, 'First wait has one readable progress explanation')
        assert.equal(await evaluate(`${mailbox}.querySelector('.message-delivery-failure')`), null, 'No failure panel is invented during a first wait')
        assert.match(await evaluate(`${mailbox}.textContent`), /2\/3/)
        await capture(width, 'first-wait-summary')
        result.events.push({ width, kind, seeded, firstWaitWithoutPriorFailure: true })
        await click(`${mailbox}.querySelector('[aria-label="Close mailbox"]')`)
        continue
      }
      await waitFor(`Boolean(${diagnostic})`)
      const before = await evaluate('deliveryDiagnostics.facts()')
      const displayed = await evaluate(`${diagnostic}.querySelector('.message-delivery-failure__heading').textContent`)
      assert.equal(displayed.trim(), kind === 'observer' ? '已保存 · 等待确认' : kind === 'unknown' || kind === 'legacy' ? '发送结果待核实' : kind === 'compaction' || kind === 'exhausted' ? '正在整理上下文' : '本次准备未完成')
      if (kind === 'observer') {
        assert.equal(await evaluate(`${diagnostic}.dataset.kind`), 'saved-waiting')
        assert.equal(await evaluate(`${diagnostic}.querySelector('[role="alert"]')`), null)
      }
      assert.equal(await evaluate(`${diagnostic}.querySelector('details').open`), false)
      const style = await evaluate(`(()=>{const s=getComputedStyle(${diagnostic}),b=getComputedStyle(${diagnostic}.querySelector('[aria-label="复制完整诊断"]'));return{padding:s.padding,border:b.borderTopWidth,fontSize:b.fontSize,minHeight:b.minHeight}})()`)
      assert.equal(style.padding, '7px 9px', 'Actual compact product diagnostic CSS is loaded')
      assert.equal(style.border, '0px'); assert.equal(style.minHeight, '26px')
      if (kind === 'compaction') assert.match(await evaluate(`${mailbox}.textContent`), /2\/3/)
      if (kind === 'exhausted') assert.match(await evaluate(`${mailbox}.textContent`), /3 次/)
      await capture(width, `${kind}-summary`)
      if (kind === 'preparation' || kind === 'observer') {
        await evaluate(`${diagnostic}.querySelector('summary').focus()`); await key('Enter', 'Enter', 13)
        await waitFor(`${diagnostic}.querySelector('details').open`)
        await capture(width, `${kind}-details`)
        await evaluate('deliveryDiagnostics.copyFails(true)')
        await click(`${diagnostic}.querySelector('[aria-label="复制完整诊断"]')`)
        await waitFor(`${diagnostic}.querySelector('[data-copy-state="failed"]')`)
        await capture(width, `${kind}-copy-failed`)
        await evaluate('deliveryDiagnostics.copyFails(false)')
        await click(`${diagnostic}.querySelector('[aria-label="复制完整诊断"]')`)
        await waitFor(`${diagnostic}.querySelector('[data-copy-state="copied"]')`)
        const report = await evaluate('deliveryDiagnostics.facts().copies.at(-1)')
        for (const fact of [seeded.logId, seeded.operationId, seeded.report.record.agentSessionId, seeded.report.record.expectedRunId, 'preclaimObservation']) assert.ok(report.includes(fact), 'Copied complete original diagnostic: ' + fact)
        if (kind === 'observer') {
          assert.ok(report.includes(JSON.stringify(seeded.inputReceipt, null, 2)), 'Copy keeps the complete original Core receipt')
          assert.ok(report.includes('This operation was aborted'))
          assert.ok(!report.includes('输入结果未知'))
        }
        await fs.writeFile(path.join(evidence, `${width}-${kind}-copied-report.txt`), report)
        await capture(width, `${kind}-copied`)
      }
      const after = await evaluate('deliveryDiagnostics.facts()')
      assert.deepEqual(after.sessions, before.sessions); assert.deepEqual(after.drafts, before.drafts)
      assert.deepEqual(after.queues, before.queues)
      result.events.push({ width, kind, seeded, displayed, identitiesAndDraftsUnchanged: true })
      await click(`${mailbox}.querySelector('[aria-label="Close mailbox"]')`)
    }
    assert.equal(result.frames.length, only ? only === 'preparation' || only === 'observer' ? 8 : 2 : 26)
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage }
    if (win && !win.isDestroyed()) {
      result.dom = await evaluate(`({focus:document.activeElement?.outerHTML,mailbox:${mailbox}?.outerHTML,facts:window.deliveryDiagnostics?.facts()})`)
      await capture(0, 'failed-scene')
    }
  }
  finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
