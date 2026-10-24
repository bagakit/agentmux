const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], boundary: 'Native input through the production Workbench header, original Dialog and Member access. Synthetic typed original Binding, grant and operation DTO leaves; no live account, permission, Host/CLI authorization or platform effects.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 1100, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'member-access': '1' } })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    const entry = '[data-workbench-region-id="channel-preview-region"] [data-channel-entry="feishu"]'
    const section = '[data-member-access]'
    const ids = { ava: '567890123456789012', ben: '678901234567890123', casey: '789012345678901234' }
    const row = name => section + ' [data-member-row=' + JSON.stringify(JSON.stringify(['user_id', ids[name]])) + ']'
    const choice = (name, label) => row(name) + ' input[aria-label=' + JSON.stringify(label) + ']'
    const exists = selector => '!!document.querySelector(' + JSON.stringify(selector) + ')'
    const named = (label, selector = '.agent-connector-dialog button') => 'js:[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(node=>node.textContent.trim()===' + JSON.stringify(label) + ')'
    const membersAction = 'js:[...document.querySelectorAll(' + JSON.stringify('[aria-label="Group connection sections"] button') + ')].find(node=>node.querySelector("span")?.textContent==="Members")'
    const memberFacts = () => read(`(() => {const s=document.querySelector(${JSON.stringify(section)}),dialog=document.querySelector('.agent-connector-dialog'),body=dialog?.querySelector('.agent-connector-dialog__body');return {
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},dialog:dialog?.getBoundingClientRect().toJSON(),body:body?{scrollTop:body.scrollTop,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight}:null,
      section:s?.outerHTML,rows:[...document.querySelectorAll(${JSON.stringify(section + ' [data-member-row]')})].map(node=>({identity:node.dataset.memberRow,state:node.dataset.memberState,rect:node.getBoundingClientRect().toJSON(),text:node.textContent,
        choices:[...node.querySelectorAll('input[type=checkbox]')].map(input=>({label:input.getAttribute('aria-label'),checked:input.checked})),actions:[...node.querySelectorAll('button')].map(button=>({label:button.textContent,disabled:button.disabled}))})),
      source:window.channelEntryProof.member.facts(),requests:window.channelEntryProof.requests,draft:window.channelEntryProof.draft(),errors:window.channelEntryProof.errors}})()`)
    async function open() {
      await click(entry); await until(exists('.connector-header-menu__item'))
      await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
      await until(exists(section + ' [data-member-row]'))
      await click(membersAction)
      await until('document.activeElement===document.querySelector(' + JSON.stringify(section) + ')'); await settle()
    }
    async function capture(name) {
      await settle(); const scene = await memberFacts()
      assert.equal(scene.rows.length, 3, 'Every exact account has one original row')
      assert.equal(new Set(scene.rows.map(item => item.identity)).size, 3)
      assert.equal(scene.draft, 'Keep this original research draft.')
      assert.deepEqual(scene.errors, [])
      assert.ok(scene.dialog.x >= 0 && scene.dialog.y >= 0 && scene.dialog.x + scene.dialog.width <= scene.viewport.width && scene.dialog.y + scene.dialog.height <= scene.viewport.height, 'The full original dialog stays in the real viewport')
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...scene })
    }
    await until('window.channelEntryProof?.ready && window.channelEntryProof.member && ' + exists(entry))
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await open()
    await until(`document.querySelector(${JSON.stringify(row('ava'))})?.dataset.memberState==="saved"&&document.querySelector(${JSON.stringify(row('ben'))})?.dataset.memberState==="pending"`)
    assert.equal(await read(exists(row('ava') + ' [data-member-save]')), false, 'An unchanged saved account offers no redundant save')
    await click(choice('casey', 'Send requests for Casey Iqbal'))
    await click(choice('ben', 'Send requests for Ben Ortiz'))
    await until(`document.querySelector(${JSON.stringify(row('casey'))})?.dataset.memberState==="dirty"`)
    const edited = await memberFacts()
    assert.equal(edited.requests.filter(item => item.method === 'connection.grant').length, 0, 'Editing local choices does not grant access')
    assert.equal(await read('[...document.querySelectorAll(".agent-connector-dialog button")].some(node=>node.textContent.trim()==="Continue setup")'), false, 'An original preparing member request is inspected rather than dispatched again')
    assert.equal(edited.rows.find(item => item.identity.includes(ids.casey)).choices.find(item => item.label.startsWith('Allow permission')).checked, false, 'Requests do not opt into permission decisions')
    await capture('member-access-wide-edits')
    win.setContentSize(520, 980); await until('innerWidth===520&&innerHeight===980'); await settle()
    await click(membersAction); await until('document.activeElement===document.querySelector(' + JSON.stringify(section) + ')')
    await capture('member-access-narrow-edits')
    await click('[aria-label="Close group setup"]'); await until('!document.querySelector(".agent-connector-dialog")')
    await open()
    assert.equal(await read('document.querySelector(' + JSON.stringify(choice('casey', 'Send requests for Casey Iqbal')) + ').checked'), true, 'Closing and reopening preserves the exact account edit')
    assert.equal(await read('window.channelEntryProof.requests.filter(item=>item.method==="connection.grant").length'), 0)
    // Only the original response leaf changes; checking, reviewing and saving still use native production controls.
    await read('window.channelEntryProof.member.refuseOriginal()')
    await click(row('ben') + ' [data-member-inspect]')
    await until(`document.querySelector(${JSON.stringify(row('ben'))})?.textContent.includes("earlier change was refused")`)
    win.setContentSize(1380, 1100); await until('innerWidth===1380&&innerHeight===1100'); await settle()
    await capture('member-access-wide-refused')
    await click(row('ben') + ' [data-member-review]')
    await until(exists(row('ben') + ' [data-member-save]'))
    await click(row('ben') + ' [data-member-save]')
    await until('window.channelEntryProof.requests.filter(item=>item.method==="connection.grant").length===1')
    await until(`document.querySelector(${JSON.stringify(row('ben'))})?.dataset.memberState==="saved"`)
    const corrected = await memberFacts(), saves = corrected.requests.filter(item => item.method === 'connection.grant')
    assert.equal(saves[0].input.actor.userId, ids.ben); assert.equal(saves[0].owner.runtimeId, 'preview-original-runtime')
    assert.notEqual(saves[0].input.operationId, 'preview-original-ben-pending', 'A conclusively refused request is not replayed')
    assert.equal(corrected.source.operations.find(item => item.operationId === 'preview-original-ben-pending').state, 'refused', 'The refused original result remains inspectable')
    assert.equal(corrected.source.grants.find(item => item.actor.userId === ids.ava).grantId, 'preview-original-ava-grant')
    assert.equal(corrected.rows.find(item => item.identity.includes(ids.casey)).state, 'dirty', 'Saving one person preserves another person’s edit')
    result.corrected = corrected
    await click(named('Pause sync'))
    await until('window.channelEntryProof.member.facts().bindings[0].state==="paused"')
    win.setContentSize(520, 980); await until('innerWidth===520&&innerHeight===980')
    await click(membersAction)
    await until(`document.querySelector(${JSON.stringify(section)})?.textContent.includes("Sharing is paused")`)
    await capture('member-access-narrow-paused')
    const final = await memberFacts()
    assert.equal(final.requests.filter(item => item.method === 'connection.grant').length, 1, 'Paused viewing causes no invalid grant or unknown replay')
    assert.equal(final.requests.filter(item => /\.create$|\.bind$|\.relink$|configure/.test(item.method)).length, 0, 'The preview creates no group, link, replacement or configuration')
    const originalReads = final.requests.filter(item => item.method === 'connection.binding.inspect')
    assert.ok(originalReads.some(item => item.input.operationId === 'preview-original-ben-pending'), 'The original uncertain operation is actually inspected')
    assert.ok(originalReads.every(item => item.owner?.hostId === 'preview-bot-host' && item.owner.runtimeId === 'preview-original-runtime'), 'Member reads keep the exact original hosting owner')
    assert.ok(final.requests.some(item => item.method === 'connection.room.members' && item.input.externalConversationId === '345678901234567890' && item.owner?.runtimeId === 'preview-original-runtime'), 'The exact original group member page is actually consumed')
    assert.ok(final.source.intents['preview-original-ben-pending'], 'Original request correlation is retained')
    assert.ok(Object.values(final.source.drafts).some(draft => Object.keys(draft.memberDrafts ?? {}).length > 0), 'An earlier revision edit is kept after pausing')
    result.final = final; result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
