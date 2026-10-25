const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], references: [], scenes: [], interactions: [], boundary: 'Original AgentConnectorDialog, original providers and native controls, shared typed connection facts plus controlled original binding inspection. Native pointer/keyboard; real Workbench/IPC/Core/CLI behavior is independently tested. No installed App or live platform effect.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'header-status': '1', 'group-details': '1', 'connector-details-modern': '1', 'conversation-sharing': '1' } })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    await until('window.channelEntryProof?.dialogReady')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input","change"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    const button = label => 'js:[...document.querySelectorAll(".agent-connector-dialog button")].find(n=>n.textContent.trim()===' + JSON.stringify(label) + ')'
    const summary = label => 'js:[...document.querySelectorAll(".agent-connector-dialog summary")].find(n=>n.textContent.trim()===' + JSON.stringify(label) + ')'
    const resetScroll = async () => { await read('document.querySelector(".agent-connector-dialog__body").scrollTop=0'); await settle() }
    const dismiss = async () => { await click('[aria-label="Close group setup"]'); await until('!document.querySelector(".agent-connector-dialog")'); assert.equal(await read('document.activeElement?.id'), 'recovery-fixture-open') }
    async function open(state, theme, width) {
      await read('window.channelEntryProof.setTheme(' + JSON.stringify(theme) + ');window.channelEntryProof.setRecovery(' + JSON.stringify(state) + ')')
      win.setContentSize(width, 980); await until('innerWidth===' + width)
      await click('#recovery-fixture-open'); await until('document.querySelector("[data-binding-recovery]")?.dataset.state===' + JSON.stringify(state)); await settle()
    }
    async function capture(name, reference = false) {
      await settle()
      const scene = await read(`({viewport:{width:innerWidth,height:innerHeight},appearance:document.documentElement.dataset.appearance,dialog:document.querySelector('.agent-connector-dialog')?.outerHTML,rect:document.querySelector('.agent-connector-dialog')?.getBoundingClientRect().toJSON(),draft:window.channelEntryProof.draft(),recovery:window.channelEntryProof.recovery(),requests:window.channelEntryProof.requests,errors:window.channelEntryProof.errors,overflows:[...document.querySelectorAll('.agent-connector-dialog section,.agent-connector-dialog details,.agent-connector-dialog button')].filter(n=>n.checkVisibility()&&n.getBoundingClientRect().right>innerWidth+1).map(n=>n.outerHTML)})`)
      assert.equal(scene.draft, 'Keep this original research draft.'); assert.deepEqual(scene.errors, []); assert.deepEqual(scene.overflows, [])
      assert.deepEqual(scene.requests.filter(n => /configure|\.bind$|\.relink$|\.pause$|\.resume$|\.detach$|\.grant$|\.create$|\.retry$/.test(n.method)), [])
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      if (reference) result.references.push({ file }); else result.frames.push(file)
      result.scenes.push({ file, reference, ...scene })
    }

    await open('refused', 'dark', 1380); await resetScroll(); await capture('setup-refused-wide-dark')
    await click(button('Check status')); await until('document.querySelector(".agent-connector-dialog")?.getAttribute("aria-busy")!=="true"')
    await click(summary('Setup receipt details')); await capture('setup-refused-receipt-dark', true); await click(summary('Setup receipt details'))
    await click(summary('Bot and automatic sync')); await capture('setup-refused-bot-sync-dark', true); await click(summary('Bot and automatic sync'))
    await read('window.channelEntryProof.setTheme("light")'); win.setContentSize(390, 844); await until('innerWidth===390'); await resetScroll()
    await capture('setup-refused-narrow-light')
    await click(summary('Setup receipt details')); await click(summary('Bot and automatic sync'))
    await click(summary('Group information and members')); await capture('setup-refused-group-members-light', true)
    await click(summary('Connection details')); await capture('setup-refused-expanded-details-light', true)
    await read('document.querySelector(".agent-connector-dialog__body").scrollTop=document.querySelector(".agent-connector-dialog__body").scrollHeight'); await settle(); await capture('setup-refused-expanded-bottom-light', true)
    await resetScroll(); await capture('setup-refused-expanded-top-light', true)
    await click(summary('Connection details')); await click(summary('Group information and members'))
    await click(summary('Bot and automatic sync')); await click(summary('Setup receipt details'))
    await click(button('Review group selection')); await until('!document.querySelector("[data-binding-recovery]")')
    assert.equal(await read(`document.querySelector('[aria-label="Existing group ID"]')?.value`), 'preview-requested-group')
    assert.equal(await read('document.querySelector(".agent-connector-check input")?.checked'), false)
    assert.equal(await read('[...document.querySelectorAll(".agent-connector-dialog button")].find(n=>n.textContent.trim()==="Connect group")?.disabled'), true)
    await resetScroll(); await capture('setup-returned-selection-light'); await dismiss()
    await open('unknown', 'dark', 520)
    assert.equal(await read('[...document.querySelectorAll(".agent-connector-dialog button")].some(n=>["Review group selection","Continue setup"].includes(n.textContent.trim()))'), false)
    await click(button('Check status')); await until('document.querySelector(".agent-connector-dialog")?.getAttribute("aria-busy")!=="true"')
    await resetScroll(); await capture('setup-unknown-dark')
    assert.ok((await read('window.__connectionsTrustedEvents')).some(event => event.type === 'click' && event.trusted))
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
