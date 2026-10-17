const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Actual SettingsPanel and production CSS with controlled typed device/application/original-request DTOs. No user App, device authorization, tenant sign-in, platform HTTP or Runtime claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 940, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    await until('window.conversationChannelsProof?.ready && document.querySelector("[data-settings-overview]")')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    async function capture(name) {
      await settle()
      const file = name + '.png'
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file)
    }
    async function navigate(id, narrow) {
      if (narrow) {
        await click('[aria-label="Settings section"]')
        await until('document.querySelector("[role=menu]")')
        await click('js:[...document.querySelectorAll("[role=menuitemradio]")].find(node=>node.getAttribute("data-state")!=="disabled"&&node.textContent.trim()===' + JSON.stringify(id === 'amux-conversation' ? 'Amux Conversation' : 'Lark') + ')')
      } else await click('nav [data-settings-target="' + id + '"]')
      await until('document.querySelector("[data-settings-pane=' + id + ']:not([hidden])")')
    }
    win.showInactive(); win.focus(); win.webContents.focus()
    await until('document.hasFocus()')
    await capture('overview-wide')
    for (const width of [1380, 520]) {
      win.setContentSize(width, 940); await until('innerWidth===' + width)
      const narrow = width === 520
      await navigate('amux-conversation', narrow)
      await until('window.conversationChannelsProof.calls.some(call=>call.method==="device.ls")')
      assert.equal(await read('window.conversationChannelsProof.calls.some(call=>call.method==="device.link")'), width !== 1380)
      if (width === 1380) await click('js:[...document.querySelectorAll("[data-settings-pane=amux-conversation] button")].find(node=>node.textContent.includes("Copy connection link"))')
      await capture('amux-' + (narrow ? 'narrow' : 'wide'))
      await navigate('lark', narrow)
      await until('document.querySelector("[data-connection=preview-bot]")')
      await capture('lark-' + (narrow ? 'narrow' : 'wide'))
      if (width === 1380) {
        await click('[data-enrollment-new]')
        await click('.connector-enrollment__history summary')
        await click('[data-enrollment-history="original-preview-setup"]')
        await until('document.querySelector("[data-enrollment-stage=unknown]")')
        await capture('lark-original-unknown')
        await click('[data-enrollment-inspect]')
        await until('window.conversationChannelsProof.calls.some(call=>call.method==="connection.enrollment.inspect")')
        await click('.connector-back')
      }
    }
    const facts = await read('({calls:window.conversationChannelsProof.calls,errors:window.conversationChannelsProof.errors})')
    assert.deepEqual(facts.errors, [])
    assert.equal(facts.calls.filter(call => call.method === 'device.link').length, 1)
    assert.equal(facts.calls.some(call => /(?:begin|advance|configure|revoke)$/u.test(call.method)), false, 'Navigation and original inspection create no new side effects')
    result.facts = facts; result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
