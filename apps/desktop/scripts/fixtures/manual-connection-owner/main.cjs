const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Actual SettingsPanel, manual consumer and production CSS. Controlled synthetic DTOs only; native Host/IPC/SDK proof is separate. No live owner, installed App or remote deployment claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const { read, until, settle, click, type } = nativeRendererInput(win, result.interactions, '')
    await until('window.manualOwnerProof?.ready && document.querySelector("[data-settings-pane=lark] [data-enrollment-existing]")')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    const capture = async name => { await settle(); const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push(file) }
    await click('[data-settings-pane=lark] [data-enrollment-existing]')
    await type('[data-settings-pane=lark] [aria-label="Connection app ID"]', 'cli_original_application')
    await type('[data-settings-pane=lark] [aria-label="Connection app secret"]', 'preview-masked-secret')
    await capture('manual-owner-edit-wide')
    win.setContentSize(520, 980); await until('innerWidth===520'); await capture('manual-owner-edit-narrow')
    await click('[data-settings-pane=lark] [data-connection-save]')
    await until('document.querySelector("[data-settings-pane=lark]").textContent.includes("Save result not confirmed")')
    await capture('manual-owner-pending-narrow')
    await click('[data-settings-pane=lark] [data-connection-save]')
    await until('document.querySelector("[data-settings-pane=lark]").textContent.includes("The original application save is confirmed")')
    win.setContentSize(1380, 980); await until('innerWidth===1380')
    await click('[data-settings-pane=lark] .channel-metadata summary'); await capture('manual-owner-saved-wide')
    const facts = await read('({errors:window.manualOwnerProof.errors,selection:document.querySelector("[data-connection-hosting] select")?.value,text:document.querySelector("[data-settings-pane=lark]").textContent})')
    assert.deepEqual(facts.errors, []); assert.equal(facts.text.includes('preview-masked-secret'), false); assert.equal(facts.selection, 'original')
    result.facts = facts; result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
