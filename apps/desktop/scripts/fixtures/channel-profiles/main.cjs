const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Original public Core input and cached profile DTOs. Actual common card, speaker resolver, Channel hook, header and cache management with production CSS; controlled later native/cache observations, no live tenant.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    result.console = []
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.console.push(message) })
    await win.loadFile(html)
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    await until('window.channelProfilesProof?.ready && document.querySelector(".log-turn__sender")?.textContent === "Original native person"')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    async function capture(name) { await settle(); const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push(file) }
    await click('.channel-metadata summary'); await until('document.querySelector(".channel-metadata__identity strong")')
    await capture('profiles-wide')
    await read('window.channelProfilesProof.rename()'); await until('document.querySelector(".agent-region-header__connector")?.textContent.includes("Renamed original group")')
    win.setContentSize(360, 900); await until('innerWidth===360'); await capture('profiles-renamed-narrow')
    await read('window.channelProfilesProof.failNext=true')
    await click('.channel-metadata__actions button'); await until('document.querySelector(".channel-metadata__status")')
    await capture('profiles-busy-narrow')
    await until('document.querySelector(".channel-metadata__issue")'); await capture('profiles-failed-narrow')
    await click('.channel-metadata__actions button:last-child'); await until('document.querySelector(".channel-metadata__identity strong")?.textContent === "Profile not observed"')
    await capture('profiles-cleared-narrow')
    result.layout = await read('({width:innerWidth, content:document.documentElement.scrollWidth, originalCard:document.querySelector(".log-turn").getBoundingClientRect().toJSON()})')
    assert(result.layout.content <= result.layout.width, 'The original actor label must fit the narrow reading surface')
    result.facts = await read('({calls:window.channelProfilesProof.calls,errors:window.channelProfilesProof.errors})'); assert.deepEqual(result.facts.errors, [])
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) result.scene = await win.webContents.executeJavaScript('({text:document.body.innerText,ready:window.channelProfilesProof?.ready,errors:window.channelProfilesProof?.errors})').catch(failure => ({ message: failure.message })); process.exitCode = 1 }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); if (win && !win.isDestroyed()) win.destroy(); app.quit() }
}).catch(error => { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify({ passed: false, failure: { message: error.message } })); app.exit(1) })
