const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.equal(section, 'node')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) { const directory = path.join(privateRoot, name); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory) }
app.setName('Owned SelectionField Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] }]))
const result = { completed: false, images: [], interactions: [], boundary: 'Actual Node settings and shared SelectionField with controlled DTOs; no real SSH/Runtime claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 960, height: 760, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const pane = '.network-node-settings'
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, pane)
    await until('Boolean(window.connectionsProof?.ready&&document.querySelector(".settings-page"))')
    await read("window.__connectionsTrustedEvents=[];for(const type of ['click','keydown','keypress','keyup','input'])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,target:event.target.tagName}),true)")
    for (const [width, theme] of [[960, 'light'], [420, 'dark'], [320, 'light']]) {
      win.setContentSize(width, 760)
      result.stage = 'reset'
      await read('window.connectionsProof.reset()')
      result.stage = 'reopen'
      await read('window.connectionsProof.reopen("network-node")')
      result.stage = 'theme'
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      result.stage = 'wait-field'
      await until(`Boolean(document.querySelector(${JSON.stringify(pane + ' [aria-label="Node to manage"]')}))`)
      result.stage = 'show'
      win.showInactive(); win.focus(); win.webContents.focus(); await settle()
      result.stage = 'click-field'
      await click(pane + ' [aria-label="Node to manage"]')
      result.stage = 'open-menu'
      await until('Boolean(document.querySelector(".selection-field__menu"))')
      result.stage = 'capture-menu'
      const menuImage = `node-menu-${width}-${theme}.png`
      fs.writeFileSync(path.join(evidence, menuImage), (await win.webContents.capturePage()).toPNG())
      result.images.push({ path: menuImage, width, theme, scenario: 'menu' })
      await click('.selection-field__menu [data-value="host-02"]')
      await until(`document.querySelector(${JSON.stringify(pane + ' [aria-label="Node to manage"]')})?.dataset.value==='host-02'`)
      await read('document.activeElement?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'); await settle()
      assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Node to manage', 'Escape returns focus to the original Node field')
      const selectedImage = `node-selected-${width}-${theme}.png`
      fs.writeFileSync(path.join(evidence, selectedImage), (await win.webContents.capturePage()).toPNG())
      result.images.push({ path: selectedImage, width, theme, scenario: 'selected' })
    }
    assert.equal(result.images.length, 6)
    result.completed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage }
    if (win && !win.isDestroyed()) result.failureObserved = await read('({page:document.querySelector(".settings-page")?.dataset.settingsPage,events:window.__connectionsTrustedEvents?.length,text:document.body.innerText.slice(0,1200)})').catch(() => null)
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.completed ? 0 : 1)
  }
})
