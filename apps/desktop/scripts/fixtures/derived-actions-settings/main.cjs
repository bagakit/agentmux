const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.env.DERIVED_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(done => setTimeout(done, ms))
const receipt = { captureOnly: true, aestheticReview: 'not-performed', realComponents: ['SettingsPanel', 'DerivedActionsSettingsPane', 'SessionTakeoverSurface'], fixtureConfigOnly: true, userDataTouched: false, screenshots: [] }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1250, height: 900, show: false, title: 'Derived actions · private review', webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer:', details.message) })
    win.webContents.debugger.attach('1.3')
    const evaluate = async expression => { const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
    const ready = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100) } throw new Error('Private visual document not ready: ' + expression) }
    const click = async selector => {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing real control '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await wait(200)
    }
    const capture = async (name, width, height) => {
      win.setContentSize(width, height); await wait(300)
      await writeFile(join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG())
      receipt.screenshots.push({ name, file: name + '.png', width, height })
    }
    await win.loadFile(process.env.DERIVED_VISUAL_HTML)
    await ready('Boolean(window.derivedVisual && document.querySelector(\'[data-settings-pane="derived-actions"] [data-derived-action-id="take-over"]\'))')
    win.showInactive()
    await capture('settings-official-dark', 1250, 900)
    await click('[data-derived-action-id="review-this-work"]')
    await capture('settings-custom-dark', 1250, 900)
    await evaluate('derivedVisual.appearance("light")')
    await capture('settings-custom-light', 1250, 900)
    await click('[data-derived-action-id="pass-on-experience"]')
    await capture('settings-hidden-official-light', 1250, 900)
    await click('[data-derived-action-id="try-another-approach"]')
    await capture('settings-custom-narrow-light', 560, 860)
    await win.loadFile(process.env.DERIVED_VISUAL_HTML, { search: 'scene=surface' })
    await ready('Boolean(window.derivedVisual && document.querySelector(\'.session-takeover[data-derived-action]\'))')
    await evaluate('derivedVisual.appearance("dark")')
    await wait(400)
    await capture('surface-dark', 1250, 860)
    await evaluate('derivedVisual.appearance("light")')
    await capture('surface-light-narrow', 560, 860)
    receipt.complete = true
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2))
  app.quit()
})
