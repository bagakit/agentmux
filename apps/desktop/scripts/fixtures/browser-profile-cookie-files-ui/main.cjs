const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const directory = process.env.COOKIE_FILES_VISUAL_ROOT
app.setName('AgentMux Cookie Files Private Review'); app.setActivationPolicy('prohibited')
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const receipt = { captureOnly: true, aestheticReview: 'not-performed', realComponents: ['SettingsPanel', 'BrowserProfilesSettingsPane', 'ProfileEditor', 'BrowserProfileCookieFiles'], fixtureOwnerFactsOnly: true, screenshots: [] }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1250, height: 1120, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.debugger.attach('1.3')
    const evaluate = async expression => { const r = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value }
    const ready = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(70) } throw Error('Cookie UI not ready: ' + expression) }
    const click = async selector => { const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing Cookie control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); await wait(120) }
    const screenshot = async (scene, mode, width) => {
      await evaluate(`profilesVisual.appearance(${JSON.stringify(mode)})`); win.setContentSize(width, 1120); await wait(160)
      await evaluate('document.querySelector(".profile-cookie-files").scrollIntoView({block:"start"})'); await wait(100)
      const state = await evaluate(`(()=>{const e=document.querySelector('.profile-cookie-files');return{theme:document.documentElement.dataset.appearance,overflow:e.scrollWidth>e.clientWidth+1,body:document.body.scrollWidth>innerWidth+1,sectionWidth:e.getBoundingClientRect().width}})()`)
      if (state.theme !== mode || state.overflow || state.body) throw Error('Cookie UI overflows: ' + JSON.stringify(state))
      const file = `cookie-files-${scene}-${mode}-${width}.png`; writeFileSync(join(directory, file), (await win.webContents.capturePage()).toPNG()); receipt.screenshots.push({ file, width, height: 1120, ...state })
    }
    const beginExport = async () => {
      await click('[data-cookie-action="export"]')
      await evaluate(`(()=>{const s=document.querySelector('[aria-label="Cookie scope"]');s.value='sites';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await ready('document.querySelectorAll(".profile-cookie-files input[type=checkbox]").length===2')
      for (const n of [1, 2]) await click(`.profile-cookie-files__site:nth-of-type(${n}) input`)
      await click('.profile-cookie-files__draft .profile-cookie-files__actions > button')
      await click('[data-cookie-submit]')
    }
    await win.loadFile(process.env.COOKIE_FILES_VISUAL_HTML)
    await ready('Boolean(window.cookieFilesVisual && document.querySelector(".profile-cookie-files__heading"))')
    win.showInactive(); await click('.profile-cookie-files__heading'); await ready('Boolean(document.querySelector("[data-cookie-action=export]"))')
    await beginExport(); await ready('document.querySelector(".profile-cookie-files").textContent.includes("Partially completed")')
    await click('[data-cookie-check]'); await ready('document.querySelector(".profile-cookie-files").textContent.includes("Entry 1: unknown")')
    for (const mode of ['dark', 'light']) for (const width of [620, 390]) await screenshot('partial', mode, width)
    await evaluate('cookieFilesVisual.state("unknown")'); await beginExport(); await ready('document.querySelector("[data-cookie-submit]").disabled')
    for (const mode of ['dark', 'light']) for (const width of [620, 390]) await screenshot('unknown', mode, width)
    await click('.profile-cookie-files__draft .profile-cookie-files__actions:last-child > button:first-child')
    await evaluate('cookieFilesVisual.state("refused")'); await beginExport(); await ready('document.querySelector(".profile-cookie-files").textContent.includes("Operation not submitted")')
    for (const mode of ['dark', 'light']) for (const width of [620, 390]) await screenshot('refused', mode, width)
    receipt.nativeInputCallbacks = await evaluate('cookieFilesVisual.counts')
    if (receipt.nativeInputCallbacks.exports !== 3 || receipt.nativeInputCallbacks.checks.length !== 1) throw Error('Native input did not reach Cookie production callbacks')
    receipt.complete = true
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2)); app.quit()
})
