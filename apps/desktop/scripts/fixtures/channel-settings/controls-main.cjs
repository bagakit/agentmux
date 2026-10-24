const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], consoleErrors: [], boundary: 'Actual SettingsPanel, App display draft/save and original scoped automatic-message control with native input. Config and public Host leaves are controlled. No live platform, credential write, real IPC/SDK, installation or transfer qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', message => { if (message.level === 'error') result.consoleErrors.push({ message: message.message, source: message.sourceId, line: message.lineNumber }) })
    await win.loadFile(html, { query: { mode: 'platform-controls' } })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    let channel = 'lark'
    const pane = () => '[data-settings-pane="' + channel + '"]:not([hidden])'
    const platform = () => channel === 'lark' ? 'feishu' : 'discord'
    const title = () => channel === 'lark' ? 'Lark' : 'Discord'
    const display = () => pane() + ' .channel-header-control input'
    const service = () => pane() + ' [data-adapter-service="' + platform() + '"]'
    const displaySave = () => 'js:[...document.querySelectorAll(' + JSON.stringify(pane() + ' .channel-header-control button') + ')].find(node=>node.textContent.trim()==="Save display")'
    async function show(next, scenario, narrow) {
      channel = next
      win.setContentSize(narrow ? 520 : 1380, 980)
      await until('innerWidth===' + (narrow ? 520 : 1380))
      const key = await read('window.channelSettingsProof.show(' + JSON.stringify(channel) + ',' + JSON.stringify(scenario) + ')')
      await until('document.querySelector(' + JSON.stringify('[data-channel-settings-scene="' + key + '"]') + ')')
      await until('document.querySelectorAll(' + JSON.stringify(pane() + ' .connector-library [data-connection]') + ').length===3')
      await until('document.querySelector(' + JSON.stringify(service() + ' [data-connector-service-state]') + ')?.dataset.connectorServiceState===' + JSON.stringify(scenario === 'service-unavailable' ? 'unconfirmed' : 'on'))
      assert.equal(await read('document.querySelector(' + JSON.stringify(display()) + ').checked'), true)
      await settle()
    }
    async function capture(name) {
      await settle()
      const facts = await read(`(() => {const pane=document.querySelector(${JSON.stringify(pane())}),scroll=pane.closest('.settings-content__scroll');return {proof:window.channelSettingsProof.facts(),viewport:{width:innerWidth,height:innerHeight},pane:pane.outerHTML,displayChecked:pane.querySelector('.channel-header-control input').checked,automaticState:pane.querySelector('[data-adapter-service] [data-connector-service-state]').dataset.connectorServiceState,scroll:scroll?{top:scroll.scrollTop,height:scroll.scrollHeight,visible:scroll.clientHeight}:null}})()`)
      assert.equal(facts.proof.draft, 'Keep this original conversation draft.'); assert.deepEqual(facts.proof.errors, [])
      const file = name + '.png'
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...facts })
    }
    await until('window.channelSettingsProof?.ready')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')

    await show('lark', 'normal', false)
    await click(display()); await click(displaySave())
    await until('window.channelSettingsProof.facts().display.feishu===false')
    assert.equal(await read('document.querySelector(' + JSON.stringify(service() + ' [data-connector-service-state]') + ').dataset.connectorServiceState'), 'on')
    assert.equal(await read('window.channelSettingsProof.facts().calls.filter(c=>c.method==="connection.service.configure").length'), 0)
    await capture('platform-controls-lark-display-hidden-wide')

    await show('lark', 'normal', true)
    await click(service() + ' [aria-label="Enable ' + title() + ' automatic messages"]')
    await click(service() + ' [data-connector-service-save]')
    await until('document.querySelector(' + JSON.stringify(service() + ' [data-connector-service-state]') + ').dataset.connectorServiceState==="off"')
    assert.equal(await read('document.querySelector(' + JSON.stringify(display()) + ').checked'), true)
    await capture('platform-controls-lark-automatic-off-narrow')

    await show('discord', 'service-unavailable', false)
    await click(display()); await click(displaySave())
    await until('window.channelSettingsProof.facts().display.discord===false')
    await capture('platform-controls-discord-unknown-wide')

    await show('discord', 'service-unavailable', true)
    await click(pane() + ' .channel-environment__global > summary')
    await capture('platform-controls-discord-unknown-narrow')
    result.facts = await read('window.channelSettingsProof.facts()')
    const allowed = new Set(['hosting-target', 'app-display-save', 'connection.owner.inspect', 'connection.service.get', 'connection.service.inspect', 'connection.service.configure', 'connection.ls', 'connection.inspect', 'connection.enrollment.ls', 'connection.setup.ls', 'connection.profile.ls', 'connection.metadata.ls', 'scratch.listTopics', 'scratch.readTopic', 'mote-preferences.read', 'space.mote.chat.inspect', 'space.mote.connection.ls'])
    assert.deepEqual(result.facts.calls.filter(call => !allowed.has(call.method)), [])
    const writes = result.facts.calls.filter(call => call.method === 'connection.service.configure')
    assert.equal(writes.length, 1); assert.equal(writes[0].input.adapterId, 'feishu'); assert.equal(writes[0].input.service.enabled, false)
    assert.deepEqual(writes[0].owner, { hostId: 'local', runtimeId: 'preview-bot-host-runtime' })
    assert.equal(result.facts.calls.filter(call => call.method === 'app-display-save').length, 2)
    assert.deepEqual(result.consoleErrors, []); assert.deepEqual(result.facts.errors, [])
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) { result.setup = await win.webContents.executeJavaScript('window.channelSettingsSetup ?? null'); fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  } finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
