const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Actual SettingsPanel, registered Discord contribution, original editor and production CSS; controlled typed credential/config/check DTOs only. Real secure IPC/native SDK behavior is verified separately. No live token or platform permissions claimed.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const { read, until, settle, click, type } = nativeRendererInput(win, result.interactions, '')
    await until('window.discordSettingsProof?.ready && document.querySelector("[data-settings-pane=discord]:not([hidden]) [data-enrollment-existing]")')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    async function capture(name) { await settle(); const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push(file) }
    await capture('discord-library-wide')
    await click('[data-settings-pane=discord] [data-enrollment-existing]')
    await type('[data-settings-pane=discord] [aria-label="Connection app ID"]', '123456789012345678')
    await type('[data-settings-pane=discord] [aria-label="Connection app secret"]', 'preview-masked-token')
    assert.equal(await read('document.querySelector(' + JSON.stringify('[data-settings-pane=discord] [aria-label="Connection app secret"]') + ').type'), 'password')
    await capture('discord-credentials-wide')
    win.setContentSize(520, 980); await until('innerWidth===520'); await capture('discord-credentials-narrow')
    await click('[data-settings-pane=discord] [data-connection-save]')
    await until('document.querySelector("[data-settings-pane=discord] [data-connection-check]")')
    await click('[data-settings-pane=discord] [data-connection-check]')
    await until('document.querySelector("[data-settings-pane=discord] [data-connection-stage=authentication]")?.dataset.state==="ready"')
    await capture('discord-saved-narrow')
    win.setContentSize(1380, 980); await until('innerWidth===1380')
    await click('[data-settings-pane=discord] [data-discord-setup] summary')
    await capture('discord-guidance-wide')
    await click('[data-settings-pane=discord] [data-connection-check]')
    await until('document.querySelector("[data-settings-pane=discord] [data-connection-stage=authentication]")?.dataset.state==="unavailable"')
    await click('[data-settings-pane=discord] .connector-diagnostics summary')
    await capture('discord-check-failed-wide')
    const facts = await read('({calls:window.discordSettingsProof.calls,errors:window.discordSettingsProof.errors,text:document.querySelector("[data-settings-pane=discord]").textContent})')
    assert.deepEqual(facts.errors, []); assert.equal(facts.calls.filter(value => value==='secure-credential-write').length, 1)
    assert.equal(facts.text.includes('preview-masked-token'), false); assert.equal(facts.text.includes('Message Content Intent'), true)
    result.facts = facts; result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
