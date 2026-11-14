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
let read, until, settle, click, press
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 960, height: 760, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const pane = '.network-node-settings'
    const shot = async (name, width, theme, scenario) => { fs.writeFileSync(path.join(evidence, name), (await win.webContents.capturePage()).toPNG()); result.images.push({ path: name, width, theme, scenario }) }
    ;({ read, until, settle, click, press } = nativeRendererInput(win, result.interactions, pane))
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
      await until('document.querySelector(".selection-field__menu")?.checkVisibility() === true')
      result.stage = 'capture-menu'
      await settle()
      await shot(`node-menu-${width}-${theme}.png`, width, theme, 'menu')
      if (width === 420) {
        await press('Down')
        if (await read('document.activeElement?.matches(".selection-field__menu [role=option][aria-selected=true]")')) await press('Down')
        await until('document.activeElement?.matches(".selection-field__menu [role=option][aria-selected=false]")')
        assert.equal(await read('document.querySelectorAll(".selection-field__menu [role=option][aria-selected=true]").length'), 1)
        await shot('node-keyboard-focus-420-dark.png', width, theme, 'keyboard-focus')
      }
      await click('.selection-field__menu [data-value="host-02"]')
      await until(`document.querySelector(${JSON.stringify(pane + ' [aria-label="Node to manage"]')})?.dataset.value==='host-02'&&document.querySelector('[id^="node-to-manage-hint-"]')?.textContent.includes('Runtime controlled-bound-runtime')&&Boolean(document.querySelector('[aria-label="Node alias"]'))`)
      await click(pane + ' [aria-label="Node to manage"]')
      await until('document.querySelector(".selection-field__menu")?.checkVisibility() === true')
      await press('Escape')
      assert.equal(await read('Boolean(document.querySelector(".selection-field__menu"))'), false, 'Native Escape closes the Node menu')
      assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Node to manage', 'Native Escape returns focus to the original Node field')
      assert.equal(await read(`document.querySelector(${JSON.stringify(pane + ' [aria-label="Node to manage"]')})?.dataset.value`), 'host-02', 'Escape preserves the selected Host')
      assert.equal(await read('Boolean(document.querySelector(".settings-page"))'), true, 'Settings remains open')
      await shot(`node-selected-${width}-${theme}.png`, width, theme, 'selected')
    }
    result.stage = 'missing-host'
    win.setContentSize(420, 760)
    await read('window.connectionsProof.reset()')
    await read('window.connectionsProof.reopen("network-node", "missing-host")')
    await read('window.connectionsProof.theme("dark")')
    await until('document.querySelector(\'[aria-label="Node to manage"]\')?.dataset.value === "missing-host"')
    await click('[aria-label="Node to manage"]')
    await until('document.querySelector(".selection-field__menu")?.checkVisibility() === true')
    await settle()
    await shot('node-missing-menu-420-dark.png', 420, 'dark', 'missing-menu')
    await click('.selection-field__menu [data-value="host-02"]')
    await until('document.querySelector(\'[aria-label="Node to manage"]\')?.dataset.value === "host-02" && Boolean(document.querySelector(\'[aria-label="Node alias"]\'))')
    await shot('node-missing-recovered-420-dark.png', 420, 'dark', 'missing-recovered')

    result.stage = 'identity-error'
    await read('window.connectionsProof.reset()')
    await read('window.connectionsProof.nodeScenario("identity-error")')
    await read('window.connectionsProof.reopen("network-node", "local")')
    await until('document.body.innerText.includes("Controlled Node identity is unconfirmed")')
    await read('new Promise(resolve => setTimeout(resolve, 80))')
    assert.equal(await read('Boolean(document.querySelector(\'[aria-label="Node alias"]\'))'), false, 'Identity failure does not substitute a local policy editor')
    assert.equal(await read("document.evaluate('count(//button[text()=\"Refresh Node identity\" and not(@disabled)])', document, null, XPathResult.NUMBER_TYPE, null).numberValue > 0"), true, 'Identity recovery remains enabled')
    await shot('node-identity-error-420-dark.png', 420, 'dark', 'identity-error')
    result.stage = 'identity-recovery'
    await read('window.connectionsProof.nodeScenario("healthy")')
    await click('js:[...document.querySelectorAll("button")].find(node => node.textContent === "Refresh Node identity")')
    await until('Boolean(document.querySelector(\'[aria-label="Node alias"]\'))', 'Identity recovery reaches the original editor')

    result.stage = 'owner-error'
    await read('window.connectionsProof.reset()')
    await read('window.connectionsProof.nodeScenario("owner-error")')
    await read('window.connectionsProof.reopen("network-node", "host-02")')
    await until('document.body.innerText.includes("Controlled Node owner read failed")')
    await until("document.evaluate('count(//button[text()=\"Refresh\" and not(@disabled)])', document, null, XPathResult.NUMBER_TYPE, null).numberValue > 0", 'Owner recovery becomes enabled after the busy transition')
    assert.equal(await read('Boolean(document.querySelector(\'[aria-label="Node alias"]\'))'), false, 'Owner failure does not replace the original policy editor')
    await shot('node-owner-error-420-dark.png', 420, 'dark', 'owner-error')
    await read('window.connectionsProof.nodeScenario("healthy")')
    await click('js:[...document.querySelectorAll("button")].find(node => node.textContent === "Refresh")')
    await until('Boolean(document.querySelector(\'[aria-label="Node alias"]\'))', 'Owner recovery reaches the original editor')

    result.stage = 'connection-transport'
    await read('window.connectionsProof.reset()')
    await read('window.connectionsProof.reopen("hosts", "host-02")')
    await until('Boolean(document.querySelector(\'[aria-label="Connection transport"]\'))')
    await click('[aria-label="Connection transport"]')
    await until('document.querySelector(".selection-field__menu")?.checkVisibility() === true')
    await settle()
    await shot('connection-transport-menu-420-dark.png', 420, 'dark', 'connection-menu')
    await click('.selection-field__menu [data-value="tailcat"]')
    await until('document.querySelector(\'[aria-label="Connection transport"]\')?.dataset.value === "tailcat" && Boolean(document.querySelector(\'[aria-label="Tailcat address"]\'))')
    await click('[aria-label="Connection transport"]')
    await until('document.querySelector(".selection-field__menu")?.checkVisibility() === true')
    await press('Escape')
    assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Connection transport', 'Native Escape returns focus to Connection transport')
    assert.equal(await read('document.querySelector(\'[aria-label="Connection transport"]\')?.dataset.value'), 'tailcat', 'Escape preserves the transport draft')
    await read('document.querySelector(\'[aria-label="Connection transport"]\').scrollIntoView({block:"center"})'); await settle()
    const selectedVisible = await read(`(()=>{const n=document.querySelector('[aria-label="Connection transport"]'),r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return n.checkVisibility()&&!!hit&&(hit===n||n.contains(hit))})()`)
    assert.ok(selectedVisible, 'The selected transport field is visible in its capture')
    await shot('connection-transport-selected-420-dark.png', 420, 'dark', 'connection-selected')
    await read('document.querySelector(\'[aria-label="Tailcat address"]\').scrollIntoView({block:"center"})'); await settle()
    await until('document.querySelector(\'[aria-label="Tailcat address"]\').checkVisibility() && [...document.querySelectorAll("button")].find(node => node.textContent === "Save hosts")?.checkVisibility()', 'Tailcat draft and save action are visible together')
    await shot('connection-transport-draft-420-dark.png', 420, 'dark', 'connection-draft')
    assert.equal(await read('window.connectionsProof.calls.filter(call => call.kind === "preview-config-save").length'), 0, 'Selection never saves configuration')
    assert.equal(await read('window.connectionsProof.calls.filter(call => call.kind === "controlled-node-configure").length'), 0, 'Selection never configures Node policy')
    assert.equal(result.images.length, 14)
    result.completed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage }
    if (win && !win.isDestroyed()) result.failureObserved = await read('({page:document.querySelector(".settings-page")?.dataset.settingsPage,events:window.__connectionsTrustedEvents?.length,text:document.body.innerText.slice(0,1200)})').catch(() => null)
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.completed ? 0 : 1)
  }
})
