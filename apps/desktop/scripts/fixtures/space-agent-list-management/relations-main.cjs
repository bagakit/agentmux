const assert = require('node:assert/strict')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, phase] = process.argv.slice(2)
app.setPath('userData', join(privateRoot, 'profile')); app.setPath('sessionData', join(privateRoot, 'session'))
const result = { passed: false, phase, pid: process.pid, frames: [], userRunControlled: false }
const delay = ms => new Promise(done => setTimeout(done, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const read = code => win.webContents.executeJavaScript(code)
  async function until(code) { for (let i = 0; i < 150; i++) { if (await read(code)) return; await delay(50) } throw new Error('Unconfirmed condition: ' + code) }
  const settle = async () => { await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(100) }
  const facts = () => read('spaceListScene.facts()')
  const rect = selector => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  async function click(selector) { const at = await rect(selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 }); await settle() }
  async function key(value, code = value) { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code, windowsVirtualKeyCode: { ' ': 32, ArrowDown: 40 }[value] ?? 0 }); await settle() }
  async function shot(image, purpose) {
    await settle()
    const geometry = await read(`(()=>{const p=document.querySelector('[data-space-list-pane]').getBoundingClientRect();return [...document.querySelectorAll('.workspace-agent-list-item')].map(n=>({key:n.dataset.agentKey,depth:n.dataset.agentDepth,rect:n.getBoundingClientRect().toJSON(),pane:p.toJSON()}))})()`)
    assert.ok(geometry.length > 0)
    for (const row of geometry) assert.ok(row.rect.right <= row.pane.right + 1 && row.rect.left >= row.pane.left, 'Cards stay within the readable pane')
    await writeFile(join(evidence, image), (await win.webContents.capturePage()).toPNG())
    result.frames.push({ image, purpose, geometry })
  }
  try {
    await win.loadFile(html, { query: { phase, relations: '1' } }); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.spaceListScene?.ready && document.querySelectorAll(".workspace-agent-list-item").length===5')
    await settle()
    result.initial = await facts()
    const ids = value => value.order.map(key => JSON.parse(key)[1])
    if (phase === 'restore') {
      const expected = JSON.parse(await readFile(join(privateRoot, 'relations-expected.json'), 'utf8'))
      assert.equal(await read('spaceListScene.seedCount'), 0)
      assert.deepEqual(result.initial.order, expected.order)
      for (const field of ['preference', 'tabs', 'layouts', 'drafts']) assert.deepEqual(result.initial[field], expected[field], 'Original ' + field + ' survives the real process restart')
      assert.deepEqual(result.initial.reopens, [])
      await shot('relations-restored.png', 'New Electron PID restores the original group order, split workface and draft without reseeding')
    } else {
      assert.deepEqual(ids(result.initial), ['alpha', 'beta', 'canonical-gamma', 'offline', 'delta'])
      assert.equal(await read('document.querySelectorAll(".workspace-agent-list-item__drag").length'), 3)
      assert.deepEqual(await read('[...document.querySelectorAll("[data-agent-depth]")].map(n=>n.dataset.agentDepth)'), ['0','1','2','0','0'])
      await shot('relations-wide-dark.png', 'Actual Dock retains the shared Agent cards; child/grandchild indentation and observed A2A adjacency')
      await click('.workspace-agents-tool__closed input')
      await until('document.querySelectorAll(".workspace-agent-list-item").length===6')
      await shot('relations-closed-dark.png', 'Independent + Closed checkbox adds the retained original child with direct Resume')
      await click('[data-agent-filter="attention"]')
      assert.deepEqual(ids(await facts()), ['canonical-gamma', 'closed-original'])
      assert.equal(await read('document.querySelectorAll(".workspace-agent-list-item__drag").length'), 1)
      await shot('relations-filtered.png', 'Attention + Closed keeps an invisible parent as the same indivisible move group')
      await click('[data-agent-filter="all"]'); await click('.workspace-agents-tool__closed input')
      await win.setContentSize(288, 850); await settle()
      await shot('relations-narrow-dark.png', 'Narrow complete workface keeps card identity, state and management controls readable')
      await click('.workspace-agents-tool__closed input')
      await shot('relations-narrow-closed.png', 'Narrow closed child has a readable original Resume action')
      await read('spaceListScene.setTheme("light")')
      await shot('relations-narrow-light.png', 'Light narrow cards and derivation guides')
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await shot('relations-reduced-motion.png', 'Reduced motion keeps the complete light narrow tree and restore action')
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      await click('.workspace-agents-tool__closed input')
      await win.setContentSize(1100, 850); await settle()
      // CDP pointer drags the root handle; all descendants, including hidden closed children, move together.
      const from = await rect('.workspace-agent-list-item__drag'), target = await rect('[data-agent-key=\'["local","delta"]\']'), to = { x: from.x, y: target.y }
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 12; i++) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x-from.x)*i/12, y: from.y+(to.y-from.y)*i/12, button: 'left', buttons: 1 }); await delay(25) }
      await until('document.querySelector(".workspace-agent-group.is-dragging")')
      const scale = await read('(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector(".workspace-agent-group.is-dragging")).transform);return{x:m.a,y:m.d}})()')
      assert.deepEqual(scale, { x: 1, y: 1 }, 'The complete derivation group keeps its original scale during a live drag')
      await shot('relations-dragging.png', 'Live CDP pointer drag shows the complete derivation group moving together before drop')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 }); await settle()
      await until('Object.keys(spaceListScene.facts().preference).length>0')
      assert.deepEqual(ids(await facts()), ['offline','delta','alpha','beta','canonical-gamma'])
      await shot('relations-group-moved.png', 'Real pointer drag moves the complete derivation tree without splitting it')
      await read('document.querySelector(".workspace-agent-list-item__drag").focus()')
      await key(' ', 'Space'); await key('ArrowDown'); await key(' ', 'Space')
      await until('JSON.parse(spaceListScene.facts().order[0])[1]==="delta"')
      await shot('relations-keyboard-moved.png', 'Equivalent real keyboard group ordering')
      const expected = await facts()
      assert.deepEqual(expected.reopens, []); assert.deepEqual(expected.controls, [])
      await read('spaceListScene.churn()'); await settle()
      assert.deepEqual((await facts()).order, expected.order)
      await read('spaceListScene.flush()'); await settle()
      await writeFile(join(privateRoot, 'relations-expected.json'), JSON.stringify(expected))
    }
    result.final = await facts(); result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally { await writeFile(join(evidence, `relations-${phase}.json`), JSON.stringify(result, null, 2)); win.destroy(); app.quit() }
})
