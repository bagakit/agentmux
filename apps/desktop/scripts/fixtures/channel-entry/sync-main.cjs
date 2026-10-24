const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], refreshes: [], boundary: 'Original Workbench/SessionPane/Header/Composer, native pointer/keyboard and production CSS. Synthetic exact public binding/metadata/diagnosis and retained pending input; zero writes. No live Session/account, Host/SDK, installed App or IME qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'conversation-sync': '1' } })
    const { read, until, settle, click, press } = nativeRendererInput(win, result.interactions, '')
    const region = '[data-workbench-region-id="channel-preview-region"]'
    const editor = region + ' [data-agent-composer] [role="textbox"][aria-label="Message Agent"]'
    const menu = '.connector-header-menu'
    const trigger = adapter => region + ' [data-channel-entry="' + adapter + '"]'
    const exists = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
    const allowedReads = new Set(['connection.ls', 'connection.inspect', 'connection.service.get', 'connection.binding.ls', 'connection.metadata.get', 'connection.profile.get', 'connection.diagnose'])
    const facts = () => read('(() => {const r=' + exists(region) + ',e=' + exists(editor) + ',m=' + exists(menu) + ';const rect=n=>n?.getBoundingClientRect().toJSON();return {viewport:{width:innerWidth,height:innerHeight},region:rect(r),header:rect(r.querySelector(".agent-region-header")),entries:[...r.querySelectorAll("[data-channel-entry]")].map(n=>({adapter:n.dataset.channelEntry,label:n.getAttribute("aria-label"),rect:rect(n),glyph:rect(n.querySelector(":scope > :is(img,svg)"))})),menu:m?{rect:rect(m),label:m.getAttribute("aria-label"),groups:[...m.querySelectorAll(".connector-header-menu__item")].map(n=>({title:n.title,label:n.getAttribute("aria-label"),name:n.querySelector("strong")?.textContent,scope:n.querySelector("small")?.textContent,description:n.querySelector("small")?.title,rect:rect(n),inDetails:!!n.closest("details")})),directions:[...m.querySelectorAll("[data-direction]")].map(n=>({direction:n.dataset.direction,text:n.textContent}))}:null,noticeCount:r.querySelectorAll(".conversation-sharing-notice").length,editor:{text:e?.textContent,focused:document.activeElement===e,sameNode:!window.__syncEditor||window.__syncEditor===e,selection:e?.editor?.state.selection.toJSON()},composer:rect(r.querySelector("[data-agent-composer]")),pending:[...document.querySelectorAll(".composer-pending:not([hidden])")].map(n=>({id:n.dataset.operationId,rect:rect(n)})),source:window.channelEntryProof.conversationSync.facts(),draft:window.channelEntryProof.draft(),requests:window.channelEntryProof.requests,routes:window.channelEntryProof.routes,errors:window.channelEntryProof.errors}})()')
    function assertReadOnly(scene) {
      assert.deepEqual(scene.errors, []); assert.deepEqual(scene.routes, [])
      assert.deepEqual(scene.source.writes, [])
      assert.ok(scene.requests.length > 0)
      assert.deepEqual(scene.requests.filter(item => !allowedReads.has(item.method)), [])
      assert.ok(scene.requests.every(item => item.owner?.hostId === 'preview-bot-host' && item.owner.runtimeId === 'preview-original-runtime'))
      assert.equal(scene.noticeCount, 0)
      assert.equal(scene.draft, 'Keep this original research draft.')
      assert.equal(scene.editor.text, scene.draft)
      assert.equal(scene.source.pending.length, 1)
      assert.equal(scene.source.pending[0].operationId, 'preview-retained-input')
      assert.ok(scene.pending.some(p => p.id === 'preview-retained-input'))
      assert.ok(scene.pending.every(p => p.rect.bottom <= scene.composer.top + 1))
    }
    async function close() {
      if (!(await read(exists(menu)))) return
      // A hover disclosure does not own Terminal keyboard focus. Leave it with
      // the pointer; Escape is reserved for the explicitly focused menu below.
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 })
      if (await read('document.activeElement?.closest(".connector-header-menu") || document.activeElement?.matches("[data-channel-entry]")')) await press('Escape')
      await until('!' + exists(menu)); await settle()
    }
    async function prepareEditor() {
      await click(editor); win.webContents.selectAll()
      await until('getSelection().toString()==="Keep this original research draft."')
      const before = await read('window.__connectionsTrustedEvents.length')
      await win.webContents.insertText('Keep this original research draft.')
      await until('window.channelEntryProof.draft()==="Keep this original research draft."')
      const events = await read('window.__connectionsTrustedEvents.slice(' + before + ')')
      assert.ok(events.some(event => event.type === 'input' && event.trusted))
      win.webContents.selectAll()
      await until('getSelection().toString()==="Keep this original research draft."&&' + exists(editor) + '.editor.state.selection.anchor!==' + exists(editor) + '.editor.state.selection.head')
      await settle()
      await read('window.__syncEditor=' + exists(editor))
      const original = await facts()
      assert.notEqual(original.editor.selection.anchor, original.editor.selection.head)
      const count = original.requests.length
      await read('window.channelEntryProof.conversationSync.setScenario("normal")')
      await until('window.channelEntryProof.requests.length>' + count); await settle()
      const updated = await facts()
      assert.equal(updated.editor.focused, true); assert.equal(updated.editor.sameNode, true)
      assert.deepEqual(updated.editor.selection, original.editor.selection)
      assert.deepEqual(updated.source.session, original.source.session)
      assert.deepEqual(updated.source.pending, original.source.pending)
      assertReadOnly(updated)
      result.refreshes.push({ before: original, after: updated })
    }
    async function toggleView(mode) {
      await close()
      const previous = await facts()
      if (previous.source.view !== mode) {
        await click(region + ' .composer-tool--view-toggle')
        await until('window.channelEntryProof.conversationSync.facts().view===' + JSON.stringify(mode)); await settle()
      }
      const next = await facts()
      assert.equal(next.editor.sameNode, true)
      assert.deepEqual(next.editor.selection, previous.editor.selection)
      assert.deepEqual(next.source.session, previous.source.session)
      assert.deepEqual(next.source.pending, previous.source.pending)
      assertReadOnly(next)
    }
    async function capture(name, adapter, narrow) {
      await close()
      if ((await facts()).source.view === 'activity') {
        await until(exists(region) + '.textContent.includes("Please review the research notes and suggest the next step.")&&' + exists(region) + '.textContent.includes("The notes are ready to review. We can compare the open questions next.")')
      }
      const before = await facts(), target = await read(exists(trigger(adapter)) + '.getBoundingClientRect().toJSON()')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2) })
      await until(exists(menu))
      const index = adapter === 'feishu' ? 0 : 1
      await until('document.querySelector(".connector-header-menu__item strong")?.textContent===window.channelEntryProof.conversationSync.facts().names[' + index + ']')
      await settle()
      const scene = await facts(); assertReadOnly(scene)
      assert.deepEqual(scene.entries.map(e => e.adapter).sort(), ['discord', 'feishu'])
      assert.ok(scene.entries.every(e => e.label.startsWith('Conversation sync · ')))
      assert.deepEqual(scene.entries.map(e => e.rect), before.entries.map(e => e.rect))
      assert.ok(narrow ? scene.region.width >= 350 && scene.region.width < 450 : scene.region.width > 1000)
      assert.equal(scene.menu.groups.length, 1)
      assert.equal(scene.menu.groups[0].scope, adapter === 'feishu' ? 'Agent replies only' : 'Conversation messages')
      assert.equal(scene.menu.groups[0].inDetails, false)
      assert.equal(scene.menu.groups[0].name, scene.source.names[index])
      assert.ok(scene.menu.rect.left >= 0 && scene.menu.rect.right <= scene.viewport.width && scene.menu.rect.bottom <= scene.viewport.height)
      assert.ok(scene.menu.directions.some(d => d.direction === 'incoming') && scene.menu.directions.some(d => d.direction === 'outgoing'))
      const file = name + '.png'
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...scene })
      // Keyboard access uses the same original control and returns to that control.
      await close(); await click(trigger(adapter)); if (!(await read(exists(menu)))) await press('Down')
      await until(exists(menu))
      assert.equal(await read('!!document.activeElement?.closest(".connector-header-menu") || document.activeElement===' + exists(trigger(adapter))), true, 'Keyboard disclosure owns focus before Escape')
      await press('Escape'); await until('!' + exists(menu))
      assert.equal(await read('document.activeElement===' + exists(trigger(adapter))), true)
    }
    await until('window.channelEntryProof?.conversationSync&&' + exists(editor) + '&&' + exists(trigger('discord')))
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input","mousemove","focusin"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await prepareEditor()
    await toggleView('terminal')
    await capture('conversation-sync-wide-replies-terminal', 'feishu', false)
    await toggleView('activity')
    await capture('conversation-sync-wide-conversation-inapp', 'discord', false)
    await close()
    await read('window.__syncEditor=null;window.channelEntryProof.setLayout(true)')
    await until(exists(region) + '.getBoundingClientRect().width<450'); await settle()
    await prepareEditor()
    await capture('conversation-sync-narrow-replies-inapp', 'feishu', true)
    await toggleView('terminal')
    await capture('conversation-sync-narrow-conversation-terminal', 'discord', true)
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
