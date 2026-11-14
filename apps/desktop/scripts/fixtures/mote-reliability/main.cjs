const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
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
      const seeded = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')), seed = seeded.original
      result.restored = await read('window.moteReliability.facts()')
      assert.ok(Object.keys(seed.drafts).length > 0 && Object.values(seed.drafts).some(value => value.prompt?.trim()), 'Seed contains a nonempty original Launcher draft')
      assert.ok(Object.keys(seed.agentDrafts).length > 0 && seed.agentDrafts[seed.session.id]?.trim(), 'Seed contains a nonempty original Agent draft')
      assert.equal(seed.drafts['private-mote-reliability-original-draft'].prompt, seeded.draftWitness.launcher)
      assert.equal(seed.agentDrafts[seed.session.id], seeded.draftWitness.agent)
      assert.deepEqual(result.restored.inputAtEntry.drafts, seed.drafts, 'Launcher input is hydrated before fixture writes')
      assert.deepEqual(result.restored.inputAtEntry.agentDrafts, seed.agentDrafts, 'Agent input is hydrated before fixture writes')
      assert.deepEqual(result.restored.fixtureWrites, [], 'The restore fixture never reseeds a draft or workface')
      assert.deepEqual(result.restored.drafts, seed.drafts, 'Original durable drafts retained in independent process')
      assert.deepEqual(result.restored.agentDrafts, seed.agentDrafts, 'Original Agent draft retained in independent process')
      assert.deepEqual(result.restored.tabs['original-initialization-tab'], seed.tabs['original-initialization-tab'], 'Original durable workface identity retained')
      assert.deepEqual(result.restored.inputAtEntry.tab, seed.tabs['original-initialization-tab'], 'Original Tab exists before fixture projection')
      assert.deepEqual(result.restored.layouts, seed.layouts, 'Original layouts retained')
      assert.deepEqual(result.restored.selection, seed.selection, 'Original selection retained')
      assert.deepEqual(result.restored.focus, seed.focus, 'Original focus retained')
      assert.deepEqual(result.restored.session.control, seed.session.control, 'Original Session and Run retained')
      result.persistedInputs = await read('window.moteReliability.persistedInputs()')
      assert.deepEqual(result.persistedInputs, seeded.persistedInputs, 'The original persisted inputs survive the independent process')
      result.draftRecovery = { originalNonempty: true, hydratedBeforeFixture: true, restoreFixtureWrites: 0, exactPersistedInputs: true, exactWorkface: true }
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
    result.draftWitness = { agent: 'Original Agent draft · ' + randomUUID() + ' · 原输入跨进程保留。', launcher: 'Original Launcher draft · ' + randomUUID() + '\n原草稿不可重新播种。' }
    const editors = `[...document.querySelectorAll('[aria-label="Message Agent"]')].filter(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length)`
    await until(editors + '.length===1')
    await click('(' + editors + ')[0]')
    await until('window.moteReliability.facts().focus.pmo?.sessionId===window.moteReliability.facts().session.id')
    await read(`(()=>{const e=(${editors})[0],range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()`)
    await input('Input.insertText', { text: result.draftWitness.agent })
    await until('window.moteReliability.facts().agentDrafts[window.moteReliability.facts().session.id]===' + JSON.stringify(result.draftWitness.agent))
    await read('window.moteReliability.editDrafts(' + JSON.stringify(result.draftWitness) + ')')
    const deadline = Date.now() + 15000
    do {
      result.persistedInputs = await read('window.moteReliability.persistedInputs()')
      const facts = await read('window.moteReliability.facts()')
      if (result.persistedInputs?.agentDrafts?.[facts.session.id] === result.draftWitness.agent &&
          result.persistedInputs?.drafts?.['private-mote-reliability-original-draft']?.prompt === result.draftWitness.launcher) break
      await pause(30)
    } while (Date.now() < deadline)
    result.original = await read('window.moteReliability.facts()')
    assert.deepEqual(result.persistedInputs, { drafts: result.original.drafts, agentDrafts: result.original.agentDrafts }, 'Nonempty exact draft witnesses reached original persistent input storage')
    assert.equal(result.original.agentDrafts[result.original.session.id], result.draftWitness.agent)
    assert.equal(result.original.drafts['private-mote-reliability-original-draft'].prompt, result.draftWitness.launcher)
    await until('window.sharedFrameProof.persistence().spatial?.graph.tabs.some(tab=>tab.tabId==="original-initialization-tab")')
    result.persisted = await read('window.sharedFrameProof.persistence()'); result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; try { result.failedFacts = await win.webContents.executeJavaScript('window.moteReliability?.facts()') } catch {} }
  finally {
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) { win.webContents.session.flushStorageData(); win.destroy() }
    app.exit(result.passed ? 0 : 1)
  }
})
