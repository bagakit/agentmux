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
    const kinds = ['preparation', 'unknown', 'legacy', 'compaction', 'first-wait', 'exhausted', 'observer', 'density']
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
      assert.equal(displayed.trim(), kind === 'observer' || kind === 'density' ? '已保存 · 等待确认' : kind === 'unknown' || kind === 'legacy' ? '发送结果待核实' : kind === 'compaction' || kind === 'exhausted' ? '正在整理上下文' : '本次准备未完成')
      if (kind === 'observer' || kind === 'density') {
        assert.equal(await evaluate(`${diagnostic}.dataset.kind`), 'saved-waiting')
        assert.equal(await evaluate(`${diagnostic}.querySelector('[role="alert"]')`), null)
      }
      assert.equal(await evaluate(`${diagnostic}.querySelector('details').open`), false)
      const style = await evaluate(`(()=>{const s=getComputedStyle(${diagnostic}),b=getComputedStyle(${diagnostic}.querySelector('[aria-label="复制诊断摘要"]'));return{padding:s.padding,border:b.borderTopWidth,fontSize:b.fontSize,minHeight:b.minHeight}})()`)
      assert.equal(style.padding, '7px 9px', 'Actual compact product diagnostic CSS is loaded')
      assert.equal(style.border, '0px'); assert.equal(style.minHeight, '26px')
      if (kind === 'compaction') assert.match(await evaluate(`${mailbox}.textContent`), /2\/3/)
      if (kind === 'exhausted') assert.match(await evaluate(`${mailbox}.textContent`), /3 次/)
      await capture(width, `${kind}-summary`)
      if (kind === 'preparation' || kind === 'observer' || kind === 'density') {
        await evaluate(`${diagnostic}.querySelector('summary').focus()`); await key('Enter', 'Enter', 13)
        await waitFor(`${diagnostic}.querySelector('details').open`)
        await capture(width, `${kind}-details`)
        await evaluate('deliveryDiagnostics.copyFails(true)')
        await click(`${diagnostic}.querySelector('[aria-label="复制诊断摘要"]')`)
        await waitFor(`${diagnostic}.querySelector('[data-copy-state="failed"]')`)
        await capture(width, `${kind}-summary-copy-failed`)
        await evaluate('deliveryDiagnostics.copyFails(false)')
        await click(`${diagnostic}.querySelector('[aria-label="复制诊断摘要"]')`)
        await waitFor(`${diagnostic}.querySelector('[data-copy-state="copied"]')`)
        const brief = await evaluate('deliveryDiagnostics.facts().copies.at(-1)')
        if (seeded.inputReceipt) {
          assert.ok(brief.includes(JSON.stringify(seeded.inputReceipt.ref.key)))
          assert.ok(brief.includes('等待代次: 1'))
        }
        assert.ok(!brief.includes('"stack"'))
        if (kind === 'density') assert.ok(brief.includes('original-connection-absent'))
        await fs.writeFile(path.join(evidence, `${width}-${kind}-summary.txt`), brief)
        await capture(width, `${kind}-summary-copied`)
        await evaluate(`${diagnostic}.querySelector('.message-delivery-failure__original > summary').focus()`); await key('Enter', 'Enter', 13)
        await waitFor(`${diagnostic}.querySelector('.message-delivery-failure__original').open`)
        await capture(width, `${kind}-full-details`)
        await evaluate('deliveryDiagnostics.copyFails(true)')
        await click(`${diagnostic}.querySelector('[aria-label="复制完整资料"]')`)
        await waitFor(`${diagnostic}.querySelector('[data-full-copy-state="failed"]')`)
        await capture(width, `${kind}-full-copy-failed`)
        await evaluate('deliveryDiagnostics.copyFails(false)')
        await click(`${diagnostic}.querySelector('[aria-label="复制完整资料"]')`)
        await waitFor(`${diagnostic}.querySelector('[data-full-copy-state="copied"]')`)
        const report = await evaluate('deliveryDiagnostics.facts().copies.at(-1)'), received = JSON.parse(report)
        assert.deepEqual(received.inputReceipt, seeded.inputReceipt)
        assert.deepEqual(received.log, seeded.report)
        if (seeded.inputReceipt) assert.ok(received.error.sourceRef.startsWith('inputReceipt.control.waiting.'))
        if (kind === 'density') assert.ok(report.includes('END_OF_RECEIVED_ERROR'))
        await fs.writeFile(path.join(evidence, `${width}-${kind}-full.json`), report)
        await capture(width, `${kind}-full-copied`)
        if (kind === 'density') {
          const pre = `${diagnostic}.querySelector('[aria-label="完整诊断原文"]')`
          await evaluate(`${pre}.focus()`)
          for (let page = 0; page < 80; page++) {
            if (await evaluate(`${pre}.scrollTop + ${pre}.clientHeight >= ${pre}.scrollHeight - 2`)) break
            await key('PageDown', 'PageDown', 34); await delay(20)
          }
          const end = await evaluate(`(()=>{const p=${pre};return {scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,focused:document.activeElement===p}})()`)
          assert.ok(end.focused); assert.ok(end.scrollTop + end.clientHeight >= end.scrollHeight - 2)
          result.events.push({width, kind, keyboardTail:end})
          await capture(width, `${kind}-full-tail`)
        }
      }
      const after = await evaluate('deliveryDiagnostics.facts()')
      assert.deepEqual(after.sessions, before.sessions); assert.deepEqual(after.drafts, before.drafts)
      assert.deepEqual(after.queues, before.queues)
      result.events.push({ width, kind, seeded, displayed, identitiesAndDraftsUnchanged: true })
      await click(`${mailbox}.querySelector('[aria-label="Close mailbox"]')`)
    }
    assert.equal(result.frames.length, only ? only === 'density' ? 16 : only === 'preparation' || only === 'observer' ? 14 : 2 : 54)
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
