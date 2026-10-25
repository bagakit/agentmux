const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], boundary: 'Original AgentConnectorDialog, original DesktopClientUiProvider, SettingsNavigation, Modal, theme and unchanged controls. Shared typed fixture leaves; native pointer/keyboard. Workbench to Host/Core routing is separately proven by the real consumer tests. No live platform or installed App effect.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'header-status': '1', 'group-details': '1', 'connector-details-modern': '1', 'conversation-sharing': '1' } })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    await until('window.channelEntryProof?.dialogReady')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input","change"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    const tab = name => '[role="tab"][aria-controls$="-' + name + '-panel"]'
    const dismiss = async () => { await click('[aria-label="Close group setup"]'); await until('!document.querySelector(".agent-connector-dialog")'); assert.equal(await read('document.activeElement?.id'), 'sharing-fixture-open') }
    async function details(scenario, theme, width) {
      win.setContentSize(1380, 980); await until('innerWidth===1380')
      await read('window.channelEntryProof.setTheme(' + JSON.stringify(theme) + ');window.channelEntryProof.setScenario(' + JSON.stringify(scenario) + ')')
      await click('#sharing-fixture-open')
      await until('document.querySelector(".agent-connector-dialog .connector-group-details")')
      await until('document.querySelector(".connector-traffic-summary")?.textContent.includes(' + JSON.stringify(scenario === 'healthy' ? 'No recent requests' : 'Source reading unconfirmed') + ')')
      win.setContentSize(width, 980); await until('innerWidth===' + width); await settle()
    }
    async function capture(name, reference = false) {
      await settle()
      const scene = await read(`({viewport:{width:innerWidth,height:innerHeight},appearance:document.documentElement.dataset.appearance,dialog:document.querySelector('.agent-connector-dialog')?.outerHTML,rect:document.querySelector('.agent-connector-dialog')?.getBoundingClientRect().toJSON(),draft:window.channelEntryProof.draft(),requests:window.channelEntryProof.requests,errors:window.channelEntryProof.errors})`)
      assert.equal(scene.draft, 'Keep this original research draft.'); assert.deepEqual(scene.errors, [])
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); if (reference) (result.references ??= []).push({ file }); else result.frames.push(file); result.scenes.push({ file, reference, ...scene })
    }
    await require('./sharing-craft-scene.cjs')({ win, read, until, click, settle, capture, captureReference: name => capture(name, true), details, dismiss, tab, result })
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
