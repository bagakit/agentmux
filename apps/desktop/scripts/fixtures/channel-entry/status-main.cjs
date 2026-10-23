const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], boundary: 'Actual production Workbench, split Regions, channel contributions, header/menu and CSS; controlled safe public connection and diagnosis DTOs. Native pointer/keyboard input operates the original components. No IPC/SDK, live account, delivery, installed App or healthy-Agent qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'header-status': '1' } })
    const { read, until, settle, click, press } = nativeRendererInput(win, result.interactions, '')
    const region = '[data-workbench-region-id="channel-preview-region"]'
    const entry = adapter => region + ' [data-channel-entry="' + adapter + '"]'
    const menu = '.connector-header-menu'
    const exists = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
    const action = (label, selector = '.connector-header-menu [role="menuitem"]') => 'js:[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(node=>node.textContent.trim()===' + JSON.stringify(label) + ')'
    const facts = () => read(`(() => {const region=document.querySelector(${JSON.stringify(region)}),menu=document.querySelector(${JSON.stringify(menu)});return {
      viewport:{width:innerWidth,height:innerHeight},region:region?.getBoundingClientRect().toJSON(),regionCount:document.querySelectorAll('[data-workbench-region-id]').length,
      entries:[...region.querySelectorAll('[data-channel-entry]')].map(node=>({adapter:node.dataset.channelEntry,state:node.dataset.channelState,label:node.getAttribute('aria-label'),title:node.title,html:node.outerHTML})),
      header:region.querySelector('.agent-region-header')?.outerHTML,menu:menu?.outerHTML??null,draft:window.channelEntryProof.draft(),
      focus:document.activeElement?.outerHTML,calls:[...window.channelEntryProof.calls]}})()`)
    async function close() {
      if (await read(exists(menu))) { await press('Escape'); await until('!document.querySelector(' + JSON.stringify(menu) + ')') }
    }
    async function layout(narrow) {
      await close(); await read('window.channelEntryProof.setLayout(' + narrow + ')')
      await until(`(() => {const r=document.querySelector(${JSON.stringify(region)})?.getBoundingClientRect();return r&&${narrow ? 'r.width>=350&&r.width<=520' : 'r.width>900'}})()`)
      await settle()
    }
    async function state(expected) {
      await until(`(() => {const entries=[...document.querySelectorAll(${JSON.stringify(region + ' [data-channel-entry]')})];return entries.length===2&&entries.every(node=>node.dataset.channelState===${JSON.stringify(expected)})})()`)
    }
    async function open(adapter) { await click(entry(adapter)); await until(exists(menu)); await settle() }
    async function capture(name) {
      await settle()
      const scene = await facts()
      assert.equal(scene.draft, 'Keep this original research draft.')
      assert.deepEqual(scene.entries.map(item => item.adapter).sort(), ['discord', 'feishu'])
      assert.ok(scene.entries.every(item => item.label && item.title), 'Both original contribution entries expose accessible state summaries')
      if (scene.menu) assert.equal(await read(`(() => {const m=document.querySelector(${JSON.stringify(menu)}),r=m.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`), true, 'Original portal panel stays inside the viewport')
      const file = name + '.png'
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...scene })
    }
    await until('window.channelEntryProof?.ready && document.querySelector(' + JSON.stringify(entry('discord')) + ')')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await state('unbound')
    // Both contributions are actually opened; Escape returns focus to the exact original trigger.
    await open('feishu'); result.unboundPanel = await facts(); await close()
    assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry('feishu')) + ')'), true)
    await press('Down'); await until(exists(menu)); await close()
    await capture('header-unbound-wide-closed')
    await layout(true); await state('unbound'); await open('discord')
    await capture('header-unbound-narrow-open')

    await layout(false); await read('window.channelEntryProof.setScenario("owner-failure")'); await state('unknown'); await open('feishu')
    await until('document.querySelector(".connector-header-menu__issue")')
    await capture('header-owner-failure-wide')
    const beforeHostingReads = await read('window.channelEntryProof.hostingReads')
    await click(action('Check bot hosting'))
    await until(exists('[role="dialog"] button[aria-label="Close group setup"]') + ' && [...document.querySelectorAll("[role=dialog] button")].some(node=>node.textContent.trim()==="Check bot hosting")')
    result.hostingRecovery = await read('({dialog:document.querySelector("[role=dialog]").outerHTML,hostingReads:window.channelEntryProof.hostingReads,draft:window.channelEntryProof.draft()})')
    assert.ok(result.hostingRecovery.hostingReads > beforeHostingReads, 'Check bot hosting reaches the original dialog owner-discovery read')
    assert.match(result.hostingRecovery.dialog, /Lark connections/)
    await click('[aria-label="Close group setup"]'); await until('!document.querySelector("[role=dialog]")')
    assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry('feishu')) + ')'), true, 'Original hosting recovery dialog returns focus to its exact channel')
    await open('feishu'); await click(action('Channel settings'))
    const section = await read('window.channelEntryProof.channelSections.feishu')
    await until(exists('[data-settings-pane="' + section + '"]:not([hidden])'))
    result.channelSettingsRecovery = await read('({routes:window.channelEntryProof.routes,pane:document.querySelector(' + JSON.stringify('[data-settings-pane="' + section + '"]:not([hidden])') + ').outerHTML})')
    assert.equal(result.channelSettingsRecovery.routes.at(-1), section, 'Channel settings opens the actual selected contribution section')
    await click('[aria-label="Close settings"]'); await until('!' + exists('[aria-label="Close settings"]'))
    await layout(true); await state('unknown'); await open('feishu')
    await capture('header-owner-failure-narrow')

    await layout(false); await read('window.channelEntryProof.setScenario("attention")')
    await until('document.querySelector(' + JSON.stringify(entry('discord')) + ')?.dataset.channelState==="attention"')
    await open('discord'); await until('document.querySelectorAll(".connector-header-menu__group").length===2')
    await capture('header-attention-wide')
    await layout(true)
    await until('document.querySelector(' + JSON.stringify(entry('discord')) + ')?.dataset.channelState==="attention"')
    await open('discord'); await until('document.querySelectorAll(".connector-header-menu__group").length===2')
    await capture('header-attention-narrow')
    // Long diagnostic rows remain available on demand rather than becoming header chrome.
    await click('.connector-header-menu__diagnostics summary')
    result.expandedDetails = await facts(); await close()
    result.facts = await read('({calls:window.channelEntryProof.calls,targets:window.channelEntryProof.targets,errors:window.channelEntryProof.errors,draft:window.channelEntryProof.draft(),trusted:window.__connectionsTrustedEvents})')
    assert.deepEqual(result.facts.errors, [])
    assert.equal(result.facts.calls.some(method => /configure|\.bind$|\.relink$|\.pause$|\.grant$|\.create$|\.retry$/.test(method)), false, 'Opening and checking captures cause no writes, grants, sends or unknown replay')
    assert.ok(result.facts.calls.includes('connection.diagnose'), 'Bound original groups use the original diagnosis consumer')
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
