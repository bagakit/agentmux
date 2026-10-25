const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-summary-actual.v1', passed: false, frames: [], operations: [], rendererConsole: [], boundary: 'Actual Global/Store/projection/Row/keyboard reader and full CSS over maintained typed preview data. No user Runtime, real Run/PID, OS input, restart or installation.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const read = code => win.webContents.executeJavaScript(code)
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 1000)) })
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async (label, condition) => { const end = Date.now() + 10000; do { if (await condition()) return; await pause(30) } while (Date.now() < end); throw new Error('Scene did not settle: ' + label) }
  const row = id => `.global-focus-main .focus-context[data-session-id="${id}"]`
  const key = async value => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value }); result.operations.push({ kind: 'key', key: value }) }
  const stable = async () => { await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await pause(100) }
  const shot = async (file, label) => { await stable(); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, ...await read('({width:innerWidth,height:innerHeight,appearance:document.documentElement.dataset.appearance,focus:document.activeElement?.getAttribute("aria-label")})') }) }
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('original typed population', () => read('window.cardInteractionScene?.summaryReady&&document.querySelectorAll(".global-focus-main .focus-context").length>=5'))
  result.before = await read('window.cardInteractionScene.summaryFacts()')
  for (const width of [1200, 620]) for (const appearance of ['dark', 'light']) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); await read('document.activeElement?.blur()'); await key('Escape'); await key('Escape'); await until('reader closed before next presentation', () => read('!document.querySelector(".focus-context-hover")')); win.setContentSize(width, 820); await read(`window.cardInteractionScene.theme(${JSON.stringify(appearance)})`); await pause(250); await stable(); assert.equal(await read('document.querySelectorAll(".focus-context-hover").length'), 0, 'Card overview has no unintended preview')
    const interrupted = await read(`(()=>{const c=document.querySelector(${JSON.stringify(row('offline'))});return{excerpt:c.querySelector('.focus-context__recap')?.textContent,cause:c.querySelector('.focus-context__activity')?.textContent,state:c.querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon'),nested:document.querySelectorAll('button button').length}})()`)
    assert.ok(interrupted.excerpt.includes('历史摘录')); assert.ok(interrupted.cause.includes('Original Runtime interrupted')); assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.nested, 0)
    await shot(`focus-summary-${appearance}-${width}.png`, 'Actual Focus task excerpts, interrupted/unknown causes and accurate status in ' + appearance)
    if (appearance === 'dark') {
      const target = width === 1200 ? 'offline' : 'recap-b'
      await read(`document.querySelector(${JSON.stringify(row(target))}).focus()`); await key('ArrowDown')
      await until('original keyboard reader', () => read('!!document.querySelector(".focus-context-hover")'))
      if (target === 'recap-b') {
        const point = await read(`(()=>{const r=document.querySelector('.agent-information-reader__status').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
        await until('original source details', () => read('!!document.querySelector(".agent-information-reader__metadata .agent-information-reader__source")'))
      }
      const complete = await read('document.querySelector(".focus-context-hover").innerText')
      if (target === 'offline') assert.ok(complete.includes('不创建替代会话'))
      else assert.ok(complete.includes('No current work signal'))
      await shot(`focus-summary-reader-${width}.png`, 'Original keyboard reader gives the complete original cause without selecting an Agent')
      assert.equal((await read('window.cardInteractionScene.summaryFacts()')).selected, result.before.selected)
    }
  }
  await key('Escape')
  const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(row('recap-b'))}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await until('original exact-SID card selection', () => read('window.cardInteractionScene.summaryFacts().selected==="recap-b"'))
  result.after = await read('window.cardInteractionScene.summaryFacts()'); assert.deepEqual(result.after.sessions, result.before.sessions); assert.equal(result.after.draft, result.before.draft); assert.equal(result.after.sessionRefsPreserved, true); assert.equal(result.after.timelineRefsPreserved, true)
  const transport = await read('window.cardInteractionScene.facts()'); result.transport = { reads: transport.reads, controls: transport.controls, clipboard: transport.clipboard }; assert.deepEqual(result.transport.controls, { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 })
  assert.equal(result.rendererConsole.filter(message => !message.includes('Electron Security Warning')).length, 0, 'No active Renderer errors')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
