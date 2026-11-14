const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence, channel = 'discord'] = process.argv.slice(2)
const pane = `[data-settings-pane=${channel}]`
const expectedHelp = channel === 'telegram' ? 'Group Privacy' : 'Message Content Intent'
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Actual SettingsPanel, registered channel contribution, original editor and production CSS; controlled typed credential/config/check DTOs only. Real secure IPC/native SDK behavior is verified separately. No live token or platform permissions claimed.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { channel } })
    const { read, until, settle, click, type } = nativeRendererInput(win, result.interactions, '')
    await until(`window.channelSettingsProof?.ready && document.querySelector("${pane}:not([hidden]) [data-enrollment-existing]")`)
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    // Drive this isolated Renderer without moving the person's OS focus.
    win.webContents.focus()
    async function capture(name) { await settle(); const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push(file) }
    await capture(`${channel}-library-wide`)
    await click(`${pane} [data-enrollment-existing]`)
    await type(`${pane} [aria-label="Connection app ID"]`, `123456789012345678`)
    await type(`${pane} [aria-label="Connection app secret"]`, `preview-masked-token`)
    assert.equal(await read(`document.querySelector(` + JSON.stringify(`${pane} [aria-label="Connection app secret"]`) + `).type`), `password`)
    await capture(`${channel}-credentials-wide`)
    win.setContentSize(520, 980); await until('innerWidth===520'); await capture(`${channel}-credentials-narrow`)
    await click(`${pane} [data-connection-save]`)
    await until(`document.querySelector("${pane} [data-connection-check]")`)
    await click(`${pane} [data-connection-check]`)
    await until(`document.querySelector("${pane} [data-connection-stage=authentication]")?.dataset.state==="ready"`)
    await capture(`${channel}-saved-narrow`)
    win.setContentSize(1380, 980); await until('innerWidth===1380')
    await click(`${pane} [data-channel-setup] summary`)
    await read(`document.querySelector("${pane} [data-channel-setup]").scrollIntoView({block:"center"})`)
    await capture(`${channel}-guidance-wide`)
    await click(`${pane} [data-connection-check]`)
    await until(`document.querySelector("${pane} [data-connection-stage=authentication]")?.dataset.state==="unavailable"`)
    await click(`${pane} [data-connection-setup-result] .connector-diagnostics summary`)
    await read(`document.querySelector("${pane} [data-connection-setup-result]").scrollIntoView({block:"center"})`)
    await capture(`${channel}-check-failed-wide`)
    const facts = await read(`({calls:window.channelSettingsProof.calls,errors:window.channelSettingsProof.errors,text:document.querySelector("${pane}").textContent})`)
    assert.deepEqual(facts.errors, []); assert.equal(facts.calls.filter(value => value==='secure-credential-write').length, 1)
    assert.equal(facts.text.includes('preview-masked-token'), false); assert.equal(facts.text.includes(expectedHelp), true)
    result.facts = facts; result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
