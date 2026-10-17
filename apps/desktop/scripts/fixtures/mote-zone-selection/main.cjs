const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, phase, frames: [], userRunTouched: false }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    await win.loadFile(html, { query: { phase, zoneSelection: '1' } })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const deadline = Date.now() + 10000
      do { if (await read(expression)) return; await pause(25) } while (Date.now() < deadline)
      throw new Error('Zone selection did not settle: ' + expression)
    }
    await until('window.closedTabProof?.ready && document.querySelector("[data-pmo-teams-topic-floating]")?.matches(":popover-open")')
    win.showInactive()
    win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    const panel = 'document.querySelector("[data-pmo-teams-topic-floating]")'
    const facts = () => read('window.closedTabProof.facts()')
    const visible = () => read('(()=>{const p=' + panel + ';return{tabs:[...p.querySelectorAll("button[data-workbench-tab-id]")].map(e=>e.dataset.workbenchTabId),active:[...p.querySelectorAll(".workbench-tab--active")].map(e=>e.dataset.workbenchTabId),rows:p.querySelectorAll(".pane-tabbar .workbench-tab-strip").length,input:!!p.querySelector("[aria-label=\\"Message Agent\\"]"),target:p.dataset.moteTargetTab}})()')
    const click = async expression => {
      const point = await read('(()=>{const e=' + expression + ';if(!e)throw new Error("Missing real control");const r=e.getBoundingClientRect();if(!r.width||!r.height)throw new Error("Unreadable real control");return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await pause(180)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    }
    const capture = async name => {
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
      await pause(180)
      const file = phase + '-' + name + '.png'
      const png = (await win.webContents.capturePage()).toPNG()
      await fs.writeFile(path.join(evidence, file), png)
      result.frames.push({ name, file, sha256: createHash('sha256').update(png).digest('hex') })
    }
    result.initial = await facts()
    await until(panel + '.querySelectorAll(".workbench-tab--active").length===1')
    result.normal = await visible()
    assert.deepEqual(result.normal.tabs, ['mote-primary-tab', 'mote-neighbor-tab'])
    assert.equal(result.normal.rows, 1)
    assert.equal(result.normal.active.length, 1)
    assert.equal(result.normal.target, result.normal.active[0])
    assert.equal(result.normal.input, true, 'The selected original Agent keeps its real Composer')
    await capture('one-shared-strip')
    const next = result.normal.active[0] === 'mote-primary-tab' ? 'mote-neighbor-tab' : 'mote-primary-tab'
    await click(panel + '.querySelector("button[data-workbench-tab-id=\\"' + next + '\\"]")')
    await until(panel + '.querySelector(".workbench-tab--active")?.dataset.workbenchTabId===' + JSON.stringify(next))
    result.chosen = await visible()
    assert.equal(result.chosen.rows, 1)
    assert.equal(result.chosen.target, next)
    win.setContentSize(640, 720)
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    await capture('narrow-shared-strip')
    if (phase === 'seed') {
      await click(panel + '.querySelector("[data-mote-topic-id=\\"launcher:reviewer\\"]")')
      await until(panel + '.dataset.moteTargetTopic==="launcher:reviewer"')
      await capture('custom-member')
      await click(panel + '.querySelector("[data-mote-topic-id=\\"launcher:leader\\"]")')
      await until(panel + '.dataset.moteTargetTopic==="launcher:leader"')
    } else {
      assert.equal(result.initial.initialization.seedApplied, false)
      assert.equal(result.initial.initialization.initializeCalls, 1)
      assert.deepEqual(Object.keys(result.initial.tabs).sort(), Object.keys(result.initial.initialization.initialWorkbench.tabs).sort())
      assert.deepEqual(result.initial.layouts, result.initial.initialization.initialWorkbench.layouts)
    }
    result.final = await facts()
    assert.deepEqual(result.final.tabs, result.initial.tabs)
    assert.deepEqual(result.final.layouts, result.initial.layouts)
    assert.deepEqual(result.final.drafts, result.initial.drafts)
    assert.deepEqual(result.final.runs, result.initial.runs)
    assert.deepEqual(result.final.focus.execution, result.initial.focus.execution)
    const forbidden = result.final.calls.filter(call => ['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt'].includes(call.operation))
    assert.deepEqual(forbidden, [])
    await until('(()=>{const s=window.closedTabProof.persistence().workbench,c=window.closedTabProof.facts();return !!s && JSON.stringify(s.layouts)===JSON.stringify(c.layouts) && JSON.stringify(Object.keys(s.tabs).sort())===JSON.stringify(Object.keys(c.tabs).sort())})()')
    await win.webContents.session.flushStorageData()
    result.durable = await read('window.closedTabProof.persistence()')
    result.passed = true
  } catch (error) {
    result.failure = { message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.observation = await win.webContents.executeJavaScript('({setup:window.closedTabSetup,body:document.body.innerText,facts:window.closedTabProof?.facts()})').catch(error => ({ error: error.message }))
      await fs.writeFile(path.join(evidence, phase + '-failure.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {})
    }
  } finally {
    if (win && !win.isDestroyed()) {
      try { await win.webContents.executeJavaScript('window.closedTabProof?.dispose()') }
      catch (error) { result.passed = false; result.cleanupFailure = error.message }
    }
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
