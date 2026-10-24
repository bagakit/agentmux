const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], consoleErrors: [], boundary: 'Actual SettingsPanel → ConnectionHostingSettings → ExternalConnectionsSettings, original bot/Mote controls and CSS. Native input with controlled public data only. No live credential, platform effect, IPC/SDK, owner transfer or installation qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', message => { if (message.level === 'error') result.consoleErrors.push({ message: message.message, source: message.sourceId, line: message.lineNumber }) })
    await win.loadFile(html)
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    let channel = 'lark'
    const pane = () => '[data-settings-pane="' + channel + '"]:not([hidden])'
    const action = (label, within = pane()) => 'js:[...document.querySelectorAll(' + JSON.stringify(within + ' button') + ')].find(node=>node.textContent.trim()===' + JSON.stringify(label) + ')'
    async function show(next, scenario, narrow) {
      channel = next
      win.setContentSize(narrow ? 520 : 1380, 980)
      await until('innerWidth===' + (narrow ? 520 : 1380))
      const key = await read('window.channelSettingsProof.show(' + JSON.stringify(channel) + ',' + JSON.stringify(scenario) + ')')
      await until('document.querySelector(' + JSON.stringify('[data-channel-settings-scene="' + key + '"]') + ')')
      await until('document.querySelector(' + JSON.stringify(pane() + ' .channel-settings') + ')')
      if (scenario === 'host-unavailable') await until('document.querySelector(' + JSON.stringify(pane() + ' [data-connection-hosting]') + ')?.textContent.includes("could not be reached")')
      else await until('document.querySelectorAll(' + JSON.stringify(pane() + ' .connector-library [data-connection]') + ').length===' + (scenario === 'normal' ? 3 : 0) + ' && !!document.querySelector(' + JSON.stringify(pane() + ' .connector-library') + ')')
      if (scenario === 'normal') await until('document.querySelector(' + JSON.stringify(pane() + ' [data-connection="' + (channel === 'lark' ? 'feishu' : 'discord') + '-complete"] [data-identity-motes]') + ')?.textContent.includes("new groups") && document.querySelector(' + JSON.stringify(pane() + ' [data-connection="' + (channel === 'lark' ? 'feishu' : 'discord') + '-complete"] [data-identity-motes]') + ')?.textContent.includes("private chat")')
      await settle()
    }
    async function capture(name) {
      await settle()
      const facts = await read(`(() => {const pane=document.querySelector(${JSON.stringify(pane())}),scroll=pane.closest('.settings-content__scroll');return {proof:window.channelSettingsProof.facts(),viewport:{width:innerWidth,height:innerHeight},pane:pane.outerHTML,rect:pane.getBoundingClientRect().toJSON(),scroll:scroll?{top:scroll.scrollTop,height:scroll.scrollHeight,visible:scroll.clientHeight}:null}})()`)
      assert.equal(facts.proof.draft, 'Keep this original conversation draft.')
      assert.deepEqual(facts.proof.errors, [])
      const file = name + '.png'
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...facts })
    }
    await until('window.channelSettingsProof?.ready')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await show('lark', 'normal', false)
    await capture('channel-settings-lark-normal-wide')
    // Open the exact same-name identity, then return using its original component action.
    await click(pane() + ' [data-connection="feishu-complete"] .connector-record__open')
    await until('document.querySelector(' + JSON.stringify(pane() + ' [data-connection-editor]') + ')')
    result.openedBot = await read('document.querySelector(' + JSON.stringify(pane() + ' [data-connection-editor]') + ').outerHTML')
    assert.match(result.openedBot, /cli_preview_application_0/)
    await click(action('Back to bots'))
    await until('document.querySelector(' + JSON.stringify(pane() + ' .connector-library') + ')')
    // Environment details only reveal the same original hosting target; no save or test action.
    await click(pane() + ' [data-connection-hosting] details > summary')
    result.hostingDisclosure = await read('document.querySelector(' + JSON.stringify(pane() + ' [data-connection-hosting]') + ').outerHTML')
    assert.match(result.hostingDisclosure, /preview-bot-host-runtime/)

    await show('lark', 'normal', true)
    await click(pane() + ' [data-mote-directory]')
    await until('document.querySelectorAll(' + JSON.stringify(pane() + ' [data-mote-identity]') + ').length===6')
    assert.equal(await read('document.querySelector(' + JSON.stringify(pane() + ' .connector-mote-directory') + ').textContent.includes("Another File path was returned")'), false)
    await capture('channel-settings-lark-motes-narrow')
    await click(pane() + ' [aria-label="View bot for Research companion"]')
    await until('document.querySelector(' + JSON.stringify(pane() + ' [data-connector-mote-detail]') + ')')
    result.openedMote = await read('document.querySelector(' + JSON.stringify(pane() + ' [data-connector-mote-detail]') + ').outerHTML')
    assert.match(result.openedMote, /Research companion/)
    await click(action('Back to Motes'))
    await until('document.querySelector(' + JSON.stringify(pane() + ' .connector-mote-directory') + ')')
    await click(action('Back to bots'))
    await until('document.querySelector(' + JSON.stringify(pane() + ' .connector-library') + ')')

    await show('discord', 'normal', false); await capture('channel-settings-discord-normal-wide')
    await show('discord', 'normal', true); await capture('channel-settings-discord-normal-narrow')
    await show('lark', 'empty', false); await capture('channel-settings-lark-empty-wide')
    await show('discord', 'empty', true); await capture('channel-settings-discord-empty-narrow')
    await show('lark', 'host-unavailable', false); await capture('channel-settings-lark-unavailable-wide')
    await show('discord', 'host-unavailable', true); await capture('channel-settings-discord-unavailable-narrow')
    result.facts = await read('window.channelSettingsProof.facts()')
    assert.deepEqual(result.facts.errors, [])
    assert.equal(result.facts.draft, 'Keep this original conversation draft.')
    const readMethods = new Set(['hosting-target', 'connection.owner.inspect', 'connection.service.get', 'connection.service.inspect', 'connection.ls', 'connection.inspect', 'connection.enrollment.ls', 'connection.setup.ls', 'connection.profile.ls', 'connection.metadata.ls', 'scratch.listTopics', 'scratch.readTopic', 'mote-preferences.read', 'space.mote.chat.inspect', 'space.mote.connection.ls'])
    assert.ok(result.facts.calls.length > 0)
    assert.deepEqual(result.facts.calls.filter(call => !readMethods.has(call.method)), [], 'Native visual actions make only the exact original reads, with zero platform or credential writes')
    assert.ok(result.facts.calls.some(call => call.method === 'mote-preferences.read' && call.owner?.runtimeId === 'preview-bot-host-runtime'))
    assert.ok(result.facts.calls.some(call => call.method === 'space.mote.chat.inspect' && call.owner?.runtimeId === 'preview-bot-host-runtime'))
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) { result.setup = await win.webContents.executeJavaScript('window.channelSettingsSetup ?? null'); fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
