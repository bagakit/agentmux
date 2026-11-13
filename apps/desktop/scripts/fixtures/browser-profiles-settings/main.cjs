const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.env.PROFILES_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(done => setTimeout(done, ms))
const receipt = { captureOnly: true, aestheticReview: 'not-performed', realComponents: ['SettingsPanel', 'BrowserProfilesSettingsPane', 'ProfileMark'], fixtureConfigOnly: true, userDataTouched: false, screenshots: [] }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1250, height: 900, show: false, title: 'Browser Profiles · private review', webPreferences: { contextIsolation: true, nodeIntegration: false } })
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
    await win.loadFile(process.env.PROFILES_VISUAL_HTML)
    await ready('Boolean(window.profilesVisual && document.querySelectorAll(\'[data-settings-pane="browser-profiles"] [data-resource-row]\').length === 4)')
    win.showInactive()
    await capture('profiles-default-dark', 1250, 860)
    await click('[aria-label="Sites with sign-ins"] button')
    await ready('document.querySelectorAll(\'.browser-profile-editor__sites li\').length === 3')
    await click('[aria-label="Clear figma.com"]')
    await capture('profiles-default-sites-dark', 1250, 860)
    await evaluate('document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await click('[data-resource-row="' + await evaluate('profilesVisual.client') + '"]')
    await capture('profiles-client-dark', 1250, 860)
    await click('.browser-profile-editor__mark')
    await capture('profiles-hues-dark', 1250, 860)
    await click('.browser-profile-editor__hues > button[style]:nth-of-type(2)')
    await click('.browser-profile-editor__name')
    await capture('profiles-renaming-dark', 1250, 860)
    await evaluate('document.activeElement && document.activeElement.blur()')
    await evaluate('profilesVisual.appearance("light")')
    await capture('profiles-client-light', 1250, 860)
    await click('[aria-label^="More for "]')
    await capture('profiles-menu-light', 1250, 860)
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await wait(200)
    await capture('profiles-narrow-light', 560, 860)
    await evaluate('profilesVisual.appearance("dark")')
    await capture('profiles-narrow-dark', 560, 860)
    receipt.complete = true
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2))
  app.quit()
})
