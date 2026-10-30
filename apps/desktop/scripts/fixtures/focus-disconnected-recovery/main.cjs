const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win; const result = { passed: false, frames: [], errors: [], boundary: 'Actual GlobalFocusSurface/Store/projection/card/common menu/SessionStop/navigation/CSS. Typed preview transport; PTY/editor paint isolated. No user App, true Runtime/PID, original user Stop, native restart or installation proof.' }
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.errors.push(message) })
  await win.loadFile(html)
  const read = js => win.webContents.executeJavaScript(js, true)
  const until = async (name, js) => { const end = Date.now() + 12000; while (Date.now() < end) { if (await read(js)) return; await new Promise(resolve => setTimeout(resolve, 40)) } throw Error('Unconfirmed scene: ' + name) }
  const click = async selector => { await until(selector, `Boolean(document.querySelector(${JSON.stringify(selector)}))`); await read(`document.querySelector(${JSON.stringify(selector)}).click()`) }
  const shot = async file => { await new Promise(resolve => setTimeout(resolve, 180)); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, width: await read('innerWidth') }) }
  const openStop = async () => {
    await read(`(()=>{const node=document.querySelector('button[data-session-id="original-retained"]');node.focus();node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:120,clientY:160}))})()`)
    await until('common original Stop menu', `[...document.querySelectorAll('[role="menuitem"]')].some(node=>node.textContent==='Stop Agent')`)
    await read(`[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent==='Stop Agent').click()`)
    await until('original Stop confirmation', `Boolean(document.querySelector('[role="dialog"]'))`)
  }
  await until('retained Session ready', `window.recoveryProof?.ready&&Boolean(document.querySelector('[data-focus-open-placeless]'))`)
  await shot('exited-placeless-wide.png')
  await click('[data-focus-open-placeless]')
  await until('original Session view opened', `window.recoveryProof.facts().regions.some(region=>region.sessionId==='original-retained')`)
  result.opened = await read('window.recoveryProof.facts()')
  assert.equal(result.opened.calls.length, 0); assert.ok(result.opened.draftsKept)
  assert.ok(result.opened.regions.every(region => region.sessionId === 'original-retained'))
  await read('window.recoveryProof.reset(false)'); await until('reset exact retained view', `Boolean(document.querySelector('[data-focus-open-placeless]'))`)
  await openStop(); await until('exited close intent', `Boolean(document.querySelector('[data-confirm-label="Close Agent"]'))`)
  await shot('exited-close-wide.png')
  await click('[data-confirm-label="Close Agent"]'); await until('persistent original continuation', `Boolean(document.querySelector('[data-confirm-label="Continue Stop"]'))`)
  win.setContentSize(420, 760); await shot('exited-stop-unconfirmed-narrow.png')
  await click('[data-confirm-label="Continue Stop"]'); await until('original Stop completed', `!document.querySelector('[role="dialog"]')`)
  await read('window.recoveryProof.reset(true)'); await until('unknown exact retained view', `document.querySelector('.focus-location-recovery')?.textContent.includes('current Run state is unknown')`)
  await openStop(); await until('unknown preserves Stop', `Boolean(document.querySelector('[data-confirm-label="Stop Agent"]'))`)
  await click('[data-confirm-label="Stop Agent"]'); await until('unknown continuation', `Boolean(document.querySelector('[data-confirm-label="Continue Stop"]'))`)
  const text = await read(`document.querySelector('[role="dialog"]').textContent`)
  assert.ok(text.includes('current state is unknown')); assert.ok(!text.includes('Current Run: exited'))
  await shot('unknown-stop-unconfirmed-narrow.png')
  await click('.confirmation-dialog__cancel'); await until('explicit observer dismissal', `!document.querySelector('[role="dialog"]')`)
  result.after = await read('window.recoveryProof.facts()'); assert.equal(result.after.calls.length, 3)
  assert.ok(result.after.calls.every(control => control.hostId === 'local' && control.agentSessionId === 'original-retained' && control.run.runId === 'original-exited-run'))
  assert.deepEqual(result.after.controlEffects, { resume: 0, launchAgent: 0, write: 0, interrupt: 0 }); assert.ok(result.after.draftsKept)
  result.passed = true
} catch(error) { result.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2)+'\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
