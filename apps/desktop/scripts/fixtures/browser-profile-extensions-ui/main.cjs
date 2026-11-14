const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.env.PROFILES_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(done => setTimeout(done, ms))
const receipt = { captureOnly: true, aestheticReview: 'not-performed', realComponents: ['SettingsPanel', 'BrowserProfilesSettingsPane', 'BrowserProfileExtensions'], fixturePackageFactsOnly: true, screenshots: [] }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1250, height: 1120, show: false, title: 'Profile extensions · private review', webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.debugger.attach('1.3')
    const evaluate = async expression => { const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
    const ready = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100) } throw new Error('Private visual document not ready: ' + expression) }
    const click = async selector => {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await wait(180)
    }
    await win.loadFile(process.env.PROFILES_VISUAL_HTML)
    await ready('Boolean(window.extensionsVisual && document.querySelectorAll("[data-resource-row]").length === 4)')
    win.showInactive()
    await click('.browser-profile-extensions__heading')
    await ready('document.querySelectorAll(".browser-profile-extensions__list > li").length === 2')
    await click('.browser-profile-extensions__list > li:first-child .browser-profile-extensions__actions > button:first-child')
    await ready('document.querySelector("[aria-label=\\"Extension source and permission review\\"]")?.textContent.includes("API: tabs")')
    await click('.browser-profile-extensions__primary')
    await ready('document.querySelector(".browser-profile-extensions__notice")?.textContent.includes("Nothing changed")')
    receipt.nativeInputCallbacks = await evaluate('extensionsVisual.receipt')
    if (receipt.nativeInputCallbacks.prepares !== 1 || receipt.nativeInputCallbacks.applies !== 1) throw Error('Actual Profile extension controls did not consume the exact review callbacks')
    for (const mode of ['dark', 'light']) {
      await evaluate(`profilesVisual.appearance(${JSON.stringify(mode)})`)
      for (const width of [1250, 560]) {
        win.setContentSize(width, 1120); await wait(240)
        await evaluate('document.querySelector(".browser-profile-extensions").scrollIntoView({block:"start"})')
        await wait(150)
        const state = await evaluate(`(()=>{const node=document.querySelector('.browser-profile-extensions'),box=node.getBoundingClientRect();return{theme:document.documentElement.dataset.theme,appearance:document.documentElement.dataset.appearance,editorWidth:box.width,overflow:node.scrollWidth>node.clientWidth+1,body:document.body.scrollWidth>innerWidth+1,reviewVisible:document.querySelector('.browser-profile-extensions__primary').getBoundingClientRect().bottom<=innerHeight}})()`)
        if (state.appearance !== mode || state.overflow || state.body || !state.reviewVisible) throw Error('Actual extension editor overflows or clips its review action: '+JSON.stringify(state))
        const name = `extensions-${mode}-${width}.png`
        writeFileSync(join(directory, name), (await win.webContents.capturePage()).toPNG()); receipt.screenshots.push({ file: name, width, height: 1120, ...state })
      }
    }
    receipt.complete = true
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2)); app.quit()
})
