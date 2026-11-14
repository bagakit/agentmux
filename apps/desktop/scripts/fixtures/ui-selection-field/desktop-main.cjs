const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.equal(section, 'desktop')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) { const directory = path.join(privateRoot, name); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory) }
app.setName('Owned SelectionField Desktop Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] }]))
const result = { completed: false, images: [], interactions: [], layouts: [], boundary: 'Actual Focus Map, Remote Routes and Host Projects with shared SelectionField and controlled DTOs; no registration, policy save or Agent launch.' }
let win
let read
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    result.console = []
    win.webContents.on('console-message', (_event, ...details) => {
      const normalized = details.map(value => typeof value === 'object' ? { message: value.message, level: value.level, sourceId: value.sourceId, lineNumber: value.lineNumber } : value)
      result.console.push(...normalized)
    })
    await win.loadFile(html)
    let until, settle, click, press
    ;({ read, until, settle, click, press } = nativeRendererInput(win, result.interactions, '.settings-page'))
    await until('!!(window.connectionsProof?.ready&&document.querySelector(".settings-page"))')
    await read("window.__connectionsTrustedEvents=[];window.__captureErrorStacks=[];window.addEventListener('error',event=>window.__captureErrorStacks.push(String(event.error?.stack||event.message)));for(const type of ['click','keydown','keypress','keyup','input'])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,target:event.target.tagName}),true)")
    async function shot(name) {
      await settle()
      fs.writeFileSync(path.join(evidence, name), (await win.webContents.capturePage()).toPNG())
      result.images.push({ path: name, scenario: name })
      result.layouts.push(await read(`(()=>{const menu=document.querySelector('.selection-field__menu'),results=document.querySelector('.selection-field__results'),items=[...document.querySelectorAll('.selection-field__option')];if(!menu)return null;const style=getComputedStyle(menu),r=menu.getBoundingClientRect(),rr=results?.getBoundingClientRect();return {name:${JSON.stringify(name)},menu:{x:r.x,y:r.y,width:r.width,height:r.height,maxHeight:style.maxHeight,overflow:style.overflow},results:results?{height:rr.height,clientHeight:results.clientHeight,scrollHeight:results.scrollHeight,overflow:getComputedStyle(results).overflow}:null,items:items.slice(0,12).map(item=>{const b=item.getBoundingClientRect();return {value:item.dataset.value,height:b.height,y:b.height?b.y:null,text:item.textContent}})}})()`))
    }
    async function center(selector) {
      await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',inline:'center'})`)
      await settle()
    }
    for (const theme of ['light', 'dark']) {
      win.setContentSize(1180, 820)
      await read('window.connectionsProof.reset()')
      await read('window.connectionsProof.reopen("focus")')
      result.stage = 'focus-theme'
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      result.stage = 'focus-wait-lod'
      result.beforeWait = await read('document.querySelector("body") !== null')
      await until('!!document.querySelector(\'[aria-label="LOD levels"]\')')
      result.stage = 'focus-open-lod'
      await center('[aria-label="LOD levels"]')
      await click('[aria-label="LOD levels"]'); await until('!!document.querySelector(".selection-field__menu")'); await shot(`focus-lod-menu-${theme}.png`)
      await click('.selection-field__menu [data-value="4"]')
      await click('.focus-map-settings__levels > details > summary')
      await center('[aria-label="Level 1 form"]')
      await click('[aria-label="Level 1 form"]'); await until('!!document.querySelector(".selection-field__menu")'); await shot(`focus-form-menu-${theme}.png`)
      await click('.selection-field__menu [data-value="compact"]')
      await click('[aria-label="Level 1 information"]'); await until('!!document.querySelector(".selection-field__menu")'); await shot(`focus-information-menu-${theme}.png`)
      result.stage = 'focus-native-escape'
      await press('Escape')
      assert.equal(await read('!!document.querySelector(".selection-field__menu")'), false, 'Native Escape closes the menu')
      assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Level 1 information', 'Native Escape returns focus to the original trigger')
      assert.equal(await read('!!document.querySelector(".settings-page")'), true, 'The owning Settings page remains open')

      await read('window.connectionsProof.reopen("remote-execution")')
      result.stage = 'routes-select-tab'
      await click('button[role="tab"][aria-controls$="-routes"]')
      result.stage = 'routes-wait-device'
      await until('!!document.querySelector(\'[aria-label="Route policy device"]\')')
      result.stage = 'routes-open-device'
      await click('[aria-label="Route policy device"]'); await until('!!document.querySelector(".selection-field__menu")'); await shot(`routes-device-menu-${theme}.png`)
      result.stage = 'routes-long-list-tail'
      await press('Down'); await press('End')
      const tail = await read(`(()=>{const item=document.querySelector('.selection-field__menu [data-value="host-23"]'),results=document.querySelector('.selection-field__results');if(!item||!results)return null;const r=item.getBoundingClientRect(),b=results.getBoundingClientRect();return {focused:document.activeElement===item,top:r.top,bottom:r.bottom,resultsTop:b.top,resultsBottom:b.bottom,scrollTop:results.scrollTop,scrollHeight:results.scrollHeight,clientHeight:results.clientHeight}})()`)
      assert.ok(tail?.focused, 'Native End focuses the actual last Host')
      assert.ok(tail.top >= tail.resultsTop - 1 && tail.bottom <= tail.resultsBottom + 1, 'The last Host is fully visible, not a clipped half row')
      assert.ok(tail.scrollTop > 0 && tail.scrollTop + tail.clientHeight >= tail.scrollHeight - 1, 'The actual results reach their scroll endpoint')
      result.interactions.push({ kind: 'native-long-list-tail', ...tail })
      await shot(`routes-device-tail-${theme}.png`)
      await click('.selection-field__menu [data-value="host-23"]')
      await until('document.querySelector(\'[aria-label="Route policy device"]\')?.dataset.value==="host-23"')
      await click('[aria-label="Route policy device"]'); await until('!!document.querySelector(".selection-field__menu")')
      result.stage = 'routes-select-host'
      await click('.selection-field__menu [data-value="host-02"]')
      result.stage = 'routes-wait-saved-connections'
      await until('!!document.querySelector(\'[aria-label="Next saved route connection"]\')')
      await click('[aria-label="Next saved route connection"]'); await until(`!!document.querySelector('.selection-field__menu [data-value="D"]')`); await shot(`routes-edge-menu-${theme}.png`)
      await click('.selection-field__menu [data-value="D"]')

      await read('window.connectionsProof.reopen("hosts")')
      result.stage = 'hosts-manage'
      await click('[data-mesh-saved-host="host-02"] button')
      await until('!!document.querySelector(\'[data-resource-editor="host-02"]\')')
      result.stage = 'hosts-projects'
      await click('[data-resource-editor="host-02"] [data-host-panel="projects"]')
      await until('document.querySelector(\'[data-resource-editor="host-02"]\')?.dataset.hostView===\'projects\'')
      await until('!!document.querySelector(".host-projects__heading button")')
      await click('.host-projects__heading button')
      await until('document.querySelector(".host-projects__form")?.textContent.includes("Agent choices belong to this saved connection.")')
      await until('!!document.querySelector(\'[aria-label="Prepare an Agent"]\')')
      await click('[aria-label="Prepare an Agent"]'); await until('!!document.querySelector(".selection-field__menu")'); await shot(`projects-executor-menu-${theme}.png`)
      await click('.selection-field__menu [data-value="remote-only"]'); await shot(`projects-executor-selected-${theme}.png`)
      assert.equal(await read('window.connectionsProof.calls.filter(call=>call.kind==="preview-config-save").length'), 0, 'Selection never saves configuration')
      assert.equal(await read('window.connectionsProof.calls.filter(call=>call.kind==="original-select-session").length'), 0, 'Selection never opens an Agent or Session')
    }
    assert.equal(result.images.length, 16)
    result.completed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage }
    result.debug = { hasWindow: Boolean(win), destroyed: win ? win.isDestroyed() : null }
    if (win && !win.isDestroyed()) result.failureObserved = await read('({errors:window.connectionsProof?.errors,stacks:window.__captureErrorStacks,text:document.body.innerText.slice(0,2000),page:document.querySelector(".settings-page")?.dataset.settingsPage})').catch(() => null)
    result.console = result.console ?? []
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.completed ? 0 : 1)
  }
})
