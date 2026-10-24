const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence, mode = 'all'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const proof = { passed: false, captureOnly: true, aestheticReview: 'not-performed', mode, frames: [], scenes: [], interactions: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 840, height: 760, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.on('console-message', event => { if (event.level >= 3) proof.errors.push({ message: event.message }) })
    win.webContents.on('render-process-gone', (_event, detail) => proof.errors.push({ process: detail }))
    await win.loadFile(html)
    win.show(); win.focus(); win.webContents.focus()
    await win.webContents.executeJavaScript(`window.__connectionsTrustedEvents=[]; for (const type of ['click','keydown','input','focusin']) document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)`)
    const input = nativeRendererInput(win, proof.interactions, '.composer-mailbox')
    const { read, until, settle, click } = input
    await until('Boolean(window.originalWaitingPreview && document.querySelector("[data-semantic-icon-sprite]"))')
    const draft = '[data-agent-composer] [role="textbox"]'
    const facts = () => read(`(() => { const panel=document.querySelector('.composer-mailbox'),actions=document.querySelector('[data-original-input-waiting]');return { viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, panel:panel?.getBoundingClientRect().toJSON(), actions:actions?.getBoundingClientRect().toJSON(), text:panel?.innerText, outcome:document.querySelector('[data-input-stop-outcome]')?.dataset.inputStopOutcome, draft:document.querySelector(${JSON.stringify(draft)})?.textContent, theme:{sprite:!!document.querySelector('[data-semantic-icon-sprite]'),mask:getComputedStyle(document.documentElement).getPropertyValue('--native-disclosure-mask').trim()}, original:window.originalWaitingPreview.facts() } })()`)
    const record = '.composer-mailbox [data-input-mailbox-kind="controlled"] .composer-mailbox__row'
    async function open() {
      await click('.composer__mailbox')
      await click(`js:[...document.querySelectorAll('.composer-mailbox [role="tab"]')].find(n=>(n.querySelector('.composer-mailbox__folder-label')?.textContent??n.textContent).trim()==='Inputs')`)
      await until(`Boolean(document.querySelector(${JSON.stringify(record)}))`)
      await click(record)
      await until('Boolean(document.querySelector("[data-input-wait-action=stop]"))')
    }
    async function frame(file) {
      await settle()
      const observed = await facts()
      assert.equal(observed.draft, 'Keep this independent unsent draft.')
      assert.deepEqual(observed.original.forbidden, [])
      assert.equal(observed.theme.sprite, true); assert.match(observed.theme.mask, /^url\(/)
      assert.ok(observed.panel.width <= observed.viewport.width)
      const png = (await win.webContents.capturePage()).toPNG()
      const bitmap = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      assert.equal(bitmap.width, Math.round(observed.viewport.width * observed.viewport.dpr))
      assert.equal(bitmap.height, Math.round(observed.viewport.height * observed.viewport.dpr))
      await fs.writeFile(path.join(evidence, file), png)
      proof.frames.push({ file, sha256: createHash('sha256').update(png).digest('hex'), bitmap })
      proof.scenes.push({ file, ...observed })
    }
    const repair = mode === 'repair-results'
    const outcomes = repair ? ['already-settled', 'stale-generation'] : ['stopped-before-dispatch', 'observation-stopped', 'already-settled', 'stale-generation']
    for (let index = 0; index < outcomes.length; index++) {
      const value = outcomes[index]
      await read(`window.originalWaitingPreview.seed(${JSON.stringify(value)})`)
      win.setContentSize(index === 0 && !repair ? 840 : 420, 760); await settle()
      const previous = await read('window.originalWaitingPreview.facts().actions.length')
      await open()
      assert.equal(await read('window.originalWaitingPreview.facts().actions.length'), previous, 'Mount/read/select never performs Stop')
      if (index === 0 && !repair) {
        await frame('waiting-wide.png')
        win.setContentSize(420, 760); await settle()
        await frame('waiting-narrow.png')
      }
      await click('[data-input-wait-action="stop"]')
      await until(`document.querySelector('[data-input-stop-outcome]')?.dataset.inputStopOutcome===${JSON.stringify(value)}`)
      assert.equal(await read('window.originalWaitingPreview.facts().actions.length'), previous + 1)
      await frame(value + '-narrow.png')
      const observed = proof.scenes.at(-1).original, action = observed.actions.at(-1)
      assert.equal(action.target.hostId, observed.hostId)
      assert.deepEqual(action.ref, observed.ref)
      assert.equal(action.target.run.runId, observed.key.expectedRun.runId)
      assert.ok(action.cancelOperationId.startsWith('desktop-input-stop-v1:'))
    }
    assert.equal(proof.frames.length, repair ? 2 : 6); assert.deepEqual(proof.errors, [])
    proof.passed = true
    proof.boundary = 'Native original SessionMailbox and AgentComposer, production CSS/theme, synthetic exact external journal and Stop ACK leaves. No real Host/Core authority, live account, Run, dispatch/rejoin, native IME or installed-package qualification. Already-settled ACK and the last retained waiting snapshot are independent observations; no admitted receipt is fabricated.'
  } catch (error) {
    proof.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      await fs.writeFile(path.join(evidence, 'failure.html'), await win.webContents.executeJavaScript('document.body.outerHTML')).catch(() => {})
      await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {})
    }
  } finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(proof, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(proof.passed ? 0 : 1)
  }
})
