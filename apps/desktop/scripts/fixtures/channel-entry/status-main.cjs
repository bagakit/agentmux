const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Production Workbench/header/menu and CSS; controlled safe public diagnosis DTOs only. Actual IPC/ConnectionHost source, effects and input facts are qualified by connector-header-status.test.tsx. No live account, delivery, installed App or healthy-Agent claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    const node = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
    const text = (label, selector = '[role="dialog"] button') => 'js:[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(node=>node.textContent.trim()===' + JSON.stringify(label) + ')'
    await until('window.channelEntryProof?.ready && document.querySelector(".agent-region-header__connector")')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await click('.agent-region-header__connector')
    await click(text('Connect a conversation', '.connector-header-menu [role="menuitem"]'))
    await until(node('[aria-label="Existing group"]'))
    await click('.selection-field[aria-label="Existing group"]')
    await until(node('[role="menuitemradio"][data-value="345678901234567890"]'))
    await click('[role="menuitemradio"][data-value="345678901234567890"]')
    await click('js:[...document.querySelectorAll(".agent-connector-check input")].find(node=>node.closest("label").textContent.includes("Share new"))')
    await click(text('Connect group')); await until(node('[aria-label="Group connection status"]'))
    await click('[aria-label="Close group setup"]')
    const expected = { normal: 'Sync on', attention: 'Needs attention', unavailable: 'Status unknown' }
    for (const status of ['normal', 'attention', 'unavailable']) {
      await read('window.channelEntryProof.status=' + JSON.stringify(status))
      if (!await read(node('.connector-header-menu'))) await click('.agent-region-header__connector')
      await click(text('Check group status', '.connector-header-menu [role="menuitem"]'))
      await until('document.querySelector(".agent-region-header__connector")?.textContent.includes(' + JSON.stringify(expected[status]) + ') && document.querySelector(".connector-header-menu time")')
      for (const [width, label] of [[1380, 'wide'], [520, 'narrow']]) {
        win.setContentSize(width, 980); await until('innerWidth===' + width)
        if (!await read(node('.connector-header-menu'))) await click('.agent-region-header__connector')
        await settle()
        const file = 'header-' + status + '-' + label + '.png'
        fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push(file)
      }
    }
    result.facts = await read('({calls:window.channelEntryProof.calls,errors:window.channelEntryProof.errors,header:document.querySelector(".agent-region-header__connector")?.outerHTML,menu:document.querySelector(".connector-header-menu")?.outerHTML})')
    assert.deepEqual(result.facts.errors, [])
    assert.equal(result.facts.calls.filter(method => method === 'connection.bind').length, 1)
    assert.equal(result.facts.calls.includes('connection.delivery.retry'), false)
    assert.equal(result.facts.calls.includes('connection.grant'), false)
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
