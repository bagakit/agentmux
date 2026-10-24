const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, profile, evidence, mode] = process.argv.slice(2)
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
const report = { passed: false, mode, scenarios: [], network: [], userRunTouched: false }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    report.network.push({ url: details.url, resourceType: details.resourceType }); callback({ cancel: true })
  })
  const win = new BrowserWindow({ width: 1040, height: 1000, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(details => { report.network.push({ kind: 'window-open', url: details.url }); return { action: 'deny' } })
  win.webContents.on('console-message', (event, _level, message) => { (report.console ??= []).push(event.message ?? message) })
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  const facts = () => evaluate('conversationLinksProbe.facts()')
  const until = async (expression, message) => {
    const deadline = Date.now() + 12000
    while (!await evaluate(expression)) { assert.ok(Date.now() < deadline, message); await delay(25) }
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  }
  const capture = async name => { await delay(80); await fs.writeFile(path.join(evidence, `${mode}-${name}.png`), (await win.webContents.capturePage()).toPNG()) }
  const click = async (selector, modifiers = []) => {
    const point = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point, modifiers })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1, modifiers }); await delay(60)
    return point
  }
  const assertLocal = value => {
    assert.equal(value.issues.length, 0, 'The original Desktop link-opening hook must not report a Host failure')
    assert.equal(value.forbidden.length, 0, 'Local link cards must not fetch metadata or open a Browser while rendering')
    assert.equal(value.remoteMedia.length, 0, 'Local link cards must not request remote artwork')
    assert.equal(report.network.length, 0, 'The private Chromium must make zero HTTP(S) requests')
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'Link cards must not create another Browser window')
  }
  try {
    await win.loadFile(html)
    await until("window.conversationLinksProbe && document.querySelectorAll('.md-link-card').length===2", 'The actual Agent and user messages must render their two independent link cards')
    for (const [name, width, height, theme] of [['wide-light', 1040, 1000, 'light'], ['wide-dark', 1040, 1000, 'dark'], ['narrow-dark', 420, 1100, 'dark']]) {
      win.setContentSize(width, height)
      await evaluate(`conversationLinksProbe.configure(${JSON.stringify(theme)},'showcase')`)
      await until("document.querySelectorAll('.md-link-card').length===2", 'Both original cards must remain rendered after a presentation change')
      const value = await facts(); report.scenarios.push({ name, value }); assertLocal(value)
      assert.equal(value.theme, theme)
      assert.equal(value.documentWidth <= width + 1, true, 'Long labels and original addresses must not overflow the reading window')
      assert.equal(value.cards.length, 2)
      for (const card of value.cards) {
        assert.ok(card.borderWidth > 0 && card.borderStyle !== 'none' && card.radius >= 4,
          'The formal Markdown stylesheet must render a bounded link card surface')
        assert.ok(card.width > 200 && card.width <= width - 40 && card.height > 60 && card.height < 280,
          'A local preview must have a readable bounded card size')
        assert.ok(card.button.width > 150 && card.button.height >= 36 && card.button.right <= card.right + 1,
          'The original link action must retain a complete keyboard and pointer target')
        assert.equal(card.button.display, 'grid', 'The formal card action CSS must supply its bounded grid layout')
        assert.ok(card.scrollWidth <= card.clientWidth + 1, 'The card must retain the long original URL without horizontal overflow')
      }
      assert.ok(value.text.includes('# 接下来想读'), 'The actual incoming message retains its input heading marker')
      await capture(name)
    }
    win.setContentSize(1040, 1000)
    await evaluate("conversationLinksProbe.configure('light','showcase')")
    await until("document.querySelectorAll('.md-link-card').length===2", 'The original authored card is ready for interaction')
    await click('.md-link-card details summary')
    await until("document.querySelector('.md-link-card details').open", 'The reader can disclose the complete original target')
    report.details = await facts(); assert.ok(report.details.text.includes(await evaluate('conversationLinksProbe.uri')))
    await capture('original-target')
    const point = await click('.md-link-card__open', ['meta', 'alt'])
    await until('conversationLinksProbe.facts().opened.length===1', 'The original pointer click must reach the Host exactly once')
    report.pointer = { point, value: (await facts()).opened[0] }
    assert.equal(report.pointer.value.url, await evaluate('conversationLinksProbe.uri'))
    assert.equal(report.pointer.value.modifiers.metaKey, true); assert.equal(report.pointer.value.modifiers.altKey, true)
    assert.equal(report.pointer.value.modifiers.ctrlKey, false)
    assert.equal(report.pointer.value.destination, 'system', 'The actual Desktop modifier policy selects the system destination')
    assert.equal(report.pointer.value.modifiers.clientX, point.x); assert.equal(report.pointer.value.modifiers.clientY, point.y)
    await click('.md-link-card .content-copy')
    await until("conversationLinksProbe.facts().copied.length===1 && conversationLinksProbe.facts().cards[0].copyState==='copied'", 'ContentCopyButton must confirm copying the complete original URI')
    assert.equal((await facts()).copied[0], await evaluate('conversationLinksProbe.uri'))
    assert.equal((await facts()).opened.length, 1, 'Copying the target must not also activate it')
    // A hidden proof window must not steal the user's OS focus. Drive Chromium's
    // trusted input channel on this exact private target, with renderer-only focus.
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await evaluate("document.querySelector('.md-link-card__open').focus({preventScroll:true})")
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await until('conversationLinksProbe.facts().opened.length===2', 'The real Chromium keyboard must activate the same original button')
    report.keyboard = await facts(); assert.equal(report.keyboard.opened[1].url, await evaluate('conversationLinksProbe.uri'))
    report.keyboard.transport = 'Private target CDP trusted keyboard; renderer-only focus emulation, no OS focus'
    assert.equal(report.keyboard.opened[1].destination, 'right', 'The actual Desktop Focus default chooses the original adjacent Region')
    assert.equal(report.keyboard.cards[0].button.active, true)
    await capture('keyboard-focus')
    await evaluate("conversationLinksProbe.configure('light','nested')")
    await until("conversationLinksProbe.facts().scenario==='nested' && document.querySelector('.md-heading')", 'The original nested Markdown must mount')
    report.nested = await facts()
    assert.equal(report.nested.cards.length, 0, 'Only top-level standalone paragraphs may become cards; nested and inline links preserve their grammar')
    await evaluate("conversationLinksProbe.configure('light','bare')")
    await until("document.querySelectorAll('.md-link-card').length===1", 'A bare original URL message must reach the same production card')
    report.bare = await facts(); assertLocal(report.bare)
    await evaluate("conversationLinksProbe.configure('light','no-adapter')")
    await until("conversationLinksProbe.facts().scenario==='no-adapter' && !document.querySelector('.md-link-card')", 'No Host adapter retains the original link rendering')
    report.noAdapter = await facts(); assertLocal(report.noAdapter)
    assert.equal(report.noAdapter.opened.length, 2)
    assert.equal(report.scenarios.length, 3)
    report.passed = true
  } catch (error) {
    report.failure = { name: error.name, message: error.message, stack: error.stack }
    report.bodyAtFailure = await facts().catch(() => null)
    await capture('failure').catch(() => {})
  } finally {
    win.destroy(); report.remainingWindows = BrowserWindow.getAllWindows().length
    await fs.writeFile(path.join(evidence, `${mode}.render.json`), JSON.stringify(report, null, 2))
    app.exit(report.passed ? 0 : 1)
  }
}).catch(async error => {
  report.failure = { name: error.name, message: error.message, stack: error.stack }
  await fs.writeFile(path.join(evidence, `${mode}.render.json`), JSON.stringify(report, null, 2)); app.exit(1)
})
