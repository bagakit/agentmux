const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-activity-certainty-actual.v1', passed: false, pid: process.pid, frames: [], rendererConsole: [],
  boundary: 'Actual compiled Global/Store/Focus context/Row/menu and styles; public Client/private FileStore seed. Fixed Run transport, unselected PTY and independent Timeline paint isolated. Requester automation only, not physical OS input, Writer, Runtime or installation.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 680, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 1600)) })
  const read = code => win.webContents.executeJavaScript(code)
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await new Promise(done => setTimeout(done, 30)) } while (Date.now() < end); throw new Error('Scene did not settle: ' + label) }
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const row = id => `.global-focus-main .focus-context[data-session-id="${id}"]`
  const geometry = () => read(`(()=>{const rows=[...document.querySelectorAll('.global-focus-main .focus-context')];const measure=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}};return{width:innerWidth,rows:rows.map(e=>({id:e.dataset.sessionId,activity:e.dataset.activity,bucket:e.dataset.bucket,state:e.dataset.state,aria:e.getAttribute('aria-label'),disabled:e.disabled,spinner:!!e.querySelector('.status--working'),bounds:measure(e)})),neutral:[...document.querySelectorAll('.focus-context-group[data-bucket="idle"]')].filter(e=>e.querySelector('.focus-context')).map(e=>({label:e.getAttribute('aria-label'),header:e.querySelector('header').getAttribute('aria-label'),text:e.querySelector('header').textContent.trim(),bounds:measure(e)})),scrollWidth:document.documentElement.scrollWidth}})()`)
  const key = async (key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, modifiers }) }
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('four original actual rows', () => read('window.activityCertaintyProof?.ready && document.querySelectorAll(".global-focus-main .focus-context").length===4'))
  result.before = await read('window.activityCertaintyProof.facts()'); result.geometry = []
  for (const width of [1200, 640]) {
    win.setContentSize(width, 680); await settle()
    await until('real readable card geometry', async () => (await geometry()).rows.every(item => item.bounds.width > 100 && item.bounds.height > 30))
    const g = await geometry(), byId = Object.fromEntries(g.rows.map(item => [item.id, item]))
    assert.equal(byId['scene-bare'].activity, 'unknown'); assert.equal(byId['scene-stale'].activity, 'unknown')
    assert.equal(byId['scene-stale'].spinner, false); assert.equal(byId['scene-working'].activity, 'active'); assert.equal(byId['scene-working'].bucket, 'working')
    assert.equal(byId['scene-idle'].activity, 'idle'); assert.equal(g.neutral.length, 1)
    assert.equal(g.neutral[0].label, 'Idle / Unknown'); assert.equal(g.neutral[0].header, 'Idle 1 · Activity unknown 2 · Recovery 0')
    assert.ok(g.rows.every(item => !item.disabled && item.bounds.left >= 0 && item.bounds.right <= width + 1))
    assert.ok(g.rows.every(item => item.bounds.hit), 'Actual visible center hits; not DOM-only row population')
    assert.ok(g.scrollWidth <= width + 1, 'No horizontal document overflow')
    result.geometry.push(g)
    const file = 'activity-certainty-' + width + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    result.frames.push({ path: file, width, height: 680, label: 'Unknown 2, confirmed Idle 1 and Working 1 from exact public snapshots' })
  }
  await read(`document.querySelector(${JSON.stringify(row('scene-bare'))}).focus()`); await key('F10', 8)
  await until('original exact Session menu', () => read(`document.querySelector('.focus-context-menu')?.dataset.agentSessionId==='scene-bare' && document.querySelectorAll('.focus-context-menu [role=menuitem]').length>0`))
  result.keyboard = { sessionId: await read('document.querySelector(".focus-context-menu").dataset.agentSessionId'), menuItems: await read('[...document.querySelectorAll(".focus-context-menu [role=menuitem]")].map(e=>e.textContent.trim())') }
  await key('Escape'); await until('original exact usable entry returned', () => read(`!document.querySelector('.focus-context-menu') && document.activeElement===document.querySelector(${JSON.stringify(row('scene-bare'))})`))
  result.keyboard.exactReturn = true
  result.activityCertainty = { bareUnknown: true, staleUnknown: true, confirmedIdle: true, confirmedWorking: true, exactNeutralCounts: true, keyboardEntry: true }
  result.after = await read('window.activityCertaintyProof.facts()')
  assert.deepEqual(result.after.controls, { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 })
  assert.equal(result.after.originalFocus, true); assert.equal(result.after.originalControls, true)
  assert.deepEqual(result.after.sessions, result.before.sessions); result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
