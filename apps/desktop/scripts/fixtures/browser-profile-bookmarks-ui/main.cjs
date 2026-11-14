const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const directory = process.env.BOOKMARKS_VISUAL_ROOT
app.setName('AgentMux Bookmarks Private Review'); app.setActivationPolicy('prohibited')
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const receipt = { captureOnly: true, aestheticReview: 'not-performed', realComponents: ['SettingsPanel', 'BrowserProfilesSettingsPane', 'ProfileEditor', 'BrowserProfileBookmarks'], fixtureOwnerFactsOnly: true, screenshots: [] }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1250, height: 1120, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.debugger.attach('1.3')
    const evaluate = async expression => { const r = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value }
    const ready = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(70) } throw Error('Private bookmark UI not ready: ' + expression) }
    const click = async selector => { const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing bookmark control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); await wait(120) }
    const screenshot = async (scene, mode, width) => {
      await evaluate(`profilesVisual.appearance(${JSON.stringify(mode)})`); win.setContentSize(width, 1120); await wait(160)
      await evaluate('document.querySelector(".profile-bookmarks").scrollIntoView({block:"start"})'); await wait(100)
      const state = await evaluate(`(()=>{const e=document.querySelector('.profile-bookmarks');return{theme:document.documentElement.dataset.appearance,overflow:e.scrollWidth>e.clientWidth+1,body:document.body.scrollWidth>innerWidth+1,sectionWidth:e.getBoundingClientRect().width}})()`)
      if (state.theme !== mode || state.overflow || state.body) throw Error('Bookmark UI overflows: ' + JSON.stringify(state))
      const file = `bookmarks-${scene}-${mode}-${width}.png`; writeFileSync(join(directory, file), (await win.webContents.capturePage()).toPNG()); receipt.screenshots.push({ file, width, height: 1120, ...state })
    }
    await win.loadFile(process.env.BOOKMARKS_VISUAL_HTML)
    await ready('Boolean(window.bookmarksVisual && document.querySelector(".profile-bookmarks__heading"))')
    win.showInactive(); await click('.profile-bookmarks__heading'); await ready('document.querySelectorAll(".profile-bookmarks__list > li").length===3')
    await evaluate(`(()=>{const s=document.querySelector('[aria-label="Bookmark Browser"]');s.value='exact-profile-browser';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click('.profile-bookmarks__list > li:nth-child(2) > .profile-bookmarks__entry')
    await ready('document.querySelector(".profile-bookmarks").textContent.includes("Open request sent")')
    await click('.profile-bookmarks__list > li:nth-child(2) .profile-bookmarks__actions > button:first-child')
    for (const mode of ['dark', 'light']) for (const width of [1250, 560]) await screenshot('edit', mode, width)
    await evaluate('bookmarksVisual.unknown()')
    await click('.profile-bookmarks__draft input:first-of-type')
    await evaluate('document.querySelector(".profile-bookmarks__draft input").select()')
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'My original draft — awaiting confirmation' })
    await click('.profile-bookmarks__draft button[type="submit"]')
    await ready('bookmarksVisual.counts.edits===1 && document.querySelector(".profile-bookmarks__draft button[type=submit]").disabled')
    for (const mode of ['dark', 'light']) await screenshot('unknown', mode, 560)
    await click('.profile-bookmarks__receipt > button')
    await ready('bookmarksVisual.counts.checked.includes(bookmarksVisual.lastOperation)')
    await ready('!document.querySelector(".profile-bookmarks__draft")')
    await evaluate('bookmarksVisual.refused()')
    await click('.profile-bookmarks__list > li:nth-child(2) .profile-bookmarks__actions > button:first-child')
    await click('[aria-label="Bookmark address"]')
    await evaluate('document.querySelector(".profile-bookmarks__draft input[aria-label]").select()')
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'not a url' })
    await click('.profile-bookmarks__draft button[type="submit"]')
    await ready('document.querySelector(".profile-bookmarks").textContent.includes("Operation not submitted") && !document.querySelector(".profile-bookmarks__draft input").disabled')
    for (const mode of ['dark', 'light']) await screenshot('refused', mode, 560)
    receipt.nativeInputCallbacks = await evaluate('bookmarksVisual.counts')
    if (receipt.nativeInputCallbacks.edits !== 2 || receipt.nativeInputCallbacks.opens !== 1 || receipt.nativeInputCallbacks.checked.length !== 1) throw Error('Native controls failed to reach exact bookmark callbacks')
    receipt.complete = true
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2)); app.quit()
})
