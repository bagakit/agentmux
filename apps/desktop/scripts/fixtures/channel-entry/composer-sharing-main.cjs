const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], updates: [], boundary: 'Original Workbench/SessionPane/AgentComposer and sharing notice; controlled exact public Lark/Discord binding, metadata and service DTOs. Native draft/caret/focus inspection and zero writes. No live Session, account, IPC/Host/SDK effect, installed App or IME qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'composer-sharing': '1' } })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    const region = '[data-workbench-region-id="channel-preview-region"]'
    const notice = region + ' .conversation-sharing-notice'
    const composer = region + ' [data-agent-composer]'
    const editor = composer + ' [role="textbox"][aria-label="Message Agent"]'
    const allowedReads = new Set(['connection.ls', 'connection.inspect', 'connection.service.get', 'connection.binding.ls', 'connection.metadata.get', 'connection.profile.get', 'connection.diagnose'])
    const facts = () => read(`(() => {
      const r=document.querySelector(${JSON.stringify(region)}),n=document.querySelector(${JSON.stringify(notice)}),c=document.querySelector(${JSON.stringify(composer)}),e=document.querySelector(${JSON.stringify(editor)}),s=getSelection();
      const offset=(node,value)=>{if(!e||!node||!e.contains(node))return null;const range=document.createRange();range.selectNodeContents(e);range.setEnd(node,value);return range.toString().length};
      return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},region:r?.getBoundingClientRect().toJSON(),notice:n?.getBoundingClientRect().toJSON(),composer:c?.getBoundingClientRect().toJSON(),
        noticeText:n?.textContent,noticeHTML:n?.outerHTML,editor:{text:e?.textContent,focused:document.activeElement===e,documentFocus:document.hasFocus(),sameNode:!window.__composerOriginalEditor||window.__composerOriginalEditor===e,selection:{anchor:offset(s?.anchorNode,s?.anchorOffset),focus:offset(s?.focusNode,s?.focusOffset),collapsed:s?.isCollapsed}},
        audiences:[...n?.querySelectorAll('.conversation-sharing-notice__audience')??[]].map(a=>({text:a.textContent,title:a.title,rect:a.getBoundingClientRect().toJSON(),statuses:[...a.querySelectorAll('.conversation-sharing-notice__status')].map(s=>({text:s.textContent,rect:s.getBoundingClientRect().toJSON()})),names:[...a.querySelectorAll('strong')].map(s=>({text:s.textContent,title:s.title,rect:s.getBoundingClientRect().toJSON(),clientWidth:s.clientWidth,scrollWidth:s.scrollWidth,overflow:getComputedStyle(s).textOverflow})),glyphs:[...a.querySelectorAll('img,svg')].map(g=>({rect:g.getBoundingClientRect().toJSON(),label:g.getAttribute('aria-label'),alt:g.getAttribute('alt')}))})),
        conversation:[...new Set([...r.querySelectorAll('[data-message-source-key]')].map(e=>e.dataset.messageSourceKey))],source:window.channelEntryProof.composerSharing.facts(),draft:window.channelEntryProof.draft(),requests:window.channelEntryProof.requests,routes:window.channelEntryProof.routes,errors:window.channelEntryProof.errors,events:window.__connectionsTrustedEvents};
    })()`)
    function assertReadOnly(scene) {
      assert.deepEqual(scene.errors, []); assert.deepEqual(scene.routes, []); assert.deepEqual(scene.source.writes, [])
      assert.ok(scene.requests.length > 0)
      assert.deepEqual(scene.requests.filter(item => !allowedReads.has(item.method)), [], 'Every observed connection call is explicitly a read')
      assert.ok(scene.requests.every(item => item.owner?.hostId === 'preview-bot-host' && item.owner.runtimeId === 'preview-original-runtime'), 'Every connection read keeps the exact original owner')
    }
    let expectedDraft = 'Keep this original research draft.'
    async function settledNames() {
      await until(`(() => {const p=window.channelEntryProof,n=document.querySelector(${JSON.stringify(notice)});return n&&n.getAttribute('aria-busy')!=='true'&&p.composerSharing.facts().names.every(name=>n.textContent.includes(name))})()`)
      await settle()
    }
    async function capture(name, narrow) {
      await settledNames()
      const scene = await facts(); assertReadOnly(scene)
      assert.equal(scene.draft, expectedDraft); assert.equal(scene.editor.text, expectedDraft)
      assert.ok(scene.source.conversationKeys.length === 2 && scene.source.conversationKeys.every(key => scene.conversation.includes(key)), 'The original conversation consumer has loaded both controlled records')
      assert.equal(scene.editor.focused, true); assert.equal(scene.editor.documentFocus, true)
      assert.equal(scene.audiences.length, 2)
      assert.ok(scene.audiences.every(a => a.glyphs.length === 1 && a.statuses.length <= 1), 'Each original audience has one small platform glyph and at most one subordinate status')
      assert.ok(scene.audiences.every(a => Math.abs(a.glyphs[0].rect.width - 12) < 0.01 && Math.abs(a.glyphs[0].rect.height - 12) < 0.01), 'Actual platform artwork remains 12 DIP at both widths')
      assert.ok(scene.audiences.every((a, index) => a.title.includes(scene.source.names[index])), 'The full original group name remains accessible when ellipsized')
      assert.ok(scene.notice.bottom <= scene.composer.top + 1, 'The notice stays above the original composer')
      assert.ok(scene.notice.left >= scene.region.left && scene.notice.right <= scene.region.right + 1)
      assert.ok(scene.composer.bottom <= scene.viewport.height, 'The entire input remains visible')
      if (narrow) {
        assert.ok(scene.region.width >= 350 && scene.region.width < 450, 'Narrow means a real split Region, not a CSS screenshot crop')
        assert.ok(scene.audiences.every(a => a.names.some(n => n.scrollWidth > n.clientWidth && n.overflow === 'ellipsis')), 'Long group names use actual constrained ellipsis')
      }
      else assert.ok(scene.region.width > 1000)
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...scene })
    }
    async function nativeInsert(value, expected) {
      const before = await read('window.__connectionsTrustedEvents.length')
      await win.webContents.insertText(value)
      await until(`window.channelEntryProof.draft()===${JSON.stringify(expected)}`)
      const events = await read(`window.__connectionsTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Native text insertion reaches the original editor')
      result.interactions.push({ kind: 'native-composer-insertText', value, expected, events })
      expectedDraft = expected
    }
    async function moveCaretLeft() {
      const before = await read('window.__connectionsTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
      await settle()
      const events = await read(`window.__connectionsTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'keydown' && event.key === 'ArrowLeft' && event.trusted))
      result.interactions.push({ kind: 'native-composer-caret-left', events })
    }
    async function updateOriginal(value) {
      await read(`window.__composerOriginalEditor=document.querySelector(${JSON.stringify(editor)})`)
      const before = await facts()
      await read(`window.channelEntryProof.composerSharing.setScenario(${JSON.stringify(value)})`)
      await until(`(() => {const f=window.channelEntryProof.composerSharing.facts();return f.reads.filter(r=>r.scenario===${JSON.stringify(value)}&&r.kind==='metadata').length>=2&&f.service.some(s=>s.currentSource&&!s.state?.adapterId&&${value === 'unavailable' ? '!!s.issue' : 's.state?.enabled===false&&!s.issue'})})()`)
      await settledNames()
      const after = await facts()
      assert.equal(after.editor.sameNode, true); assert.equal(after.editor.focused, true)
      assert.deepEqual(after.editor.selection, before.editor.selection, 'Notice updates preserve the exact caret')
      assert.equal(after.draft, before.draft); assertReadOnly(after)
      result.updates.push({ scenario: value, before, after })
    }
    await until(`window.channelEntryProof?.composerSharing&&!!document.querySelector(${JSON.stringify(editor)})`)
    await until(`(() => {const keys=[...document.querySelectorAll(${JSON.stringify(region + ' [data-message-source-key]')})].map(e=>e.dataset.messageSourceKey);return window.channelEntryProof.composerSharing.facts().conversationKeys.every(key=>keys.includes(key))})()`, 'Original conversation public read projects both controlled records')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input","focusin"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    await settledNames()
    await until('window.channelEntryProof.composerSharing.facts().service.some(s=>s.currentSource&&!s.state?.adapterId&&s.state?.enabled===true&&!s.issue)')
    await click(editor); win.webContents.selectAll()
    await until(`getSelection().toString()===${JSON.stringify(expectedDraft)}`)
    await nativeInsert(expectedDraft, expectedDraft)
    await capture('composer-sharing-wide-normal', false)
    assert.ok(result.scenes[0].audiences.every(a => a.statuses.length === 0), 'Observed normal service has no persistent warning line')
    await read('window.channelEntryProof.setLayout(true)'); await settledNames(); await click(editor)
    // Split layout can remount the pane; establish a native caret before testing notice-only changes.
    win.webContents.selectAll(); await until(`getSelection().toString()===${JSON.stringify(expectedDraft)}`)
    await nativeInsert(expectedDraft, expectedDraft); await moveCaretLeft()
    assert.equal((await facts()).editor.selection.anchor, expectedDraft.length - 1)
    await capture('composer-sharing-narrow-normal', true)
    await updateOriginal('unavailable')
    await nativeInsert(' for review', expectedDraft.slice(0, -1) + ' for review.')
    await capture('composer-sharing-narrow-cached-unavailable', true)
    assert.ok(result.scenes[2].source.service.some(s => !s.state?.adapterId && s.state?.enabled === true && s.issue), 'A failed read retains its old policy without confirming current health')
    await updateOriginal('paused-off')
    await nativeInsert(' tomorrow', expectedDraft.slice(0, -1) + ' tomorrow.')
    await capture('composer-sharing-narrow-paused-off', true)
    const final = await facts(); assertReadOnly(final)
    assert.deepEqual(final.source.bindings.map(b => ({ id: b.bindingId, state: b.state, revision: b.revision, publication: b.scope.publication })), [
      { id: 'preview-partial-lark', state: 'paused', revision: 2, publication: 'future-native-user-facing' },
      { id: 'preview-whole-discord', state: 'active', revision: 1, publication: 'future-shared-conversation' }
    ])
    assert.ok(final.audiences.every(a => a.statuses.length === 1))
    result.final = final; result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.failure.renderer = await win.webContents.executeJavaScript('({text:document.body.innerText,source:window.channelEntryProof?.composerSharing?.facts(),errors:window.channelEntryProof?.errors})').catch(() => null)
      fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
