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
    await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1', initialUnbound: '1' } })
    await until('window.moteStartCapture?.ready && document.querySelector(".mote-start .tiptap")', 'Actual full App welcome and Composer')
    await read('window.__connectionsTrustedEvents=window.moteStartCapture.facts().trustedEvents')
    app.focus({ steal: true }); win.show(); win.focus(); win.webContents.focus(); await settle()
    const before = await read('window.moteStartCapture.facts()')
    async function capture(name, surface = panel) {
      await settle()
      const facts = await read('window.moteStartCapture.facts()'); assert.deepEqual(facts.writes, [], 'Opening, reading and typing never creates or sends')
      const dom = await read(`(()=>{const n=${surface};return{body:n?.innerText,rect:n?.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},scroll:document.querySelector('.mote-start')?.scrollTop,motion:[...document.querySelectorAll('.mote-start .mote-identity-motion')].map(n=>({visible:n.dataset.moteVisible,motion:n.dataset.moteMotion})),draft:document.querySelector('.mote-start .tiptap')?.innerText}})()`)
      assert.ok(dom.rect?.width > 0); const file = name + '.png'
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.images.push(file); result.operations.push({ name, dom, facts })
    }
    if (process.argv.includes('--supplement-only')) {
      await click(`js:${panel}.querySelector(${JSON.stringify('[aria-label="Open Mote in Space"]')})`)
      await until('document.querySelector("[data-mote-space] .mote-start")', 'Actual Space welcome')
      await click(`js:${panel}.querySelector(${JSON.stringify('[aria-label="Close Mote"]')})`)
      const space = 'document.querySelector("[data-mote-space]")'
      const portrait = await read(`(()=>{const n=${space}.querySelector('.mote-start__portrait'),r=n.getBoundingClientRect();return{x:r.right-10,y:r.top+30}})()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(portrait.x), y: Math.round(portrait.y) }); await settle()
      result.motion = await read(`(()=>{const n=${space}.querySelector('.mote-start .mote-identity-motion');return{visible:n?.dataset.moteVisible,gaze:n?.dataset.moteGaze,x:n?.style.getPropertyValue('--mote-gaze-x'),background:getComputedStyle(${space}.querySelector('.mote-start__brand-art')).animationPlayState}})()`)
      assert.equal(result.motion.visible, 'on'); assert.equal(result.motion.gaze, 'near'); assert.equal(result.motion.background, 'running')
      await capture('10-space-welcome-pointer', space)
      win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await read('window.moteStartCapture.theme(true)'); await settle()
      assert.equal(await read(`getComputedStyle(${space}.querySelector('.mote-start__brand-art')).animationName`), 'none')
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
