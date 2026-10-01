const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, phase, frames: [], userRunTouched: false,
  boundary: 'Complete production App and real ordinary durable initialization; controlled public Session/API facts only. No Native Browser, Core/ctxmux or actual CLI survival claim.' }
app.on('window-all-closed', () => { result.unexpectedWindowClosure = { step: result.step }; result.passed = false })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
const bounded = async (work, label, budget = 12000) => {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Private close proof timeout: ' + label)), budget) })]) }
  finally { clearTimeout(timer) }
}
app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write('Renderer: ' + message + '\n') })
    result.step = 'load-complete-production-App'
    await bounded(win.loadFile(html, { query: { phase } }), result.step)
    const read = expression => bounded(win.webContents.executeJavaScript(expression), 'Renderer observation')
    const until = async expression => {
      const deadline = Date.now() + 10000
      do { if (await read(expression)) return; await pause(25) } while (Date.now() < deadline)
      throw new Error('Private close proof did not settle: ' + expression)
    }
    const facts = () => read('window.closedTabProof.facts()')
    await until('window.closedTabProof?.ready && !!document.querySelector("[data-pmo-teams-topic-launcher] button")')
    win.showInactive(); win.webContents.debugger.attach('1.3')
    const input = (method, params) => bounded(win.webContents.debugger.sendCommand(method, params), 'Original Renderer input')
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const panel = 'document.getElementById("pmo-teams-topic-floating-panel")'
    const entry = 'document.querySelector("[data-pmo-teams-topic-launcher] button")'
    const click = async (expression, button = 'left') => {
      const point = await read('(()=>{const e=' + expression + ';if(!e)throw new Error(' + JSON.stringify('Missing real control: ' + expression) + ');const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)throw new Error("Empty real control");return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 })
    }
    const capture = async name => {
      if (process.env.MOTE_CLOSED_TAB_AFFECTED_EMPTY_ONLY === '1' && !name.includes('empty')) return
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const file = phase + '-' + name + '.png'
      const png = (await bounded(win.webContents.capturePage(), 'Renderer capture')).toPNG()
      await fs.writeFile(path.join(evidence, file), png)
      result.frames.push({ name, file, sha256: createHash('sha256').update(png).digest('hex'), source: 'original-renderer-no-native-browser-claim' })
    }
    const visible = async (topic, tab) => {
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.moteTargetTopic===' + JSON.stringify(topic) + ' && (' + panel + '.dataset.moteTargetTab??null)===' + JSON.stringify(tab))
      const current = await facts()
      assert.equal(current.floating.targetTopicId, topic); assert.equal(current.floating.targetTabId, tab)
      assert.ok(current.ui.visible)
      return current
    }
    const choose = async (topic, tab) => {
      await click(panel + '.querySelector(' + JSON.stringify('[data-mote-topic-id="' + topic + '"]') + ')')
      return visible(topic, tab)
    }
    const keepClose = async id => {
      assert.ok((await facts()).tabs[id], 'Real nonempty original Tab exists before closing')
      const navigation = panel + '.querySelector(' + JSON.stringify('.mote-navigation-toggle') + ')'
      if (await read(navigation + '?.getAttribute("aria-expanded")==="false"')) await click(navigation)
      await click(panel + '.querySelector(' + JSON.stringify('button[data-workbench-tab-id="' + id + '"] .workbench-tab__close') + ')')
      await until('[...document.querySelectorAll("[role=dialog] button")].some(e=>e.textContent==="Keep Session & Close")')
      await click('[...document.querySelectorAll("[role=dialog] button")].find(e=>e.textContent==="Keep Session & Close")')
      await until('!window.closedTabProof.facts().tabs[' + JSON.stringify(id) + ']')
      assert.equal(await read(panel + '?.matches(":popover-open")'), true,
        'Trusted Keep & Close retains its original native auto-popover without reopening')
    }
    const forbidden = current => current.calls.filter(call => ['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt'].includes(call.operation))
    result.initial = await facts()
    assert.equal(result.initial.initialization.initializeCalls, 1)
    if (phase === 'seed') {
      assert.equal(result.initial.initialization.seedApplied, true)
      assert.deepEqual(Object.keys(result.initial.tabs).sort(), ['custom-mote-tab', 'mote-neighbor-tab', 'mote-primary-tab', 'original-project-tab'])
      await visible('launcher:leader', 'mote-primary-tab')
      if (process.env.MOTE_CLOSED_TAB_OVERLAY_ACTIONS === '1') {
        result.step = 'trusted-ordinary-window-dialog-after-Mote-navigation'
        await choose('launcher:reviewer', 'custom-mote-tab')
        await choose('launcher:leader', 'mote-primary-tab')
        await click(panel + '.querySelector(' + JSON.stringify('[aria-label="Close Mote"]') + ')')
        await until('!' + panel + '.matches(":popover-open")')
        result.initialFooterHit = await read(`(()=>{const e=${entry},r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{width:r.width,height:r.height,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:!!h&&(h===e||e.contains(h)),hostDisplay:getComputedStyle(document.querySelector('[data-overlay-host="interaction"]')).display}})()`)
        assert.equal(result.initialFooterHit.hit, true); assert.equal(result.initialFooterHit.inside, true); assert.equal(result.initialFooterHit.hostDisplay, 'none')
        await click('document.querySelector(' + JSON.stringify('button[data-workbench-tab-id="original-project-tab"] .workbench-tab__close') + ')')
        await pause(100)
        result.ordinaryOpening = await read(`(()=>{const d=document.querySelector('.confirmation-dialog'),h=document.querySelector('[data-overlay-host="interaction"]');return{dialog:!!d,active:document.activeElement?.outerHTML,hostParent:h?.parentElement?.id,hostOpen:h?.matches(':popover-open'),floatOpen:${panel}.matches(':popover-open'),dialogRect:d?JSON.stringify(d.getBoundingClientRect()):null}})()`)
        await until('document.querySelector(".confirmation-dialog") && document.activeElement?.textContent==="Cancel"')
        result.ordinaryConfirmation = await read(`(()=>{const d=document.querySelector('.confirmation-dialog'),h=d.closest('[popover]'),r=d.getBoundingClientRect();return{hostOpen:h.matches(':popover-open'),rootParent:h.parentElement===document.getElementById('agentmux-window-overlay-host'),floatOpen:${panel}.matches(':popover-open'),hit:d.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}})()`)
        assert.deepEqual(result.ordinaryConfirmation, { hostOpen: true, rootParent: true, floatOpen: false, hit: true, inside: true })
        await capture('trusted-ordinary-window-confirmation')
        await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
        await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
        await until('!document.querySelector(".confirmation-dialog")')
        assert.equal(await read(panel + '.matches(":popover-open")'), false, 'Ordinary Dialog never reopens the closed Mote')
        assert.deepEqual((await facts()).tabs, result.initial.tabs)
        result.afterOrdinaryFooterHit = await read(`(()=>{const e=${entry},r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{hit:!!h&&(h===e||e.contains(h)),hostDisplay:getComputedStyle(document.querySelector('[data-overlay-host="interaction"]')).display}})()`)
        assert.deepEqual(result.afterOrdinaryFooterHit, { hit: true, hostDisplay: 'none' })
        // A bounded generic protocol case keeps closing DOM present, including a
        // nested listbox. No runtime or Mote identity is simulated by this node.
        result.retainedClosingSurfaces = []
        for (const role of ['dialog', 'menu']) {
          await read(`(()=>{const e=document.createElement('div');e.id='retained-closing-protocol';e.role=${JSON.stringify(role)};e.dataset.state='closed';e.style.cssText='position:fixed;inset:0;animation:retained-protocol-exit 1s';const child=document.createElement('div');child.role='listbox';e.append(child);document.querySelector('[data-overlay-host="interaction"]').append(e)})()`)
          await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
          const closed = await read(`(()=>{const e=document.getElementById('retained-closing-protocol'),h=e.parentElement,f=${entry},r=f.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{hostOpen:h.matches(':popover-open'),hostDisplay:getComputedStyle(h).display,surfaceDisplay:getComputedStyle(e).display,surfaceWidth:e.getBoundingClientRect().width,footerHit:!!hit&&(hit===f||f.contains(hit))}})()`)
          assert.deepEqual(closed, { hostOpen: false, hostDisplay: 'none', surfaceDisplay: 'none', surfaceWidth: 0, footerHit: true })
          result.retainedClosingSurfaces.push({ role, ...closed })
          await read('document.getElementById("retained-closing-protocol").remove()')
        }
        await click(entry)
        await visible('launcher:leader', 'mote-primary-tab')
        const beforeConfirmation = await facts()
        assert.deepEqual(beforeConfirmation.viewModes, { ...result.initial.viewModes, 'mote-primary': 'activity' }, 'An explicit reopen selects conversation only for that original Mote Session')
        result.step = 'trusted-window-confirmation-cancel-and-object-menu-dialog'
        const navigation = panel + '.querySelector(' + JSON.stringify('.mote-navigation-toggle') + ')'
        await until(panel + '.querySelector("[data-message-id=private-mote-reply] [data-mote-author]")')
        const chatQualification = () => read(`(()=>{const p=${panel},w=p.querySelector('[data-mote-workface]'),feed=p.querySelector('.activity-feed[data-mote-conversation="true"]'),own=feed?.querySelector('[data-message-id="private-mote-reply"]'),unknown=feed?.querySelector('[data-message-id="private-unknown-reply"]'),avatar=own?.querySelector('[data-mote-author] .space-object-icon'),originalAvatar=p.querySelector('[data-mote-topic-id="launcher:leader"] .space-object-icon__avatar'),group=p.querySelector('[data-pane-group-id]'),name=own?.querySelector('.log-turn__who'),rect=e=>e?JSON.parse(JSON.stringify(e.getBoundingClientRect())):null,hit=e=>{if(!e)return false;const b=e.getBoundingClientRect(),h=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return !!h&&!!own?.contains(h)},r=feed?.getBoundingClientRect();return{geometry:{narrow:group?.dataset.moteNavigationNarrow,open:group?.dataset.moteNavigationOpen,pane:rect(group?.querySelector('.pane-content')),navigation:rect(group?.querySelector('.mote-conversations')),body:rect(group?.querySelector('.pane-body')),name:rect(name),avatar:rect(avatar),nameHit:hit(name),avatarHit:hit(avatar)},topic:w?.dataset.moteWorkface,tab:p.dataset.moteTargetTab,discussions:p.textContent.includes('Discussions'),author:own?.querySelector('.log-turn__who')?.textContent,avatarOwner:own?.querySelector('[data-mote-author]')?.dataset.moteAuthor,avatarSource:avatar?.dataset.spaceIconSource,avatarImage:avatar?.querySelector('img')?.src,originalAvatarImage:originalAvatar?.src,unknownAuthor:unknown?.querySelector('.log-turn__who')?.textContent,unknownMoteAvatar:!!unknown?.querySelector('[data-mote-author]'),feedVisible:!!r&&r.width>0&&r.height>0,viewport:{width:innerWidth,height:innerHeight}}})()`)
        const composerQualification = () => read(`(()=>{const p=${panel},c=p.querySelector('.composer'),e=c?.querySelector('.composer__editor .tiptap'),tools=c?.querySelector('.composer__toolbar > div:first-child'),controls=c?.querySelector('.composer-session-controls'),rect=e=>e?JSON.parse(JSON.stringify(e.getBoundingClientRect())):null;let hit=false;if(e){const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);hit=!!h&&(h===e||e.contains(h))}return{composer:rect(c),editor:rect(e),tools:rect(tools),controls:rect(controls),draft:e?.textContent,editorHit:hit}})()`)
        const readableComposer = (current) => {
          assert.equal(current.draft, 'Original unsent draft · mote-primary', 'Original unsent draft remains exact')
          assert.ok(current.composer.width > 0 && current.editor.width > 0 && current.controls.width > 0, 'Original editor and controls have real area')
          assert.ok(current.editor.width >= current.composer.width - 2, 'Narrow original editor keeps the full Composer line')
          assert.ok(current.tools.top >= current.editor.bottom - 1 && current.controls.top >= current.editor.bottom - 1, 'Original tools yield a separate row below editable text')
          assert.ok(current.controls.right <= current.composer.right && current.controls.bottom <= current.composer.bottom, 'Original Session controls remain inside the Composer')
          assert.equal(current.editorHit, true, 'Original draft editing area remains reachable')
        }
        result.chatBeforeNavigation = await chatQualification()
        await capture('wide-default-mote-chat')
        if (await read(navigation + '?.getAttribute("aria-expanded")==="false"')) await click(navigation)
        result.chatWide = await chatQualification()
        assert.equal(result.chatWide.topic, 'launcher:leader'); assert.equal(result.chatWide.tab, 'mote-primary-tab')
        assert.equal(result.chatWide.discussions, true); assert.equal(result.chatWide.author, 'Mote')
        assert.equal(result.chatWide.avatarOwner, 'launcher:leader'); assert.equal(result.chatWide.avatarSource, 'automatic')
        assert.ok(result.chatWide.avatarImage); assert.equal(result.chatWide.avatarImage, result.chatWide.originalAvatarImage)
        assert.equal(result.chatWide.unknownAuthor, 'unavailable-original-author'); assert.equal(result.chatWide.unknownMoteAvatar, false)
        assert.equal(result.chatWide.feedVisible, true)
        const readableChat = (chat) => {
          const g = chat.geometry
          assert.ok(g.navigation.width > 0 && g.body.width > 0, 'Original navigation and body have real area')
          assert.ok(g.body.left >= g.navigation.right - 1, 'Discussions reserve layout width; the original body is not covered')
          assert.ok(g.name.width > 0 && g.name.height > 0 && g.avatar.width > 0 && g.avatar.height > 0, 'Original Mote author and avatar have real area')
          assert.equal(g.nameHit, true, 'Original Mote author is painted above its own message')
          assert.equal(g.avatarHit, true, 'Original Mote avatar is painted above its own message')
        }
        readableChat(result.chatWide)
        result.composerWide = await composerQualification(); readableComposer(result.composerWide)
        await capture('wide-qualified-mote-chat')
        win.setContentSize(640, 680); await until('innerWidth===640')
        result.chatNarrow = await chatQualification()
        assert.equal(result.chatNarrow.topic, 'launcher:leader'); assert.equal(result.chatNarrow.author, 'Mote'); assert.equal(result.chatNarrow.feedVisible, true)
        assert.equal(result.chatNarrow.avatarSource, 'automatic'); assert.equal(result.chatNarrow.avatarImage, result.chatNarrow.originalAvatarImage)
        readableChat(result.chatNarrow)
        result.composerNarrow = await composerQualification(); readableComposer(result.composerNarrow)
        await capture('narrow-qualified-mote-chat')
        await click(navigation)
        result.chatNarrowReading = await chatQualification()
        assert.equal(result.chatNarrowReading.geometry.open, 'false'); assert.equal(result.chatNarrowReading.geometry.nameHit, true); assert.equal(result.chatNarrowReading.geometry.avatarHit, true)
        await capture('narrow-reading-mote-chat')
        await click(navigation)
        win.setContentSize(1100, 760); await until('innerWidth===1100')
        await click(panel + '.querySelector(' + JSON.stringify('[data-workbench-tab-id="mote-primary-tab"] .workbench-tab__close') + ')')
        await until('document.querySelector(".confirmation-dialog") && document.activeElement?.textContent==="Cancel"')
        result.confirmation = await read(`(()=>{const d=document.querySelector('.confirmation-dialog'),h=d.closest('[popover]'),r=d.getBoundingClientRect();return{hostOpen:h.matches(':popover-open'),nativeParent:h.parentElement===${panel},floatOpen:${panel}.matches(':popover-open'),defaultFocus:document.activeElement.textContent,hit:d.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}})()`)
        assert.deepEqual(result.confirmation, { hostOpen: true, nativeParent: true, floatOpen: true, defaultFocus: 'Cancel', hit: true, inside: true })
        await capture('trusted-window-confirmation')
        const backdropTarget = panel + '.querySelector(' + JSON.stringify('[data-mote-topic-id="launcher:reviewer"]') + ')'
        result.modalBackdrop = await read(`(()=>{const e=${backdropTarget},r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{hitScrim:!!hit?.closest('.confirmation-dialog__overlay'),originalMote:${panel}.dataset.moteTargetTopic}})()`)
        assert.deepEqual(result.modalBackdrop, { hitScrim: true, originalMote: 'launcher:leader' })
        await click(backdropTarget)
        await until('!document.querySelector(".confirmation-dialog")')
        const afterBackdrop = await facts()
        assert.equal(await read(panel + '.matches(":popover-open")'), true, 'Modal backdrop dismisses only its Dialog')
        assert.equal(afterBackdrop.floating.targetTopicId, 'launcher:leader', 'Scrim consumes the pointer over another Mote')
        for (const key of ['tabs', 'drafts', 'outbox', 'runs', 'viewModes']) assert.deepEqual(afterBackdrop[key], beforeConfirmation[key], 'Backdrop preserves ' + key)
        assert.deepEqual(forbidden(afterBackdrop), [])
        await click(panel + '.querySelector(' + JSON.stringify('[data-workbench-tab-id="mote-primary-tab"] .workbench-tab__close') + ')')
        await until('document.querySelector(".confirmation-dialog") && document.activeElement?.textContent==="Cancel"')
        await click('[...document.querySelectorAll(".confirmation-dialog button")].find(e=>e.textContent==="Cancel")')
        await until('!document.querySelector(".confirmation-dialog")')
        assert.equal(await read(panel + '.matches(":popover-open")'), true, 'Trusted Cancel retains the original auto-popover')
        const row = panel + '.querySelector(' + JSON.stringify('[data-mote-topic-id="launcher:reviewer"]') + ')'
        await click(row, 'right')
        await until('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent==="Rename Mote…")')
        const menuState = `(()=>{const m=document.querySelector('.tab-context-menu[role="menu"][data-state="open"]');return m?{open:true,opacity:getComputedStyle(m).opacity,animations:m.getAnimations().map(a=>({name:a.animationName,state:a.playState,duration:a.effect?.getTiming().duration}))}:null})()`
        result.menuEntryBeforeCapture = await read(menuState)
        assert.equal(result.menuEntryBeforeCapture?.open, true, 'The original object menu is open before its animation settles')
        await read(`(()=>{const m=document.querySelector('.tab-context-menu[role="menu"][data-state="open"]');if(!m)throw new Error('Original menu closed before capture');return Promise.all(m.getAnimations().map(a=>a.finished))})()`)
        result.menuEntryFinal = await read(menuState)
        assert.equal(result.menuEntryFinal?.open, true); assert.equal(result.menuEntryFinal.opacity, '1', 'Capture the original menu after its real entry animation')
        await capture('trusted-original-object-menu')
        await click('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent==="Rename Mote…")')
        await until('document.querySelector(".mote-rename input")===document.activeElement')
        result.menuDialog = await read(`(()=>{const d=document.querySelector('.mote-rename'),h=d.closest('[popover]'),r=d.getBoundingClientRect();return{hostOpen:h.matches(':popover-open'),nativeParent:h.parentElement===${panel},floatOpen:${panel}.matches(':popover-open'),hit:d.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),name:document.querySelector('.mote-rename input').value}})()`)
        assert.equal(result.menuDialog.hostOpen, true); assert.equal(result.menuDialog.nativeParent, true); assert.equal(result.menuDialog.floatOpen, true); assert.equal(result.menuDialog.hit, true)
        await capture('trusted-menu-rename-dialog')
        await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
        await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
        await until('!document.querySelector(".mote-rename")')
        assert.equal(await read(panel + '.matches(":popover-open")'), true, 'The topmost Dialog alone consumes Escape')
        result.menuFocusAfterEscape = await read(`({active:document.activeElement?.outerHTML,originalRow:document.activeElement===${row}})`)
        // Radix restores the original FocusScope after its exit commit. Observe
        // that completion; never synthesize focus or reopen the original Mote.
        await until('document.activeElement===' + row)
        result.menuFocusSettled = await read(`({active:document.activeElement?.outerHTML,originalRow:document.activeElement===${row}})`)
        assert.equal(await read('document.activeElement===' + row), true, 'Menu Dialog returns to its original Mote')
      }
      result.step = 'actual-selected-keep-close-continues-original-neighbor'
      await keepClose('mote-primary-tab')
      result.remaining = await visible('launcher:leader', 'mote-neighbor-tab')
      assert.deepEqual(result.remaining.tabs['mote-neighbor-tab'], result.initial.tabs['mote-neighbor-tab'])
      assert.ok(!result.remaining.ui.text.includes('Original Tab retained'))
      assert.deepEqual(forbidden(result.remaining), [])
      await capture('wide-original-remaining-tab')
      result.step = 'actual-last-keep-close-persists-actionable-empty-topic'
      await choose('launcher:reviewer', 'custom-mote-tab')
      await keepClose('custom-mote-tab')
      result.empty = await visible('launcher:reviewer', null)
      assert.ok(result.empty.ui.newTab, 'Empty Topic exposes a real New Tab action')
      assert.ok(!result.empty.ui.text.includes('Original Tab retained'))
      await capture('wide-empty-topic')
      await choose('launcher:leader', 'mote-neighbor-tab')
      await choose('launcher:reviewer', null)
      win.setContentSize(640, 680)
      await until('innerWidth===640'); await capture('narrow-empty-topic')
      await click(panel + '.querySelector("button[aria-label=\'Open Mote Space\']")')
      await until('!' + panel + '?.matches(":popover-open") && window.closedTabProof.facts().mainSurface==="workbench"')
      const inSpace = await facts()
      assert.equal(inSpace.selection.topicId, 'launcher:reviewer'); assert.equal(inSpace.selection.tabId, null)
      assert.deepEqual(inSpace.tabs, result.empty.tabs, 'Open Space retains the empty Topic without creating a launcher')
      result.emptySpaceDom = await read(`(()=>{const e=document.querySelector('[data-mote-empty-space="launcher:reviewer"]');const b=e?.querySelector('[aria-label="New Tab"]');const r=b?.getBoundingClientRect();const hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;return{title:e?.textContent,status:e?.querySelector('[role="status"]')?.textContent,buttonText:b?.textContent,width:r?.width,height:r?.height,centerHitsButton:!!b&&!!hit&&(hit===b||b.contains(hit))}})()`)
      assert.ok(result.emptySpaceDom.title?.includes('Review the next step'), 'Real Space displays the selected Topic identity')
      assert.equal(result.emptySpaceDom.status, 'No Tab in this context')
      assert.ok(result.emptySpaceDom.buttonText?.includes('New Tab'))
      assert.ok(result.emptySpaceDom.width > 0 && result.emptySpaceDom.height > 0 && result.emptySpaceDom.centerHitsButton, 'Original New Tab button is visibly reachable')
      await capture('narrow-empty-full-space')
      // Reopen the original owner after navigation, then leave an explicit durable empty target.
      await click(entry); await visible('launcher:reviewer', null)
      win.setContentSize(1100, 760); await until('innerWidth===1100')
      result.final = await visible('launcher:reviewer', null)
    } else {
      result.step = 'second-real-process-ordinary-durable-restore'
      const prior = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).final
      const initial = await visible('launcher:reviewer', null)
      assert.equal(initial.initialization.seedApplied, false, 'Restore does not seed after hydration')
      assert.ok(initial.initialization.initialDurable?.state.restoredWorkbench, 'Second process really reads durable workbench')
      assert.equal(initial.initialization.initialFloating.targetTabId, null)
      assert.deepEqual(initial.initialization.afterOrdinaryInitialize.tabIds.sort(), Object.keys(prior.tabs).sort())
      for (const key of ['tabs', 'layouts', 'drafts', 'outbox', 'viewModes', 'activeWorkspaceId', 'mainSurface']) assert.deepEqual(initial[key], prior[key], 'Ordinary restart retains ' + key)
      assert.deepEqual(initial.focus.execution, prior.focus.execution)
      assert.deepEqual(initial.runs, prior.runs)
      assert.deepEqual(initial.calls.filter(call => call.operation === 'recover').sort((a,b)=>a.sessionId.localeCompare(b.sessionId)), [
        { operation: 'recover', sessionId: 'mote-neighbor', runId: 'original-run-mote-neighbor' },
        { operation: 'recover', sessionId: 'project-worker', runId: 'original-run-project-worker' }
      ])
      await capture('wide-restarted-empty-topic')
      const neighbor = await choose('launcher:leader', 'mote-neighbor-tab')
      assert.deepEqual(neighbor.tabs['mote-neighbor-tab'], prior.tabs['mote-neighbor-tab'])
      await until('window.closedTabProof.facts().calls.some(c=>c.operation==="attach"&&c.sessionId==="mote-neighbor"&&c.runId==="original-run-mote-neighbor")')
      await capture('wide-restarted-original-remaining-tab')
      result.step = 'exact-never-closed-missing-reference-recovery-control'
      const beforeUnknown = await facts()
      await read('window.closedTabProof.showUnknown()')
      result.unknown = await visible('launcher:leader', 'saved-unavailable-tab')
      assert.ok(result.unknown.ui.text.includes('Original Tab retained'))
      assert.deepEqual(result.unknown.tabs, beforeUnknown.tabs)
      assert.deepEqual(result.unknown.drafts, beforeUnknown.drafts)
      assert.deepEqual(result.unknown.focus.execution, beforeUnknown.focus.execution)
      result.unknownQualification = await read(`(()=>{const p=${panel},w=p.querySelector('[data-mote-workface]');return{topic:w?.dataset.moteWorkface,tab:p.dataset.moteTargetTab,status:p.textContent.includes('Original Tab retained'),newSessionClaim:p.textContent.includes('New Session')}})()`)
      assert.equal(result.unknownQualification.topic, 'launcher:leader'); assert.equal(result.unknownQualification.tab, 'saved-unavailable-tab'); assert.equal(result.unknownQualification.status, true)
      await capture('wide-unknown-exact-reference')
      result.final = await choose('launcher:reviewer', null)
    }
    assert.deepEqual(result.final.tabs['original-project-tab'], result.initial.tabs['original-project-tab'])
    assert.equal(result.final.tabs['original-project-tab'].layout.root.ratio, 0.63)
    assert.deepEqual(result.final.focus.execution, result.initial.focus.execution)
    assert.deepEqual(result.final.drafts, result.initial.drafts)
    assert.deepEqual(result.final.outbox, result.initial.outbox)
    assert.deepEqual(result.final.runs, result.initial.runs)
    assert.deepEqual(forbidden(result.final), [])
    assert.equal(result.final.tabs['mote-primary-tab'], undefined); assert.equal(result.final.tabs['custom-mote-tab'], undefined)
    result.step = 'wait-real-durable-writer-before-exit'
    await until('(()=>{const s=JSON.parse(localStorage.getItem("agentmux-workbench-v1"))?.state,c=window.closedTabProof.facts();return !!s?.restoredWorkbench?.tabs["original-project-tab"] && !s.restoredWorkbench.tabs["mote-primary-tab"] && !s.restoredWorkbench.tabs["custom-mote-tab"] && JSON.stringify(s.restoredWorkbench.layouts)===JSON.stringify(c.layouts) && JSON.stringify(s.agentComposerDrafts)===JSON.stringify(c.drafts) && JSON.stringify(s.agentFocus.execution)===JSON.stringify(c.focus.execution) && s.activeWorkspaceId===c.activeWorkspaceId && s.mainSurface===c.mainSurface && JSON.stringify(s.viewModes)===JSON.stringify(c.viewModes) && JSON.parse(localStorage.getItem("agentmux.leader-topic-floating.v1")).targetTabId===null})()')
    await win.webContents.session.flushStorageData()
    result.durable = await read('JSON.parse(localStorage.getItem("agentmux-workbench-v1"))')
    assert.equal(result.unexpectedWindowClosure, undefined)
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.observation = await bounded(win.webContents.executeJavaScript('({setup:window.closedTabSetup,body:document.body.innerText,facts:window.closedTabProof?.facts()})'), 'failure facts', 2000).catch(error=>({error:error.message}))
  } finally {
    if (win && !win.isDestroyed()) try { await bounded(win.webContents.executeJavaScript('window.closedTabProof?.dispose()'), 'Renderer cleanup', 5000) }
    catch (error) { result.passed=false; result.cleanupFailure={message:error.message} }
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
