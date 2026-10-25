const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], boundary: 'Native production Workbench, saved-bot settings and group member controls with synthetic typed application access, exact creator/profile and operation leaves. No live grants, Host/SDK authorization or native effects are qualified.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 1100, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'application-access': '1' } })
    const { read, until, settle, click, press } = nativeRendererInput(win, result.interactions, '')
    const entry = '[data-workbench-region-id="channel-preview-region"] [data-channel-entry="feishu"]'
    const identity = JSON.stringify(['user_id', '567890123456789012'])
    const appRow = '[data-application-member-row=' + JSON.stringify(identity) + ']'
    const groupRow = '[data-member-row=' + JSON.stringify(identity) + ']'
    const exists = selector => '!!document.querySelector(' + JSON.stringify(selector) + ')'
    const named = (label, selector = '.agent-connector-dialog button') => 'js:[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(node=>node.textContent.trim()===' + JSON.stringify(label) + ')'
    async function showMembers() {
      const panel = '[data-connection-panel="members"]'
      if (!await read('document.querySelector(' + JSON.stringify(panel) + ')?.open')) await click(panel + ' > summary')
      if (!await read(exists(groupRow + ' select'))) await click(groupRow + ' [data-member-edit]')
    }
    const choices = selector => read('[...document.querySelectorAll(' + JSON.stringify(selector + ' input[type="checkbox"]') + ')].map(input=>({label:input.getAttribute("aria-label"),checked:input.checked,disabled:input.matches(":disabled")}))')
    const facts = () => read(`(() => {const selector='.settings-page:not([hidden]),.agent-connector-dialog,.connector-header-menu';return {
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},surfaces:[...document.querySelectorAll(selector)].map(node=>({className:node.className,rect:node.getBoundingClientRect().toJSON(),html:node.outerHTML})),
      applicationRows:[...document.querySelectorAll('[data-application-member-row]')].map(node=>({identity:node.dataset.applicationMemberRow,state:node.dataset.memberState,text:node.textContent})),
      memberRows:[...document.querySelectorAll('[data-member-row]')].map(node=>({identity:node.dataset.memberRow,state:node.dataset.memberState,text:node.textContent})),
      requests:window.channelEntryProof.requests,source:window.channelEntryProof.application.facts(),draft:window.channelEntryProof.draft(),errors:window.channelEntryProof.errors}})()`)
    async function openGroup() {
      await click(entry); await until(exists('.connector-header-menu__item'))
      await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
      await until(exists('[data-member-access]'))
    }
    async function capture(name, focus) {
      if (focus) { await read('document.querySelector(' + JSON.stringify(focus) + ')?.scrollIntoView({block:"start"})'); await settle() }
      const scene = await facts(); assert.equal(scene.draft, 'Keep this original research draft.'); assert.deepEqual(scene.errors, [])
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...scene })
    }
    await until('window.channelEntryProof?.application && ' + exists(entry))
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input","change"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await openGroup()
    await click(named('Connection details', '.agent-connector-dialog summary'))
    await click(named('Application settings')); await until(exists('[data-application-access-settings] > summary'))
    await click('[data-application-access-settings] > summary'); await until(exists(appRow + ' [data-application-member-save]'))
    assert.deepEqual((await choices(appRow)).map(item => item.checked), [true, true, true], 'The exact confirmed absent creator is a proposal, not a saved grant')
    assert.equal((await facts()).requests.filter(item => item.method === 'connection.application.access.configure').length, 0)
    await capture('application-member-wide-proposal', '[data-application-access-settings]')
    await click(appRow + ' [data-application-member-save]')
    await until('document.querySelector(' + JSON.stringify(appRow) + ')?.textContent.includes("Saved · all groups")')
    assert.equal((await facts()).requests.filter(item => item.method === 'connection.application.access.configure').length, 1, 'Only the explicit all-groups Save dispatches')
    win.setContentSize(520, 980); await until('innerWidth===520&&innerHeight===980')
    await capture('application-member-narrow-saved', '[data-application-access-settings]')
    await click('[aria-label="Close settings"]'); await until('!' + exists('[aria-label="Close settings"]'))
    win.setContentSize(1380, 1100); await until('innerWidth===1380&&innerHeight===1100')
    await openGroup(); await showMembers()
    await until(exists(groupRow + ' select'))
    if (await read('document.querySelector(' + JSON.stringify(groupRow + ' select') + ').value==="room"')) {
      result.retainedCreatorProposal = await facts()
      assert.ok(result.retainedCreatorProposal.source.groupDrafts, 'Opening the group before application settings retained its original creator proposal')
      await click(named('Discard changes', groupRow + ' button'))
      await showMembers()
    }
    await until('document.querySelector(' + JSON.stringify(groupRow + ' select') + ')?.value==="application"')
    assert.deepEqual((await choices(groupRow)).map(item => item.checked), [true, true, true])
    assert.ok((await choices(groupRow)).every(item => item.disabled), 'Inherited choices are observations, not an implicit group save')
    await capture('group-member-wide-inherited', '[data-member-access]')
    const beforeSelection = await read('window.__connectionsTrustedEvents.length')
    // The original closed select supports native type-ahead; its system popup
    // is outside WebContents input. Reach it with Tab without opening that popup.
    for (let step = 0; step < 160 && !await read('document.activeElement===document.querySelector(' + JSON.stringify(groupRow + ' select') + ')'); step++) await press('Tab')
    assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(groupRow + ' select') + ')'), true)
    for (const character of 'Only this group') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: character })
      win.webContents.sendInputEvent({ type: 'char', keyCode: character })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: character })
    }
    await until('document.querySelector(' + JSON.stringify(groupRow + ' select') + ')?.value==="room"')
    const selectionEvents = await read(`window.__connectionsTrustedEvents.slice(${beforeSelection})`)
    assert.ok(selectionEvents.some(event => event.type === 'change' && event.trusted), 'The original select changes through actual native input')
    result.interactions.push({ kind: 'native-select-group-source', events: selectionEvents })
    await click(groupRow + ' input[aria-label="Allow permission decisions for Ava Chen"]')
    await until(exists(groupRow + ' [data-member-save]'))
    const edited = await facts()
    assert.equal(edited.requests.filter(item => item.method === 'connection.grant' || item.method === 'connection.binding.member.inherit').length, 0, 'Selecting group-only access and editing remains an unsaved draft')
    win.setContentSize(520, 980); await until('innerWidth===520&&innerHeight===980'); await showMembers()
    await capture('group-member-narrow-local-draft', '[data-member-access]')
    await click('[aria-label="Close group setup"]'); await until('!' + exists('.agent-connector-dialog'))
    await openGroup(); await showMembers()
    assert.equal(await read('document.querySelector(' + JSON.stringify(groupRow + ' select') + ').value'), 'room')
    assert.deepEqual((await choices(groupRow)).map(item => item.checked), [true, true, false], 'The exact group draft survives reopening without changing the application rule')
    await click('[aria-label="Close group setup"]'); await until('!' + exists('.agent-connector-dialog'))
    await read('window.channelEntryProof.application.unavailable()')
    win.setContentSize(1380, 1100); await until('innerWidth===1380&&innerHeight===1100'); await click(entry)
    await until(exists('[data-problem-kind="access-unconfirmed"]'))
    await capture('group-member-access-check-unavailable')
    const final = await facts(), writes = final.requests.filter(item => /configure$|\.grant$|\.inherit$|\.bind$|\.create$/.test(item.method))
    assert.equal(writes.length, 1); assert.equal(writes[0].method, 'connection.application.access.configure')
    assert.deepEqual(writes[0].owner, { hostId: 'preview-bot-host', runtimeId: 'preview-original-runtime' })
    assert.deepEqual(final.source.grants[0].capabilities, ['input', 'answer', 'permission'])
    assert.equal(final.source.memberGrants.length, 0)
    assert.ok(final.requests.filter(item => item.method.startsWith('connection.application.access.')).every(item => item.owner?.runtimeId === 'preview-original-runtime'))
    await press('Escape')
    result.final = final; result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
