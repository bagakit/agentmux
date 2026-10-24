const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], boundary: 'Actual original Workbench/header/AgentConnectorDialog and theme with synthetic typed saved Lark replies-only and Discord whole audiences. Native Review only edits a draft; no save, platform action, live data or public owner effect qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 1100, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'conversation-sharing': '1' } })
    const { read, until, settle, click, press } = nativeRendererInput(win, result.interactions, '')
    const entry = '[data-workbench-region-id="channel-preview-region"] [data-channel-entry="feishu"]'
    const exists = selector => '!!document.querySelector(' + JSON.stringify(selector) + ')'
    const named = label => 'js:[...document.querySelectorAll(".agent-connector-dialog button")].find(node=>node.textContent.trim()===' + JSON.stringify(label) + ')'
    const facts = () => read(`({viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},dialog:document.querySelector('.agent-connector-dialog')?.outerHTML,rect:document.querySelector('.agent-connector-dialog')?.getBoundingClientRect().toJSON(),partial:document.querySelector('[data-partial-sharing]')?.textContent,requests:window.channelEntryProof.requests,source:window.channelEntryProof.sharing.facts(),draft:window.channelEntryProof.draft(),errors:window.channelEntryProof.errors,audiences:[...document.querySelectorAll('[data-sharing-audience]')].map(node=>({identity:node.dataset.sharingAudience,text:node.textContent})),consent:[...document.querySelectorAll('[data-connection-section="sharing"] .agent-connector-check input')].map(node=>({checked:node.checked,disabled:node.disabled}))})`)
    const writes = scene => scene.requests.filter(item => /configure$|\.grant$|\.inherit$|\.bind$|\.relink$|\.create$|\.pause$|\.resume$/.test(item.method))
    async function size(width, height) { win.setContentSize(width, height); await until(`innerWidth===${width}&&innerHeight===${height}`); await settle() }
    async function capture(name, selector) {
      if (selector) { await read('document.querySelector(' + JSON.stringify(selector) + ')?.scrollIntoView({block:"start"})'); await settle() }
      const scene = await facts(); assert.equal(scene.draft, 'Keep this original research draft.'); assert.deepEqual(scene.errors, []); assert.equal(writes(scene).length, 0)
      assert.equal(scene.source.bindings.find(item => item.bindingId === 'preview-partial-lark').scope.publication, 'future-native-user-facing')
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push(file); result.scenes.push({ file, ...scene })
    }
    await until('window.channelEntryProof?.sharing && ' + exists(entry))
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input","change"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await click(entry); await until(exists('.connector-header-menu__item'))
    await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
    await until(exists('[data-partial-sharing]'))
    assert.match((await facts()).partial, /App and group user messages are not shared/)
    await capture('sharing-wide-partial-saved', '[data-partial-sharing]')
    await size(520, 980); await capture('sharing-narrow-partial-saved', '[data-partial-sharing]')
    await size(1380, 1100); await click(named('Review whole conversation'))
    await until(exists('[aria-label="Groups sharing this conversation"][open]'))
    const reviewed = await facts(); assert.deepEqual(reviewed.consent.map(input => input.checked), [false]); assert.deepEqual(reviewed.audiences.map(item => item.identity).sort(), ['preview-partial-lark', 'preview-whole-discord'])
    assert.match(reviewed.audiences.map(item => item.text).join('\n'), /Lark research bot/); assert.match(reviewed.audiences.map(item => item.text).join('\n'), /Discord project bot/)
    await capture('sharing-wide-whole-confirmation', '[data-connection-section="sharing"]')
    await size(520, 980); await capture('sharing-narrow-whole-confirmation', '[data-connection-section="sharing"]')
    await click('[aria-label="Close group setup"]'); await until('!' + exists('.agent-connector-dialog'))
    const final = await facts(); assert.equal(writes(final).length, 0); assert.equal(final.draft, 'Keep this original research draft.'); assert.deepEqual(final.errors, [])
    assert.ok(final.requests.every(item => !item.owner || item.owner.hostId === 'preview-bot-host' && item.owner.runtimeId === 'preview-original-runtime'))
    result.final = final; result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
