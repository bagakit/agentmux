const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, privateRoot, evidence, phase] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-failed-close-actual.v1', passed: false, pid: process.pid, phase, frames: [], operations: [], rendererConsole: [], boundary: 'Actual Global/Attention/Store and current Main public dependencies; private Chromium process lifecycle and original Store persistence. Isolated typed Session/Run facts and native stop transport do not certify physical Runtime/PTY or user installation. PTY and Monaco paint leaves isolated.' }
let win
app.whenReady().then(async () => { try {
  ipcMain.handle('failed-close:read', async () => { try { return JSON.parse(await fs.readFile(path.join(privateRoot, 'typed-runtime.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })
  ipcMain.handle('failed-close:write', (_event, value) => fs.writeFile(path.join(privateRoot, 'typed-runtime.json'), JSON.stringify(value)))
  ipcMain.handle('failed-close:flush', () => win.webContents.session.flushStorageData())
  win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 2000)) })
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await pause(30) } while (Date.now() < end); throw new Error('Scene did not settle: ' + label) }
  const settle = async () => { await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await pause(180); await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))') }
  const click = async selector => {
    const rect = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),disabled:e.disabled}})()`)
    assert.equal(rect.hit, true, 'Actual hit ' + selector); assert.notEqual(rect.disabled, true)
    for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    result.operations.push({ kind: 'click', selector }); await settle()
  }
  const facts = () => read('window.failedCloseProof.facts()')
  const retained = f => {
    assert.ok(f.tabs['shared-release-tab'].regions['healthy-region']); assert.ok(f.tabs['unknown-tab'].regions['unknown-region']); assert.ok(f.tabs['refused-tab'].regions['refused-region']); assert.ok(f.tabs['unsaved-file-tab'].regions['file-region'])
    assert.equal(f.drafts.healthy, 'Healthy original unsent draft'); assert.equal(f.drafts.unknown, 'Unknown Run keeps this draft')
    assert.ok(Object.values(f.documents).some(document => document.content.includes('Unsaved original release note'))); assert.ok(Object.values(f.dirty).some(Boolean))
    assert.equal(f.sessions.find(session => session.id === 'healthy').control.run.runId, 'typed-failed-close-healthy')
  }
  const shot = async (file, label) => { await settle(); const geometry = await read(`(()=>{const p=document.querySelector('.attention-request-panel');if(!p)return null;const r=p.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,opacity:getComputedStyle(p).opacity,text:p.innerText}})()`); if (geometry) { assert.ok(geometry.left >= -.5 && geometry.right <= await read('innerWidth') + .5, 'Panel remains in viewport'); assert.ok(geometry.top >= -.5 && geometry.bottom <= await read('innerHeight') + .5, 'Complete panel remains visible'); assert.equal(geometry.opacity, '1') } await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()); result.frames.push({ file, label, viewport: await read('innerWidth'), geometry, facts: await facts() }) }
  const review = async id => { if (await read('!!document.querySelector(".attention-request-panel")')) await click('[aria-label="Close request"]'); await click(`.global-focus-main [data-session-id="${id}"]`); await click('.focus-toolbar__review'); await until('failure review', () => read('!!document.querySelector(".attention-request-panel")')) }
  await win.loadFile(html, { query: { phase } }); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('original Store initialization', () => read('window.failedCloseProof?.ready'))
  if (phase === 'first') await read('window.failedCloseProof.seed()')
  result.initial = await facts(); assert.equal(result.initial.originalInitialize, true); assert.equal(result.initial.initialized, true); assert.equal(result.initial.seedCount, phase === 'first' ? 1 : 0); retained(result.initial)
  if (phase === 'second') {
    assert.equal(result.initial.sessions.some(session => session.id === 'failed'), false); assert.equal(Object.values(result.initial.tabs).some(tab => Object.values(tab.regions).some(region => region.sessionId === 'failed')), false)
    assert.equal(result.initial.sessions.find(session => session.id === 'unknown').detail, 'Runtime observation is unavailable. The original Run state cannot be confirmed.')
    await review('unknown'); await shot('restored-unknown-1200.png', 'New Electron PID restores original work surfaces, unsaved note and unconfirmed failure without second seed')
  } else {
    await review('failed'); assert.equal((await facts()).presentedTab, 'shared-release-tab'); assert.ok((await facts()).presentedRegions.includes('healthy-region')); await shot('failed-review-1200.png', 'Actual error Review shows original failure and exact ended-Session action')
    win.setContentSize(640, 900); await settle(); await shot('failed-review-640.png', 'Narrow failure view retains complete original failure and action')
    await click('.attention-request-panel__next'); await until('pending control', () => read('window.failedCloseProof.facts().controls.length===1'))
    await shot('closing-wait-640.png', 'Accepted pending stop keeps failed Session and shared healthy Region, awaiting exact Core retirement')
    assert.equal((await facts()).sessions.some(session => session.id === 'failed'), true); retained(await facts())
    await read('window.failedCloseProof.release()'); await until('unconfirmed retry', () => read('document.querySelector(".attention-request-panel__next")?.innerText.includes("Retry")'))
    await shot('accepted-unconfirmed-640.png', 'Fulfilled stop is unconfirmed; exact same Session remains with retry')
    await review('refused'); await click('.attention-request-panel__next'); await until('original refusal', () => read('window.failedCloseProof.facts().error?.includes("Registry close was refused")'))
    await shot('refused-640.png', 'Original service rejection is readable; no Session or work surface is predeleted')
    await review('unknown'); win.setContentSize(360, 900); await settle(); assert.equal(await read('!!document.querySelector(".attention-request-panel__next")'), false); await shot('unknown-360.png', 'Unconfirmed process facts retain inspect capability without ended close')
    await review('healthy-error'); assert.equal(await read('!!document.querySelector(".attention-request-panel__next")'), false); await shot('healthy-error-360.png', 'Observation error preserves the running Agent and original input capability')
    win.setContentSize(1200, 900); await settle(); await review('failed'); await click('.attention-request-panel__next'); await read('window.failedCloseProof.confirm()'); await until('exact Core confirmation', () => read('document.querySelector(".attention-request-panel")?.innerText.includes("Core confirmed")'))
    await shot('confirmed-1200.png', 'Exact run-removed retires failed Session while other Regions, draft and unsaved note remain')
  }
  result.persisted = await facts(); retained(result.persisted); await read('window.failedCloseProof.flush()'); await win.webContents.session.flushStorageData()
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure-' + phase + '.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual-' + phase + '.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
