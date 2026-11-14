const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, phase, pid: process.pid, frames: [], input: [], errors: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.errors.push(String(message)) })
    await win.loadFile(html, { query: { phase: 'initialization-' + phase } })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const end = Date.now() + 15000
      do { if (await read('Boolean(' + expression + ')')) return; await pause(30) } while (Date.now() < end)
      throw Error('App did not settle: ' + expression + '; ' + JSON.stringify(await read('({setup:window.sharedFrameSetup,body:document.body.textContent.slice(-1200)})')))
    }
    await until('window.moteReliability?.ready && document.querySelector("[data-mote-page]")')
    win.showInactive(); win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true }); await pause(300)
    result.baseline = await read('window.moteReliability.facts()')
    const counts = calls => Object.fromEntries(['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt'].map(operation => [operation, calls.filter(call => call.operation === operation).length]))
    const button = (label, scope = 'document') => `[...${scope}.querySelectorAll('button,[role="tab"]')].filter(e=>!e.closest('[hidden],[inert]')&&e.getClientRects().length).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)})`
    const click = async (expression, settle = 180) => {
      const point = await read(`(()=>{const e=${expression};if(!e)throw Error('Missing control: '+${JSON.stringify(expression)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      result.input.push({ kind: 'click', expression }); if (settle) await pause(settle)
    }
    const escape = async () => { for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pause(160) }
    const capture = async (name, settle = 160) => {
      if (settle) await pause(settle)
      const facts = await read('window.moteReliability.facts()')
      assert.ok(facts.tabs['original-initialization-tab'], 'Original Tab retained')
      assert.equal(facts.session.control.run.runId, result.baseline.session.control.run.runId, 'Original Run retained')
      assert.deepEqual(counts(facts.calls), counts(result.baseline.calls), 'Status and configuration add no lifecycle/input requests')
      const file = phase + '-' + name + '.png'
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push({ name, file, page: facts.profilePage, theme: facts.theme, dimensions: win.getContentSize(), variant: facts.variant })
    }
    const profile = async () => { await click(button('Profile', 'document.querySelector(".mote-space-frame__header")')); await until('document.querySelector("[data-mote-page=profile]")') }
    const refresh = async () => { await click(button('Refresh actual schedule', 'document.querySelector(".mote-quick-mode")')) }
    if (phase === 'restore') {
      const seed = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).original
      result.restored = await read('window.moteReliability.facts()')
      assert.deepEqual(result.restored.drafts, seed.drafts, 'Original durable drafts retained in independent process')
      assert.deepEqual(result.restored.tabs['original-initialization-tab'], seed.tabs['original-initialization-tab'], 'Original durable workface identity retained')
      await profile(); await capture('restored-heartbeat-dark-wide')
      result.passed = true; return
    }
    for (const [theme, width, height] of [['dark', 1180, 820], ['dark', 420, 740], ['light', 1180, 820], ['light', 420, 740]]) {
      win.setContentSize(width, height); await read(`window.moteInit.theme(${JSON.stringify(theme)})`); await pause(180)
      await profile(); await read('window.moteReliability.variant("paused")'); await refresh()
      await capture('paused-profile-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
      await click(button('Configure heartbeat'), 25)
      await until('document.querySelector(".mote-quick-mode-dialog [data-mote-maintenance-status=paused]")')
      if (theme === 'dark' && width === 1180) await capture('heartbeat-opening-intermediate', 0)
      await capture('heartbeat-dialog-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
      await escape()
    }
    win.setContentSize(1180, 820); await read('window.moteInit.theme("dark");window.moteReliability.variant("active")'); await profile(); await refresh()
    await capture('accepted-profile-dark-wide')
    await read('window.moteReliability.variant("unbound")'); await refresh(); await capture('unbound-profile-dark-wide')
    await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    win.setContentSize(420, 740); await click(button('Configure heartbeat')); await capture('unbound-reduced-motion-dark-narrow'); await escape()
    await read('window.moteReliability.startup()'); await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
    await until(`document.querySelector('[aria-label="Mote startup"]')`)
    await capture('startup-guidance-dark-narrow')
    win.setContentSize(1180, 820); await read('window.moteInit.theme("light")'); await capture('startup-guidance-light-wide')
    result.original = await read('window.moteReliability.facts()')
    await until('window.sharedFrameProof.persistence().spatial?.graph.tabs.some(tab=>tab.tabId==="original-initialization-tab")')
    result.persisted = await read('window.sharedFrameProof.persistence()'); result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; try { result.failedFacts = await win.webContents.executeJavaScript('window.moteReliability?.facts()') } catch {} }
  finally {
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) { win.webContents.session.flushStorageData(); win.destroy() }
    app.exit(result.passed ? 0 : 1)
  }
})
