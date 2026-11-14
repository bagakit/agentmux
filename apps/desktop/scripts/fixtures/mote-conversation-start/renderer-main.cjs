const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData')); app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', images: [], operations: [], interactions: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    const panel = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
    const readingOnly = process.argv.includes('--reading-only')
    await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1', initialUnbound: '1', ...(readingOnly ? { readingHeld: '1' } : {}) } })
    await until('window.moteStartCapture?.ready && document.querySelector(".mote-start .tiptap")', 'Actual full App welcome and Composer')
    await read('window.__connectionsTrustedEvents=window.moteStartCapture.facts().trustedEvents')
    app.focus({ steal: true }); win.show(); win.focus(); win.webContents.focus(); await settle()
    const before = await read('window.moteStartCapture.facts()')
    result.visualMutation = await read('window.__moteRolloverVisualMutation ?? null')
    async function capture(name, surface = panel) {
      await settle()
      const facts = await read('window.moteStartCapture.facts()'); assert.deepEqual(facts.writes, [], 'Opening, reading and typing never creates or sends')
      const dom = await read(`(()=>{const n=${surface};return{body:n?.innerText,rect:n?.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},scroll:document.querySelector('.mote-start')?.scrollTop,motion:[...document.querySelectorAll('.mote-start .mote-identity-motion')].map(n=>({visible:n.dataset.moteVisible,motion:n.dataset.moteMotion})),draft:document.querySelector('.mote-start .tiptap')?.innerText}})()`)
      assert.ok(dom.rect?.width > 0); const file = name + '.png'
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.images.push(file); result.operations.push({ name, dom, facts })
    }
    if (process.argv.includes('--executor-setup-only')) {
      await read('window.moteStartCapture.setup()')
      await until(`${panel}.querySelector('.mote-start__notice button')?.textContent==='配置 Agent'`, 'Missing Executor has an adjacent setup action')
      await click('.mote-start .tiptap'); await win.webContents.insertText('先帮我把这个问题想清楚，配置后再发。')
      await capture('24-executor-setup-draft-wide')
      win.setContentSize(640, 720); await read('window.moteStartCapture.theme(true)'); await settle()
      await capture('25-executor-setup-draft-narrow')
      await click(`js:[...${panel}.querySelectorAll('button')].find(node=>node.textContent==='配置 Agent')`)
      await until('document.querySelector(".mote-quick-mode-dialog")?.textContent.includes("Saved settings loaded")', 'Original preferences loaded in actual Quick dialog')
      await click('[aria-label="Executor for new chat"]')
      await until('document.querySelector("[data-value=original-host-executor]")', 'Choices from original preferences rather than client config')
      await capture('26-executor-source-choice-narrow', 'document.querySelector(".mote-quick-mode-dialog")')
      await click('[data-value="original-host-executor"]')
      win.setContentSize(1180, 850); await read('window.moteStartCapture.theme(false)'); await settle()
      await capture('27-executor-setup-settings-wide', 'document.querySelector(".mote-quick-mode-dialog")')
      await click('[aria-label="Close quick mode"]')
      await until('!document.querySelector(".mote-quick-mode-dialog")', 'Return from setup preserves original message')
      assert.ok(await read('document.querySelector(".mote-start .tiptap").innerText.includes("配置后再发")'))
      result.initial = before; result.final = await read('window.moteStartCapture.facts()')
      assert.deepEqual(result.final.identities, before.identities); result.passed = true; return
    }
    if (process.argv.includes('--main-menu-only')) {
      await read('window.moteStartCapture.bound()')
      await until(`${panel}.querySelector('.mote-main-actions__trigger') && ${panel}.querySelector('.mote-workface__original:not([hidden]) .tiptap')`, 'Original current Main and its menu')
      const trigger = `js:${panel}.querySelector('.mote-main-actions__trigger')`
      await click(trigger)
      await until('document.querySelector(".mote-main-actions__menu")', 'Main menu opens in its shared overlay')
      await capture('20-main-menu-wide')
      // The shared overlay consumes Escape before the fixture's ordinary bubbling listener.
      await read('window.moteMainMenuKeys=[];window.addEventListener("keydown",event=>window.moteMainMenuKeys.push({key:event.key,trusted:event.isTrusted}),{capture:true,once:true})')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await settle()
      const keys = await read('window.moteMainMenuKeys')
      assert.ok(keys.some(event => event.key === 'Escape' && event.trusted), 'The real captured Escape reaches the original shared overlay')
      result.interactions.push({ kind: 'native-renderer-key', key: 'Escape', capture: keys })
      await until('!document.querySelector(".mote-main-actions__menu") && document.activeElement?.matches(".mote-main-actions__trigger")', 'Escape closes the menu and returns focus')
      await click(trigger)
      await click('js:[...document.querySelectorAll(".mote-main-actions__menu button")].find(node=>node.textContent==="选择已有主 Agent／设置")')
      await until('document.querySelector(".mote-quick-mode-dialog")', 'Main settings open through the original menu')
      await click('[aria-label="Close quick mode"]')
      await until('!document.querySelector(".mote-quick-mode-dialog") && document.activeElement?.matches(".mote-main-actions__trigger")', 'Closing settings returns to the Main trigger')
      await settle()
      assert.equal(await read('document.querySelectorAll("[role=menu][data-state=open]").length'), 0, 'Closing Main settings does not open a background Agent menu')
      result.focus = await read('({className:document.activeElement.className,text:document.activeElement.textContent})')
      await capture('21-main-settings-closed-focus')
      assert.equal(await read('document.querySelectorAll("[role=menu][data-state=open]").length'), 0, 'The captured focus-return frame has no background Agent menu')
      win.setContentSize(640, 720); await settle()
      await click(trigger); await until('document.querySelector(".mote-main-actions__menu")', 'Narrow Main menu')
      await capture('22-main-menu-narrow')
      await click(`js:${panel}.querySelector('.mote-workface__original:not([hidden]) .tiptap')`)
      await until('!document.querySelector(".mote-main-actions__menu")', 'A complete native outside click dismisses the menu')
      await capture('23-main-menu-outside-closed')
      result.initial = before; result.final = await read('window.moteStartCapture.facts()')
      const runsByIdentity = rows => Object.fromEntries(rows.map(row => [row.id, row.control]))
      assert.deepEqual(result.final.identities, before.identities); assert.deepEqual(runsByIdentity(result.final.runs), runsByIdentity(before.runs)); assert.deepEqual(result.final.drafts, before.drafts)
      result.passed = true; return
    }
    if (process.argv.includes('--reading-only')) {
      // The person opens a Mote whose Main read is still in flight: identity, Composer and a loading history appear at once.
      await until(`${panel}.querySelector('.mote-start[data-mode="reading"] .mote-start__portrait') && ${panel}.querySelector('.mote-start-history__skeleton')`, 'Reading shell with portrait and loading history')
      await capture('18-reading-shell')
      await click(`js:${panel}.querySelector('.mote-start .tiptap')`); await win.webContents.insertText('先帮我把今天的待办理一下')
      await until(`${panel}.querySelector('.mote-start [aria-label="Send"]:not([disabled])')`, 'Typed draft enables Send while reading')
      await click(`js:${panel}.querySelector('.mote-start [aria-label="Send"]')`)
      await until(`${panel}.querySelector('.mote-first-message[data-stage="held"]')`, 'Sent while reading is held, not created or sent')
      await capture('19-reading-held-message')
      await read('window.moteStartCapture.releaseReading()')
      result.passed = true; return
    }
    if (process.argv.includes('--rollover-later-only')) {
      await read('void(window.moteRolloverVisual=window.moteStartCapture.rolloverMember())')
      await until(`${panel}.querySelector('[data-mote-section="threads"] .mote-workface__original:not([hidden])')`, 'Later explicit member selection is displayed first')
      await read('window.moteRolloverVisual.arrive()')
      await until(`${panel}.querySelector('[data-mote-section="threads"] .mote-workface__original:not([hidden]) details[open] button')`, 'Single original Query remains reachable in the selected member')
      await capture('16-member-original-query-continuation')
      const retained = await read('({queue:window.moteRolloverVisual.operationId,draft:document.querySelector(".mote-workface__original:not([hidden]) .tiptap")?.innerText})')
      await click(`js:${panel}.querySelector('[data-mote-rollover="private-new-query"] button')`)
      await until(`${panel}.querySelector('.mote-start') && window.moteRolloverVisual.requests.length===1`, 'Explicit continuation enters the original pending Main action')
      await capture('17-explicit-original-query-pending')
      result.rollover = { retained, pending: await read('window.moteRolloverVisual.requests'), boundary: 'Controlled original pending request only; real Host creation/input confirmation is covered by the consumer test, not this visual fixture.' }
      result.initial = before; result.final = await read('window.moteStartCapture.facts()')
      assert.deepEqual(result.final.identities, before.identities); result.passed = true; return
    }
    if (process.argv.includes('--supplement-only')) {
      await click(`js:${panel}.querySelector(${JSON.stringify('[aria-label="Open Mote in Space"]')})`)
      await until('document.querySelector("[data-mote-space] .mote-start")', 'Actual Space welcome')
      await click(`js:${panel}.querySelector(${JSON.stringify('[aria-label="Close Mote"]')})`)
      const space = 'document.querySelector("[data-mote-space]")'
      const portrait = await read(`(()=>{const n=${space}.querySelector('.mote-start__portrait'),r=n.getBoundingClientRect();return{x:r.right-10,y:r.top+30}})()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(portrait.x), y: Math.round(portrait.y) }); await settle()
      result.motion = await read(`(()=>{const n=${space}.querySelector('.mote-start .mote-identity-motion');return{visible:n?.dataset.moteVisible,gaze:n?.dataset.moteGaze,x:n?.style.getPropertyValue('--mote-gaze-x'),background:getComputedStyle(${space}.querySelector('.mote-start__aura')).animationIterationCount}})()`)
      assert.equal(result.motion.visible, 'on'); assert.equal(result.motion.gaze, 'near'); assert.equal(result.motion.background, '1')
      await capture('10-space-welcome-pointer', space)
      win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await read('window.moteStartCapture.theme(true)'); await settle()
      assert.equal(await read(`getComputedStyle(${space}.querySelector('.mote-start__aura')).animationName`), 'none')
      await capture('11-space-reduced-motion-light', space)
      win.webContents.debugger.detach()
      await read(`(${space}).querySelector('.mote-start-history').scrollIntoView({block:'center'})`); await settle()
      await capture('12-period-history-list', space)
      const boundedId = await read('window.moteBoundedVisualSource?.link?.period?.id')
      assert.ok(boundedId, 'Use the exact actual Core recorded source for the bounded body')
      await click(`.mote-start-history li[data-mote-period="${boundedId}"] > button`)
      await until('document.querySelector(".mote-workface__period .log-turn")', 'Actual shared bounded body from original recorded frames')
      await capture('13-bounded-period-body', space)
      await click('.mote-workface__period > button'); await until('document.querySelector(".mote-start__settings")', 'Return from the same period')
      await click('.mote-start__settings'); await until('document.querySelector(".mote-quick-mode-dialog input[type=number]")', 'Actual policy editor')
      const duration = 'input[aria-label="Conversation inactivity (minutes)"]'
      await click(duration); win.webContents.selectAll(); await win.webContents.insertText('12.5')
      await until(`document.querySelector(${JSON.stringify(duration)}).value==='12.5'`, 'Native number input edit; number inputs have no selectionStart contract')
      const savedPolicy = await read('document.querySelector(".mote-quick-mode-dialog__footer").innerText')
      assert.ok(savedPolicy.includes('Save')); result.unsavedPolicyEdit = { originalMinutes: 45, draftMinutes: 12.5, saved: false }
      await capture('14-policy-edit-save-visible', 'document.querySelector(".mote-quick-mode-dialog")')
      await click('[aria-label="Close quick mode"]')
      await click('.mote-start-history li[data-mote-period="period-legacy"] > button')
      await click(`js:[...document.querySelectorAll('.mote-workface__period button')].find(n=>n.textContent==='打开原 Agent 对话')`)
      await until('document.querySelector(".mote-workface__period [data-mote-earlier-source] .log-turn")', 'Original whole Session read has a visible scope, independent of role boundaries')
      await capture('15-original-session-scope', space)
      result.initial = before; result.final = await read('window.moteStartCapture.facts()'); assert.deepEqual(result.final.identities, before.identities); result.passed = true; return
    }
    await capture('01-welcome-history-dark')
    await click('.mote-start .tiptap'); await win.webContents.insertText('帮我把下一步想清楚，再一起开始。')
    await until('document.querySelector(".mote-start .tiptap").innerText.includes("下一步")', 'Native actual Composer draft')
    await capture('02-welcome-draft-dark')
    await read('window.moteStartCapture.theme(true)'); await capture('03-welcome-history-light')
    win.setContentSize(760, 720); await settle(); await capture('04-welcome-narrow-light')
    await read('window.moteStartCapture.theme(false)'); win.setContentSize(760, 540); await settle(); await capture('05-welcome-short-dark')
    win.setContentSize(1180, 850); await read('window.moteStartCapture.history(false)'); await until('!document.querySelector(".mote-start-history")', 'True empty history')
    await capture('06-welcome-empty-dark')
    await read('window.moteStartCapture.unknown()'); await until('document.querySelector(".mote-start[data-mode=unconfirmed]")', 'Unknown source keeps original input')
    await capture('07-welcome-source-unconfirmed')
    await read('window.moteStartCapture.history(true)'); await until('document.querySelector("[data-mote-period=period-recent]")', 'Original period rows')
    await click('button.mote-start-history__open'); await until('document.querySelector(".mote-workface__period .mote-conversation__earlier")', 'Original period reader')
    await capture('08-period-reader-dark')
    await read('window.moteStartCapture.history(true)'); await until('document.querySelector(".mote-start")', 'Return to original welcome')
    await click('.mote-start__settings'); await until(`document.querySelector(${JSON.stringify('[aria-label="Automatic rollover policy"]')})`, 'Existing Quick settings policy')
    await capture('09-policy-editor-dark', 'document.querySelector(".mote-quick-mode-dialog")')
    result.initial = before; result.final = await read('window.moteStartCapture.facts()')
    assert.deepEqual(result.final.identities, before.identities); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) { result.dom = await win.webContents.executeJavaScript('document.body.innerText').catch(() => null); await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {}) }
  } finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.quit() }
})
